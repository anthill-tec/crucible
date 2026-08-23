#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
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
  rust-crucible.py register --project-dir /path/to/other/rust/repo --agent foo --role RED
  RUST_CRUCIBLE_PROJECT_DIR=/path/to/other/rust/repo rust-crucible.py register --agent foo --role RED
"""

import argparse
import atexit
import importlib.util
import os
import re
import shutil
import signal
import subprocess
import sys
import time
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


def _request(method, path, payload=None, timeout=None):
    """JSON request to Crucible. Returns parsed JSON, or {ok:False,error} on HTTP/conn error.

    CR-CRU-035 §S1 — `timeout=None` (the default) is UNBOUNDED: ingest POSTs
    (`/api/v2/runs/parsed`) for a large regression/coverage run can legitimately
    take the server >10s, and a short bound there is a false-negative. The short
    hook-safe bound is applied ONLY on the status/plans read path via `_get`.

    CR-CRU-054 §S2 — a thin delegator to the fleet's ONE transport,
    `_crucible_axi.http_request`, which documents the full contract (including
    the §S2b empty-body correction). The local name is kept deliberately: the
    CR-CRU-030 delegation pattern, addressed unqualified by every call site
    here and by the client test harnesses."""
    return _axi().http_request(CRUCIBLE_URL, method, path, payload, timeout)


def _post(path, payload):
    return _request("POST", path, payload)


def _get(path, timeout=10):
    # §S1 — the read path (status/plans) is bounded by a SHORT hook-safe timeout
    # so an unreachable/slow server can't hang a session-start hook forever.
    return _request("GET", path, timeout=timeout)


def _patch(path, payload):
    return _request("PATCH", path, payload)


# ── §S1 shared TOON-AXI envelope module + toon codec (loaded by file path) ──

_TOON_MOD = None
_AXI_MOD = None

# §S2b cadence (CR-CRU-008) reused by gate-run's interim poll.


def _toon():
    """Lazily load the sibling clients/toon.py TOON codec by file path (the
    hyphen-named client is itself loaded by path, so toon.py is not on sys.path)."""
    global _TOON_MOD
    if _TOON_MOD is None:
        toon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "toon.py")
        spec = importlib.util.spec_from_file_location(f"{__name__}_toon", toon_path)
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
        spec = importlib.util.spec_from_file_location(f"{__name__}_axi_shared", axi_path)
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


def _ops():
    """CR-CRU-054 §S2 — this client's own callables, handed to the shared verb
    implementations in `_crucible_axi.py`.

    Built FRESH per call from the module globals so the lifted logic observes a
    test that patches `_post`/`_emit_axi`/`_agent_id` (the fleet's established
    harness idiom) rather than a reference captured at import time."""
    return _axi().ClientOps(
        get=_get, post=_post, patch=_patch,
        emit=_emit_axi, context=_axi_context, agent_id=_agent_id,
        project_key=_project_key, plans_path=_plans_path,
        open_plans=_open_plans, resolve_plan=_resolve_plan_or_emit,
        post_gate=_post_gate, post_milestone=_post_milestone,
        base_url=CRUCIBLE_URL)


def _run_context():
    """CR-CRU-008 §S2 — env + git → run context for declared cycle linkage.

    CR-CRU-054 §S2 — a thin delegator to `_crucible_axi.run_context`, which
    documents the full contract (WORKFLOW_CYCLE/WAVE/ROLE, tolerant git
    provenance, and None — never a bare `{}` — when no workflow env is set).
    The local name is kept deliberately: the CR-CRU-030 delegation pattern,
    addressed unqualified by every call site here and by the client test
    harnesses."""
    return _axi().run_context()


# ── plans path + ingest envelopes ────────────────────────────────────────────


def _plans_path(project_dir):
    """This project's plans-collection URL — CR-CRU-054 §S2 delegator to
    `_crucible_axi.plans_path`. Only the URL TEMPLATE is shared: `_project_key`
    stays client-owned (each client owns its own `.env`/project-dir layout)."""
    return _axi().plans_path(_project_key(project_dir))


def _open_plans(project_dir):
    """This project's open plans — CR-CRU-054 §S2 delegator to
    `_crucible_axi.open_plans`, which owns the status filter and the hard stop
    on a failed plans GET."""
    return _axi().open_plans(_get, _plans_path(project_dir))


def _emit_ingest_axi(verb, resp, project_dir, agent):
    """Emit the §S1 envelope for an ingest verb:
    run{passed,failed,pending,total} (from the SERVER-parsed response).
    CR-CRU-050 §S2 — the server's junit codec already classifies `<skipped/>`
    as pending; the key was simply dropped when printing. CR-CRU-056 §S3 — the
    client RESOLVES no cycle: a bound agent's run is server-stamped with its
    registered cycle (a stale binding gets a 409, surfaced via `error`). C5 —
    the envelope context ECHOES the attachment the SERVER reported
    (`context.cycleId` on the ingest response), so the agent sees which cycle
    absorbed its evidence without a second `GET /api/v2/events`; absent → the
    key is omitted."""
    s = resp.get("run", {}) or {}
    run = {"passed": s.get("passed"), "failed": s.get("failed"),
           "pending": s.get("pending", 0), "total": s.get("total")}
    context = _axi_context(project_dir, agent_id=agent,
                           cycle_id=_axi().echoed_cycle_id(resp))
    result_fields = {"run": run, "help": _axi().HELP_STEPS.get(verb, ["status"])}
    err = resp.get("error")
    if err is not None:
        result_fields["error"] = err
    _emit_axi(verb, bool(resp.get("ok")), result_fields, context, [])


def _clippy_help(ok, errors, lints, scope):
    """CR-CRU-058 §S2 (CR-CRU-048's rule) — the next step for the clippy state
    ACTUALLY reached, never a canned per-verb string: a clean lint run points at
    the next verb, a failing one names the concrete lint count to fix first."""
    if ok:
        return ["test --agent <agentId>", "status"]
    if errors:
        return [f"fix the {errors} clippy error(s) reported for {scope}, "
                f"then re-run", "status"]
    return [f"fix the {lints} clippy warning(s) reported for {scope} "
            f"(-D warnings makes them hard errors), then re-run", "status"]


def _docker_help(action, ok):
    """CR-CRU-058 §S2 — state-derived next step for a compose action."""
    if action == "up":
        if ok:
            return ["smoke-test --with-docker --agent <agentId>", "docker-down"]
        return ["inspect `docker compose logs` for the service that failed to "
                "start / become healthy, then re-run docker-up",
                "docker-down"]
    if ok:
        return ["status"]
    return ["the stack did not tear down cleanly — remove it by hand with "
            "`docker compose down -v`, then re-check",
            "status"]


def _gate_locked_help(verb):
    """CR-CRU-058 §S2 — the run never started because another gate holds the
    lock: the next action is to wait for the holder, not to re-run blindly."""
    return [f"wait for the in-flight gate to finish (gate-lock.sh wait-free), "
            f"then re-run {verb} --agent <agentId>",
            "status"]


def _gate_locked_warning(verb):
    return {
        "code": "gate-locked",
        "detail": (f"{verb} did not start — a gate lock is already held by "
                   f"another regression/smoke run; nothing was built, run or "
                   f"ingested"),
    }


def _disk_abort_help(verb, need_free_g):
    """CR-CRU-058 §S2 — the disk guard hard-aborted BEFORE any cargo work: the
    concrete next action is reclaiming space (or lowering the floor), never the
    verb's normal successor, which would walk straight back into the abort."""
    return [f"reclaim disk on /home (`cargo sweep --time 3`, "
            f"`cargo cache --autoclean`) to clear the {need_free_g}G floor, or "
            f"lower it with --min-free-g N, then re-run {verb}",
            "status"]


def _disk_abort_warning(verb):
    return {
        "code": "disk-guard-abort",
        "detail": (f"{verb} hard-aborted at the pre-run disk guard (CR-245 "
                   f"ENOSPC guard) — no cargo build, no test run and no ingest "
                   f"happened"),
    }


def _docker_up_failed_warning(verb):
    return {
        "code": "docker-up-failed",
        "detail": (f"{verb} aborted: the compose stack never came up, so no "
                   f"tests were run and nothing was ingested"),
    }


def _clippy_gate_abort_warning():
    return {
        "code": "clippy-gate-abort",
        "detail": ("the pre-merge gate stopped at its fail-fast clippy "
                   "-D warnings step — the coverage regression never ran, so "
                   "this gate says NOTHING about the test suite"),
    }


def _parse_junit(junit_path):
    """CR-CRU-058 §S1 — parse a nextest JUnit report CLIENT-side into
    `(summary, tree_nodes, files)`.

    ONE parse for the three rust sites that need client-side counts
    (`_regression_ingest_run`, `_workspace_regression_run`, `_smoke_test`) —
    the envelope's `run:` block cannot come from the ingest response, which
    carries no counts when the server is unreachable.

    `files` is the CR-CRU-051 §S3 distinct-source count via bun's fallback
    chain (`file` → `classname` → suite name), so it can never collapse to 0.
    RESOLVED GRANULARITY FOR THIS CLIENT: **per test BINARY, which is per-FILE
    only for the common `tests/*.rs` layout.** Measured against the real
    cargo-nextest 0.9.130, not assumed: nextest stamps `classname`
    (`crate::test-file-stem`, the test-binary id) on every `<testcase>` and
    NEVER a `file` attribute, so rung 1 of the chain never fires today. Each
    `tests/*.rs` integration file compiles to its own binary, so classname
    coincides with the source file there; several `src/`-embedded unit-test
    modules SHARE one lib test binary and therefore one classname, so the count
    is coarser than per-file for those. Named honestly rather than claiming
    blanket per-file precision. It rides the printed/enveloped line only — it
    never enters `summary`/`payload` (CR-CRU-047 §S2)."""
    root = ET.parse(junit_path).getroot()
    tree_nodes = []
    total = passed = failed = pending = 0
    duration_ms = 0
    files = set()
    # A JUnit root can be <testsuites> (nextest's wrapper) OR a bare
    # <testsuite> — handle both, like the server's junit codec.
    suites = ([root] if root.tag == "testsuite" else []) + root.findall(".//testsuite")
    for suite in suites:
        children = []
        suite_fail = False
        for tc in suite.findall("testcase"):
            source = tc.get("file") or tc.get("classname") or suite.get("name")
            if source:
                files.add(source.replace("\\", "/"))
            tc_time = int(float(tc.get("time", 0)) * 1000)
            fail = tc.find("failure") is not None or tc.find("error") is not None
            # CR-CRU-050 §S1/§S1b — a `<skipped/>` testcase (nextest emits it
            # for `#[ignore]`d tests) is PENDING, never passed. Order matters:
            # failure/error first, then skipped, then pass. A skip does NOT
            # fail its suite. Mirrors mvn-crucible.py:641, the reference.
            if fail:
                status = "fail"
                failed += 1
                suite_fail = True
            elif tc.find("skipped") is not None:
                status = "pending"
                pending += 1
            else:
                status = "pass"
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
        "pending": pending, "duration_ms": duration_ms,
    }
    return summary, tree_nodes, files


