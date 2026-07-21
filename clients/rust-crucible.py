#!/usr/bin/env python3
"""Rust + Cargo Crucible CLI — single entry point for orchestrator + rust-{red,
green,fix,verify} agent lifecycle ops AND for running Cargo targets (nextest,
check, clippy, llvm-cov). Replaces inline python / loose shell so each
invocation has a stable command signature.

This script is tool-specific (Cargo / Nextest / JUnit-XML / llvm-cov / Clippy),
not project-specific — the project path is parameterizable.

Subcommands:
  register, unregister  Agent lifecycle.
  test                  cargo nextest run -p <crate> -P <profile> [--features ...]
                        [--filter EXPR]. If --agent passed, auto-ingests JUnit.
  check                 cargo check -p <crate> [--features ...]. If --agent passed,
                        ingests stderr to /api/v2/runs/compile.
  clippy                cargo clippy -p <crate> [--features ...] [--deny-warnings].
                        If --agent passed, ingests stderr to /api/v2/runs/compile.
  auto-ingest           Ingest only: if JUnit XML exists fresh, ingest as junit;
                        otherwise run `cargo check` and ingest as compile.
                        For when caller has already run `cargo nextest` separately.
  regression-ingest     cargo clean -p ... → llvm-cov nextest -p ... → parse junit
                        + lcov → /api/v2/runs/parsed with coverage. Per-crate scope.
  workspace-regression  cargo clean → cargo llvm-cov nextest --workspace
                        --all-features -P <profile> → ingest. ORCHESTRATOR
                        pre-merge gate path (no docker).
  smoke-test            cargo nextest run --workspace [--all-features|--features X]
                        -P <profile> --no-fail-fast → ingest JUnit (no
                        coverage). Faster than workspace-regression — used for
                        the raw smoke pass that rust-orchestration.md (Pre-merge gate, smoke×2)
                        prescribes BEFORE the llvm-cov pass. Less prone to
                        instrumentation-induced timing flakes.
  docker-up             docker compose up -d --wait. Compose file + services from
                        flags / env / .env (nothing hardcoded; see Project section).
                        Pre-cleans stale bind-mounts per rust-orchestration.md (Disk hygiene — bind-mounts).
  docker-down           docker compose down -v. Always runs even on error so the
                        stack doesn't leak between gates.
  pre-merge-gate        Full pre-merge: cargo clean → docker-up → workspace-
                        regression --all-features → docker-down → ingest.
                        ORCHESTRATOR one-shot for CRs that touch e2e features.

Project + Crucible endpoint:
  Reads CRUCIBLE_PROJECT_KEY from <project-dir>/.env.
  Project path resolution: --project-dir > $RUST_CRUCIBLE_PROJECT_DIR > the git repo
  containing the current directory. No project is hardcoded — works in ANY Cargo repo.
  Posts to $CRUCIBLE_URL (default http://localhost:3849), v2 endpoints ONLY:
  /api/v2/agents/register|unregister, /api/v2/runs (codec junit),
  /api/v2/runs/parsed, /api/v2/runs/compile.

Examples:
  # Run targeted tests + ingest in one call
  rust-crucible.py test --crate nai_runtime --features test-support --agent CR-NAI-203-C5-RED

  # Run targeted tests without ingest (just see if they pass)
  rust-crucible.py test --crate nai_ast

  # Check compile + ingest as rustc compile errors
  rust-crucible.py check --crate nai_runtime --features test-support --agent CR-NAI-203-C5-RED

  # Clippy with warnings as errors + ingest
  rust-crucible.py clippy --crate nai_runtime --deny-warnings --agent CR-NAI-203-VERIFY

  # Full workspace coverage regression (orchestrator pre-merge gate)
  rust-crucible.py workspace-regression --agent vidushi --features all-features

  # Override project path
  rust-crucible.py register --project-dir /path/to/other/rust/repo --agent foo --phase RED
  RUST_CRUCIBLE_PROJECT_DIR=/path/to/other/rust/repo rust-crucible.py register --agent foo --phase RED
"""

import argparse
import atexit
import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

CRUCIBLE_URL = os.environ.get("CRUCIBLE_URL", "http://localhost:3849")
STALE_THRESHOLD_S = 60

# Parallel rustc cap for the FULL-workspace `--all-features` compiles (smoke-test,
# workspace-regression, pre-merge-gate, workspace clippy gate). Per-crate / `-p`-scoped
# commands keep the "12" cap — they compile one crate + cached deps and are light.
#
# ROOT CAUSE (measured 2026-07-03 — SUPERSEDES the earlier systemd-oomd theory):
# the full `--all-features` workspace gate that got reaped mid-compile was NOT an OOM
# kill of any kind. Live diagnostics proved it: user.slice `memory.events` oom_kill=0,
# systemd-oomd monitoring ZERO cgroups (ManagedOOMMemoryPressure=auto, limit 0), no
# kernel oom-killer entries. The real mechanism: UNCAPPED cargo (24 cores → 24 parallel
# rustc) spikes memory → aggressive zram thrash (vm.swappiness=150; ~11Gi zram used at
# rest) → the session-COUPLED background gate process is reaped under thrash. Capping
# COMPILE parallelism removes the spike. Capping TEST threads never helped — the death
# was in the COMPILE phase, before tests ran.
#
# MEASURED SAFE BAND (decoupled systemd units, min-free-RAM sampled; 24-core/31Gi box):
#   warm  j8 → 14.3Gi free /850s | j10 → 12.6Gi /490s | j12 → 11.9Gi /329s   (all success)
#   COLD  j10 (full clean, deps+tests recompiled) → 14.0Gi free /578s        (success; cold ≈ warm)
# Only uncapped j24 ever reaped. j10 chosen: cold-validated, ~8-10min gates, ~14Gi
# headroom, wide margin below j24. j12 is also proven-safe-warm (faster) — cold-validate
# before adopting. setdefault → override via CARGO_BUILD_JOBS env for a one-off.
WORKSPACE_BUILD_JOBS = "10"

# A gate lock older than this is treated as ABANDONED and reclaimed regardless of the
# holder pid — the portable backstop for an uncatchable SIGKILL/oomd whose pid was
# later recycled (see _acquire_gate_lock). No legit gate run approaches 2h.
STALE_LOCK_MAX_AGE_S = 7200


def _resolve_project_dir(arg_value):
    """Resolution order: --project-dir > $RUST_CRUCIBLE_PROJECT_DIR > git repo of CWD > CWD.

    No project is hardcoded — this script works in ANY Cargo project. The default is the
    git repository containing the current directory (`git rev-parse --show-toplevel`),
    falling back to the current directory when not inside a git repo. The `.env` holding
    CRUCIBLE_PROJECT_KEY must live at that resolved root.
    """
    if arg_value:
        return arg_value
    env_value = os.environ.get("RUST_CRUCIBLE_PROJECT_DIR")
    if env_value:
        return env_value
    r = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True
    )
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else os.getcwd()


def _read_env(project_dir):
    """Parse <project-dir>/.env into a dict (ignores blanks/comments). Empty if absent."""
    env = {}
    path = f"{project_dir}/.env"
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
    return env


def _project_key(project_dir):
    env = _read_env(project_dir)
    if "CRUCIBLE_PROJECT_KEY" not in env:
        sys.exit(f"[crucible] ERROR: CRUCIBLE_PROJECT_KEY not found in {project_dir}/.env")
    return env["CRUCIBLE_PROJECT_KEY"]


def _resolve_compose_file(arg_value, project_dir):
    """--compose-file > $RUST_CRUCIBLE_COMPOSE_FILE > CRUCIBLE_COMPOSE_FILE in .env > None.

    No compose path is hardcoded. None means: don't pass -f and let `docker compose`
    auto-discover compose.yaml / docker-compose.yml in the project root.
    """
    if arg_value:
        return arg_value
    env = os.environ.get("RUST_CRUCIBLE_COMPOSE_FILE")
    if env:
        return env
    return _read_env(project_dir).get("CRUCIBLE_COMPOSE_FILE")


def _resolve_services(arg_value, project_dir):
    """--services list > CRUCIBLE_DOCKER_SERVICES in .env (comma/space-separated) > None.

    No service set is hardcoded. None means: bring up ALL services in the compose file.
    """
    if arg_value:
        return arg_value
    raw = _read_env(project_dir).get("CRUCIBLE_DOCKER_SERVICES", "")
    parsed = [s for s in raw.replace(",", " ").split() if s]
    return parsed or None


def _request(method, path, payload=None):
    """JSON request to Crucible. Returns parsed JSON, or {ok:False,error} on HTTP/conn error."""
    req = urllib.request.Request(
        f"{CRUCIBLE_URL}{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    try:
        return json.loads(urllib.request.urlopen(req).read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        return {"ok": False, "error": f"HTTP {e.code}: {body}"}
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"connection failed: {e.reason} "
                                      f"(is Crucible running at {CRUCIBLE_URL}?)"}


def _post(path, payload):
    return _request("POST", path, payload)


def _get(path):
    return _request("GET", path)


def _patch(path, payload):
    return _request("PATCH", path, payload)


# ── §S1 shared TOON-AXI envelope module + toon codec (loaded by file path) ──

_TOON_MOD = None
_AXI_MOD = None

# §S2b cadence (CR-CRU-008) reused by gate-run's interim poll.
_GATE_POLL_CADENCE_S = 2.0
_GATE_POLL_TICK_S = 0.4


def _toon():
    """Lazily load the sibling clients/toon.py TOON codec by file path (the
    hyphen-named client is itself loaded by path, so toon.py is not on sys.path)."""
    global _TOON_MOD
    if _TOON_MOD is None:
        toon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "toon.py")
        spec = importlib.util.spec_from_file_location("rust_crucible_toon", toon_path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"could not load TOON codec at {toon_path}")
        _TOON_MOD = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_TOON_MOD)
    return _TOON_MOD


def _axi():
    """Lazily load the shared clients/_crucible_axi.py envelope module (§S1) by path."""
    global _AXI_MOD
    if _AXI_MOD is None:
        axi_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_crucible_axi.py")
        spec = importlib.util.spec_from_file_location("rust_crucible_axi_shared", axi_path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"could not load shared AXI module at {axi_path}")
        _AXI_MOD = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_AXI_MOD)
    return _AXI_MOD


_AXI_UNSET = _axi().AXI_UNSET


def _axi_context(project_dir, agent_id=None, cr=None, cycle_id=_AXI_UNSET):
    """§S1 envelope context: { projectKey, agentId?, cycleId?, wave, cr, track? }.
    Resolves the project_key from `.env`, then delegates to the shared
    _crucible_axi.axi_context so the output is byte-identical across clients."""
    return _axi().axi_context(
        _project_key(project_dir), agent_id=agent_id, cr=cr, cycle_id=cycle_id)


def _emit_axi(verb, ok, result_fields, context, warnings, legacy_line=None):
    """Write the §S1 TOON-AXI envelope (delegates to the shared module)."""
    return _axi().emit_axi(verb, ok, result_fields, context, warnings, legacy_line)


def _run_context():
    """CR-CRU-008 §S2 — env + git → run context for declared cycle linkage.

    Reads WORKFLOW_CYCLE_ID (int-coerced; invalid → omitted), WORKFLOW_CYCLE,
    WORKFLOW_WAVE and WORKFLOW_ROLE. When at least one is set, attaches
    git {branch, commit} from a cheap `git rev-parse` (tolerant of a
    non-repo cwd → omitted). Returns the context dict, or None when no
    workflow env is set. Same pattern as clients/bun-crucible.py.
    """
    context = {}
    cycle_id_raw = os.environ.get("WORKFLOW_CYCLE_ID")
    if cycle_id_raw is not None:
        try:
            context["cycleId"] = int(cycle_id_raw)
        except ValueError:
            pass
    cycle = os.environ.get("WORKFLOW_CYCLE")
    if cycle:
        context["cycle"] = cycle
    wave = os.environ.get("WORKFLOW_WAVE")
    if wave:
        context["wave"] = wave
    role = os.environ.get("WORKFLOW_ROLE")
    if role:
        context["orchestrator"] = role
    if not context:
        return None
    try:
        branch = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        if branch and commit:
            context["git"] = {"branch": branch, "commit": commit}
    except (OSError, subprocess.CalledProcessError):
        pass
    return context


def _ingest_context(cycle_id):
    """§S9 — the ingest payload's `context`: the env/git `_run_context()` enriched
    with the RESOLVED cycleId so the SERVER-recorded run carries the attach cycle
    (not just the printed envelope). Returns None only when there is nothing to attach."""
    context = _run_context() or {}
    if cycle_id is not None:
        context["cycleId"] = cycle_id
    return context or None


# ── §S9 — active-cycle resolution + register guard + ingest envelopes ────────


def _plans_path(project_dir):
    return f"/api/v2/projects/{_project_key(project_dir)}/plans"


def _open_plans(project_dir):
    resp = _get(_plans_path(project_dir))
    if not resp.get("ok"):
        sys.exit(f"[crucible] ERROR: could not list plans: {resp.get('error')}")
    return [p for p in resp.get("plans", []) if p.get("status") == "open"]


def _active_cycle_id(project_dir):
    """First ACTIVE cycle id among the project's OPEN plans, or None. Tolerant of any
    lookup failure — delegates the pure resolution to the shared module."""
    try:
        resp = _get(_plans_path(project_dir))
    except Exception:
        return None
    if not isinstance(resp, dict) or not resp.get("ok"):
        return None
    return _axi().resolve_active_cycle_id(resp.get("plans", []))


def _resolve_ingest_cycle(project_dir):
    """§S9 — resolve the cycle an --agent ingest attaches to. An explicit valid
    WORKFLOW_CYCLE_ID is authoritative; otherwise the open plan's single active
    cycle is auto-resolved. Returns (cycle_id, warnings, hard_error)."""
    raw = os.environ.get("WORKFLOW_CYCLE_ID")
    if raw is not None:
        try:
            return int(raw), [], False
        except ValueError:
            pass
    active = _active_cycle_id(project_dir)
    if active is not None:
        return active, [], False
    warning = {"code": "no-active-cycle", "detail": "no active cycle — activate one first"}
    return None, [warning], True


def _register_cycle_guard(project_dir):
    """§S9 — register mirrors the ingest hard-error: with WORKFLOW_CYCLE_ID unset AND
    a successfully-read open plan carrying no active cycle, registration hard-errors.
    A plans fetch that itself FAILS is NOT proof of "no active cycle", so register
    proceeds. Returns (hard_error, warnings)."""
    raw = os.environ.get("WORKFLOW_CYCLE_ID")
    if raw is not None:
        try:
            int(raw)
            return False, []
        except ValueError:
            pass
    resp = _get(_plans_path(project_dir))
    if not isinstance(resp, dict) or not resp.get("ok"):
        return False, []
    if _axi().resolve_active_cycle_id(resp.get("plans", [])) is not None:
        return False, []
    return True, [{"code": "no-active-cycle",
                   "detail": "no active cycle — activate one first"}]


def _emit_ingest_axi(verb, resp, project_dir, agent, cycle_id, warnings):
    """Emit the §S1 envelope for a SUCCESSFUL ingest verb: run{passed,failed,total}
    (from the SERVER-parsed response) + cycle-aware context."""
    s = resp.get("run", {}) or {}
    run = {"passed": s.get("passed"), "failed": s.get("failed"), "total": s.get("total")}
    context = _axi_context(project_dir, agent_id=agent, cycle_id=cycle_id)
    for w in warnings:
        print(f"warning: {w['code']} — {w['detail']}", file=sys.stderr)
    _emit_axi(verb, bool(resp.get("ok")),
              {"run": run, "help": _axi().HELP_STEPS.get(verb, ["status"])},
              context, warnings)


def _emit_ingest_hard_error(verb, project_dir, agent, warnings):
    """§S9 — emit the ok:false envelope (cycleId=null) when there is no active cycle
    to attach an ingest to. The run is NOT POSTed."""
    context = _axi_context(project_dir, agent_id=agent, cycle_id=None)
    for w in warnings:
        print(f"error: {w['code']} — {w['detail']}", file=sys.stderr)
    _emit_axi(verb, False, {}, context, warnings)


def _gate_lock_path(project_dir):
    """The STANDARD gate-lock path — the MAIN repo ROOT (parent of the common
    git dir), NOT inside .git, SHARED across all worktrees. Matches
    gate-lock.sh's lock_path(). Returns None if not resolvable."""
    try:
        gcd = subprocess.run(
            ["git", "-C", project_dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
            capture_output=True, text=True,
        ).stdout.strip()
        if not gcd:  # fallback for older git — resolve to absolute ourselves
            gd = subprocess.run(
                ["git", "-C", project_dir, "rev-parse", "--git-common-dir"],
                capture_output=True, text=True,
            ).stdout.strip()
            gcd = gd if os.path.isabs(gd) else os.path.abspath(os.path.join(project_dir, gd))
    except Exception:
        return None
    if not gcd:
        return None
    return os.path.join(os.path.dirname(gcd), "nai-gate.lock")


# ── Gate-lock lifecycle (crucible OWNS the lock file) ─────────────────────────
# crucible CREATES the gate lock (with its own pid) at the start of a gated run
# and REMOVES it on finish AND on a catchable kill (SIGTERM/SIGINT/SIGHUP) +
# atexit. The ORCHESTRATOR still does the check/wait/escalate (gate-lock.sh
# wait-free) before firing us — this owns only the lock FILE's lifecycle.
# SIGKILL/oomd can't be caught → in-process self-cleanup is IMPOSSIBLE; the NEXT run
# reclaims a stale lock (holder pid dead, OR pid recycled to a non-cargo process, OR
# lock age > STALE_LOCK_MAX_AGE_S). So an oomd-killed run never permanently wedges it.
_HELD_GATE_LOCK = None  # path of a gate lock THIS process created (to clean up)


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True   # exists, just not ours to signal
    except OSError:
        return False
    return True


def _pid_is_gate_runner(pid):
    """True only if `pid` is alive AND looks like a cargo/nextest/crucible process.
    Guards against PID REUSE: after an uncatchable SIGKILL/oomd the holder pid is
    dead, but the OS may recycle it to an unrelated process that `_pid_alive` would
    see as 'live' → a false REFUSE that wedges the gate. Linux /proc; on non-Linux
    (or if /proc is unreadable) it falls back to plain liveness."""
    if not _pid_alive(pid):
        return False
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmd = f.read().replace(b"\0", b" ").decode("utf-8", "replace").lower()
    except OSError:
        return True   # can't introspect (non-Linux / perms) → trust liveness
    if not cmd.strip():
        return True   # kernel thread / empty cmdline → don't second-guess liveness
    return any(tok in cmd for tok in ("cargo", "nextest", "rust-crucible", "llvm-cov"))


def _lock_field(path, key):
    try:
        for ln in open(path):
            if ln.startswith(key + "="):
                return ln.split("=", 1)[1].strip()
    except OSError:
        pass
    return None


def _release_gate_lock(*_a):
    """Remove the gate lock THIS process created. Idempotent + signal-safe."""
    global _HELD_GATE_LOCK
    path, _HELD_GATE_LOCK = _HELD_GATE_LOCK, None
    if path:
        try:
            os.remove(path)
        except OSError:
            pass


def _gate_lock_signal(signum, _frame):
    _release_gate_lock()
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)   # re-raise so the exit status reflects the kill


def _acquire_gate_lock(project_dir, agent):
    """ATOMICALLY create the gate lock with OUR pid at the start of a gated run;
    register cleanup (atexit + SIGTERM/SIGINT/SIGHUP) so it is removed on exit or a
    catchable kill. If a lock is ALREADY present with a LIVE holder, REFUSE — do
    NOT start a second concurrent regression/smoke run (guards against two
    instances in the same CR/track). A stale lock (holder pid dead) is reclaimed.
    The orchestrator's wait-free does the waiting/escalation; crucible is the hard
    atomic guard. Returns True to PROCEED, False if REFUSED (caller MUST abort)."""
    global _HELD_GATE_LOCK
    path = _gate_lock_path(project_dir)
    if not path:
        return True   # can't resolve a lock path → run unlocked (degraded, don't block)
    if os.path.exists(path):
        hp = _lock_field(path, "pid")
        ep = _lock_field(path, "epoch")
        age = (int(time.time()) - int(ep)) if (ep and ep.isdigit()) else None
        holder_live = bool(hp and hp.isdigit() and _pid_is_gate_runner(int(hp)))
        too_old = age is not None and age > STALE_LOCK_MAX_AGE_S
        if holder_live and not too_old:
            print(f"[crucible] REFUSING to start — a gate lock is already present at "
                  f"{path} (owner={_lock_field(path,'owner') or '?'}, "
                  f"cr={_lock_field(path,'cr') or '?'}, pid={hp} alive). Another "
                  f"regression/smoke run is in progress — the orchestrator should "
                  f"wait-free and retry. Not starting a second concurrent instance.")
            return False
        why = (f"holder pid {hp} dead or recycled (not a cargo/nextest process)"
               if not holder_live else
               f"lock age {age}s exceeds max {STALE_LOCK_MAX_AGE_S}s — abandoned")
        print(f"[crucible] reclaiming stale gate lock ({why})")
        try:
            os.remove(path)
        except OSError:
            pass
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        print("[crucible] REFUSING to start — lost the create race; another run just started.")
        return False
    except OSError as e:
        print(f"[crucible] WARNING: could not create gate lock ({e}); running unlocked.")
        return True   # degraded — a lock-fs error must not hard-block the run
    cr = re.search(r"CR-NAI-\d+", agent or "")
    with os.fdopen(fd, "w") as f:
        f.write(f"owner={agent}\ncr={cr.group(0) if cr else ''}\n"
                f"pid={os.getpid()}\nepoch={int(time.time())}\n"
                f"started={time.strftime('%Y-%m-%d %H:%M:%S')}\nrunner={agent}\n")
    _HELD_GATE_LOCK = path
    atexit.register(_release_gate_lock)
    for _sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        try:
            signal.signal(_sig, _gate_lock_signal)
        except (OSError, ValueError, RuntimeError):
            pass
    print(f"[crucible] gate lock created at {path} (owner={agent}, pid={os.getpid()})")
    return True