def _run_block(summary, files=None):
    """The §S1 `run:` result field an ingest/regression envelope carries. `files`
    (CR-CRU-051) is included ONLY where §S1 names it — the two regression
    verbs — never fabricated for the verbs that have no such count."""
    run = {
        "passed": summary["passed"], "failed": summary["failed"],
        "pending": summary["pending"], "total": summary["total"],
    }
    if files is not None:
        run["files"] = len(files)
    return run


def _parse_lcov(lcov_path):
    """Aggregate line/function coverage out of an lcov report, or None when the
    report is absent."""
    if not os.path.exists(lcov_path):
        return None
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
    return {
        "lines": {
            "total": lf, "covered": lh,
            "percent": round(lh / lf * 100, 1) if lf else 0,
        },
        "functions": {
            "total": ff, "covered": fh,
            "percent": round(fh / ff * 100, 1) if ff else 0,
        },
    }


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
                  f"wait-free and retry. Not starting a second concurrent instance.",
                  file=sys.stderr)
            return False
        why = (f"holder pid {hp} dead or recycled (not a cargo/nextest process)"
               if not holder_live else
               f"lock age {age}s exceeds max {STALE_LOCK_MAX_AGE_S}s — abandoned")
        print(f"[crucible] reclaiming stale gate lock ({why})", file=sys.stderr)
        try:
            os.remove(path)
        except OSError:
            pass
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        print("[crucible] REFUSING to start — lost the create race; another run just started.",
              file=sys.stderr)
        return False
    except OSError as e:
        print(f"[crucible] WARNING: could not create gate lock ({e}); running unlocked.",
              file=sys.stderr)
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
    print(f"[crucible] gate lock created at {path} (owner={agent}, pid={os.getpid()})",
          file=sys.stderr)
    return True