def _run_logged(cmd, cwd, env, log_path):
    """Run `cmd`. If `log_path` is set, capture the COMBINED stdout+stderr (merged
    in order), write it to `log_path`, and echo it to this process's stdout so the
    caller still sees the run. Returns the `subprocess.CompletedProcess`.

    Used for the streaming run commands (test / smoke-test / workspace-regression)
    so an agent can read the full run output back from a file for debugging — the
    streamed-to-terminal output is otherwise lost.
    """
    if not log_path:
        # No log requested — stream live (interactive), current behaviour.
        return subprocess.run(cmd, cwd=cwd, env=env)
    result = subprocess.run(
        cmd, cwd=cwd, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    out = result.stdout or ""
    try:
        with open(log_path, "w") as f:
            f.write(out)
        print(f"[crucible] run log → {log_path} ({len(out)} bytes)")
    except OSError as e:
        print(f"[crucible] WARN: could not write run log to {log_path}: {e}")
    sys.stdout.write(out)  # echo so the run is still visible on the terminal
    return result


def cmd_register(args):
    """Register / heartbeat. §S9: no active cycle (and no WORKFLOW_CYCLE_ID override)
    is a HARD ERROR — the agent must never come online against an untracked plan."""
    project_dir = _resolve_project_dir(args.project_dir)
    hard_error, warnings = _register_cycle_guard(project_dir)
    if hard_error:
        for w in warnings:
            print(f"error: {w['code']} — {w['detail']}", file=sys.stderr)
        _emit_axi("register", False,
                  {"agent": args.agent, "help": _axi().HELP_STEPS["register"]},
                  _axi_context(project_dir, agent_id=args.agent, cycle_id=None),
                  warnings)
        return 1
    payload = {
        "agentId": args.agent,
        "projectKey": _project_key(project_dir),
        "status": "online",
        "message": args.message or f"Starting {args.phase} phase",
        # displayName MUST go inside `identity` — top-level is ignored by v2.
        "identity": {"displayName": args.agent, "source": "openclaw"},
    }
    resp = _post("/api/v2/agents/register", payload)
    ok = bool(resp.get("ok", False))
    legacy = f"register: ok={resp.get('ok', False)} agent={args.agent} phase={args.phase}"
    _emit_axi("register", ok,
              {"agent": args.agent, "help": _axi().HELP_STEPS["register"]},
              _axi_context(project_dir, agent_id=args.agent), [], legacy)
    return 0 if ok else 1


def cmd_unregister(args):
    project_dir = _resolve_project_dir(args.project_dir)
    resp = _post(
        "/api/v2/agents/unregister",
        {"agentId": args.agent, "projectKey": _project_key(project_dir)},
    )
    ok = bool(resp.get("ok", False))
    legacy = f"unregister: ok={resp.get('ok', False)} agent={args.agent}"
    _emit_axi("unregister", ok,
              {"agent": args.agent, "help": _axi().HELP_STEPS["unregister"]},
              _axi_context(project_dir, agent_id=args.agent), [], legacy)
    return 0 if ok else 1


def _remove_agent_silent(project_dir, agent_id):
    """CR-CRU-008 §S4 anti-ghost cleanup for a gated run: remove the agent row
    WITHOUT journaling a lifecycle event (the run's ingest was the implicit
    registration — a plain unregister would journal an 'unregistered' event and
    bury the run just ingested). Best-effort: never raises, never pollutes the
    run verdict or stdout. Mirrors clients/bun-crucible.py's _remove_agent_silent."""
    try:
        _post(
            "/api/v2/agents/unregister",
            {"agentId": agent_id, "projectKey": _project_key(project_dir), "silent": True},
        )
    except Exception:
        pass


def _clean_stale_junit(project_dir, profile=None):
    now = time.time()
    paths = [
        f"{project_dir}/target/nextest/ci/junit.xml",
        f"{project_dir}/target/nextest/default/junit.xml",
    ]
    if profile and profile not in ("ci", "default"):
        paths.append(f"{project_dir}/target/nextest/{profile}/junit.xml")
    for p in paths:
        if os.path.exists(p):
            age = now - os.path.getmtime(p)
            if age > STALE_THRESHOLD_S:
                print(f"[crucible] removed stale junit ({int(age)}s): {p}")
                os.remove(p)


def cmd_auto_ingest(args):
    """Detect: junit XML present → ingest tests. Absent → cargo check stderr → ingest compile."""
    project_dir = _resolve_project_dir(args.project_dir)
    _clean_stale_junit(project_dir)
    ci = f"{project_dir}/target/nextest/ci/junit.xml"
    default = f"{project_dir}/target/nextest/default/junit.xml"
    junit_path = ci if os.path.exists(ci) else (default if os.path.exists(default) else None)

    if junit_path:
        # §S9 — resolve/attach the active cycle BEFORE the POST so the ingested run
        # carries the resolved cycleId in the SERVER record; no active cycle → hard
        # error, never a cycleId=null orphan.
        cycle_id, warnings, hard_error = _resolve_ingest_cycle(project_dir)
        if hard_error:
            _emit_ingest_hard_error("auto-ingest", project_dir, args.agent, warnings)
            return 1
        resp = _ingest_junit_axi(project_dir, args.agent, junit_path, tier="unit",
                                 context=_ingest_context(cycle_id))
        _emit_ingest_axi("auto-ingest", resp, project_dir, args.agent,
                         cycle_id, warnings)
        s = resp.get("run", {}) or {}
        return 0 if (resp.get("ok") and (s.get("failed") or 0) == 0) else 1

    # No junit — compile failure path
    cmd = ["cargo", "check", "-p", args.crate]
    if args.features:
        cmd += ["--features", args.features]
    print(f"[crucible] no junit — running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=project_dir)
    err_count = result.stderr.count("error[E")
    warn_count = result.stderr.count("warning:")
    payload = {
        "projectKey": _project_key(project_dir),
        "format": "rustc",
        "errors": result.stderr,
        "agentId": args.agent,
    }
    context = _run_context()
    if context:
        payload["context"] = context
    resp = _post("/api/v2/runs/compile", payload)
    print(
        f"ingest compile: ok={resp.get('ok')} "
        f"errors={err_count} warnings={warn_count} cargo_exit={result.returncode}"
    )
    return 0 if resp.get("ok") else 1


def cmd_regression_ingest(args):
    """Gated regression run — wraps the ingest body in an anti-ghost silent
    cleanup (CR-CRU-008 §S4): even a failed/raising run removes the implicitly
    registered agent, and never touches the retired /api/agents/remove shim."""
    project_dir = _resolve_project_dir(args.project_dir)
    try:
        return _regression_ingest_run(args)
    finally:
        if getattr(args, "agent", None):
            _remove_agent_silent(project_dir, args.agent)


def _regression_ingest_run(args):
    """Full regression: cargo clean → llvm-cov nextest → parse junit + lcov → /api/v2/runs/parsed."""
    project_dir = _resolve_project_dir(args.project_dir)
    crates = [c.strip() for c in args.crates.split(",") if c.strip()]

    for c in crates:
        subprocess.run(["cargo", "clean", "-p", c], cwd=project_dir, capture_output=True)
    print(f"[crucible] cleaned: {', '.join(crates)}")

    env = os.environ.copy()
    env.setdefault("CARGO_BUILD_JOBS", "12")  # dev machine cap, per rust-orchestration.md
    cmd = ["cargo", "llvm-cov", "--failure-mode", "all", "nextest"]  # tolerate killed-subprocess corrupt .profraw (CR-385)
    for c in crates:
        cmd += ["-p", c]
    cmd += [
        "--lcov", "--output-path", "target/lcov.info",
        "-P", "ci", "--ignore-run-fail",
    ]
    if args.features:
        cmd += ["--features", args.features]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=project_dir, env=env)
    print(f"[crucible] llvm-cov nextest exit={result.returncode}")

    junit_path = f"{project_dir}/target/nextest/ci/junit.xml"
    if not os.path.exists(junit_path):
        print("[crucible] ERROR: no junit.xml after llvm-cov nextest")
        return 1

    root = ET.parse(junit_path).getroot()
    tree_nodes = []
    total = passed = failed = 0
    duration_ms = 0
    # A JUnit root can be <testsuites> (nextest's wrapper) OR a bare
    # <testsuite> — handle both, like the server's junit codec.
    suites = ([root] if root.tag == "testsuite" else []) + root.findall(".//testsuite")
    for suite in suites:
        children = []
        suite_fail = False
        for tc in suite.findall("testcase"):
            tc_time = int(float(tc.get("time", 0)) * 1000)
            fail = tc.find("failure") is not None or tc.find("error") is not None
            status = "fail" if fail else "pass"
            if fail:
                failed += 1
                suite_fail = True
            else:
                passed += 1
            total += 1
            duration_ms += tc_time
            children.append({
                "name": tc.get("name", "?"),
                "status": status,
                "duration_ms": tc_time,
            })
        tree_nodes.append({
            "name": suite.get("name", "?"),
            "status": "fail" if suite_fail else "pass",
            "children": children,
        })

    summary = {
        "total": total, "passed": passed, "failed": failed,
        "pending": 0, "duration_ms": duration_ms,
    }

    coverage = None
    lcov_path = f"{project_dir}/target/lcov.info"
    if os.path.exists(lcov_path):
        lf = lh = ff = fh = 0
        with open(lcov_path) as f:
            for line in f:
                if line.startswith("LF:"):
                    lf += int(line[3:].strip())
                elif line.startswith("LH:"):
                    lh += int(line[3:].strip())
                elif line.startswith("FNF:"):
                    ff += int(line[4:].strip())
                elif line.startswith("FNH:"):
                    fh += int(line[4:].strip())
        coverage = {
            "lines": {
                "total": lf, "covered": lh,
                "percent": round(lh / lf * 100, 1) if lf else 0,
            },
            "functions": {
                "total": ff, "covered": fh,
                "percent": round(fh / ff * 100, 1) if ff else 0,
            },
        }

    payload = {
        "projectKey": _project_key(project_dir),
        "agentId": args.agent,
        "summary": summary,
        "tree": tree_nodes,
    }
    if coverage:
        payload["coverage"] = coverage
    payload["tier"] = "regression"
    context = _run_context()
    if context:
        payload["context"] = context

    resp = _post("/api/v2/runs/parsed", payload)
    cov_line = ""
    if coverage:
        cov_line = (
            f" lines={coverage['lines']['percent']}% "
            f"funcs={coverage['functions']['percent']}%"
        )
    print(
        f"regression: ok={resp.get('ok')} "
        f"passed={passed} failed={failed} total={total}{cov_line}"
    )
    return 0 if resp.get("ok") else 1


def _resolve_junit_path(project_dir, profile=None):
    """The freshest junit xml path — profile-aware (nextest writes to
    target/nextest/<profile>/junit.xml), or None if none present."""
    candidates = []
    if profile:
        candidates.append(f"{project_dir}/target/nextest/{profile}/junit.xml")
    candidates += [
        f"{project_dir}/target/nextest/ci/junit.xml",
        f"{project_dir}/target/nextest/default/junit.xml",
    ]
    return next((p for p in candidates if os.path.exists(p)), None)


def _ingest_junit_axi(project_dir, agent_id, junit_path, tier=None, context=None):
    """Ingest a junit XML to /api/v2/runs (server-side codec=junit parse) and return
    the parsed response dict (the caller emits the §S1 envelope). The human-readable
    ingest line is interactive-only (stderr) — stdout is the machine channel."""
    payload = {
        "projectKey": _project_key(project_dir),
        "codec": "junit",
        "dataPath": junit_path,
        "agentId": agent_id,
    }
    if tier:
        payload["tier"] = tier
    if context:
        payload["context"] = context
    resp = _post("/api/v2/runs", payload)
    s = resp.get("run", {}) or {}
    print(
        f"ingest junit: ok={resp.get('ok')} "
        f"passed={s.get('passed')} failed={s.get('failed')} total={s.get('total')}"
        + (f" error={resp.get('error')}" if resp.get("error") else ""),
        file=sys.stderr,
    )
    return resp


def _ingest_rustc_stderr(project_dir, agent_id, stderr_text, kind="check"):
    """Helper: ingest rustc / clippy stderr to /api/v2/runs/compile."""
    err_count = stderr_text.count("error[E") + stderr_text.count("error: ")
    warn_count = stderr_text.count("warning:")
    payload = {
        "projectKey": _project_key(project_dir),
        "format": "rustc",
        "errors": stderr_text,
        "agentId": agent_id,
    }
    context = _run_context()
    if context:
        payload["context"] = context
    resp = _post("/api/v2/runs/compile", payload)
    print(
        f"ingest compile ({kind}): ok={resp.get('ok')} "
        f"errors={err_count} warnings={warn_count}",
        file=sys.stderr,
    )
    return 0 if resp.get("ok") else 1


def cmd_test(args):
    """cargo nextest run -p <crate> [--features ...] [--filter EXPR] -P <profile>.
    If --agent passed, also auto-ingest junit afterwards."""
    project_dir = _resolve_project_dir(args.project_dir)
    _clean_stale_junit(project_dir, args.profile)
    cmd = ["cargo", "nextest", "run", "-p", args.crate, "-P", args.profile]
    if args.features:
        cmd += ["--features", args.features]
    if args.no_fail_fast:
        cmd += ["--no-fail-fast"]
    if args.test:
        cmd += ["--test", args.test]
    if args.filter:
        cmd += ["-E", args.filter]
    env = os.environ.copy()
    env.setdefault("CARGO_BUILD_JOBS", "12")
    print(f"[crucible] running: {' '.join(cmd)}")
    result = _run_logged(cmd, project_dir, env, getattr(args, "log", None))
    print(f"[crucible] cargo nextest exit={result.returncode}", file=sys.stderr)
    if args.agent:
        # Test may have failed; ingest result regardless (junit captures fail state).
        # Profile-aware: nextest writes junit to target/nextest/<profile>/junit.xml.
        junit_path = _resolve_junit_path(project_dir, args.profile)
        if junit_path:
            # §S9 — resolve the cycle BEFORE the POST so a no-active-cycle run
            # hard-errors WITHOUT ever ingesting a cycleId=null orphan.
            cycle_id, warnings, hard_error = _resolve_ingest_cycle(project_dir)
            if hard_error:
                _emit_ingest_hard_error("test", project_dir, args.agent, warnings)
                return 1
            resp = _ingest_junit_axi(project_dir, args.agent, junit_path, tier="unit",
                                     context=_ingest_context(cycle_id))
            _emit_ingest_axi("test", resp, project_dir, args.agent, cycle_id, warnings)
            s = resp.get("run", {}) or {}
            if (s.get("failed") or 0) > 0:
                return 1
            return 0 if resp.get("ok") else 1
        # If tests didn't even compile, capture cargo check stderr → ingest compile
        # and emit an ok:false test envelope (no junit run to report).
        check_cmd = ["cargo", "check", "-p", args.crate, "--tests"]
        if args.features:
            check_cmd += ["--features", args.features]
        check_result = subprocess.run(check_cmd, capture_output=True, text=True,
                                      cwd=project_dir, env=env)
        _ingest_rustc_stderr(project_dir, args.agent, check_result.stderr, kind="test-compile")
        _emit_axi("test", False, {"help": _axi().HELP_STEPS["test"]},
                  _axi_context(project_dir, agent_id=args.agent), [])
        return result.returncode or 1
    return result.returncode


def cmd_check(args):
    """cargo check -p <crate> [--features ...]. If --agent passed, ingest stderr."""
    project_dir = _resolve_project_dir(args.project_dir)
    cmd = ["cargo", "check", "-p", args.crate]
    if args.tests:
        cmd += ["--tests"]
    if args.features:
        cmd += ["--features", args.features]
    env = os.environ.copy()
    env.setdefault("CARGO_BUILD_JOBS", "12")
    print(f"[crucible] running: {' '.join(cmd)}", file=sys.stderr)
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=project_dir, env=env)
    err_count = result.stderr.count("error[E") + result.stderr.count("error: ")
    warn_count = result.stderr.count("warning:")
    print(f"[crucible] cargo check exit={result.returncode} "
          f"errors={err_count} warnings={warn_count}", file=sys.stderr)
    ok = result.returncode == 0
    # §S2/§S13/§S15 — the compile gate returns the §S1 envelope on BOTH clean and
    # error compile; a failing check ingests the rustc errors (with run context).
    if args.agent and not ok:
        _ingest_rustc_stderr(project_dir, args.agent, result.stderr, kind="check")
    legacy = f"check: ok={ok} exit={result.returncode}"
    _emit_axi("check", ok,
              {"exit": result.returncode, "help": _axi().HELP_STEPS["check"]},
              _axi_context(project_dir, agent_id=args.agent), [], legacy)
    return 0 if ok else (result.returncode or 1)


def cmd_clippy(args):
    """cargo clippy -p <crate> [--features ...] [--deny-warnings]. If --agent, ingest stderr."""
    project_dir = _resolve_project_dir(args.project_dir)
    cmd = ["cargo", "clippy", "-p", args.crate]
    if args.tests:
        cmd += ["--tests"]
    if args.features:
        cmd += ["--features", args.features]
    if args.deny_warnings:
        cmd += ["--", "-D", "warnings"]
    env = os.environ.copy()
    env.setdefault("CARGO_BUILD_JOBS", "12")
    print(f"[crucible] running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=project_dir, env=env)
    err_count = result.stderr.count("error[E") + result.stderr.count("error: ")
    warn_count = result.stderr.count("warning:")
    print(f"[crucible] cargo clippy exit={result.returncode} errors={err_count} warnings={warn_count}")
    if args.agent:
        return _ingest_rustc_stderr(project_dir, args.agent, result.stderr, kind="clippy")
    return result.returncode


def cmd_workspace_clippy(args):
    """Standalone workspace clippy — the pre-merge gate's fail-fast step 1, runnable
    on its own (one-pass debt discovery / hotfix verification without the coverage
    run). Same invocation, same ingest."""
    project_dir = _resolve_project_dir(args.project_dir)
    return _clippy_workspace_gate(project_dir, args.agent)


def _clippy_workspace_gate(project_dir, agent):
    """Workspace `cargo clippy --all-targets --all-features -- -D warnings` gate step.

    Runs as the FIRST, fail-fast step of the pre-merge gate (before the expensive
    llvm-cov coverage run). With `-D warnings` every clippy lint becomes a hard
    error, so a non-zero return aborts the gate. This closes the gap that let
    CR-NAI-297 ship a `needless_return` (CR-200 geo) + `nonminimal_bool` / unused
    imports through a green gate: nextest + llvm-cov never enforce clippy lints, so
    a crate could be test-green yet fail `clippy -D warnings` (and break any
    downstream crate built with `-D warnings`). Ingests stderr to Crucible if `agent`.
    """
    env = os.environ.copy()
    env.setdefault("CARGO_BUILD_JOBS", WORKSPACE_BUILD_JOBS)  # full-workspace compile — see constant
    cmd = ["cargo", "clippy", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings"]
    print(f"[crucible:clippy-gate] running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=project_dir, env=env)
    err_count = result.stderr.count("error[E") + result.stderr.count("error: ")
    warn_count = result.stderr.count("warning:")
    print(f"[crucible:clippy-gate] cargo clippy exit={result.returncode} "
          f"errors={err_count} warnings={warn_count}")
    if agent:
        _ingest_rustc_stderr(project_dir, agent, result.stderr, kind="clippy")
    if result.returncode != 0:
        tail = "\n".join(result.stderr.strip().splitlines()[-25:])
        print(f"[crucible:clippy-gate] ⛔ ABORT — clippy -D warnings failed:\n{tail}")
    return result.returncode


def _disk_precheck(label, min_free_g=50):
    """rust-orchestration.md (Disk hygiene) Disk Hygiene guard.

    A full `--all-features` / llvm-cov workspace run can leave 100-200G+ of `target/`
    artifacts. CR-245 drove `/home` to disk-full mid-run; CR-255 left a root-owned
    docker bind-mount orphan when a worktree finish couldn't reclaim it. Surface disk
    state BEFORE the heavy build and nudge recovery when free space is low, so we catch
    the problem before ENOSPC rather than after. Best-effort + non-fatal (informational).
    """
    try:
        df = subprocess.run(["df", "-BG", "/home"], capture_output=True, text=True)
        line = df.stdout.strip().splitlines()[-1] if df.stdout.strip() else ""
    except Exception:
        return None
    print(f"[crucible:{label}] disk /home: {line}")
    parts = line.split()
    free_g = int(parts[3].rstrip("G")) if len(parts) >= 4 and parts[3].rstrip("G").isdigit() else None
    if free_g is not None and free_g < min_free_g:
        print(f"[crucible:{label}] ⚠ LOW DISK — {free_g}G free on /home (<{min_free_g}G). A full "
              f"--all-features coverage run can need 100-200G+ of target artifacts; you may hit "
              f"ENOSPC mid-run. Reclaim FIRST (rust-orchestration.md (Disk hygiene), orchestrator-only):")
        print("    cargo sweep --time 7      # drop target/ artifacts older than 7 days")
        print("    cargo cache --autoclean   # ~/.cargo registry hygiene")
        print("    # btrfs/snapper pinning freed space? sudo snapper -c home list && delete old snapshots")
    return free_g


def _disk_free_g(mount="/home"):
    """Free GB on `mount` as an int, or None if undeterminable."""
    try:
        df = subprocess.run(["df", "-BG", mount], capture_output=True, text=True)
        parts = df.stdout.strip().splitlines()[-1].split()
        v = parts[3].rstrip("G")
        return int(v) if v.isdigit() else None
    except Exception:
        return None


def _disk_guard(label, project_dir, need_free_g):
    """Pre-heavy-run disk DECISION (user-directed 2026-05-31). Call AFTER the caller's
    `cargo clean`, so the measurement reflects real post-clean headroom rather than a
    false alarm from a full target/ that is about to be wiped. If free < need_free_g,
    attempt best-effort reclaim (cargo cache registry hygiene) and re-measure; if STILL
    short, return False so the caller HARD-ABORTS before ENOSPC wastes a long build
    (CR-245). Returns True when it is safe to proceed.

    btrfs/snapper note: on a snapshotted /home, `cargo clean` frees extents that stay
    pinned by snapshots until they roll/are deleted (root-only), so df can under-report
    reclaimable space. The guard keys on df free (the true ENOSPC constraint) and points
    at snapper in its abort message.
    """
    free = _disk_free_g()
    if free is None:
        print(f"[crucible:{label}] disk check unavailable — proceeding")
        return True
    print(f"[crucible:{label}] free /home: {free}G (need >= {need_free_g}G)")
    if free >= need_free_g:
        return True
    print(f"[crucible:{label}] low disk — best-effort reclaim (cargo cache --autoclean)")
    subprocess.run(["cargo", "cache", "--autoclean"], cwd=project_dir, capture_output=True)
    free2 = _disk_free_g()
    print(f"[crucible:{label}] free after reclaim: {free2}G")
    if free2 is not None and free2 >= need_free_g:
        return True
    print(
        f"[crucible:{label}] ⛔ ABORT — {free2}G free on /home < {need_free_g}G needed for a full\n"
        f"  --all-features coverage / e2e run (CR-245 ENOSPC guard). Reclaim FIRST, then re-run:\n"
        f"    cargo sweep --time 3        # drop stale target artifacts\n"
        f"    cargo cache --autoclean     # ~/.cargo registry hygiene\n"
        f"    sudo snapper -c home list   # btrfs snapshots pin freed extents (root-only)\n"
        f"  (lower the floor with --min-free-g N on a smaller disk.)"
    )
    return False


def _reclaim_disk(project_dir, label):
    """Post-heavy-run reclaim (user-directed 2026-05-31): `cargo clean` to release the
    freshly-built --all-features + llvm-cov target/ (~100-200G) on completion of a full
    regression / e2e gate. On btrfs/snapper the files are removed immediately (and won't
    be re-snapshotted), though df may lag until snapshots roll."""
    before = _disk_free_g()
    print(f"[crucible:{label}] post-run reclaim: cargo clean")
    subprocess.run(["cargo", "clean"], cwd=project_dir, capture_output=True)
    after = _disk_free_g()
    if before is not None and after is not None:
        delta = after - before
        if delta > 0:
            print(f"[crucible:{label}] reclaimed ~{delta}G — free now {after}G")
        else:
            print(f"[crucible:{label}] target/ cleaned; df free {after}G "
                  f"(btrfs/snapper may pin freed extents until snapshots roll)")


def cmd_smoke_test(args):
    """Raw workspace nextest run (no llvm-cov). Per rust-orchestration.md (Pre-merge gate, smoke×2).

    Steps: (optional cargo clean) → (optional docker-up) → cargo nextest run
    --workspace [--all-features|--features X] -P <profile> --no-fail-fast →
    parse junit → /api/v2/runs with `codec: junit`. NO coverage.
    """
    project_dir = _resolve_project_dir(args.project_dir)
    # crucible OWNS the gate-lock FILE: refuse to start if one is already present
    # (no double-runs in a CR/track), else create it + auto-remove on exit/kill.
    if not _acquire_gate_lock(project_dir, getattr(args, "agent", None)):
        return 75  # gate-locked — another regression/smoke run is in progress (retry)

    if args.clean:
        print("[smoke-test] cargo clean (workspace)")
        subprocess.run(["cargo", "clean"], cwd=project_dir, capture_output=True)

    # Disk DECISION before the heavy --all-features e2e/smoke run (user-directed
    # 2026-05-31): measured AFTER any clean. Hard-abort (rc 2) if a full run can't
    # fit, rather than ENOSPC mid-build. No post-run reclaim here — smoke / docker-
    # e2e deliberately reuses the --all-features build across runs (unless --clean).
    if args.all_features:
        if not _disk_guard("smoke-test", project_dir, getattr(args, "min_free_g", 80)):
            return 2

    docker_brought_up = False
    if args.with_docker:
        up_args = argparse.Namespace(
            project_dir=args.project_dir,
            compose_file=args.compose_file,
            no_wait=True,
            # threaded from the caller so a non-kafka compose (qdrant/postgis e2e)
            # can bring up ITS services instead of the .env kafka CRUCIBLE_DOCKER_SERVICES.
            services=getattr(args, "services", None),
            all_services=getattr(args, "all_services", False),
        )
        rc = cmd_docker_up(up_args)
        if rc != 0:
            print("[smoke-test] docker-up failed — aborting.")
            return rc
        docker_brought_up = True

    smoke_rc = 1
    try:
        _clean_stale_junit(project_dir)
        env = os.environ.copy()
        env.setdefault("CARGO_BUILD_JOBS", WORKSPACE_BUILD_JOBS)  # full-workspace compile — see constant
        if args.with_docker:
            # docker-e2e: hand the e2e tests the project's `.env` service environment
            # (REDIS_URL, broker/DB URLs, etc.) so container-dependent tests find the
            # compose-published services this gate just brought up. The docker-FREE
            # `-P ci` gate does NOT do this → service-dependent tests skip cleanly.
            # Real process env still wins (setdefault). General pattern, not redis-specific.
            for _k, _v in _read_env(project_dir).items():
                env.setdefault(_k, _v)
        cmd = ["cargo", "nextest", "run", "--workspace"]
        if args.all_features:
            cmd += ["--all-features"]
        elif args.features:
            cmd += ["--features", args.features]
        cmd += ["-P", args.profile, "--no-fail-fast"]
        print(f"[smoke-test] running: {' '.join(cmd)}")
        result = subprocess.run(cmd, cwd=project_dir, env=env)
        print(f"[smoke-test] cargo nextest exit={result.returncode}")

        # Ingest JUnit regardless of exit code (failed tests still report).
        ci_junit = f"{project_dir}/target/nextest/{args.profile}/junit.xml"
        default_junit = f"{project_dir}/target/nextest/default/junit.xml"
        junit_path = ci_junit if os.path.exists(ci_junit) else (
            default_junit if os.path.exists(default_junit) else None
        )
        if not junit_path:
            print("[smoke-test] no junit.xml found — nothing to ingest")
            return 1

        payload = {
            "projectKey": _project_key(project_dir),
            "codec": "junit",
            "dataPath": junit_path,
            "agentId": args.agent,
        }
        context = _run_context()
        if context:
            payload["context"] = context
        resp = _post("/api/v2/runs", payload)
        s = resp.get("run", {})
        print(
            f"smoke-test: ok={resp.get('ok')} "
            f"passed={s.get('passed')} failed={s.get('failed')} total={s.get('total')}"
        )
        smoke_rc = 0 if (resp.get("ok") and s.get("failed", 0) == 0) else 1
    finally:
        if docker_brought_up:
            down_args = argparse.Namespace(
                project_dir=args.project_dir,
                compose_file=args.compose_file,
            )
            cmd_docker_down(down_args)

    return smoke_rc


def cmd_workspace_regression(args):
    """Full workspace coverage regression — orchestrator pre-merge gate path.

    Steps: cargo clean → DISK GUARD (decide/abort) → cargo llvm-cov nextest --workspace
    [--all-features|--features X] -P <profile> [--ignore-run-fail] --lcov --output-path
    <lcov-output> → parse junit + lcov → /api/v2/runs/parsed → POST-RUN RECLAIM.

    Disk hygiene (user-directed 2026-05-31): clean FIRST, then `_disk_guard` measures
    real post-clean headroom and HARD-ABORTS (rc 2) if a full coverage run can't fit —
    failing fast instead of ENOSPC mid-build (CR-245). On completion (any path) the
    fresh target/ is reclaimed via `cargo clean` unless --keep-target is passed.
    """
    project_dir = _resolve_project_dir(args.project_dir)
    # crucible OWNS the gate-lock FILE: refuse to start if one is already present
    # (no double-runs), else create it + auto-remove on exit/kill.
    if not _acquire_gate_lock(project_dir, getattr(args, "agent", None)):
        return 75  # gate-locked — another regression/smoke run is in progress (retry)

    print("[crucible] cargo clean (workspace)")
    subprocess.run(["cargo", "clean"], cwd=project_dir, capture_output=True)

    if not _disk_guard("workspace-regression", project_dir, getattr(args, "min_free_g", 80)):
        return 2

    try:
        return _workspace_regression_run(args, project_dir)
    finally:
        if not getattr(args, "keep_target", False):
            _reclaim_disk(project_dir, "workspace-regression")


def _workspace_regression_run(args, project_dir):
    """Build + run + ingest body (wrapped by cmd_workspace_regression's disk guard +
    post-run reclaim). Assumes the workspace was already `cargo clean`ed."""
    env = os.environ.copy()
    env.setdefault("CARGO_BUILD_JOBS", WORKSPACE_BUILD_JOBS)  # full-workspace compile — see constant
    # --failure-mode all: tolerate corrupt .profraw from tests that spawn + SIGKILL an
    # instrumented child (crash-resume / lifecycle / nai-subprocess e2e) — llvm-profdata
    # drops those with a warning and merges the rest, so coverage still produces a valid
    # lcov instead of aborting on the first bad profile. Universally safe (default `any`
    # aborts on ANY corrupt profile). CR-385.
    cmd = ["cargo", "llvm-cov", "--failure-mode", "all", "nextest", "--workspace"]
    if args.all_features:
        cmd += ["--all-features"]
    elif args.features:
        cmd += ["--features", args.features]
    cmd += [
        "--lcov", "--output-path", args.lcov_output,
        "-P", args.profile,
    ]
    if args.ignore_run_fail:
        cmd += ["--ignore-run-fail"]
    print(f"[crucible] running: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=project_dir, env=env)
    print(f"[crucible] llvm-cov nextest exit={result.returncode}")

    junit_path = f"{project_dir}/target/nextest/{args.profile}/junit.xml"
    if not os.path.exists(junit_path):
        print(f"[crucible] ERROR: no junit.xml at {junit_path}")
        return 1

    root = ET.parse(junit_path).getroot()
    tree_nodes = []
    total = passed = failed = 0
    duration_ms = 0
    # A JUnit root can be <testsuites> (nextest's wrapper) OR a bare
    # <testsuite> — handle both, like the server's junit codec.
    suites = ([root] if root.tag == "testsuite" else []) + root.findall(".//testsuite")
    for suite in suites:
        children = []
        suite_fail = False
        for tc in suite.findall("testcase"):
            tc_time = int(float(tc.get("time", 0)) * 1000)
            fail = tc.find("failure") is not None or tc.find("error") is not None
            status = "fail" if fail else "pass"
            if fail:
                failed += 1
                suite_fail = True
            else:
                passed += 1
            total += 1
            duration_ms += tc_time
            children.append({"name": tc.get("name", "?"), "status": status, "duration_ms": tc_time})
        tree_nodes.append({
            "name": suite.get("name", "?"),
            "status": "fail" if suite_fail else "pass",
            "children": children,
        })

    summary = {
        "total": total, "passed": passed, "failed": failed,
        "pending": 0, "duration_ms": duration_ms,
    }

    coverage = None
    lcov_path = f"{project_dir}/{args.lcov_output}"
    if os.path.exists(lcov_path):
        lf = lh = ff = fh = 0
        with open(lcov_path) as f:
            for line in f:
                if line.startswith("LF:"):
                    lf += int(line[3:].strip())
                elif line.startswith("LH:"):
                    lh += int(line[3:].strip())
                elif line.startswith("FNF:"):
                    ff += int(line[4:].strip())
                elif line.startswith("FNH:"):
                    fh += int(line[4:].strip())
        coverage = {
            "lines": {
                "total": lf, "covered": lh,
                "percent": round(lh / lf * 100, 1) if lf else 0,
            },
            "functions": {
                "total": ff, "covered": fh,
                "percent": round(fh / ff * 100, 1) if ff else 0,
            },
        }

    payload = {
        "projectKey": _project_key(project_dir),
        "agentId": args.agent,
        "summary": summary,
        "tree": tree_nodes,
    }
    if coverage:
        payload["coverage"] = coverage
    context = _run_context()
    if context:
        payload["context"] = context

    resp = _post("/api/v2/runs/parsed", payload)
    cov_line = ""
    if coverage:
        cov_line = f" lines={coverage['lines']['percent']}% funcs={coverage['functions']['percent']}%"
    print(
        f"workspace regression: ok={resp.get('ok')} "
        f"passed={passed} failed={failed} total={total}{cov_line}"
    )
    return 0 if resp.get("ok") else 1


def _clean_stale_bind_mounts(project_dir):
    """Remove host bind-mount files left from prior compose runs that may have
    non-UID-1000 ownership (per rust-orchestration.md (Disk hygiene — bind-mounts)). Paths are read from
    CRUCIBLE_BIND_MOUNT_PATHS in .env (comma/space-separated); no-op if unset, so
    this is harmless for projects that don't use bind mounts."""
    raw = _read_env(project_dir).get("CRUCIBLE_BIND_MOUNT_PATHS", "")
    candidates = [p for p in raw.replace(",", " ").split() if p]
    for path in candidates:
        if not os.path.exists(path):
            continue
        try:
            for entry in os.listdir(path):
                full = os.path.join(path, entry)
                try:
                    if os.path.isfile(full):
                        os.remove(full)
                except PermissionError:
                    # File owned by a prior container UID; use a throwaway
                    # alpine container to chmod + delete.
                    subprocess.run(
                        ["docker", "run", "--rm", "-v", f"{path}:/data", "alpine",
                         "sh", "-c", "chmod -R 0777 /data && rm -rf /data/*"],
                        capture_output=True,
                    )
                    break
        except PermissionError:
            pass


def _compose_args(arg_value, project_dir, missing_ok):
    """Build the `-f <path>` prefix (or [] for docker auto-discovery). Returns
    (compose_args, error_rc): error_rc is None on success, an int to return on failure."""
    compose_file = _resolve_compose_file(arg_value, project_dir)
    if not compose_file:
        return [], None  # no -f → docker compose auto-discovers compose.yaml in project_dir
    compose_path = compose_file if os.path.isabs(compose_file) else os.path.join(project_dir, compose_file)
    if not os.path.exists(compose_path):
        if missing_ok:
            print(f"[crucible] compose file absent, skipping: {compose_path}")
            return [], 0
        print(f"[crucible] ERROR: compose file not found: {compose_path}")
        return [], 1
    return ["-f", compose_path], None


def cmd_docker_up(args):
    project_dir = _resolve_project_dir(args.project_dir)
    compose_args, err = _compose_args(args.compose_file, project_dir, missing_ok=False)
    if err is not None:
        return err
    _clean_stale_bind_mounts(project_dir)
    env = os.environ.copy()
    env.setdefault("UID", str(os.getuid()))
    env.setdefault("GID", str(os.getgid()))

    # Resolve which services to bring up: --services > CRUCIBLE_DOCKER_SERVICES in
    # .env > all services. `--all-services` forces "all", overriding any .env subset.
    cmd = ["docker", "compose", *compose_args, "up", "-d"]
    if not args.no_wait:
        cmd += ["--wait"]
    if not args.all_services:
        services = _resolve_services(args.services, project_dir)
        if services:
            cmd += services
    print(f"[docker] {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=project_dir, env=env)
    if result.returncode != 0:
        print(f"[docker] up failed: exit={result.returncode}")
        return result.returncode
    print("[docker] up OK")
    return 0


def cmd_docker_down(args):
    project_dir = _resolve_project_dir(args.project_dir)
    compose_args, err = _compose_args(args.compose_file, project_dir, missing_ok=True)
    if err is not None:
        return err
    cmd = ["docker", "compose", *compose_args, "down", "-v"]
    print(f"[docker] {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=project_dir)
    print(f"[docker] down exit={result.returncode}")
    return result.returncode


def cmd_pre_merge_gate(args):
    """ORCHESTRATOR pre-merge gate — docker-FREE.

    Runs workspace-regression --all-features under -P ci. The ci profile's
    default-filter (.config/nextest.toml) excludes the docker-infra tier
    (E2E_SET) so this gate needs NO docker and is deterministic, while STILL
    running every in-process full-boot e2e test (NaiApp/DevApp boot tests — the
    wiring-gap detectors are docker-free and are NOT in E2E_SET).

    Docker-dependent connector/build tests run separately via `docker-e2e-gate`
    — mandatory for CRs whose gap-analysis flags boot/connector/Bridge/provider
    wiring, and at pre-release. See rust-orchestration.md (Pre-merge gate / E2E gate).

    Step 0 (default-on, fail-fast): a workspace `clippy --all-targets --all-features
    -- -D warnings` lint gate runs BEFORE the coverage regression — a lint failure
    aborts the gate without paying for the full llvm-cov build. The workspace was
    cleaned to zero `-D warnings` by CR-NAI-305 (2026-06-05), so this is enforced by
    default; pass `--skip-clippy` only for a deliberate bypass.
    """
    project_dir = _resolve_project_dir(args.project_dir)
    if not getattr(args, "skip_clippy", False):
        clippy_rc = _clippy_workspace_gate(project_dir, args.agent)
        if clippy_rc != 0:
            print("[crucible] pre-merge gate FAILED at the clippy -D warnings step — "
                  "skipped the coverage regression. Fix the lints first (or --skip-clippy to bypass).")
            return clippy_rc

    ws_args = argparse.Namespace(
        project_dir=args.project_dir,
        agent=args.agent,
        all_features=True,
        features=None,
        profile=args.profile,
        lcov_output=args.lcov_output,
        ignore_run_fail=True,
        min_free_g=getattr(args, "min_free_g", 80),
        keep_target=getattr(args, "keep_target", False),
    )
    return cmd_workspace_regression(ws_args)


def cmd_docker_e2e_gate(args):
    """ORCHESTRATOR docker-e2e gate.

    Brings docker up, runs ONLY the docker-infra tier (-P e2e default-filter in
    .config/nextest.toml) as a RAW nextest run (no llvm-cov — e2e runs connector
    subprocesses that instrumentation can't reach, so coverage signal is ~0 and
    instrumentation only masks timing races), brings docker down (always), ingests
    junit. Thin wrapper over smoke-test with profile=e2e + docker forced on.

    NOT part of the per-cycle or default pre-merge gate. Run it when gap-analysis
    flags NaiApp boot / connector registration / Bridge / provider wiring (only
    real infra surfaces those wiring gaps), and at pre-release as the catch-all.
    Reuses the pre-merge-gate --all-features build unless --clean is passed.
    """
    smoke_args = argparse.Namespace(
        project_dir=args.project_dir,
        agent=args.agent,
        all_features=True,
        features=None,
        clean=args.clean,
        with_docker=True,
        compose_file=args.compose_file,
        profile="e2e",
        # let a non-kafka compose (qdrant/postgis) override the .env kafka service subset
        services=getattr(args, "services", None),
        all_services=getattr(args, "all_services", False),
    )
    return cmd_smoke_test(smoke_args)


# ── CR-CRU-030 §S2/§S4/§S6/§S7 — plan / cycle / status verbs ────────────────


def cmd_plan_file(args):
    project_dir = _resolve_project_dir(args.project_dir)
    labels = [label.strip() for label in args.cycles.split(",") if label.strip()]
    if not labels:
        sys.exit("[crucible] ERROR: --cycles must name at least one cycle")
    payload = {"cr": args.cr, "cycles": [{"label": label} for label in labels]}
    if args.title:
        payload["title"] = args.title
    wave = args.wave if getattr(args, "wave", None) is not None else os.environ.get("WORKFLOW_WAVE")
    warnings = []
    if wave:
        payload["wave"] = wave
    else:
        w = _axi().no_wave_warning(args.cr)
        warnings.append(w)
        print(f"warning: {w['code']} — {w['detail']}", file=sys.stderr)
    track = os.environ.get("WORKFLOW_ROLE")
    if track:
        payload["track"] = track
    orchestrator = args.orchestrator or os.environ.get("WORKFLOW_ORCHESTRATOR")
    if orchestrator:
        payload["orchestrator"] = orchestrator
    resp = _post(_plans_path(project_dir), payload)
    if not resp.get("ok"):
        legacy = f"plan-file: ok=False error={resp.get('error')}"
        _emit_axi("plan-file", False, {"cr": args.cr}, _axi_context(project_dir), warnings, legacy)
        return 1
    cycles = resp.get("cycles", [])
    ids = " ".join(f"{c.get('label')}={c.get('id')}" for c in cycles)
    legacy = (f"plan-file: ok=True planId={resp.get('planId')} cr={resp.get('cr')} "
              f"cycles: {ids}")
    _emit_axi("plan-file", True,
              {"planId": resp.get("planId"), "cr": resp.get("cr"), "cycles": cycles,
               "help": ["cycle-activate <id>"]},
              _axi_context(project_dir, cr=resp.get("cr") or args.cr), warnings, legacy)
    return 0


def cmd_plan_backfill(args):
    """§S2 — resolve the target plan (single, or --cr) and PATCH its wave (wave-only
    body is closed-plan-safe, so the resolver considers ALL plans)."""
    project_dir = _resolve_project_dir(args.project_dir)
    resp = _get(_plans_path(project_dir))
    if not resp.get("ok"):
        legacy = f"[crucible] ERROR: could not list plans: {resp.get('error')}"
        _emit_axi("plan-backfill", False, {"wave": args.wave},
                  _axi_context(project_dir, cr=args.cr), [], legacy)
        return 1
    plans = resp.get("plans", [])
    if args.cr:
        plans = [p for p in plans if p.get("cr") == args.cr]
    if len(plans) == 0:
        legacy = ("[crucible] ERROR: no plan to backfill"
                  + (f" for cr={args.cr}" if args.cr else ""))
        _emit_axi("plan-backfill", False, {"wave": args.wave},
                  _axi_context(project_dir, cr=args.cr), [], legacy)
        return 1
    if len(plans) > 1:
        names = ", ".join(f"{p.get('cr')} (plan {p.get('planId')})" for p in plans)
        legacy = (f"[crucible] ERROR: {len(plans)} plans — ambiguous plan-backfill. "
                  f"Pass --cr to pick one of: {names}")
        _emit_axi("plan-backfill", False, {"wave": args.wave},
                  _axi_context(project_dir, cr=args.cr), [], legacy)
        return 1
    plan = plans[0]
    patch_resp = _patch(f"{_plans_path(project_dir)}/{plan['planId']}", {"wave": args.wave})
    ok = patch_resp.get("ok", False)
    cr_label = plan.get("cr")
    legacy = (f"plan-backfill: ok={ok} plan={plan['planId']} cr={cr_label} wave={args.wave}"
              + (f" error={patch_resp.get('error')}" if patch_resp.get("error") else ""))
    _emit_axi("plan-backfill", bool(ok),
              {"plan": plan["planId"], "cr": cr_label, "wave": args.wave},
              _axi_context(project_dir, cr=cr_label), [], legacy)
    return 0 if ok else 1


def _cycle_transition(args, status):
    """Cycle ids are unique per PROJECT — resolve the owning OPEN plan by scanning
    GET …/plans, then PATCH that plan's cycle."""
    project_dir = _resolve_project_dir(args.project_dir)
    cycle_id = args.cycle_id
    open_plans = _open_plans(project_dir)
    target = next(
        (p for p in open_plans
         if any(c.get("id") == cycle_id for c in p.get("cycles", []))),
        None,
    )
    verb = "cycle-activate" if status == "active" else "cycle-done"
    help_steps = (["cycle-done <id>", "status"] if status == "active"
                  else ["cr-close --commit <sha>", "status"])
    if target is None:
        known = "; ".join(
            f"plan {p.get('planId')} ({p.get('cr')}): "
            + ", ".join(str(c.get("id")) for c in p.get("cycles", []))
            for p in open_plans
        ) or "none"
        legacy = (f"[crucible] ERROR: cycle {cycle_id} is not in any OPEN plan. "
                  f"Open plans' cycle ids: {known}")
        _emit_axi(verb, False, {"cycle": cycle_id, "help": help_steps},
                  _axi_context(project_dir), [], legacy)
        return 1
    resp = _patch(f"{_plans_path(project_dir)}/{target['planId']}/cycles/{cycle_id}",
                  {"status": status})
    ok = resp.get("ok", False)
    legacy = (f"{verb}: ok={ok} cycle={cycle_id} plan={target['planId']}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    _emit_axi(verb, bool(ok),
              {"cycle": cycle_id, "plan": target["planId"], "help": help_steps},
              _axi_context(project_dir), [], legacy)
    return 0 if ok else 1


def cmd_cycle_activate(args):
    return _cycle_transition(args, "active")


def cmd_cycle_done(args):
    return _cycle_transition(args, "done")


def cmd_cr_close(args):
    project_dir = _resolve_project_dir(args.project_dir)
    open_plans = _open_plans(project_dir)
    if args.cr:
        open_plans = [p for p in open_plans if p.get("cr") == args.cr]
    if len(open_plans) == 0:
        legacy = ("[crucible] ERROR: no OPEN plan to close"
                  + (f" for cr={args.cr}" if args.cr else ""))
        _emit_axi("cr-close", False,
                  {"commit": args.commit, "help": _axi().HELP_STEPS["cr-close"]},
                  _axi_context(project_dir, cr=args.cr), [], legacy)
        return 1
    if len(open_plans) > 1:
        names = ", ".join(f"{p.get('cr')} (plan {p.get('planId')})" for p in open_plans)
        legacy = (f"[crucible] ERROR: {len(open_plans)} open plans — ambiguous cr-close. "
                  f"Pass --cr to pick one of: {names}")
        _emit_axi("cr-close", False,
                  {"commit": args.commit, "help": _axi().HELP_STEPS["cr-close"]},
                  _axi_context(project_dir), [], legacy)
        return 1
    plan = open_plans[0]
    resp = _patch(f"{_plans_path(project_dir)}/{plan['planId']}",
                  {"status": "closed", "merge": {"commit": args.commit}})
    ok = resp.get("ok", False)
    cr_label = plan.get("cr")
    legacy = (f"cr-close: ok={ok} plan={plan['planId']} cr={cr_label} commit={args.commit}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    _emit_axi("cr-close", bool(ok),
              {"plan": plan["planId"], "cr": cr_label, "commit": args.commit,
               "help": _axi().HELP_STEPS["cr-close"]},
              _axi_context(project_dir, cr=cr_label), [], legacy)
    if not ok:
        return 1
    ms_resp = _post_milestone(
        project_dir, _agent_id(args), "cr-merged",
        label=cr_label, commit=args.commit,
        context=_axi().fleet_context(cr=cr_label) or None,
    )
    print(f"cr-merged: ok={ms_resp.get('ok', False)} cr={cr_label} commit={args.commit}"
          + (f" error={ms_resp.get('error')}" if ms_resp.get("error") else ""),
          file=sys.stderr)
    return 0


def _resolve_plan_or_emit(verb, project_dir, cr, result_fields, open_only):
    """Shared prelude for the plan-targeting write verbs (cycle-add / checkpoint /
    abort): GET the plans, resolve exactly ONE target via the shared
    resolve_single_plan, and on any failure emit ok:false + return (None, 1)."""
    resp = _get(_plans_path(project_dir))
    if not resp.get("ok"):
        legacy = f"[crucible] ERROR: could not list plans: {resp.get('error')}"
        _emit_axi(verb, False, result_fields, _axi_context(project_dir, cr=cr), [], legacy)
        return None, 1
    plans = resp.get("plans", [])
    plan, reason = _axi().resolve_single_plan(plans, cr=cr, open_only=open_only)
    if reason is not None:
        scope = "open plan" if open_only else "plan"
        if reason == "none":
            legacy = (f"[crucible] ERROR: no {scope} to {verb}"
                      + (f" for cr={cr}" if cr else ""))
        else:
            candidates = [p for p in plans
                          if (not open_only or p.get("status") == "open")]
            names = ", ".join(f"{p.get('cr')} (plan {p.get('planId')})" for p in candidates)
            legacy = (f"[crucible] ERROR: {len(candidates)} {scope}s — ambiguous {verb}. "
                      f"Pass --cr to pick one of: {names}")
        _emit_axi(verb, False, result_fields, _axi_context(project_dir, cr=cr), [], legacy)
        return None, 1
    return plan, None


def cmd_cycle_add(args):
    """§S4 — append a cycle to a plan. Resolve the target plan (ALL plans, optional
    --cr), POST …/plans/<planId>/cycles with ONLY the label, and let the SERVER
    reject a CLOSED/absent plan. The assigned numeric id stays machine-readable."""
    project_dir = _resolve_project_dir(args.project_dir)
    result_fields = {"label": args.label, "help": _axi().HELP_STEPS["cycle-add"]}
    plan, rc = _resolve_plan_or_emit("cycle-add", project_dir, args.cr,
                                     result_fields, open_only=False)
    if plan is None:
        return rc
    resp = _post(f"{_plans_path(project_dir)}/{plan['planId']}/cycles",
                 {"label": args.label})
    ok = resp.get("ok", False)
    cr_label = plan.get("cr")
    legacy = (f"cycle-add: ok={ok} plan={plan['planId']} cr={cr_label} "
              f"label={args.label} id={resp.get('id')}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    _emit_axi("cycle-add", bool(ok),
              {"plan": plan["planId"], "id": resp.get("id"), "label": args.label,
               "help": _axi().HELP_STEPS["cycle-add"]},
              _axi_context(project_dir, cr=cr_label), [], legacy)
    return 0 if ok else 1


def cmd_checkpoint(args):
    """§S7 — checkpoint the resolved OPEN plan (POST …/plans/<id>/checkpoint)."""
    project_dir = _resolve_project_dir(args.project_dir)
    plan, rc = _resolve_plan_or_emit("checkpoint", project_dir, args.cr,
                                     {"help": _axi().HELP_STEPS["checkpoint"]}, open_only=True)
    if plan is None:
        return rc
    resp = _post(f"{_plans_path(project_dir)}/{plan['planId']}/checkpoint", {})
    ok = resp.get("ok", False)
    legacy = (f"checkpoint: ok={ok} plan={plan['planId']}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    _emit_axi("checkpoint", bool(ok),
              {"plan": plan["planId"], "changed": resp.get("changed"),
               "help": _axi().HELP_STEPS["checkpoint"]},
              _axi_context(project_dir, cr=plan.get("cr")), [], legacy)
    return 0 if ok else 1


def cmd_stop(args):
    """§S7 — project-level stop (POST …/projects/<key>/stop). No plan targeting."""
    project_dir = _resolve_project_dir(args.project_dir)
    resp = _post(f"/api/v2/projects/{_project_key(project_dir)}/stop", {})
    ok = resp.get("ok", False)
    legacy = (f"stop: ok={ok} checkpointed={resp.get('checkpointed')}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    _emit_axi("stop", bool(ok),
              {"checkpointed": resp.get("checkpointed"), "help": _axi().HELP_STEPS["stop"]},
              _axi_context(project_dir), [], legacy)
    return 0 if ok else 1


def cmd_abort(args):
    """§S7 — abort the resolved OPEN plan (POST …/plans/<id>/abort). WITHOUT
    --user-approved the body's userApproved is false, so the server's discouraging
    409 refusal stays reachable (surfaced as ok:false + non-zero)."""
    project_dir = _resolve_project_dir(args.project_dir)
    plan, rc = _resolve_plan_or_emit("abort", project_dir, args.cr,
                                     {"help": _axi().HELP_STEPS["abort"]}, open_only=True)
    if plan is None:
        return rc
    resp = _post(f"{_plans_path(project_dir)}/{plan['planId']}/abort",
                 {"userApproved": bool(args.user_approved)})
    ok = resp.get("ok", False)
    legacy = (f"abort: ok={ok} plan={plan['planId']} userApproved={bool(args.user_approved)}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    _emit_axi("abort", bool(ok),
              {"plan": plan["planId"], "help": _axi().HELP_STEPS["abort"]},
              _axi_context(project_dir, cr=plan.get("cr")), [], legacy)
    return 0 if ok else 1


def cmd_status(args):
    """§S6 — the plan/status READ verb (alias `plans`, no --agent). GET …/plans and
    return the queue as a uniform-table §S1 envelope plus a top-level lastRunCr."""
    project_dir = _resolve_project_dir(args.project_dir)
    resp = _get(_plans_path(project_dir))
    if not resp.get("ok"):
        legacy = f"[crucible] ERROR: could not list plans: {resp.get('error')}"
        _emit_axi("status", False,
                  {"plans": [], "lastRunCr": None, "help": _axi().HELP_STEPS["status"]},
                  _axi_context(project_dir), [], legacy)
        return 1
    plans = resp.get("plans", [])
    full_rows = _axi().build_status_rows(plans)
    last = _axi().last_run_cr(plans)
    fields = getattr(args, "fields", None)
    requested = [f.strip() for f in fields.split(",") if f.strip()] if fields else []
    rows = _axi().select_status_fields(full_rows, requested)
    count = len(plans)
    if not rows:
        legacy = "status: ok=True — no plans filed for this project"
        _emit_axi("status", True,
                  {"plans": [], "lastRunCr": None, "count": 0,
                   "help": _axi().HELP_STEPS["status"]},
                  _axi_context(project_dir), [], legacy)
        return 0
    legacy = f"status: ok=True plans={len(rows)} lastRunCr={last}"
    _emit_axi("status", True,
              {"plans": rows, "lastRunCr": last, "count": count,
               "help": _axi().HELP_STEPS["status"]},
              _axi_context(project_dir), [], legacy)
    return 0


# ── CR-CRU-013 §S5 — fleet gate / milestone verbs ───────────────────────────


def _agent_id(args):
    """The agentId for a fleet event. Explicit --agent > $WORKFLOW_ROLE > a stable
    fallback (these verbs never assert on the id, but the server requires one)."""
    explicit = getattr(args, "agent", None)
    if explicit:
        return explicit
    return os.environ.get("WORKFLOW_ROLE") or "rust-crucible"


def _post_gate(project_dir, agent_id, gate, context=None):
    payload = {"projectKey": _project_key(project_dir), "agentId": agent_id, "gate": gate}
    if context:
        payload["context"] = context
    return _post("/api/v2/gates", payload)


def _post_milestone(project_dir, agent_id, mtype, label=None, commit=None, context=None):
    payload = {"projectKey": _project_key(project_dir), "agentId": agent_id, "type": mtype}
    if label:
        payload["label"] = label
    if commit:
        payload["commit"] = commit
    if context:
        payload["context"] = context
    return _post("/api/v2/milestones", payload)


def cmd_gate_report(args):
    """§S8 — report a single already-run gate (flags path). Emits the §S1 envelope
    plus the interactive line on stderr, and always raises the prefer-gate-run
    discouragement warning (envelope + stderr)."""
    project_dir = _resolve_project_dir(args.project_dir)
    prefer = _axi().PREFER_GATE_RUN_WARNING
    warnings = [dict(prefer)]
    print(f"warning: {prefer['code']} — {prefer['detail']}", file=sys.stderr)
    context = _axi_context(project_dir, agent_id=_agent_id(args))
    try:
        steps = _axi().parse_steps_flag(args.steps) if args.steps else []
    except ValueError as e:
        legacy = f"gate-report: ERROR: {e}"
        _emit_axi("gate-report", False, {"outcome": args.outcome}, context, warnings, legacy)
        return 1
    intent = args.intent or f"{args.outcome} gate"
    gate = {"intent": intent, "outcome": args.outcome, "steps": steps}
    if args.commit:
        gate["push"] = {"commit": args.commit}
    resp = _post_gate(project_dir, _agent_id(args), gate, _axi().fleet_context() or None)
    ok = resp.get("ok", False)
    legacy = (f"gate-report: ok={ok} outcome={args.outcome}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    result_fields = {"outcome": args.outcome}
    err = resp.get("error")
    if err is not None:
        result_fields["error"] = _axi().truncate_field(err, full=getattr(args, "full", False))
    _emit_axi("gate-report", bool(ok), result_fields, context, warnings, legacy)
    return 0 if ok else 1


def cmd_gate_run(args):
    """§S8 — axi PROXY wrapper: launch `no-mistakes axi run`, poll `axi status` for
    throttled interim gates, seal a final gate from the run's outcome, and relay the
    axi detail to the caller. The caller issues NO POST itself; no prefer-gate-run
    warning (it is itself the streaming standard)."""
    project_dir = _resolve_project_dir(args.project_dir)
    nm = shutil.which("no-mistakes")
    if not nm:
        print("gate-run: ERROR: `no-mistakes` not found on PATH — cannot proxy axi run",
              file=sys.stderr)
        return 1

    intent = args.intent
    agent_id = _agent_id(args)
    context = _axi().fleet_context()

    try:
        proc = subprocess.Popen(
            [nm, "axi", "run", "--intent", intent],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
    except OSError as e:
        print(f"gate-run: ERROR: could not launch `no-mistakes axi run`: {e}",
              file=sys.stderr)
        return 1

    last_post = None
    while proc.poll() is None:
        now = time.monotonic()
        if last_post is None or (now - last_post) >= _GATE_POLL_CADENCE_S:
            status = subprocess.run([nm, "axi", "status"], capture_output=True, text=True)
            snap = (status.stdout or "").strip()
            if snap:
                try:
                    decoded = _toon().decode(snap)
                except Exception:
                    decoded = None
                if isinstance(decoded, dict):
                    run = decoded.get("run") or {}
                    in_flight = (str(run.get("status")) != "completed"
                                 and "outcome" not in decoded)
                    gate, nsteps = _axi().gate_from_axi(decoded, intent, final=False)
                    if in_flight and 0 < nsteps < 9:
                        _post_gate(project_dir, agent_id, gate, context or None)
                        last_post = now
        time.sleep(_GATE_POLL_TICK_S)

    out, _err = proc.communicate()
    if out:
        sys.stdout.write(out)

    final_snap = (out or "").strip()
    final_decoded = None
    if final_snap:
        try:
            final_decoded = _toon().decode(final_snap)
        except Exception:
            final_decoded = None
    if not isinstance(final_decoded, dict):
        print("gate-run: ERROR: `axi run` produced no parseable final snapshot",
              file=sys.stderr)
        return 1

    final_gate, _ = _axi().gate_from_axi(final_decoded, intent, final=True)
    resp = _post_gate(project_dir, agent_id, final_gate, context or None)
    ok = resp.get("ok", False)
    overall = bool(ok and proc.returncode == 0)
    legacy = (f"gate-run: ok={ok} outcome={final_gate.get('outcome')} exit={proc.returncode}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    _emit_axi("gate-run", overall, {"outcome": final_gate.get("outcome")},
              _axi_context(project_dir, agent_id=agent_id), [], legacy)
    return 0 if overall else 1


def cmd_milestone(args):
    """POST a workflow milestone. §S4b."""
    project_dir = _resolve_project_dir(args.project_dir)
    context = _axi().fleet_context(cr=args.cr)
    resp = _post_milestone(project_dir, _agent_id(args), args.type,
                           label=args.label, commit=getattr(args, "commit", None),
                           context=context or None)
    ok = resp.get("ok", False)
    print(f"milestone: ok={ok} type={args.type}"
          + (f" label={args.label}" if args.label else "")
          + (f" error={resp.get('error')}" if resp.get("error") else ""),
          file=sys.stderr)
    return 0 if ok else 1


_DASHBOARD_PURPOSE_LINE = (
    "rust-crucible.py -- Rust/Cargo Crucible CLI "
    "(agent lifecycle, test/ingest, plan/cycle verbs)."
)


def _abbrev_home(path):
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path.startswith(home) else path


def cmd_dashboard():
    """§S14 — a bare invocation (no args) returns the LIVE board: the §S6 status
    dashboard on stdout, plus a one-line tool purpose + the executable path on stderr."""
    print(_DASHBOARD_PURPOSE_LINE, file=sys.stderr)
    print(_abbrev_home(os.path.abspath(__file__)), file=sys.stderr)
    return cmd_status(argparse.Namespace(project_dir=None, fields=None))


def _add_project_dir_arg(p):
    p.add_argument(
        "--project-dir",
        help="Override project root (default: $RUST_CRUCIBLE_PROJECT_DIR, else the git "
             "repo containing the current directory). The .env at the project root must "
             "contain CRUCIBLE_PROJECT_KEY.",
    )


def _add_log_arg(p):
    p.add_argument(
        "--log",
        help="Write the FULL run output (combined stdout+stderr, in order) to this file "
             "path in addition to streaming it. Lets an agent read the run back for "
             "debugging — nextest's streamed output is otherwise lost.",
    )


def main():
    p = argparse.ArgumentParser(prog="rust-crucible", description=__doc__)
    # §S14 — subcommand is OPTIONAL: a bare invocation falls through to the
    # no-arg live dashboard (below), never argparse's required-subcommand error.
    sub = p.add_subparsers(dest="cmd", required=False)

    r = sub.add_parser("register", help="Register / heartbeat an agent")
    r.add_argument("--agent", required=True, help="Agent id, e.g. CR-NAI-203-C5-RED")
    # CR-CRU-008 register ergonomics: --phase optional, defaulting to
    # "report" — the old hard requirement forced orchestrator-side
    # implicit-heartbeat workarounds.
    r.add_argument(
        "--phase",
        choices=["RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report"],
        default="report",
    )
    r.add_argument("--message", help="Optional status message")
    _add_project_dir_arg(r)
    r.set_defaults(func=cmd_register)

    u = sub.add_parser("unregister", help="Unregister an agent")
    u.add_argument("--agent", required=True)
    _add_project_dir_arg(u)
    u.set_defaults(func=cmd_unregister)

    a = sub.add_parser(
        "auto-ingest",
        help="Ingest only: junit if present, else `cargo check` stderr as compile errors.",
    )
    a.add_argument("--agent", required=True)
    a.add_argument("--crate", required=True, help="Crate name (for compile fallback)")
    a.add_argument(
        "--features",
        help="Comma-separated feature flags (e.g. test-support)",
    )
    _add_project_dir_arg(a)
    a.set_defaults(func=cmd_auto_ingest)

    g = sub.add_parser(
        "regression-ingest",
        help="Per-crate coverage regression: clean + llvm-cov nextest + ingest parsed.",
    )
    g.add_argument("--agent", required=True)
    g.add_argument(
        "--crates",
        required=True,
        help="Comma-separated crate names, e.g. nai_ast,nai_runtime",
    )
    g.add_argument("--features", help="Optional --features flag")
    _add_project_dir_arg(g)
    g.set_defaults(func=cmd_regression_ingest)

    # --- New subcommands ---

    t = sub.add_parser(
        "test",
        help="cargo nextest run -p <crate>. With --agent: also ingest junit afterwards.",
    )
    t.add_argument("--crate", required=True)
    t.add_argument("--features", help="Comma-separated feature flags")
    t.add_argument("--profile", default="ci", help="Nextest profile (default: ci)")
    t.add_argument("--test", help="Single test binary, e.g. window_pipeline_e2e")
    t.add_argument("--filter", help="Nextest -E filter expression")
    t.add_argument("--no-fail-fast", action="store_true", help="Pass --no-fail-fast to nextest")
    t.add_argument("--agent", help="If set, auto-ingest junit after the run")
    _add_project_dir_arg(t)
    _add_log_arg(t)
    t.set_defaults(func=cmd_test)

    c = sub.add_parser(
        "check",
        help="cargo check -p <crate>. With --agent: ingest stderr as rustc compile errors.",
    )
    c.add_argument("--crate", required=True)
    c.add_argument("--features", help="Comma-separated feature flags")
    c.add_argument("--tests", action="store_true", help="Add --tests flag (check tests too)")
    c.add_argument("--agent", help="If set, ingest stderr as compile errors")
    _add_project_dir_arg(c)
    c.set_defaults(func=cmd_check)

    cl = sub.add_parser(
        "clippy",
        help="cargo clippy -p <crate>. With --agent: ingest stderr as compile errors.",
    )
    cl.add_argument("--crate", required=True)
    cl.add_argument("--features", help="Comma-separated feature flags")
    cl.add_argument("--tests", action="store_true", help="Add --tests flag (lint tests too)")
    cl.add_argument(
        "--deny-warnings",
        action="store_true",
        help="Append -- -D warnings (turn warnings into errors)",
    )
    cl.add_argument("--agent", help="If set, ingest stderr as compile errors")
    _add_project_dir_arg(cl)
    cl.set_defaults(func=cmd_clippy)

    wcl = sub.add_parser(
        "workspace-clippy",
        help="Workspace clippy --all-targets --all-features -- -D warnings — the "
             "pre-merge gate's fail-fast step 1, standalone. With --agent: ingest.",
    )
    wcl.add_argument("--agent", help="If set, ingest stderr as compile errors")
    _add_project_dir_arg(wcl)
    wcl.set_defaults(func=cmd_workspace_clippy)

    w = sub.add_parser(
        "workspace-regression",
        help="Full workspace coverage regression (orchestrator pre-merge gate).",
    )
    w.add_argument("--agent", required=True, help="Agent id (typically the orchestrator's)")
    w.add_argument(
        "--all-features",
        action="store_true",
        help="Pass --all-features (recommended for the canonical pre-merge gate)",
    )
    w.add_argument(
        "--features",
        help="Specific --features set (mutually exclusive with --all-features)",
    )
    w.add_argument("--profile", default="ci", help="Nextest profile (default: ci)")
    w.add_argument(
        "--lcov-output",
        default="target/lcov.info",
        help="lcov output path relative to project root (default: target/lcov.info)",
    )
    w.add_argument(
        "--ignore-run-fail",
        action="store_true",
        default=True,
        help="Pass --ignore-run-fail to llvm-cov so coverage is published even on test failures",
    )
    w.add_argument(
        "--min-free-g", type=int, default=80,
        help="Disk-guard floor in GB: after the pre-run clean, hard-abort if free /home "
             "is still below this (default: 80). Lower on a smaller disk.",
    )
    w.add_argument(
        "--keep-target", action="store_true",
        help="Skip the post-run `cargo clean` reclaim (keep target/ artifacts).",
    )
    _add_project_dir_arg(w)
    w.set_defaults(func=cmd_workspace_regression)

    st = sub.add_parser(
        "smoke-test",
        help="Raw workspace nextest (no llvm-cov) per rust-orchestration.md (Pre-merge gate, smoke×2). "
             "Faster than workspace-regression; less prone to instrumentation-induced flakes.",
    )
    st.add_argument("--agent", required=True, help="Agent id (typically vidushi)")
    st.add_argument(
        "--all-features",
        action="store_true",
        help="Pass --all-features to nextest (canonical pre-merge smoke)",
    )
    st.add_argument(
        "--features",
        help="Specific --features set (mutually exclusive with --all-features)",
    )
    st.add_argument("--profile", default="ci", help="Nextest profile (default: ci)")
    st.add_argument(
        "--clean",
        action="store_true",
        help="Run `cargo clean` before nextest (canonical pre-merge step 1)",
    )
    st.add_argument(
        "--with-docker",
        action="store_true",
        help="Bring up the e2e docker stack (compose-file) before tests; tear down after",
    )
    st.add_argument(
        "--compose-file",
        default=None,
        help="Compose file path (rel to project root). Default: $RUST_CRUCIBLE_COMPOSE_FILE "
             "or CRUCIBLE_COMPOSE_FILE in .env, else docker auto-discovery (compose.yaml).",
    )
    _add_project_dir_arg(st)
    st.set_defaults(func=cmd_smoke_test)

    du = sub.add_parser(
        "docker-up",
        help="docker compose up -d. Services default to CRUCIBLE_DOCKER_SERVICES in .env "
             "(else all). Pre-cleans stale bind-mounts listed in CRUCIBLE_BIND_MOUNT_PATHS.",
    )
    du.add_argument(
        "--compose-file",
        default=None,
        help="Compose file path (rel to project root). Default: $RUST_CRUCIBLE_COMPOSE_FILE "
             "or CRUCIBLE_COMPOSE_FILE in .env, else docker auto-discovery (compose.yaml).",
    )
    du.add_argument(
        "--no-wait",
        action="store_true",
        help="Skip the --wait flag (don't block on healthchecks)",
    )
    du.add_argument(
        "--services",
        nargs="+",
        help="Specific services to bring up. Default: CRUCIBLE_DOCKER_SERVICES in .env, "
             "else all services in the compose file.",
    )
    du.add_argument(
        "--all-services",
        action="store_true",
        help="Force ALL services in the compose file, overriding any CRUCIBLE_DOCKER_SERVICES "
             "subset in .env.",
    )
    _add_project_dir_arg(du)
    du.set_defaults(func=cmd_docker_up)

    dd = sub.add_parser(
        "docker-down",
        help="docker compose down -v for the e2e compose file.",
    )
    dd.add_argument(
        "--compose-file",
        default=None,
        help="Compose file path (rel to project root). Default: $RUST_CRUCIBLE_COMPOSE_FILE "
             "or CRUCIBLE_COMPOSE_FILE in .env, else docker auto-discovery (compose.yaml).",
    )
    _add_project_dir_arg(dd)
    dd.set_defaults(func=cmd_docker_down)

    pmg = sub.add_parser(
        "pre-merge-gate",
        help="ORCHESTRATOR pre-merge (docker-FREE): fail-fast clippy --workspace --all-targets "
             "--all-features -- -D warnings (default-on; --skip-clippy to bypass) → workspace-regression "
             "--all-features -P ci (excludes the docker-infra tier, keeps in-process full-boot e2e) + ingest. "
             "Docker-infra tests run via docker-e2e-gate.",
    )
    pmg.add_argument("--agent", required=True, help="Agent id (typically vidushi)")
    pmg.add_argument("--profile", default="ci", help="Nextest profile (default: ci)")
    pmg.add_argument(
        "--lcov-output",
        default="target/lcov.info",
        help="lcov output path relative to project root (default: target/lcov.info)",
    )
    pmg.add_argument(
        "--min-free-g", type=int, default=80,
        help="Disk-guard floor in GB before the gate (default: 80).",
    )
    pmg.add_argument(
        "--keep-target", action="store_true",
        help="Skip the post-run `cargo clean` reclaim (keep target/ artifacts).",
    )
    pmg.add_argument(
        "--skip-clippy", action="store_true",
        help="Bypass the fail-fast clippy gate. By DEFAULT the gate runs `clippy --workspace "
             "--all-targets --all-features -- -D warnings` BEFORE the coverage regression and "
             "aborts on any lint (the workspace was cleaned to zero -D warnings by CR-NAI-305, "
             "2026-06-05). Pass this only for a deliberate bypass.",
    )
    _add_project_dir_arg(pmg)
    pmg.set_defaults(func=cmd_pre_merge_gate)

    e2e = sub.add_parser(
        "docker-e2e-gate",
        help="ORCHESTRATOR docker-e2e gate: docker-up + raw `nextest run --all-features -P e2e` "
             "(docker-infra tier ONLY) + docker-down + ingest. Mandatory for CRs touching "
             "boot/connector/Bridge/provider wiring, and at pre-release.",
    )
    e2e.add_argument("--agent", required=True, help="Agent id (typically vidushi)")
    e2e.add_argument(
        "--compose-file",
        default=None,
        help="Compose file path (rel to project root). Default: $RUST_CRUCIBLE_COMPOSE_FILE "
             "or CRUCIBLE_COMPOSE_FILE in .env, else docker auto-discovery (compose.yaml).",
    )
    e2e.add_argument(
        "--clean",
        action="store_true",
        help="cargo clean before building (default: reuse the pre-merge-gate --all-features build).",
    )
    e2e.add_argument(
        "--services",
        nargs="+",
        default=None,
        help="Specific compose services to bring up (overrides the .env CRUCIBLE_DOCKER_SERVICES "
             "kafka subset). Use for a non-kafka stack, e.g. --services qdrant.",
    )
    e2e.add_argument(
        "--all-services",
        action="store_true",
        help="Bring up ALL services in the given compose file, overriding the .env "
             "CRUCIBLE_DOCKER_SERVICES kafka subset. Use for single-sidecar composes "
             "(qdrant-e2e / postgis-e2e).",
    )
    _add_project_dir_arg(e2e)
    e2e.set_defaults(func=cmd_docker_e2e_gate)

    # ── CR-CRU-030 §S2/§S4/§S6/§S7 — plan / cycle / status / gate verbs ──
    pf = sub.add_parser("plan-file",
                        help="File a cycle plan; prints the ASSIGNED numeric cycle ids.")
    pf.add_argument("--cr", required=True, help="CR id, e.g. CR-NAI-203.")
    pf.add_argument("--title", help="Optional plan title.")
    pf.add_argument("--cycles", required=True,
                    help='Comma-separated cycle labels, e.g. "a,b,c".')
    pf.add_argument("--orchestrator",
                    help="Orchestrator name (default: $WORKFLOW_ORCHESTRATOR when set).")
    pf.add_argument("--wave",
                    help="Wave number (§S3). Resolution: --wave > $WORKFLOW_WAVE.")
    _add_project_dir_arg(pf)
    pf.set_defaults(func=cmd_plan_file)

    pb = sub.add_parser("plan-backfill",
                        help="Backfill a plan's wave (PATCH wave-only; open OR closed).")
    pb.add_argument("--wave", required=True, help="Wave number to assign.")
    pb.add_argument("--cr", help="Disambiguate when multiple plans exist.")
    _add_project_dir_arg(pb)
    pb.set_defaults(func=cmd_plan_backfill)

    ca = sub.add_parser("cycle-activate", help="Transition a plan cycle to active.")
    ca.add_argument("cycle_id", type=int, help="Numeric cycle id (unique per project).")
    _add_project_dir_arg(ca)
    ca.set_defaults(func=cmd_cycle_activate)

    cdn = sub.add_parser("cycle-done", help="Transition an ACTIVE plan cycle to done.")
    cdn.add_argument("cycle_id", type=int, help="Numeric cycle id (unique per project).")
    _add_project_dir_arg(cdn)
    cdn.set_defaults(func=cmd_cycle_done)

    cc = sub.add_parser("cr-close",
                        help="Close the single OPEN plan (PATCH status=closed + merge.commit).")
    cc.add_argument("--commit", required=True, help="Merge commit sha.")
    cc.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    cc.add_argument("--agent", help="Agent id for the cr-merged milestone (default: $WORKFLOW_ROLE).")
    _add_project_dir_arg(cc)
    cc.set_defaults(func=cmd_cr_close)

    cad = sub.add_parser("cycle-add",
                         help="Append a cycle to a plan (POST …/plans/<id>/cycles); "
                              "prints the ASSIGNED numeric id.")
    cad.add_argument("label", help="Label for the new cycle.")
    cad.add_argument("--cr", help="Disambiguate when multiple plans exist.")
    _add_project_dir_arg(cad)
    cad.set_defaults(func=cmd_cycle_add)

    cp = sub.add_parser("checkpoint",
                        help="Checkpoint the resolved OPEN plan (POST …/plans/<id>/checkpoint).")
    cp.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    _add_project_dir_arg(cp)
    cp.set_defaults(func=cmd_checkpoint)

    stp = sub.add_parser("stop",
                         help="Stop the project — checkpoint every open plan "
                              "(POST …/projects/<key>/stop).")
    _add_project_dir_arg(stp)
    stp.set_defaults(func=cmd_stop)

    ab = sub.add_parser("abort",
                        help="Abort the resolved OPEN plan (POST …/plans/<id>/abort). "
                             "Requires --user-approved to pass the server's 409 gate.")
    ab.add_argument("--user-approved", action="store_true",
                    help="Map to body userApproved:true (the server refuses without it).")
    ab.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    _add_project_dir_arg(ab)
    ab.set_defaults(func=cmd_abort)

    for _name in ("status", "plans"):
        sv = sub.add_parser(_name,
                            help="Read the plan queue (GET …/plans) as a TOON-AXI table "
                                 "+ lastRunCr. Read-only; `plans` is an alias of `status`.")
        sv.add_argument("--fields",
                        help="Comma-separated EXTRA columns to add to the minimal "
                             "cr,wave,status,activeCycleId set (§S10).")
        _add_project_dir_arg(sv)
        sv.set_defaults(func=cmd_status)

    gr = sub.add_parser("gate-run",
                        help="axi PROXY: run `no-mistakes axi run`, post throttled interim "
                             "+ final gates, relay the axi detail to the caller.")
    gr.add_argument("--intent", required=True, help="The intent/goal passed down to `axi run`.")
    gr.add_argument("--agent", help="Agent id for the gate events (default: $WORKFLOW_ROLE).")
    _add_project_dir_arg(gr)
    gr.set_defaults(func=cmd_gate_run)

    grp = sub.add_parser("gate-report",
                         help="Report a single already-run gate → POST /api/v2/gates.")
    grp.add_argument("--outcome", required=True,
                     help="Gate outcome (checks-passed|passed|failed|cancelled).")
    grp.add_argument("--commit", help="The pushed commit sha (gate.push.commit).")
    grp.add_argument("--steps", help='Comma-separated "name:status" step results.')
    grp.add_argument("--intent", help="Gate intent (default: derived from --outcome).")
    grp.add_argument("--agent", help="Agent id (default: $WORKFLOW_ROLE).")
    grp.add_argument("--full", action="store_true",
                     help="Emit large text fields (e.g. a server error detail) untruncated (§S11).")
    _add_project_dir_arg(grp)
    grp.set_defaults(func=cmd_gate_report)

    ms = sub.add_parser("milestone", help="POST a workflow milestone → /api/v2/milestones.")
    ms.add_argument("--type", required=True,
                    help="Milestone type (gap-analysis|design-review|stage-flip|custom|cr-merged).")
    ms.add_argument("--label", help="Human-readable milestone label.")
    ms.add_argument("--cr", help="CR id (rides context.cr).")
    ms.add_argument("--commit", help="Optional commit sha.")
    ms.add_argument("--agent", help="Agent id (default: $WORKFLOW_ROLE).")
    _add_project_dir_arg(ms)
    ms.set_defaults(func=cmd_milestone)

    args = p.parse_args()
    # §S14 — no subcommand: run the no-arg live dashboard, not argparse usage.
    if getattr(args, "func", None) is None:
        sys.exit(cmd_dashboard())
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