def _run_logged(cmd, cwd, env, log_path):
    """Run `cmd`. If `log_path` is set, capture the COMBINED stdout+stderr (merged
    in order), write it to `log_path`, and echo it to this process's STDERR so the
    caller still sees the run. Returns the `subprocess.CompletedProcess`.

    Used for the streaming run commands (test / smoke-test / workspace-regression)
    so an agent can read the full run output back from a file for debugging — the
    streamed-to-terminal output is otherwise lost.

    CR-CRU-058 §S3 — the echo and both log-status lines go to STDERR, matching
    the rest of the fleet (`python-crucible._run_logged` is the reference): a
    cargo/nextest run's own output on stdout would put megabytes of prose in
    front of the verb's envelope, so stdout would no longer parse as a TOON
    envelope alone. Nothing is lost — the human channel still shows every byte.
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
        print(f"[crucible] run log → {log_path} ({len(out)} bytes)", file=sys.stderr)
    except OSError as e:
        print(f"[crucible] WARN: could not write run log to {log_path}: {e}",
              file=sys.stderr)
    sys.stderr.write(out)  # echo so the run is still visible on the terminal
    return result


def cmd_register(args):
    """Register / heartbeat. CR-CRU-056 §S1/§S2 — `--cycle` binds the agent to
    an ACTIVE cycle of an OPEN plan; the server validates the binding and
    REQUIRES it for TDD roles (RED/GREEN/FIX/VERIFY) — a refused registration
    surfaces the server's 409 envelope (error + help) and exits non-zero.
    ORCHESTRATOR/report may register unbound.

    CR-CRU-054 §S2b — delegates to the shared implementation, which owns the
    §S5 runtime identity hard stop (DN §4 finding #3) and the documented-enum
    `--source` strategy (finding #5)."""
    return _axi().cmd_register(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_unregister(args):
    """Remove this agent's row (journals an 'unregistered' lifecycle event).

    CR-CRU-054 §S2b — delegates to the shared implementation, whose §S5 runtime
    identity hard stop replaced argparse `required=True` (DN §4 finding #3)."""
    return _axi().cmd_unregister(args, _resolve_project_dir(args.project_dir), _ops())


def _remove_agent_silent(project_dir, agent_id):
    """CR-CRU-008 §S4 anti-ghost cleanup for a gated run — CR-CRU-054 §S2b thin
    delegator to `_crucible_axi.remove_agent_silent`, which owns the guarded
    POST and the honest outcome signal (the real response when the server
    answered, None when the call never reached it; DN §4 finding #6)."""
    return _axi().remove_agent_silent(project_dir, agent_id, _ops())


def _open_gate_identity(project_dir, agent_id, cycle_id, message):
    """CR-CRU-056 — open a gated run's identity and learn whether the run
    CREATED it. CR-CRU-054 §S2b — a thin delegator to
    `_crucible_axi.open_gate_identity`, which owns the role-optional heartbeat
    touch and the documented-enum identity `source`."""
    return _axi().open_gate_identity(project_dir, agent_id, cycle_id, message, _ops())


def _close_gate_identity(project_dir, identity):
    """CR-CRU-056 — the closing half of the gated-run bracket. CR-CRU-054 §S2b —
    a thin delegator to `_crucible_axi.close_gate_identity`, which owns the
    ownership gate and the honest cleanup reporting (DN §4 finding #6); this
    module's own silent removal rides along as the client-side seam."""
    return _axi().close_gate_identity(project_dir, identity, _ops(),
                                      remove_fn=_remove_agent_silent)


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
                print(f"[crucible] removed stale junit ({int(age)}s): {p}",
                      file=sys.stderr)
                os.remove(p)


def cmd_auto_ingest(args):
    """Detect: junit XML present → ingest tests. Absent → cargo check stderr → ingest compile."""
    project_dir = _resolve_project_dir(args.project_dir)
    _clean_stale_junit(project_dir)
    ci = f"{project_dir}/target/nextest/ci/junit.xml"
    default = f"{project_dir}/target/nextest/default/junit.xml"
    junit_path = ci if os.path.exists(ci) else (default if os.path.exists(default) else None)

    if junit_path:
        resp = _ingest_junit_axi(project_dir, args.agent, junit_path, tier="unit",
                                 context=_run_context())
        _emit_ingest_axi("auto-ingest", resp, project_dir, args.agent)
        s = resp.get("run", {}) or {}
        return 0 if (resp.get("ok") and (s.get("failed") or 0) == 0) else 1

    # No junit — compile failure path
    cmd = ["cargo", "check", "-p", args.crate]
    if args.features:
        cmd += ["--features", args.features]
    print(f"[crucible] no junit — running: {' '.join(cmd)}", file=sys.stderr)
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
    # CR-CRU-058 §S1/§S3 — this branch used to end in TWO unguarded stdout
    # prints and no emitter at all: the last path in the fleet putting a
    # `[crucible] …` human line on the machine channel, and the only outcome of
    # `auto-ingest` with no envelope behind it. Both human lines are stderr now
    # (the second rides `_emit_axi`'s own legacy_line, so it is printed ONCE),
    # and the branch carries the envelope its junit sibling already emitted.
    #
    # `ok` means the same thing on BOTH branches of this one verb — did the
    # evidence reach the board — matching `_emit_ingest_axi` above and this
    # function's own return code; the BUILD outcome rides `exit`, the shape
    # `cmd_check` and `mvn cmd_compile` already use for a compile envelope.
    # `help[]` is derived from the state ACTUALLY reached (CR-CRU-048's rule),
    # mirroring the shared `run_help`: an unrecorded run points at the server
    # first, a broken build at the errors just ingested, and a clean build with
    # no report at the verb that would produce one.
    ok = bool(resp.get("ok"))
    if not ok:
        help_steps = _axi().server_unreachable_help("auto-ingest", CRUCIBLE_URL)
    elif result.returncode != 0:
        help_steps = [f"fix the {err_count} compile error(s) just ingested to "
                      f"Crucible, then re-run auto-ingest --agent <agentId>",
                      "status"]
    else:
        help_steps = ["no junit report was present and `cargo check` is clean "
                      "— run test --agent <agentId> to produce one", "status"]
    result_fields = {"exit": result.returncode, "help": help_steps}
    err = resp.get("error")
    if err is not None:
        result_fields["error"] = err
    _emit_axi("auto-ingest", ok, result_fields,
              _axi_context(project_dir, agent_id=args.agent,
                           cycle_id=_axi().echoed_cycle_id(resp)),
              [] if ok
              else [_axi().ingest_failed_warning("auto-ingest", CRUCIBLE_URL)],
              f"ingest compile: ok={resp.get('ok')} errors={err_count} "
              f"warnings={warn_count} cargo_exit={result.returncode}")
    return 0 if ok else 1


def cmd_regression_ingest(args):
    """Gated regression run — an opening heartbeat DECLARES the run's identity
    (binding it when `--cycle` is given), and the ingest body is wrapped in an
    anti-ghost silent cleanup (CR-CRU-008 §S4): even a failed/raising run tears
    the identity down, and never touches the retired /api/agents/remove shim.
    CR-CRU-056 — the cleanup fires ONLY for an identity this run created; a
    caller who registered BEFORE the run keeps its registration and binding."""
    project_dir = _resolve_project_dir(args.project_dir)
    identity = None
    try:
        if getattr(args, "agent", None):
            identity = _open_gate_identity(project_dir, args.agent,
                                           getattr(args, "cycle", None),
                                           "gated regression run starting")
        return _regression_ingest_run(args)
    finally:
        _close_gate_identity(project_dir, identity)


def _regression_ingest_run(args):
    """Full regression: cargo clean → llvm-cov nextest → parse junit + lcov → /api/v2/runs/parsed."""
    project_dir = _resolve_project_dir(args.project_dir)
    crates = [c.strip() for c in args.crates.split(",") if c.strip()]

    for c in crates:
        subprocess.run(["cargo", "clean", "-p", c], cwd=project_dir, capture_output=True)
    # §S3 — human narration on stderr; stdout carries the §S1 envelope alone.
    print(f"[crucible] cleaned: {', '.join(crates)}", file=sys.stderr)

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
    print(f"[crucible] llvm-cov nextest exit={result.returncode}", file=sys.stderr)

    junit_path = f"{project_dir}/target/nextest/ci/junit.xml"
    if not os.path.exists(junit_path):
        _emit_axi("regression-ingest", False,
                  {"help": _axi().no_report_help("regression-ingest",
                                                 "junit.xml")},
                  _axi_context(project_dir, agent_id=args.agent),
                  [_axi().no_report_warning(
                      "regression-ingest", "junit.xml", result.returncode,
                      result.stderr or result.stdout or "")],
                  "[crucible] ERROR: no junit.xml after llvm-cov nextest")
        return 1

    # CR-CRU-051 §S3 — the distinct-source `files` count and its resolved
    # GRANULARITY for this client (per test BINARY; per-FILE only for the
    # common `tests/*.rs` layout) are documented in full on `_parse_junit`,
    # the one parse this site shares with `_workspace_regression_run` and the
    # smoke path. It rides the printed/enveloped line only — never
    # `summary`/`payload` (CR-CRU-047 §S2).
    summary, tree_nodes, files = _parse_junit(junit_path)
    passed = summary["passed"]
    failed = summary["failed"]
    pending = summary["pending"]
    total = summary["total"]

    coverage = _parse_lcov(f"{project_dir}/target/lcov.info")

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
    # CR-CRU-038 §S2b — the captured llvm-cov nextest output rides along as
    # `raw` so the server-stored run carries real output for the run-detail
    # raw-toggle to reveal.
    raw = (result.stdout or "") + (result.stderr or "")
    if raw:
        payload["raw"] = raw

    resp = _post("/api/v2/runs/parsed", payload)
    ok = bool(resp.get("ok"))
    cov_line = ""
    if coverage:
        cov_line = (
            f" lines={coverage['lines']['percent']}% "
            f"funcs={coverage['functions']['percent']}%"
        )
    result_fields = {
        "run": _run_block(summary, files),
        "help": _axi().run_help("regression-ingest", ok, failed, CRUCIBLE_URL),
    }
    if coverage:
        result_fields["coverage"] = {
            "lines": coverage["lines"]["percent"],
            "functions": coverage["functions"]["percent"],
        }
    err = resp.get("error")
    if err is not None:
        result_fields["error"] = err
    _emit_axi("regression-ingest", ok, result_fields,
              _axi_context(project_dir, agent_id=args.agent,
                           cycle_id=_axi().echoed_cycle_id(resp)),
              [] if ok else [_axi().ingest_failed_warning(
                  "regression-ingest", CRUCIBLE_URL)],
              f"regression: ok={resp.get('ok')} "
              f"passed={passed} failed={failed} pending={pending} total={total} "
              f"files={len(files)}{cov_line}")
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
        f"passed={s.get('passed')} failed={s.get('failed')} "
        f"pending={s.get('pending', 0)} total={s.get('total')}"
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
    print(f"[crucible] running: {' '.join(cmd)}", file=sys.stderr)
    result = _run_logged(cmd, project_dir, env, getattr(args, "log", None))
    print(f"[crucible] cargo nextest exit={result.returncode}", file=sys.stderr)
    if args.agent:
        # Test may have failed; ingest result regardless (junit captures fail state).
        # Profile-aware: nextest writes junit to target/nextest/<profile>/junit.xml.
        junit_path = _resolve_junit_path(project_dir, args.profile)
        if junit_path:
            resp = _ingest_junit_axi(project_dir, args.agent, junit_path, tier="unit",
                                     context=_run_context())
            _emit_ingest_axi("test", resp, project_dir, args.agent)
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
    # §S3 — the human narration is interactive-only (stderr); stdout carries the
    # §S1 envelope ALONE (this is the CR-CRU-046 deferral, now closed).
    print(f"[crucible] running: {' '.join(cmd)}", file=sys.stderr)
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=project_dir, env=env)
    err_count = result.stderr.count("error[E") + result.stderr.count("error: ")
    warn_count = result.stderr.count("warning:")
    print(f"[crucible] cargo clippy exit={result.returncode} "
          f"errors={err_count} warnings={warn_count}", file=sys.stderr)
    ok = result.returncode == 0
    warnings = []
    rc = result.returncode
    if args.agent:
        ingest_rc = _ingest_rustc_stderr(project_dir, args.agent, result.stderr, kind="clippy")
        if ingest_rc != 0:
            warnings.append(_axi().ingest_failed_warning("clippy", CRUCIBLE_URL))
        rc = ingest_rc
    # §S1 — the lint WARNING count is `lints`, never `warnings`: `emit_axi`
    # unconditionally overwrites `axi["warnings"]` with the STRUCTURED warnings
    # list, so a result field of that name would be clobbered by it.
    _emit_axi("clippy", ok,
              {"exit": result.returncode, "errors": err_count, "lints": warn_count,
               "help": _clippy_help(ok, err_count, warn_count, args.crate)},
              _axi_context(project_dir, agent_id=args.agent), warnings,
              f"clippy: ok={ok} exit={result.returncode} "
              f"errors={err_count} warnings={warn_count}")
    return rc


def cmd_workspace_clippy(args):
    """Standalone workspace clippy — the pre-merge gate's fail-fast step 1, runnable
    on its own (one-pass debt discovery / hotfix verification without the coverage
    run). Same invocation, same ingest."""
    project_dir = _resolve_project_dir(args.project_dir)
    gate = _clippy_workspace_gate(project_dir, args.agent)
    ok = gate["exit"] == 0
    _emit_axi("workspace-clippy", ok,
              {"exit": gate["exit"], "errors": gate["errors"], "lints": gate["lints"],
               "help": _clippy_help(ok, gate["errors"], gate["lints"], "the workspace")},
              _axi_context(project_dir, agent_id=args.agent), gate["warnings"],
              f"workspace-clippy: ok={ok} exit={gate['exit']} "
              f"errors={gate['errors']} warnings={gate['lints']}")
    return gate["exit"]


def _clippy_workspace_gate(project_dir, agent):
    """Workspace `cargo clippy --all-targets --all-features -- -D warnings` gate step.

    Runs as the FIRST, fail-fast step of the pre-merge gate (before the expensive
    llvm-cov coverage run). With `-D warnings` every clippy lint becomes a hard
    error, so a non-zero return aborts the gate. This closes the gap that let
    CR-NAI-297 ship a `needless_return` (CR-200 geo) + `nonminimal_bool` / unused
    imports through a green gate: nextest + llvm-cov never enforce clippy lints, so
    a crate could be test-green yet fail `clippy -D warnings` (and break any
    downstream crate built with `-D warnings`). Ingests stderr to Crucible if `agent`.

    CR-CRU-058 §S1 — this helper NEVER emits: it is a STEP of two envelope-owning
    verbs (`workspace-clippy` standalone, and `pre-merge-gate`'s fail-fast step 0),
    and each must put exactly ONE document on stdout. It returns the measured
    state — `{exit, errors, lints, warnings}` — and its caller emits.
    """
    env = os.environ.copy()
    env.setdefault("CARGO_BUILD_JOBS", WORKSPACE_BUILD_JOBS)  # full-workspace compile — see constant
    cmd = ["cargo", "clippy", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings"]
    # §S3 — every human line here is interactive-only; stdout is the envelope's.
    print(f"[crucible:clippy-gate] running: {' '.join(cmd)}", file=sys.stderr)
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=project_dir, env=env)
    err_count = result.stderr.count("error[E") + result.stderr.count("error: ")
    warn_count = result.stderr.count("warning:")
    print(f"[crucible:clippy-gate] cargo clippy exit={result.returncode} "
          f"errors={err_count} warnings={warn_count}", file=sys.stderr)
    warnings = []
    if agent:
        if _ingest_rustc_stderr(project_dir, agent, result.stderr, kind="clippy") != 0:
            warnings.append(_axi().ingest_failed_warning("workspace clippy", CRUCIBLE_URL))
    if result.returncode != 0:
        tail = "\n".join(result.stderr.strip().splitlines()[-25:])
        print(f"[crucible:clippy-gate] ⛔ ABORT — clippy -D warnings failed:\n{tail}",
              file=sys.stderr)
    return {"exit": result.returncode, "errors": err_count, "lints": warn_count,
            "warnings": warnings}


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
    print(f"[crucible:{label}] disk /home: {line}", file=sys.stderr)
    parts = line.split()
    free_g = int(parts[3].rstrip("G")) if len(parts) >= 4 and parts[3].rstrip("G").isdigit() else None
    if free_g is not None and free_g < min_free_g:
        print(f"[crucible:{label}] ⚠ LOW DISK — {free_g}G free on /home (<{min_free_g}G). A full "
              f"--all-features coverage run can need 100-200G+ of target artifacts; you may hit "
              f"ENOSPC mid-run. Reclaim FIRST (rust-orchestration.md (Disk hygiene), orchestrator-only):",
              file=sys.stderr)
        print("    cargo sweep --time 7      # drop target/ artifacts older than 7 days",
              file=sys.stderr)
        print("    cargo cache --autoclean   # ~/.cargo registry hygiene", file=sys.stderr)
        print("    # btrfs/snapper pinning freed space? sudo snapper -c home list && delete old snapshots",
              file=sys.stderr)
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
        print(f"[crucible:{label}] disk check unavailable — proceeding", file=sys.stderr)
        return True
    print(f"[crucible:{label}] free /home: {free}G (need >= {need_free_g}G)", file=sys.stderr)
    if free >= need_free_g:
        return True
    print(f"[crucible:{label}] low disk — best-effort reclaim (cargo cache --autoclean)",
          file=sys.stderr)
    subprocess.run(["cargo", "cache", "--autoclean"], cwd=project_dir, capture_output=True)
    free2 = _disk_free_g()
    print(f"[crucible:{label}] free after reclaim: {free2}G", file=sys.stderr)
    if free2 is not None and free2 >= need_free_g:
        return True
    print(
        f"[crucible:{label}] ⛔ ABORT — {free2}G free on /home < {need_free_g}G needed for a full\n"
        f"  --all-features coverage / e2e run (CR-245 ENOSPC guard). Reclaim FIRST, then re-run:\n"
        f"    cargo sweep --time 3        # drop stale target artifacts\n"
        f"    cargo cache --autoclean     # ~/.cargo registry hygiene\n"
        f"    sudo snapper -c home list   # btrfs snapshots pin freed extents (root-only)\n"
        f"  (lower the floor with --min-free-g N on a smaller disk.)",
        file=sys.stderr,
    )
    return False


def _reclaim_disk(project_dir, label):
    """Post-heavy-run reclaim (user-directed 2026-05-31): `cargo clean` to release the
    freshly-built --all-features + llvm-cov target/ (~100-200G) on completion of a full
    regression / e2e gate. On btrfs/snapper the files are removed immediately (and won't
    be re-snapshotted), though df may lag until snapshots roll."""
    before = _disk_free_g()
    print(f"[crucible:{label}] post-run reclaim: cargo clean", file=sys.stderr)
    subprocess.run(["cargo", "clean"], cwd=project_dir, capture_output=True)
    after = _disk_free_g()
    if before is not None and after is not None:
        delta = after - before
        if delta > 0:
            print(f"[crucible:{label}] reclaimed ~{delta}G — free now {after}G",
                  file=sys.stderr)
        else:
            print(f"[crucible:{label}] target/ cleaned; df free {after}G "
                  f"(btrfs/snapper may pin freed extents until snapshots roll)",
                  file=sys.stderr)


def cmd_smoke_test(args):
    """Raw workspace nextest run (no llvm-cov). Per rust-orchestration.md (Pre-merge gate, smoke×2).

    Steps: (optional cargo clean) → (optional docker-up) → cargo nextest run
    --workspace [--all-features|--features X] -P <profile> --no-fail-fast →
    parse junit → /api/v2/runs with `codec: junit`. NO coverage.
    """
    return _smoke_test(args, "smoke-test")


def _smoke_test(args, verb):
    """The smoke run body, shared by `smoke-test` and its thin wrapper
    `docker-e2e-gate` (CR-CRU-058 §S1): `verb` names the envelope this run
    belongs to, so the wrapper's stdout carries ONE document under its OWN verb
    rather than the inner verb's."""
    project_dir = _resolve_project_dir(args.project_dir)
    # crucible OWNS the gate-lock FILE: refuse to start if one is already present
    # (no double-runs in a CR/track), else create it + auto-remove on exit/kill.
    if not _acquire_gate_lock(project_dir, getattr(args, "agent", None)):
        _emit_axi(verb, False, {"help": _gate_locked_help(verb)},
                  _axi_context(project_dir, agent_id=getattr(args, "agent", None)),
                  [_gate_locked_warning(verb)],
                  f"{verb}: ok=False — gate-locked")
        return 75  # gate-locked — another regression/smoke run is in progress (retry)

    if args.clean:
        print("[smoke-test] cargo clean (workspace)", file=sys.stderr)
        subprocess.run(["cargo", "clean"], cwd=project_dir, capture_output=True)

    # Disk DECISION before the heavy --all-features e2e/smoke run (user-directed
    # 2026-05-31): measured AFTER any clean. Hard-abort (rc 2) if a full run can't
    # fit, rather than ENOSPC mid-build. No post-run reclaim here — smoke / docker-
    # e2e deliberately reuses the --all-features build across runs (unless --clean).
    if args.all_features:
        if not _disk_guard("smoke-test", project_dir, getattr(args, "min_free_g", 80)):
            _emit_axi(verb, False,
                      {"help": _disk_abort_help(verb,
                                                getattr(args, "min_free_g", 80))},
                      _axi_context(project_dir, agent_id=getattr(args, "agent", None)),
                      [_disk_abort_warning(verb)],
                      f"{verb}: ok=False — aborted by the disk guard")
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
        # The STEP form (no envelope of its own) — this gate owns stdout.
        rc = _docker_up(up_args, project_dir)
        if rc != 0:
            print("[smoke-test] docker-up failed — aborting.", file=sys.stderr)
            _emit_axi(verb, False,
                      {"action": "up", "exit": rc, "help": _docker_help("up", False)},
                      _axi_context(project_dir, agent_id=getattr(args, "agent", None)),
                      [_docker_up_failed_warning(verb)],
                      f"{verb}: ok=False exit={rc} — docker-up failed")
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
        # §S3 — the narration AND the nextest child's own stream are
        # interactive-only (the child inherits stderr, so the run is still
        # watched live); stdout carries the §S1 envelope alone.
        print(f"[smoke-test] running: {' '.join(cmd)}", file=sys.stderr)
        result = subprocess.run(cmd, cwd=project_dir, env=env, stdout=sys.stderr)
        print(f"[smoke-test] cargo nextest exit={result.returncode}", file=sys.stderr)

        # Ingest JUnit regardless of exit code (failed tests still report).
        ci_junit = f"{project_dir}/target/nextest/{args.profile}/junit.xml"
        default_junit = f"{project_dir}/target/nextest/default/junit.xml"
        junit_path = ci_junit if os.path.exists(ci_junit) else (
            default_junit if os.path.exists(default_junit) else None
        )
        if not junit_path:
            _emit_axi(verb, False,
                      {"help": _axi().no_report_help(verb, "junit.xml")},
                      _axi_context(project_dir, agent_id=args.agent),
                      [_axi().no_report_warning(verb, "junit.xml",
                                                result.returncode, "")],
                      "[smoke-test] no junit.xml found — nothing to ingest")
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
        # The `run:` block is parsed CLIENT-side: the ingest response carries no
        # counts when the server could not be reached, and an envelope that
        # reported a real run as empty would be a false negative. §S1 names
        # `files` for the two REGRESSION verbs only — it is not fabricated here.
        summary, _tree, _files = _parse_junit(junit_path)
        smoke_rc = 0 if (resp.get("ok") and s.get("failed", 0) == 0) else 1
        ok = bool(resp.get("ok")) and summary["failed"] == 0
        result_fields = {
            "run": _run_block(summary),
            "help": _axi().run_help(verb, ok, summary["failed"], CRUCIBLE_URL),
        }
        err = resp.get("error")
        if err is not None:
            result_fields["error"] = err
        _emit_axi(verb, ok, result_fields,
                  _axi_context(project_dir, agent_id=args.agent,
                               cycle_id=_axi().echoed_cycle_id(resp)),
                  [] if resp.get("ok")
                  else [_axi().ingest_failed_warning(verb, CRUCIBLE_URL)],
                  f"smoke-test: ok={resp.get('ok')} "
                  f"passed={s.get('passed')} failed={s.get('failed')} "
                  f"pending={s.get('pending', 0)} total={s.get('total')}")
    finally:
        if docker_brought_up:
            down_args = argparse.Namespace(
                project_dir=args.project_dir,
                compose_file=args.compose_file,
            )
            # STEP form — the teardown must not put a second document on stdout.
            _docker_down(down_args, project_dir)

    return smoke_rc


def cmd_workspace_regression(args, verb="workspace-regression"):
    """Full workspace coverage regression — orchestrator pre-merge gate path.

    Steps: cargo clean → DISK GUARD (decide/abort) → cargo llvm-cov nextest --workspace
    [--all-features|--features X] -P <profile> [--ignore-run-fail] --lcov --output-path
    <lcov-output> → parse junit + lcov → /api/v2/runs/parsed → POST-RUN RECLAIM.

    Disk hygiene (user-directed 2026-05-31): clean FIRST, then `_disk_guard` measures
    real post-clean headroom and HARD-ABORTS (rc 2) if a full coverage run can't fit —
    failing fast instead of ENOSPC mid-build (CR-245). On completion (any path) the
    fresh target/ is reclaimed via `cargo clean` unless --keep-target is passed.

    CR-CRU-058 §S1 — `verb` names the envelope this run belongs to: `pre-merge-gate`
    runs this body AS its regression step, so the gate's stdout must carry ONE
    document under the GATE's own verb, not the inner one's.
    """
    project_dir = _resolve_project_dir(args.project_dir)
    # crucible OWNS the gate-lock FILE: refuse to start if one is already present
    # (no double-runs), else create it + auto-remove on exit/kill.
    if not _acquire_gate_lock(project_dir, getattr(args, "agent", None)):
        _emit_axi(verb, False, {"help": _gate_locked_help(verb)},
                  _axi_context(project_dir, agent_id=getattr(args, "agent", None)),
                  [_gate_locked_warning(verb)],
                  f"{verb}: ok=False — gate-locked")
        return 75  # gate-locked — another regression/smoke run is in progress (retry)

    print("[crucible] cargo clean (workspace)", file=sys.stderr)
    subprocess.run(["cargo", "clean"], cwd=project_dir, capture_output=True)

    min_free_g = getattr(args, "min_free_g", 80)
    if not _disk_guard("workspace-regression", project_dir, min_free_g):
        # §S2 — a hard-abort BEFORE any cargo/network work is a genuinely
        # different state from a run that proceeded: its help[] points at
        # reclaiming disk, never at the regression's own successor verb.
        _emit_axi(verb, False, {"help": _disk_abort_help(verb, min_free_g)},
                  _axi_context(project_dir, agent_id=getattr(args, "agent", None)),
                  [_disk_abort_warning(verb)],
                  f"{verb}: ok=False — aborted by the disk guard")
        return 2

    try:
        return _workspace_regression_run(args, project_dir, verb)
    finally:
        if not getattr(args, "keep_target", False):
            _reclaim_disk(project_dir, "workspace-regression")


def _workspace_regression_run(args, project_dir, verb="workspace-regression"):
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
    # §S3 — narration and the llvm-cov child's own stream are interactive-only
    # (the child still inherits stderr, so the run is watched live); stdout
    # carries the §S1 envelope alone.
    print(f"[crucible] running: {' '.join(cmd)}", file=sys.stderr)
    result = subprocess.run(cmd, cwd=project_dir, env=env, stdout=sys.stderr)
    print(f"[crucible] llvm-cov nextest exit={result.returncode}", file=sys.stderr)

    junit_path = f"{project_dir}/target/nextest/{args.profile}/junit.xml"
    if not os.path.exists(junit_path):
        _emit_axi(verb, False,
                  {"help": _axi().no_report_help(verb, "junit.xml")},
                  _axi_context(project_dir, agent_id=args.agent),
                  [_axi().no_report_warning(verb, "junit.xml",
                                            result.returncode, "")],
                  f"[crucible] ERROR: no junit.xml at {junit_path}")
        return 1

    # CR-CRU-051 §S3 — the pre-merge-gate site's own distinct-source `files`
    # count, and its resolved GRANULARITY for this client (per test BINARY;
    # per-FILE only for the common `tests/*.rs` layout), are documented in full
    # on `_parse_junit`, the one parse this site now shares with
    # `_regression_ingest_run`. It rides the printed/enveloped line only —
    # never `summary`/`payload` (CR-CRU-047 §S2).
    summary, tree_nodes, files = _parse_junit(junit_path)
    passed = summary["passed"]
    failed = summary["failed"]
    pending = summary["pending"]
    total = summary["total"]

    coverage = _parse_lcov(f"{project_dir}/{args.lcov_output}")

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
    ok = bool(resp.get("ok"))
    cov_line = ""
    if coverage:
        cov_line = f" lines={coverage['lines']['percent']}% funcs={coverage['functions']['percent']}%"
    result_fields = {
        "run": _run_block(summary, files),
        "help": _axi().run_help(verb, ok, failed, CRUCIBLE_URL),
    }
    if coverage:
        result_fields["coverage"] = {
            "lines": coverage["lines"]["percent"],
            "functions": coverage["functions"]["percent"],
        }
    err = resp.get("error")
    if err is not None:
        result_fields["error"] = err
    _emit_axi(verb, ok, result_fields,
              _axi_context(project_dir, agent_id=args.agent,
                           cycle_id=_axi().echoed_cycle_id(resp)),
              [] if ok else [_axi().ingest_failed_warning(verb, CRUCIBLE_URL)],
              f"workspace regression: ok={resp.get('ok')} "
              f"passed={passed} failed={failed} pending={pending} total={total} "
              f"files={len(files)}{cov_line}")
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
            print(f"[crucible] compose file absent, skipping: {compose_path}",
                  file=sys.stderr)
            return [], 0
        print(f"[crucible] ERROR: compose file not found: {compose_path}", file=sys.stderr)
        return [], 1
    return ["-f", compose_path], None


def cmd_docker_up(args):
    """`docker compose up -d --wait` + the §S1 envelope (action + outcome)."""
    project_dir = _resolve_project_dir(args.project_dir)
    rc = _docker_up(args, project_dir)
    ok = rc == 0
    _emit_axi("docker-up", ok,
              {"action": "up", "exit": rc, "help": _docker_help("up", ok)},
              _axi_context(project_dir), [],
              f"docker-up: ok={ok} exit={rc}")
    return rc


def _docker_up(args, project_dir):
    """The compose bring-up itself — NO envelope, so the gate verbs that use it
    as a STEP (`smoke-test --with-docker`, `docker-e2e-gate`) keep exactly one
    document on stdout (CR-CRU-058 §S1/§S3). `cmd_docker_up` emits."""
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
    # §S3 — the compose narration AND the compose child's own stdout are
    # interactive-only; stdout belongs to the envelope alone.
    print(f"[docker] {' '.join(cmd)}", file=sys.stderr)
    result = subprocess.run(cmd, cwd=project_dir, env=env, stdout=sys.stderr)
    if result.returncode != 0:
        print(f"[docker] up failed: exit={result.returncode}", file=sys.stderr)
        return result.returncode
    print("[docker] up OK", file=sys.stderr)
    return 0


def cmd_docker_down(args):
    """`docker compose down -v` + the §S1 envelope (action + outcome)."""
    project_dir = _resolve_project_dir(args.project_dir)
    rc = _docker_down(args, project_dir)
    ok = rc == 0
    _emit_axi("docker-down", ok,
              {"action": "down", "exit": rc, "help": _docker_help("down", ok)},
              _axi_context(project_dir), [],
              f"docker-down: ok={ok} exit={rc}")
    return rc


def _docker_down(args, project_dir):
    """The compose teardown itself — NO envelope (same step-vs-verb split as
    `_docker_up`); `cmd_docker_down` emits."""
    compose_args, err = _compose_args(args.compose_file, project_dir, missing_ok=True)
    if err is not None:
        return err
    cmd = ["docker", "compose", *compose_args, "down", "-v"]
    print(f"[docker] {' '.join(cmd)}", file=sys.stderr)
    result = subprocess.run(cmd, cwd=project_dir, stdout=sys.stderr)
    print(f"[docker] down exit={result.returncode}", file=sys.stderr)
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
        gate = _clippy_workspace_gate(project_dir, args.agent)
        if gate["exit"] != 0:
            print("[crucible] pre-merge gate FAILED at the clippy -D warnings step — "
                  "skipped the coverage regression. Fix the lints first "
                  "(or --skip-clippy to bypass).", file=sys.stderr)
            # §S2 — the state reached is "aborted at step 0, the regression
            # never ran": the next action is the lints, never the gate's own
            # successor. A passing gate falls through to the regression
            # envelope below, whose help[] is derived from the RUN state.
            _emit_axi("pre-merge-gate", False,
                      {"stage": "clippy", "exit": gate["exit"],
                       "errors": gate["errors"], "lints": gate["lints"],
                       "help": _clippy_help(False, gate["errors"], gate["lints"],
                                            "the workspace")
                               + ["re-run pre-merge-gate --agent <agentId>"]},
                      _axi_context(project_dir, agent_id=args.agent),
                      gate["warnings"] + [_clippy_gate_abort_warning()],
                      f"pre-merge-gate: ok=False exit={gate['exit']} — "
                      f"aborted at the clippy -D warnings step")
            return gate["exit"]

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
    # §S1 — the regression body emits under THIS gate's verb, so the gate puts
    # exactly one envelope on stdout under the name the caller invoked.
    return cmd_workspace_regression(ws_args, verb="pre-merge-gate")


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
        # CR-CRU-064 §S6 — thread the caller's disk-guard floor through; without
        # this `_smoke_test` fell back to an unconditional 80 for this verb.
        min_free_g=getattr(args, "min_free_g", 80),
    )
    # §S1 — same one-document rule as pre-merge-gate: the shared smoke body
    # emits under `docker-e2e-gate`, the verb the caller actually invoked.
    return _smoke_test(smoke_args, "docker-e2e-gate")


# ── CR-CRU-030 §S2/§S4/§S6/§S7 — plan / cycle / status verbs ────────────────


def cmd_plan_file(args):
    """§S4 — file a workflow plan (CR + its cycles). CR-CRU-054 §S2b — delegates
    to the shared implementation, which owns the §S5 identity hard stop, the
    wave/title warnings and `context.cr` on BOTH the success and failure
    envelopes (DN §4 finding #2)."""
    return _axi().cmd_plan_file(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_plan_backfill(args):
    """§S2 — resolve the target plan (single, or --cr) and PATCH its wave (wave-only
    body is closed-plan-safe, so the resolver considers ALL plans).

    CR-CRU-056 §S2b — the plan PATCH requires a live registered caller;
    resolve the identity FIRST so the hard stop precedes any request."""
    agent_id = _agent_id(args)
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
    patch_resp = _patch(f"{_plans_path(project_dir)}/{plan['planId']}",
                        {"wave": args.wave, "agentId": agent_id})
    ok = patch_resp.get("ok", False)
    cr_label = plan.get("cr")
    legacy = (f"plan-backfill: ok={ok} plan={plan['planId']} cr={cr_label} wave={args.wave}"
              + (f" error={patch_resp.get('error')}" if patch_resp.get("error") else ""))
    _emit_axi("plan-backfill", bool(ok),
              {"plan": plan["planId"], "cr": cr_label, "wave": args.wave},
              _axi_context(project_dir, cr=cr_label), [], legacy)
    return 0 if ok else 1


def _cycle_transition(args, status):
    """§S4 — transition a cycle to `status`, resolving its owning OPEN plan
    first. CR-CRU-054 §S2 — delegates to the shared implementation."""
    return _axi().cycle_transition(args, _resolve_project_dir(args.project_dir), _ops(), status)


def cmd_cycle_activate(args):
    return _cycle_transition(args, "active")


def cmd_cycle_done(args):
    return _cycle_transition(args, "done")


def cmd_cr_close(args):
    """§S4c — close the resolved OPEN plan and post the cr-merged milestone,
    requiring a live registered caller. CR-CRU-054 §S2 — delegates to the
    shared implementation."""
    return _axi().cmd_cr_close(args, _resolve_project_dir(args.project_dir), _ops())


def _resolve_plan_or_emit(verb, project_dir, cr, result_fields, open_only):
    """Resolve exactly ONE target plan for a write verb (cycle-add /
    checkpoint / abort), or emit the ok:false envelope and return `(None, 1)`.

    CR-CRU-054 §S2 — a thin delegator to `_crucible_axi.resolve_plan_or_emit`,
    which owns the whole prelude; this client injects only its own transport,
    emitter and resolved plans path."""
    return _axi().resolve_plan_or_emit(
        verb, cr, result_fields, open_only,
        _get, _plans_path(project_dir), _emit_axi,
        lambda: _axi_context(project_dir, cr=cr))


def cmd_cycle_add(args):
    """§S4 — append a cycle to the resolved plan, requiring a live registered
    caller. CR-CRU-054 §S2 — delegates to the shared implementation."""
    return _axi().cmd_cycle_add(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_checkpoint(args):
    """§S7 — checkpoint the resolved OPEN plan, requiring a live registered
    caller. CR-CRU-054 §S2 — delegates to the shared implementation."""
    return _axi().cmd_checkpoint(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_stop(args):
    """§S7 — project-level stop (POST …/projects/<key>/stop), requiring a live
    registered caller. CR-CRU-054 §S2 — delegates to the shared
    implementation."""
    return _axi().cmd_stop(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_abort(args):
    """§S7 — abort the resolved OPEN plan, requiring a live registered caller.
    CR-CRU-054 §S2 — delegates to the shared implementation."""
    return _axi().cmd_abort(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_status(args):
    """§S6 — the plan/status READ verb (alias `plans`, no --agent): GET …/plans
    and return the queue as a uniform-table §S1 envelope plus a top-level
    lastRunCr. CR-CRU-054 §S2 — delegates to the shared implementation."""
    return _axi().cmd_status(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_queue(args):
    """CR-CRU-081 §S2 — the queue READ verb (no --agent): the registered CR
    queue (GET …/queue) plus the CR ids a `cr-merged` milestone covers, the two
    landing-record sources the release ceremony's provenance needs. Delegates
    to the shared implementation."""
    return _axi().cmd_queue(args, _resolve_project_dir(args.project_dir), _ops())


# ── CR-CRU-013 §S5 — fleet gate / milestone verbs ───────────────────────────


def _agent_id(args):
    """CR-CRU-044 §S5 — the agentId for a fleet event: the identity is
    DECLARED (`--agent`) or the verb FAILS. Delegates to the shared fleet
    resolver so all five clients cannot drift apart again.

    There is no fallback: the old filename-derived default
    (`"rust-crucible"`) fabricated an identity from this script's own
    filename and planted a phantom row on the dashboard agent rail, and
    $WORKFLOW_ROLE is the TRACK LANE (mainline | track-n), not an identity.
    Raises `_crucible_axi.AgentIdentityRequired`, which `main` converts into
    the ok:false hard-stop envelope + a non-zero exit, POSTing nothing."""
    return _axi().require_agent_id(args)


def _post_gate(project_dir, agent_id, gate, context=None):
    """POST a gate event (CR-CRU-054 §S2 — delegates to the shared builder)."""
    return _axi().post_gate(_project_key(project_dir), agent_id, gate, _post,
                            context)


def _post_milestone(project_dir, agent_id, mtype, label=None, commit=None,
                    context=None, released_at=None, crs=None, packages=None,
                    repair_provenance=False):
    """POST a workflow milestone (CR-CRU-054 §S2 — delegates to the shared
    builder). CR-CRU-080 §S4 — `released_at`/`crs` carry a release's
    provenance through the same builder. CR-CRU-081 §S3 —
    `repair_provenance` carries the opt-in that CORRECTS an already-recorded
    release instead of replaying it. CR-CRU-084 §S1 — `packages` carries the
    artifacts that release delivered."""
    return _axi().post_milestone(_project_key(project_dir), agent_id, mtype,
                                 _post, label=label, commit=commit,
                                 context=context, released_at=released_at,
                                 crs=crs, packages=packages,
                                 repair_provenance=repair_provenance)


def cmd_gate_report(args):
    """§S8 — report a single already-run gate (flags path), always raising the
    prefer-gate-run discouragement. CR-CRU-054 §S2 — delegates to the shared
    implementation."""
    return _axi().cmd_gate_report(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_gate_run(args):
    """§S8 — axi PROXY wrapper around `no-mistakes axi run`. CR-CRU-054 §S2 —
    delegates to the shared implementation; tool discovery stays HERE (this
    module's own `shutil`) so each client's harness keeps its patch seam."""
    return _axi().cmd_gate_run(
        args, _resolve_project_dir(args.project_dir), shutil.which("no-mistakes"), _ops())


def cmd_milestone(args):
    """POST a workflow milestone. §S4b — CR-CRU-054 §S2b delegator to the shared
    implementation, which writes the legacy line to STDERR so it can never
    corrupt the §S1 envelope stream (DN §4 finding #1)."""
    return _axi().cmd_milestone(args, _resolve_project_dir(args.project_dir), _ops())


_DASHBOARD_PURPOSE_LINE = (
    "rust-crucible.py -- Rust/Cargo Crucible CLI "
    "(agent lifecycle, test/ingest, plan/cycle verbs)."
)


def _abbrev_home(path):
    """Render an absolute path with `~` for the home dir (§S14) — CR-CRU-054 §S2
    delegator to `_crucible_axi.abbrev_home`."""
    return _axi().abbrev_home(path)


def cmd_dashboard():
    """§S14 — a bare invocation (no args) returns the LIVE board: the §S6 status
    dashboard on stdout, plus a one-line tool purpose + the executable path on stderr."""
    print(_DASHBOARD_PURPOSE_LINE, file=sys.stderr)
    print(_abbrev_home(os.path.abspath(__file__)), file=sys.stderr)
    return cmd_status(_axi().status_namespace())


def _add_project_dir_arg(p):
    p.add_argument(
        "--project-dir",
        help="Override project root (default: $RUST_CRUCIBLE_PROJECT_DIR, else the git "
             "repo containing the current directory). The .env at the project root must "
             "contain CRUCIBLE_PROJECT_KEY.",
    )


def _add_gate_cycle_arg(p):
    """CR-CRU-056 — bind `--cycle` on a GATED verb (CR-CRU-054 §S2 — delegates
    to the shared binding so all five clients document it identically)."""
    return _axi().add_gate_cycle_arg(p)


def _add_workflow_agent_arg(p, extra=""):
    """CR-CRU-056 §S2b — the shared `--agent` flag for workflow verbs: every
    mutating workflow verb posts as a LIVE registered caller (`agentId` on the
    wire) and hard-stops client-side when the identity is undeclared."""
    p.add_argument(
        "--agent",
        help="Registered agent id — REQUIRED (§S2b): every workflow verb posts as a "
             "live registered caller; the identity is declared or the verb fails, "
             "with no fallback. An unregistered id is refused by the server (409)."
             + extra,
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

    r = sub.add_parser("register",
                       help="Register / heartbeat an agent. TDD roles must bind a "
                            "cycle with --cycle.")
    # CR-CRU-054 §S2b (DN §4 finding #3) — NOT argparse-required: the §S5
    # runtime hard stop owns the refusal so it arrives as a structured envelope.
    r.add_argument(
        "--agent",
        help="Agent id — a free-form identifier. REQUIRED, but enforced at RUNTIME "
             "by the §S5 hard stop (CR-CRU-054 §S2b) so a missing id yields the "
             "ok:false AXI envelope, not a bare argparse usage error. "
             "The role is declared by --role and "
             "is never inferred from the agentId's shape; any CR-<PROJ>-NNN-<cycle>-<ROLE> "
             "convention is a naming habit only.",
    )
    # CR-CRU-044 §S3 — role is first-class DATA: --role is REQUIRED and
    # enum-constrained (this supersedes CR-CRU-008's `default="report"`
    # ergonomics; pass `--role report` for a non-TDD registration).
    r.add_argument(
        "--role",
        choices=["RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report"],
        required=True,
        help="Declared role — the ONLY role channel. Use `report` for a registration "
             "that is not exercising a TDD role.",
    )
    # CR-CRU-056 §S1/§S2 — cycle binding. Optional at the CLI; the SERVER
    # enforces the per-role requirement.
    r.add_argument(
        "--cycle", type=int,
        help="Cycle id to BIND this agent to (an ACTIVE cycle of an OPEN plan). "
             "TDD roles (RED/GREEN/FIX/VERIFY) MUST bind — the server refuses an "
             "unbound TDD registration (409). ORCHESTRATOR/report may register "
             "unbound. A bound agent's ingests are server-stamped with this cycle.",
    )
    r.add_argument("--source", default="claude-md",
                   choices=["claude-md", "package-json", "git-repo", "manual"],
                   help="Identity discovery source per agent-protocol (default: claude-md)")
    r.add_argument("--message", help="Optional status message")
    _add_project_dir_arg(r)
    r.set_defaults(func=cmd_register)

    u = sub.add_parser("unregister", help="Unregister an agent")
    u.add_argument("--agent",
                   help="Agent id — REQUIRED, but enforced at RUNTIME by the §S5 "
                        "hard stop (CR-CRU-054 §S2b) so a missing id yields "
                        "the ok:false AXI envelope, not a bare argparse "
                        "usage error.")
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
    _add_gate_cycle_arg(g)
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
    e2e.add_argument(
        "--min-free-g", type=int, default=80,
        help="Disk-guard floor in GB before the gate (default: 80).",
    )
    _add_project_dir_arg(e2e)
    e2e.set_defaults(func=cmd_docker_e2e_gate)

    # ── CR-CRU-030 §S2/§S4/§S6/§S7 — plan / cycle / status / gate verbs ──
    pf = sub.add_parser("plan-file",
                        help="File a cycle plan; prints the ASSIGNED numeric cycle ids. "
                             "Requires --agent <registered id> (§S2b).")
    pf.add_argument("--cr", required=True, help="CR id, e.g. CR-NAI-203.")
    pf.add_argument("--title", help="Optional plan title.")
    pf.add_argument("--cycles", required=True,
                    help='Comma-separated cycle labels, e.g. "a,b,c".')
    _add_workflow_agent_arg(
        pf, extra=" The registered id is also stored as the plan's orchestrator "
                  "(the free-text --orchestrator label is retired).")
    pf.add_argument("--wave",
                    help="Wave number (§S3). Resolution: --wave > $WORKFLOW_WAVE.")
    _add_project_dir_arg(pf)
    pf.set_defaults(func=cmd_plan_file)

    pb = sub.add_parser("plan-backfill",
                        help="Backfill a plan's wave (PATCH wave-only; open OR closed). "
                             "Requires --agent <registered id> (§S2b).")
    pb.add_argument("--wave", required=True, help="Wave number to assign.")
    pb.add_argument("--cr", help="Disambiguate when multiple plans exist.")
    _add_workflow_agent_arg(pb)
    _add_project_dir_arg(pb)
    pb.set_defaults(func=cmd_plan_backfill)

    ca = sub.add_parser("cycle-activate",
                        help="Transition a plan cycle to active. "
                             "Requires --agent <registered id> (§S2b).")
    ca.add_argument("cycle_id", type=int, help="Numeric cycle id (unique per project).")
    _add_workflow_agent_arg(ca)
    _add_project_dir_arg(ca)
    ca.set_defaults(func=cmd_cycle_activate)

    cdn = sub.add_parser("cycle-done",
                         help="Transition an ACTIVE plan cycle to done. "
                              "Requires --agent <registered id> (§S2b).")
    cdn.add_argument("cycle_id", type=int, help="Numeric cycle id (unique per project).")
    _add_workflow_agent_arg(cdn)
    _add_project_dir_arg(cdn)
    cdn.set_defaults(func=cmd_cycle_done)

    cc = sub.add_parser("cr-close",
                        help="Close the single OPEN plan (PATCH status=closed + merge.commit). "
                             "Requires --agent <registered id> (§S2b).")
    cc.add_argument("--commit", required=True, help="Merge commit sha.")
    cc.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    _add_workflow_agent_arg(
        cc, extra=" The same id posts the closing cr-merged milestone (§S5).")
    _add_project_dir_arg(cc)
    cc.set_defaults(func=cmd_cr_close)

    cad = sub.add_parser("cycle-add",
                         help="Append a cycle to a plan (POST …/plans/<id>/cycles); "
                              "prints the ASSIGNED numeric id. "
                              "Requires --agent <registered id> (§S2b).")
    cad.add_argument("label", help="Label for the new cycle.")
    cad.add_argument("--cr", help="Disambiguate when multiple plans exist.")
    _add_workflow_agent_arg(cad)
    _add_project_dir_arg(cad)
    cad.set_defaults(func=cmd_cycle_add)

    cp = sub.add_parser("checkpoint",
                        help="Checkpoint the resolved OPEN plan (POST …/plans/<id>/checkpoint). "
                             "Requires --agent <registered id> (§S2b).")
    cp.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    _add_workflow_agent_arg(cp)
    _add_project_dir_arg(cp)
    cp.set_defaults(func=cmd_checkpoint)

    stp = sub.add_parser("stop",
                         help="Stop the project — checkpoint every open plan "
                              "(POST …/projects/<key>/stop). "
                              "Requires --agent <registered id> (§S2b).")
    _add_workflow_agent_arg(stp)
    _add_project_dir_arg(stp)
    stp.set_defaults(func=cmd_stop)

    ab = sub.add_parser("abort",
                        help="Abort the resolved OPEN plan (POST …/plans/<id>/abort). "
                             "Requires --user-approved to pass the server's 409 gate "
                             "and --agent <registered id> (§S2b).")
    ab.add_argument("--user-approved", action="store_true",
                    help="Map to body userApproved:true (the server refuses without it).")
    ab.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    _add_workflow_agent_arg(ab)
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

    # ── CR-CRU-081 §S2 — the landing-record READ verb (no --agent) ──
    qv = sub.add_parser("queue",
                        help="Read the registered CR queue (GET …/queue) plus the "
                             "cr-merged milestone ids as a TOON-AXI table. Read-only.")
    _add_project_dir_arg(qv)
    qv.set_defaults(func=cmd_queue)

    gr = sub.add_parser("gate-run",
                        help="axi PROXY: run `no-mistakes axi run`, post throttled interim "
                             "+ final gates, relay the axi detail to the caller.")
    gr.add_argument("--intent", required=True, help="The intent/goal passed down to `axi run`.")
    gr.add_argument("--agent", help="Agent id for the gate events — REQUIRED (§S5): the "
                          "identity is declared or the verb fails; there is "
                          "no fallback.")
    gr.add_argument("--skip", help="Pipeline steps to skip, forwarded VERBATIM to "
                          "`no-mistakes axi run --skip` (pure passthrough — the "
                          "client never validates or rewrites the value). Exists "
                          "because no-mistakes' `ci` step is PR-based, and a "
                          "git-flow project that merges directly has no PR for it "
                          "to watch — without --skip the gate blocks until "
                          "ci_timeout.")
    _add_project_dir_arg(gr)
    gr.set_defaults(func=cmd_gate_run)

    grp = sub.add_parser("gate-report",
                         help="Report a single already-run gate → POST /api/v2/gates.")
    grp.add_argument("--outcome", required=True,
                     help="Gate outcome (checks-passed|passed|failed|cancelled).")
    grp.add_argument("--commit", help="The pushed commit sha (gate.push.commit).")
    grp.add_argument("--steps", help='Comma-separated "name:status" step results.')
    grp.add_argument("--intent", help="Gate intent (default: derived from --outcome).")
    grp.add_argument("--agent", help="Agent id — REQUIRED (§S5): the identity is declared or "
                         "the verb fails; there is no fallback.")
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
    # CR-CRU-080 §S4 — a release's provenance, computed by the ceremony (the
    # only actor standing in the repo with git in reach).
    ms.add_argument("--released-at", dest="released_at", type=int,
                    help="Release SHIP date: the tag's own commit date in epoch "
                         "SECONDS (`git log -1 --format=%%ct <tag>`), which is "
                         "when the release shipped rather than when it was "
                         "recorded (§S4).")
    ms.add_argument("--crs",
                    help="Comma-separated CR ids the release shipped (the merges "
                         "in its tag range). Only the ids the project's "
                         "registered queue holds are recorded (§S4).")
    # CR-CRU-084 §S1 — WHAT the release delivered, declared by the ceremony:
    # Crucible never verifies a publish, so the pair is a DECLARATION (§S1
    # Non-goals). Absent means "this ceremony said nothing" and the key never
    # reaches the wire; `--packages ""` means "this release delivered none",
    # which is a different and recordable fact (§S3/AC4).
    ms.add_argument("--packages",
                    help="Comma-separated `registry:name:version` entries the "
                         "release DELIVERED, e.g. `pypi:crucible-axi:0.4.0,"
                         "npm:@anthill-tec/crucible-server:0.4.0`. Pass an "
                         "empty string to record that it delivered none "
                         "(§S1/§S3).")
    # CR-CRU-081 §S3 — the OPT-IN correction path: without this flag a
    # re-post of an already-recorded release is the server's dedup replay
    # (CR-CRU-080 §S3), which is what keeps an ordinary run unable to
    # rewrite release history by accident.
    ms.add_argument("--repair-provenance", dest="repair_provenance",
                    action="store_true",
                    help="RE-DERIVE an already-recorded release's provenance "
                         "from this post's --released-at/--crs instead of "
                         "replaying it. Opt-in and non-default; the release's "
                         "version, commit and row are never touched (§S3).")
    ms.add_argument("--agent", help="Agent id — REQUIRED (§S5): the identity is declared or "
                         "the verb fails; there is no fallback.")
    _add_project_dir_arg(ms)
    ms.set_defaults(func=cmd_milestone)

    args = p.parse_args()
    # §S14 — no subcommand: run the no-arg live dashboard, not argparse usage.
    if getattr(args, "func", None) is None:
        sys.exit(cmd_dashboard())
    # CR-CRU-044 §S5 — dispatch through the shared `run_verb`, which turns an
    # UNDECLARED agent identity into the ok:false hard-stop envelope + a
    # non-zero exit (POSTing nothing) instead of an unhandled traceback.
    sys.exit(_axi().run_verb(
        args.func, args,
        lambda a: _project_key(_resolve_project_dir(getattr(a, "project_dir", None)))))


if __name__ == "__main__":
    main()
