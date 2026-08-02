#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Maven + Quarkus Crucible CLI — single entry point for orchestrator + the
java RED/GREEN/FIX/VERIFY agent lifecycle ops AND for running Maven test tiers
(surefire unit, module reactor, failsafe e2e, full regression with JaCoCo).
Replaces inline python / loose curl so each invocation has a stable command
signature (one-time permission approval per signature, not per run).

Java sibling of rust-crucible.py. Tool-specific (Maven / Surefire / Failsafe /
JUnit-XML / JaCoCo), NOT project-specific — the project path + maven dir are
parameterizable, nothing is hardcoded.

The four test tiers (the differentiation this script encodes):
  unit        Targeted surefire run of ONE class/method — the RED/GREEN cycle
              level. `mvn clean test -Dtest=<pattern>`. No coverage.
  module      A whole module's surefire suite (reactor `-pl <module> [-am]`),
              or the single-module service's full unit suite. `mvn clean test`.
              No coverage.
  e2e         Failsafe integration tests (`*IT.java` / @QuarkusIntegrationTest),
              optionally `-Dnative`. `mvn clean verify` (or `failsafe:integration-
              test` against a prebuilt package). No coverage.
  regression  Full reactor suite WITH JaCoCo coverage — the orchestrator
              pre-merge gate. `mvn clean verify` → parse surefire + failsafe +
              jacoco.csv → /api/v2/runs/parsed. Coverage published ONLY here.

Subcommands:
  register, unregister  Agent lifecycle (heartbeat / remove).
  unit                  mvn clean test -Dtest=<pattern> [-pl m]. Surefire ingest.
                        Compile-fail → mvn test-compile → /api/v2/runs/compile.
  module                mvn clean test [-pl <module> [-am]]. Surefire ingest.
  compile               mvn clean test-compile [-pl m]. Ingest output to
                        /api/v2/runs/compile (RED-as-compile-fail path).
  e2e                   mvn clean verify [-Dnative] [-pl m]  (or, with
                        --failsafe-only, mvn failsafe:integration-test). Ingests
                        failsafe (and surefire) results. No coverage. Optional docker.
  regression            mvn clean verify (whole reactor) → surefire + failsafe +
                        jacoco coverage → /api/v2/runs/parsed. ORCHESTRATOR gate.
  auto-ingest           Ingest EXISTING surefire/failsafe reports without running
                        maven (when the caller already ran mvn). Compile fallback.
  docker-up/docker-down docker compose up -d --wait / down -v (compose + services
                        from flags / env / .env; nothing hardcoded).
  pre-merge-gate        docker-up → regression → docker-down (always). One-shot.

Project + Crucible endpoint:
  Reads CRUCIBLE_PROJECT_KEY (a UUID) from <project-dir>/.env.
  Project path: --project-dir > $MVN_CRUCIBLE_PROJECT_DIR > git repo of CWD > CWD.
  Maven dir (where mvnw + target live; e.g. a `backend` subdir):
    --maven-dir > $MVN_CRUCIBLE_MAVEN_DIR > CRUCIBLE_MAVEN_DIR in .env > project dir.
  Optional .env keys: CRUCIBLE_MAVEN_DIR, CRUCIBLE_COMPOSE_FILE,
    CRUCIBLE_DOCKER_SERVICES, CRUCIBLE_BIND_MOUNT_PATHS, CRUCIBLE_COVERAGE_PROFILE.
  Posts to $CRUCIBLE_URL (default http://localhost:3849), v2 endpoints ONLY:
  /api/v2/agents/register|unregister, /api/v2/runs (codec junit),
  /api/v2/runs/parsed, /api/v2/runs/compile.

Examples:
  # UNIT (targeted RED/GREEN) — one class + ingest
  mvn-crucible.py unit --test BusinessEntityServiceTest --agent CR-ES-12-C1-RED

  # MODULE (whole module suite in a reactor)
  mvn-crucible.py module --module runtime --also-make --agent CR-SU-8-C2-GREEN

  # Compile-only (ingest RED compile failure)
  mvn-crucible.py compile --module runtime --agent CR-SU-8-C1-RED

  # E2E (failsafe / @QuarkusIntegrationTest, JVM)
  mvn-crucible.py e2e --agent CR-ES-12-VERIFY --system-prop api.version=1.4.2
  # E2E native (package already built): just run failsafe
  mvn-crucible.py e2e --failsafe-only --native --agent CR-ES-12-VERIFY

  # REGRESSION (orchestrator pre-merge gate, full suite + coverage)
  mvn-crucible.py regression --agent maya

  # Override maven dir (monorepo backend) / project
  mvn-crucible.py unit --maven-dir backend --test FooTest --agent X
  MVN_CRUCIBLE_PROJECT_DIR=/path/to/repo mvn-crucible.py module --agent X
"""

import argparse
import csv
import glob
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

CRUCIBLE_URL = os.environ.get("CRUCIBLE_URL", "http://localhost:3849")
STALE_THRESHOLD_S = 120

# §S2b cadence (CR-CRU-008 _Narrator default) reused by gate-run's interim poll.
_GATE_POLL_CADENCE_S = 2.0
_GATE_POLL_TICK_S = 0.4


# --------------------------------------------------------------------------- #
# Resolution helpers (project dir, maven dir, .env, project key)
# --------------------------------------------------------------------------- #
def _resolve_project_dir(arg_value):
    """--project-dir > $MVN_CRUCIBLE_PROJECT_DIR > git repo of CWD > CWD.

    No project is hardcoded. The `.env` holding CRUCIBLE_PROJECT_KEY must live
    at this resolved root.
    """
    if arg_value:
        return arg_value
    env_value = os.environ.get("MVN_CRUCIBLE_PROJECT_DIR")
    if env_value:
        return env_value
    r = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True
    )
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else os.getcwd()


def _read_env(project_dir):
    """Parse <project-dir>/.env into a dict (ignores blanks/comments). Empty if absent."""
    env = {}
    path = os.path.join(project_dir, ".env")
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


def _resolve_maven_dir(arg_value, project_dir):
    """Where mvnw + target live. --maven-dir > $MVN_CRUCIBLE_MAVEN_DIR >
    CRUCIBLE_MAVEN_DIR in .env > project_dir. Relative values are joined to the
    project root (e.g. `backend` for a monorepo). Nothing hardcoded.
    """
    sub = (
        arg_value
        or os.environ.get("MVN_CRUCIBLE_MAVEN_DIR")
        or _read_env(project_dir).get("CRUCIBLE_MAVEN_DIR")
    )
    if not sub:
        return project_dir
    return sub if os.path.isabs(sub) else os.path.join(project_dir, sub)


def _mvn_base(maven_dir):
    """Prefer the project's `./mvnw` wrapper (all CI uses it); fall back to `mvn`."""
    wrapper = os.path.join(maven_dir, "mvnw")
    if os.path.exists(wrapper) and os.access(wrapper, os.X_OK):
        return ["./mvnw"]
    return ["mvn"]


def _common_mvn_flags(args):
    """Translate the shared CLI knobs into Maven args (order-independent for mvn)."""
    flags = []
    module = getattr(args, "module", None)
    if module:
        flags += ["-pl", module]
        if getattr(args, "also_make", False):
            flags += ["-am"]
    if getattr(args, "update_snapshots", False):
        flags += ["-U"]
    if getattr(args, "native", False):
        flags += ["-Dnative"]
    for prof in getattr(args, "profile", None) or []:
        flags += ["-P", prof]
    for sp in getattr(args, "system_prop", None) or []:
        flags += [f"-D{sp}"]
    return flags


# --------------------------------------------------------------------------- #
# HTTP + process helpers
# --------------------------------------------------------------------------- #
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
    """§S1 envelope context; resolves the project_key from `.env`, then delegates
    to the shared _crucible_axi.axi_context (byte-identical across clients)."""
    return _axi().axi_context(
        _project_key(project_dir), agent_id=agent_id, cr=cr, cycle_id=cycle_id)


def _emit_axi(verb, ok, result_fields, context, warnings, legacy_line=None):
    """Write the §S1 TOON-AXI envelope (delegates to the shared module)."""
    return _axi().emit_axi(verb, ok, result_fields, context, warnings, legacy_line)


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


def _emit_ingest_axi_resp(verb, resp, project_dir, agent):
    """Emit the §S1 envelope for a SERVER-parsed ingest (junit-dir path): run fields
    come from the server response `run`. CR-CRU-050 §S2 — `pending` is printed
    alongside, so the line always sums. CR-CRU-056 §S3 — the client RESOLVES no
    cycle: a bound agent's run is server-stamped with its registered cycle (a
    stale binding gets a 409, surfaced via `error`). C5 — the envelope context
    ECHOES the attachment the SERVER reported (`context.cycleId` on the ingest
    response), so the agent sees which cycle absorbed its evidence without a
    second `GET /api/v2/events`; absent → the key is omitted."""
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


def _emit_ingest_summary_axi(verb, resp, summary, project_dir, agent):
    """Emit the §S1 envelope for a CLIENT-parsed ingest (parsed path): run fields
    come from the client-computed summary. CR-CRU-050 §S2 — `pending` is
    printed alongside, so the line always sums. CR-CRU-056 §S3 — no client-
    resolved cycle; a bound agent's run is server-stamped. C5 — the envelope
    context ECHOES the attachment the SERVER reported (`context.cycleId` on the
    ingest response); absent → the key is omitted."""
    run = {"passed": summary["passed"], "failed": summary["failed"],
           "pending": summary.get("pending", 0),
           "total": summary["total"]}
    context = _axi_context(project_dir, agent_id=agent,
                           cycle_id=_axi().echoed_cycle_id(resp))
    result_fields = {"run": run, "help": _axi().HELP_STEPS.get(verb, ["status"])}
    err = resp.get("error")
    if err is not None:
        result_fields["error"] = err
    _emit_axi(verb, bool(resp.get("ok")), result_fields, context, [])


# ── §S2b (CR-CRU-008) — in-run progress narration (class granularity) ──────

# surefire/failsafe class-start line, e.g. `[INFO] Running com.acme.AlphaTest`.
_MVN_RUNNING_LINE = re.compile(r"(?:^|\s)Running ([A-Za-z_][\w.$]*)\s*$")


def _narrate_heartbeat(project_dir, agent_id, message):
    """§S2b — one narration heartbeat via the v2 register/heartbeat verb (no
    new API; a heartbeat against an already-existing agent journals no
    lifecycle event server-side). Best-effort and silent: never raises, never
    prints — the stdout data pipe stays pure and the run can never fail on a
    narration hiccup.

    Returns the server's response dict (or None when the ping was swallowed),
    so a gated run's `GatedRunIdentity` can read its `changed` flag: a tick
    that RE-CREATES a pruned row makes that row this run's to clean up."""
    try:
        # CR-CRU-044 §S1(a) — narration is a liveness ping, not a
        # re-registration: it goes to the phase-optional heartbeat verb so it
        # never has to re-declare (nor can it blank) the registered phase.
        return _post("/api/v2/agents/heartbeat", {
            "agentId": agent_id,
            "projectKey": _project_key(project_dir),
            "status": "online",
            "message": message,
            "identity": {"displayName": agent_id, "source": "openclaw"},
        })
    except (Exception, SystemExit):
        return None


class _Narrator:
    """§S2b — throttled 'running class N/M' narration for Maven tiers.

    Fed the streamed mvn output line-by-line; counts surefire/failsafe
    `Running <class>` lines. M is the best-known class total: the larger of
    classes seen in the stream and TEST-*.xml reports on disk (surefire writes
    each class's XML as it finishes, so M ratchets toward the true total and
    can never read below N). Throttle, read literally from the spec: FIRST
    update only after ≥2s from the first class start OR ≥10 class starts (a
    sub-window run narrates nothing); later updates ≥2s or ≥10 classes past
    the last posted one. `finish()` posts one replacement heartbeat AFTER the
    final ingest so the narration never outlives the run (mvn tiers keep the
    agent row — there is no bun-style silent removal bracket).
    """

    def __init__(self, post, xml_total, min_seconds=2.0, min_completions=10):
        self._post = post
        self._xml_total = xml_total
        self._min_seconds = min_seconds
        self._min_completions = min_completions
        self._count = 0
        self._first_seen = None   # monotonic ts of the first class start
        self._posted_at = None    # monotonic ts of the last posted update
        self._posted_count = 0
        self.posted = False

    def observe(self, line):
        m = _MVN_RUNNING_LINE.search(line.rstrip("\r\n"))
        if m:
            self._class_started(m.group(1))

    def _class_started(self, class_name):
        now = time.monotonic()
        self._count += 1
        if self._first_seen is None:
            self._first_seen = now
        since = now - (self._posted_at if self._posted_at is not None
                       else self._first_seen)
        if (since < self._min_seconds
                and self._count - self._posted_count < self._min_completions):
            return
        total = max(self._xml_total(), self._count)
        self._post(f"running class {self._count}/{total} · {class_name}")
        self.posted = True
        self._posted_at, self._posted_count = now, self._count

    def finish(self):
        """Replace the narration once the final ingest has landed (ordering:
        call strictly after the ingest POST)."""
        if not self.posted:
            return
        total = max(self._xml_total(), self._count)
        self._post(f"finished {self._count}/{total} test classes — results ingested")


def _run_logged(cmd, cwd, env, log_path, narrator=None):
    """Run `cmd`. If `log_path` set, capture COMBINED stdout+stderr (in order),
    write it to `log_path`, and echo it to stdout so the run stays visible — lets
    an agent read a long mvn run back from a file instead of re-running it
    (per the global rule: grep surefire/failsafe reports, don't re-run).

    §S2b: capture is a STREAMING tail (Popen, line-buffered) — the optional
    `narrator` observes every line live for throttled progress heartbeats —
    while the captured output, log file and echo stay byte-identical to the
    old capture-after-exit behavior. A narrator WITHOUT a log path still
    streams (tailing requires the pipe); the combined output is then echoed on
    completion instead of inheriting stdio.
    """
    if not log_path and narrator is None:
        return subprocess.run(cmd, cwd=cwd, env=env)
    proc = subprocess.Popen(
        cmd, cwd=cwd, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    lines = []
    for line in proc.stdout:
        lines.append(line)
        if narrator is not None:
            narrator.observe(line)
    proc.stdout.close()
    returncode = proc.wait()
    out = "".join(lines)
    if log_path:
        try:
            with open(log_path, "w") as f:
                f.write(out)
            print(f"[crucible] run log → {log_path} ({len(out)} bytes)", file=sys.stderr)
        except OSError as e:
            print(f"[crucible] WARN: could not write run log to {log_path}: {e}",
                  file=sys.stderr)
    sys.stderr.write(out)
    return subprocess.CompletedProcess(cmd, returncode, stdout=out)


# --------------------------------------------------------------------------- #
# Agent lifecycle
# --------------------------------------------------------------------------- #
def cmd_register(args):
    """Register / heartbeat. CR-CRU-056 §S1/§S2 — `--cycle` binds the agent to
    an ACTIVE cycle of an OPEN plan; the server validates the binding and
    REQUIRES it for TDD phases (RED/GREEN/FIX/VERIFY) — a refused registration
    surfaces the server's 409 envelope (error + help) and exits non-zero.
    ORCHESTRATOR/report may register unbound."""
    project_dir = _resolve_project_dir(args.project_dir)
    payload = {
        "agentId": args.agent,
        "projectKey": _project_key(project_dir),
        "status": "online",
        "message": args.message or f"Starting {args.phase} phase",
        # CR-CRU-044 §S1 — the declared phase is part of the registration wire
        # contract (the server rejects a registration that carries none).
        "phase": args.phase,
        # displayName MUST go inside `identity` — top-level is silently ignored.
        "identity": {"displayName": args.agent, "source": "openclaw"},
    }
    if args.cycle is not None:
        payload["cycleId"] = args.cycle
    resp = _post("/api/v2/agents/register", payload)
    ok = bool(resp.get("ok", False))
    legacy = f"register: ok={resp.get('ok', False)} agent={args.agent} phase={args.phase}"
    result_fields = {"agent": args.agent, "help": _axi().HELP_STEPS["register"]}
    err = resp.get("error")
    if err is not None:
        # Faithful pass-through of the server's 409 envelope (error + help[]).
        result_fields["error"] = err
    _emit_axi("register", ok, result_fields,
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
    WITHOUT journaling a lifecycle event. Best-effort: never raises, never
    pollutes the run verdict or stdout. Mirrors clients/bun-crucible.py's
    _remove_agent_silent.

    CR-CRU-056 — call this ONLY for an identity the gated run itself created
    (`_axi().GatedRunIdentity.should_remove`). §S1 stores the cycle binding ON
    the agent row, so removing a CALLER-owned registration destroys that
    caller's binding and the next gated run under the same identity ingests
    unattached."""
    try:
        _post(
            "/api/v2/agents/unregister",
            {"agentId": agent_id, "projectKey": _project_key(project_dir), "silent": True},
        )
    except Exception:
        pass


def _open_gate_identity(project_dir, agent_id, cycle_id, message):
    """CR-CRU-056 — open a gated run's identity and learn whether the run
    CREATED it. One phase-optional heartbeat (never /register: the gated verbs
    declare no phase, and the heartbeat route is the one touch that cannot
    blank a pre-registered caller's phase); `cycle_id` is the verb's `--cycle`,
    validated SERVER-side. The returned `GatedRunIdentity` answers
    `should_remove` for the closing anti-ghost cleanup."""
    identity = _axi().GatedRunIdentity(agent_id, cycle_id)
    resp = _post(identity.PATH,
                 identity.open_payload(_project_key(project_dir), message=message,
                                       source="openclaw"))
    identity.observe(resp)
    if resp.get("error") is not None or not resp.get("ok", False):
        print(_axi().gate_identity_open_failed_line(agent_id, resp.get("error")),
              file=sys.stderr)
    return identity


def _close_gate_identity(project_dir, identity):
    """CR-CRU-056 — the closing half of the bracket: silently remove the agent
    row ONLY when this run created it, and SAY SO either way on stderr so the
    decision is never invisible."""
    if identity is None:
        return
    if not identity.should_remove:
        print(_axi().gate_identity_skipped_line(identity.agent_id, identity.confirmed),
              file=sys.stderr)
        return
    _remove_agent_silent(project_dir, identity.agent_id)
    print(f"cleanup: agent={identity.agent_id} removed (created by this run)",
          file=sys.stderr)


# --------------------------------------------------------------------------- #
# Report discovery + parsing (surefire / failsafe JUnit XML, JaCoCo CSV)
# --------------------------------------------------------------------------- #
def _report_dirs(maven_dir, module, kind):
    """Resolve the `<kind>-reports` dirs to read. `kind` is 'surefire' or
    'failsafe'. With --module → just that module's dir. Otherwise the reactor:
    the maven_dir's own target + every nested module target (multi-module libs).
    """
    name = f"{kind}-reports"
    if module:
        return [os.path.join(maven_dir, module, "target", name)]
    dirs = {os.path.join(maven_dir, "target", name)}
    for p in glob.glob(os.path.join(maven_dir, "**", "target", name), recursive=True):
        dirs.add(p)
    return sorted(dirs)


def _dirs_with_xml(dirs):
    return [d for d in dirs if os.path.isdir(d) and glob.glob(os.path.join(d, "TEST-*.xml"))]


def _warn_if_stale(dirs):
    now = time.time()
    for d in dirs:
        for x in glob.glob(os.path.join(d, "TEST-*.xml")):
            age = now - os.path.getmtime(x)
            if age > STALE_THRESHOLD_S:
                print(f"[crucible] WARN: report looks stale ({int(age)}s old): {x} "
                      "— did the run actually re-write it? (use `clean` to be sure)")
                return


def _parse_junit(dirs):
    """Parse all TEST-*.xml across `dirs` into (summary, tree). Each file's root
    is a <testsuite>; testcases with <failure>/<error> → fail, <skipped> → pending.
    """
    tree_nodes = []
    total = passed = failed = pending = 0
    duration_ms = 0
    for d in dirs:
        for xml_file in sorted(glob.glob(os.path.join(d, "TEST-*.xml"))):
            try:
                root = ET.parse(xml_file).getroot()
            except ET.ParseError as e:
                print(f"[crucible] WARN: unparseable report {xml_file}: {e}")
                continue
            suite_name = root.get("name", os.path.basename(xml_file))
            children = []
            suite_fail = False
            for tc in root.findall("testcase"):
                tc_time = int(float(tc.get("time", 0) or 0) * 1000)
                if tc.find("failure") is not None or tc.find("error") is not None:
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
                "name": suite_name,
                "status": "fail" if suite_fail else "pass",
                "children": children,
            })
    summary = {
        "total": total, "passed": passed, "failed": failed,
        "pending": pending, "duration_ms": duration_ms,
    }
    return summary, tree_nodes


def _collect_jacoco(maven_dir):
    """Sum JaCoCo CSV across the reactor. Prefer the quarkus-jacoco extension
    output (`target/jacoco-report/jacoco.csv`); fall back to the maven-plugin
    output (`target/site/jacoco/jacoco.csv`). Returns a coverage dict or None.

    NOTE: only call this on a FULL GREEN regression — JaCoCo from a partial or
    failed run is incomplete and must NOT be published.
    """
    for rel in ("jacoco-report/jacoco.csv", "site/jacoco/jacoco.csv"):
        files = sorted(set(
            glob.glob(os.path.join(maven_dir, "target", rel))
            + glob.glob(os.path.join(maven_dir, "**", "target", rel), recursive=True)
        ))
        if not files:
            continue
        lt = lc = mt = mc = bt = bc = 0
        for path in files:
            with open(path) as f:
                for row in csv.DictReader(f):
                    lc += int(row.get("LINE_COVERED", 0) or 0)
                    lt += int(row.get("LINE_MISSED", 0) or 0) + int(row.get("LINE_COVERED", 0) or 0)
                    mc += int(row.get("METHOD_COVERED", 0) or 0)
                    mt += int(row.get("METHOD_MISSED", 0) or 0) + int(row.get("METHOD_COVERED", 0) or 0)
                    bc += int(row.get("BRANCH_COVERED", 0) or 0)
                    bt += int(row.get("BRANCH_MISSED", 0) or 0) + int(row.get("BRANCH_COVERED", 0) or 0)
        print(f"[crucible] jacoco: {len(files)} csv file(s) from {rel}")
        return {
            "lines": {"total": lt, "covered": lc, "percent": round(lc / lt * 100, 1) if lt else 0},
            "functions": {"total": mt, "covered": mc, "percent": round(mc / mt * 100, 1) if mt else 0},
            "branches": {"total": bt, "covered": bc, "percent": round(bc / bt * 100, 1) if bt else 0},
        }
    return None


# --------------------------------------------------------------------------- #
# Ingest helpers
# --------------------------------------------------------------------------- #
def _ingest_junit_dir(project_dir, agent, report_dir, tier=None, context=None):
    """Fast path: hand a single reports DIR to Crucible's built-in JUnit parser
    (the v2 junit codec reads a file OR a directory of TEST-*.xml). Returns the
    parsed response dict (the caller emits the §S1 envelope)."""
    payload = {
        "projectKey": _project_key(project_dir),
        "codec": "junit",
        "dataPath": report_dir,
        "agentId": agent,
    }
    if tier:
        payload["tier"] = tier
    ctx = context if context is not None else _run_context()
    if ctx:
        payload["context"] = ctx
    resp = _post("/api/v2/runs", payload)
    s = resp.get("run", {})
    print(f"ingest junit: ok={resp.get('ok')} dir={report_dir} "
          f"passed={s.get('passed')} failed={s.get('failed')} "
          f"pending={s.get('pending', 0)} total={s.get('total')}",
          file=sys.stderr)
    return resp


def _ingest_parsed(project_dir, agent, summary, tree, coverage=None, tier=None,
                   context=None, raw=None):
    """POST a client-parsed run to /api/v2/runs/parsed. Returns the response dict."""
    payload = {
        "projectKey": _project_key(project_dir),
        "agentId": agent,
        "summary": summary,
        "tree": tree,
    }
    if coverage:
        payload["coverage"] = coverage
    if tier:
        payload["tier"] = tier
    ctx = context if context is not None else _run_context()
    if ctx:
        payload["context"] = ctx
    # CR-CRU-038 §S2b — the captured runner output rides along as `raw` so the
    # server-stored run carries real output for the run-detail raw-toggle.
    if raw:
        payload["raw"] = raw
    resp = _post("/api/v2/runs/parsed", payload)
    cov = ""
    if coverage:
        cov = (f" lines={coverage['lines']['percent']}% "
               f"funcs={coverage['functions']['percent']}% "
               f"branches={coverage['branches']['percent']}%")
    print(f"ingest parsed: ok={resp.get('ok')} passed={summary['passed']} "
          f"failed={summary['failed']} pending={summary['pending']} "
          f"total={summary['total']}{cov}", file=sys.stderr)
    return resp


def _ingest_compile(project_dir, agent, output, context=None):
    """Ingest Maven/javac build output. Crucible parses `[ERROR] /path/File.java:
    [line,col] message` into structured per-file errors; raw output kept as fallback.
    """
    err_count = output.count("[ERROR]")
    payload = {
        "projectKey": _project_key(project_dir),
        "agentId": agent,
        "errors": output,
    }
    ctx = context if context is not None else _run_context()
    if ctx:
        payload["context"] = ctx
    resp = _post("/api/v2/runs/compile", payload)
    print(f"ingest compile: ok={resp.get('ok')} error_lines={err_count}", file=sys.stderr)
    return 0 if resp.get("ok") else 1


def _smart_ingest(project_dir, agent, dirs, tier=None, context=None):
    """One reports dir with XML → fast junit-dir path. Many → parse + parsed.
    None → return False so the caller can run the compile fallback.
    """
    existing = _dirs_with_xml(dirs)
    if not existing:
        return False
    _warn_if_stale(existing)
    if len(existing) == 1:
        _ingest_junit_dir(project_dir, agent, existing[0], tier=tier, context=context)
    else:
        summary, tree = _parse_junit(existing)
        _ingest_parsed(project_dir, agent, summary, tree, tier=tier, context=context)
    return True


def _compile_fallback(maven_dir, project_dir, agent, common_flags):
    """No test reports → tests didn't compile. Run `mvn clean test-compile` and
    ingest the build output as a compile failure (the RED-as-compile path)."""
    base = _mvn_base(maven_dir)
    cmd = base + ["clean", "test-compile"] + common_flags
    print(f"[crucible] no reports — capturing compile: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=maven_dir, capture_output=True, text=True)
    output = (result.stdout or "") + (result.stderr or "")
    return _ingest_compile(project_dir, agent, output)


# --------------------------------------------------------------------------- #
# Test-tier commands
# --------------------------------------------------------------------------- #
def _run_surefire_tier(args, goal_extra, label):
    """Shared body for `unit` and `module`: mvn clean test [...], then ingest
    surefire. On no-reports, compile fallback. Surefire only, NEVER coverage."""
    project_dir = _resolve_project_dir(args.project_dir)
    maven_dir = _resolve_maven_dir(args.maven_dir, project_dir)
    common = _common_mvn_flags(args)
    cmd = _mvn_base(maven_dir) + ["clean", "test"] + goal_extra + common
    env = os.environ.copy()
    print(f"[{label}] running: {' '.join(cmd)}  (cwd={maven_dir})")
    narrator = None
    if args.agent:
        # §S2b — tail the run and narrate class-level progress heartbeats.
        module = getattr(args, "module", None)

        def _xml_total():
            return sum(
                len(glob.glob(os.path.join(d, "TEST-*.xml")))
                for d in _report_dirs(maven_dir, module, "surefire")
            )

        narrator = _Narrator(
            lambda message: _narrate_heartbeat(project_dir, args.agent, message),
            _xml_total,
        )
    result = _run_logged(cmd, maven_dir, env, getattr(args, "log", None), narrator)
    print(f"[{label}] mvn exit={result.returncode}")
    if not args.agent:
        return result.returncode
    dirs = _report_dirs(maven_dir, getattr(args, "module", None), "surefire")
    # CR-CRU-056 §S3 — no client-side cycle resolution: a bound agent's run is
    # server-stamped with its registered cycle.
    ctx = _run_context()
    # CR-CRU-008 §S2 tier map: the subcommand name IS the tier (unit/module).
    if _smart_ingest(project_dir, args.agent, dirs, tier=label, context=ctx):
        rc = 0
    else:
        rc = _compile_fallback(maven_dir, project_dir, args.agent, common)
    # §S2b — the final ingest replaces the narration (strictly after it).
    if narrator is not None:
        narrator.finish()
    return rc


def cmd_unit(args):
    """UNIT tier — targeted single class/method (RED/GREEN cycle level)."""
    extra = [f"-Dtest={args.test}"] if args.test else []
    return _run_surefire_tier(args, extra, "unit")


def cmd_module(args):
    """MODULE tier — a whole module's surefire suite (reactor -pl)."""
    return _run_surefire_tier(args, [], "module")


def cmd_compile(args):
    """Compile-only: mvn clean test-compile → ingest /api/v2/runs/compile."""
    project_dir = _resolve_project_dir(args.project_dir)
    maven_dir = _resolve_maven_dir(args.maven_dir, project_dir)
    common = _common_mvn_flags(args)
    cmd = _mvn_base(maven_dir) + ["clean", "test-compile"] + common
    print(f"[compile] running: {' '.join(cmd)}  (cwd={maven_dir})")
    result = subprocess.run(cmd, cwd=maven_dir, capture_output=True, text=True)
    output = (result.stdout or "") + (result.stderr or "")
    sys.stdout.write(output)
    print(f"[compile] mvn exit={result.returncode}")
    if args.agent:
        return _ingest_compile(project_dir, args.agent, output)
    return result.returncode


def _docker_clean_check(maven_dir):
    """Global rule: docker should be clean before native/jvm e2e cycles.
    Informational — list running containers so leftovers from a prior run are
    visible before TestContainers/compose spins up more."""
    try:
        r = subprocess.run(["docker", "ps", "--format", "{{.Names}} ({{.Image}})"],
                           capture_output=True, text=True)
        running = [l for l in r.stdout.splitlines() if l.strip()]
        if running:
            print(f"[crucible] ⚠ {len(running)} docker container(s) already running before e2e:")
            for l in running[:15]:
                print(f"    {l}")
            print("    Confirm these are expected; stale e2e containers can poison the run.")
    except Exception:
        pass


def cmd_e2e(args):
    """E2E tier — failsafe integration tests (*IT.java / @QuarkusIntegrationTest),
    optionally native. No coverage. Optional docker compose lifecycle."""
    project_dir = _resolve_project_dir(args.project_dir)
    maven_dir = _resolve_maven_dir(args.maven_dir, project_dir)
    common = _common_mvn_flags(args)
    _docker_clean_check(maven_dir)

    docker_up = False
    if args.with_docker:
        rc = cmd_docker_up(argparse.Namespace(
            project_dir=args.project_dir, compose_file=args.compose_file,
            no_wait=args.no_wait, services=None, all_services=False, maven_dir=args.maven_dir))
        if rc != 0:
            print("[e2e] docker-up failed — aborting.")
            return rc
        docker_up = True

    e2e_rc = 1
    try:
        if args.failsafe_only:
            # Package assumed already built (e.g. native package step done in CI).
            cmd = _mvn_base(maven_dir) + ["failsafe:integration-test", "failsafe:verify"] + common
        else:
            cmd = _mvn_base(maven_dir) + ["clean", "verify"] + common
        env = os.environ.copy()
        print(f"[e2e] running: {' '.join(cmd)}  (cwd={maven_dir})")
        result = _run_logged(cmd, maven_dir, env, getattr(args, "log", None))
        print(f"[e2e] mvn exit={result.returncode}")
        if not args.agent:
            e2e_rc = result.returncode
        else:
            # Ingest failsafe (the IT results) + surefire (unit run by verify) together.
            fs = _dirs_with_xml(_report_dirs(maven_dir, getattr(args, "module", None), "failsafe"))
            su = _dirs_with_xml(_report_dirs(maven_dir, getattr(args, "module", None), "surefire"))
            dirs = fs + su
            if dirs:
                _warn_if_stale(dirs)
                summary, tree = _parse_junit(dirs)
                _ingest_parsed(project_dir, args.agent, summary, tree, tier="e2e")
                e2e_rc = 0 if summary["failed"] == 0 else 1
            else:
                e2e_rc = _compile_fallback(maven_dir, project_dir, args.agent, common)
    finally:
        if docker_up:
            cmd_docker_down(argparse.Namespace(
                project_dir=args.project_dir, compose_file=args.compose_file,
                maven_dir=args.maven_dir))
    return e2e_rc


def cmd_regression(args):
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
        return _regression_run(args, identity)
    finally:
        _close_gate_identity(project_dir, identity)


def _regression_run(args, identity=None):
    """REGRESSION tier — full reactor suite WITH JaCoCo coverage. Orchestrator
    pre-merge gate. Parses surefire + failsafe + jacoco.csv → /api/v2/runs/parsed.
    Coverage is published ONLY here, and ONLY when zero failures.

    `identity` is the caller's `GatedRunIdentity` (CR-CRU-056): the narration
    ticks report through it, so a tick that re-creates a pruned row hands this
    run ownership of that row.
    """
    project_dir = _resolve_project_dir(args.project_dir)
    maven_dir = _resolve_maven_dir(args.maven_dir, project_dir)
    common = _common_mvn_flags(args)
    # Coverage profile: --coverage-profile or CRUCIBLE_COVERAGE_PROFILE in .env.
    cov_profile = args.coverage_profile or _read_env(project_dir).get("CRUCIBLE_COVERAGE_PROFILE")
    if cov_profile:
        common = common + ["-P", cov_profile]

    cmd = _mvn_base(maven_dir) + ["clean", args.goal] + common
    env = os.environ.copy()
    print(f"[regression] running: {' '.join(cmd)}  (cwd={maven_dir})")
    narrator = None
    if args.agent:
        # §S2b — tail the run and narrate class-level progress heartbeats. This
        # also forces _run_logged's streaming-capture branch so result.stdout is
        # populated for a bare `regression --agent X` (no --log) — the captured
        # runner output rides along as `raw` uniformly, matching _run_surefire_tier.
        def _xml_total():
            return sum(
                len(glob.glob(os.path.join(d, "TEST-*.xml")))
                for d in (_report_dirs(maven_dir, None, "surefire")
                          + _report_dirs(maven_dir, None, "failsafe"))
            )

        def _tick(message):
            # CR-CRU-056 — a tick that RE-CREATES a pruned row makes that row
            # this run's to clean up; `observe` reads the server's `changed`.
            resp = _narrate_heartbeat(project_dir, args.agent, message)
            if identity is not None:
                identity.observe(resp)

        narrator = _Narrator(_tick, _xml_total)
    result = _run_logged(cmd, maven_dir, env, getattr(args, "log", None), narrator)
    print(f"[regression] mvn exit={result.returncode}")

    su = _dirs_with_xml(_report_dirs(maven_dir, None, "surefire"))
    fs = _dirs_with_xml(_report_dirs(maven_dir, None, "failsafe"))
    dirs = su + fs
    if not dirs:
        print("[regression] no surefire/failsafe reports — capturing compile output")
        return _compile_fallback(maven_dir, project_dir, args.agent, common)

    _warn_if_stale(dirs)
    summary, tree = _parse_junit(dirs)

    coverage = None
    if summary["failed"] == 0:
        coverage = _collect_jacoco(maven_dir)
        if coverage is None:
            print("[regression] WARN: no jacoco.csv found — ingesting WITHOUT coverage. "
                  "Check the quarkus-jacoco extension / --coverage-profile.", file=sys.stderr)
    else:
        print(f"[regression] {summary['failed']} failure(s) — NOT publishing coverage "
              "(JaCoCo from a failing run is incomplete).", file=sys.stderr)

    resp = _ingest_parsed(project_dir, args.agent, summary, tree, coverage,
                          tier="regression", context=_run_context(),
                          raw=getattr(result, "stdout", None))
    _emit_ingest_summary_axi("regression", resp, summary, project_dir, args.agent)
    return 0 if (resp.get("ok") and summary["failed"] == 0) else 1


def cmd_test(args):
    """§S2 fleet-uniform test verb — `mvn clean test [-Dtest=…]` → surefire
    junit-dir ingest (/api/v2/runs). With --agent the result is ingested; a bound
    agent's run is server-stamped with its registered cycle."""
    project_dir = _resolve_project_dir(args.project_dir)
    maven_dir = _resolve_maven_dir(args.maven_dir, project_dir)
    common = _common_mvn_flags(args)
    extra = [f"-Dtest={args.test}"] if getattr(args, "test", None) else []
    cmd = _mvn_base(maven_dir) + ["clean", "test"] + extra + common
    env = os.environ.copy()
    print(f"[test] running: {' '.join(cmd)}  (cwd={maven_dir})", file=sys.stderr)
    result = _run_logged(cmd, maven_dir, env, getattr(args, "log", None))
    print(f"[test] mvn exit={result.returncode}", file=sys.stderr)
    if not args.agent:
        return result.returncode
    dirs = _dirs_with_xml(_report_dirs(maven_dir, getattr(args, "module", None), "surefire"))
    if not dirs:
        # No reports → tests didn't compile. Ingest the build output as compile.
        return _compile_fallback(maven_dir, project_dir, args.agent, common)
    _warn_if_stale(dirs)
    ctx = _run_context()
    if len(dirs) == 1:
        resp = _ingest_junit_dir(project_dir, args.agent, dirs[0], tier="unit", context=ctx)
        _emit_ingest_axi_resp("test", resp, project_dir, args.agent)
        failed = (resp.get("run") or {}).get("failed") or 0
    else:
        summary, tree = _parse_junit(dirs)
        resp = _ingest_parsed(project_dir, args.agent, summary, tree, tier="unit", context=ctx)
        _emit_ingest_summary_axi("test", resp, summary, project_dir, args.agent)
        failed = summary["failed"]
    if failed and failed > 0:
        return 1
    return 0 if resp.get("ok") else 1


def cmd_check(args):
    """§S2 fleet-uniform compile gate — `mvn clean test-compile`; on failure ingest
    the build output to /api/v2/runs/compile. Returns the §S1 envelope."""
    project_dir = _resolve_project_dir(args.project_dir)
    maven_dir = _resolve_maven_dir(args.maven_dir, project_dir)
    common = _common_mvn_flags(args)
    cmd = _mvn_base(maven_dir) + ["clean", "test-compile"] + common
    print(f"[check] running: {' '.join(cmd)}  (cwd={maven_dir})", file=sys.stderr)
    result = subprocess.run(cmd, cwd=maven_dir, capture_output=True, text=True)
    output = (result.stdout or "") + (result.stderr or "")
    sys.stderr.write(output)
    print(f"[check] mvn exit={result.returncode}", file=sys.stderr)
    ok = result.returncode == 0
    if not ok and args.agent:
        _ingest_compile(project_dir, args.agent, output)
    legacy = f"check: ok={ok} exit={result.returncode}"
    _emit_axi("check", ok,
              {"exit": result.returncode, "help": _axi().HELP_STEPS["check"]},
              _axi_context(project_dir, agent_id=args.agent), [], legacy)
    return 0 if ok else (result.returncode or 1)


def cmd_auto_ingest(args):
    """Ingest EXISTING surefire/failsafe reports without running maven. A bound
    agent's run is server-stamped with its registered cycle. Compile fallback if
    no reports exist."""
    project_dir = _resolve_project_dir(args.project_dir)
    maven_dir = _resolve_maven_dir(args.maven_dir, project_dir)
    su = _dirs_with_xml(_report_dirs(maven_dir, getattr(args, "module", None), "surefire"))
    fs = _dirs_with_xml(_report_dirs(maven_dir, getattr(args, "module", None), "failsafe"))
    dirs = su + fs
    if not dirs:
        print("[auto-ingest] no reports found", file=sys.stderr)
        return _compile_fallback(maven_dir, project_dir, args.agent, _common_mvn_flags(args))
    _warn_if_stale(dirs)
    ctx = _run_context()
    if len(dirs) == 1 and not args.coverage:
        resp = _ingest_junit_dir(project_dir, args.agent, dirs[0], tier="unit", context=ctx)
        _emit_ingest_axi_resp("auto-ingest", resp, project_dir, args.agent)
    else:
        summary, tree = _parse_junit(dirs)
        coverage = _collect_jacoco(maven_dir) if (args.coverage and summary["failed"] == 0) else None
        resp = _ingest_parsed(project_dir, args.agent, summary, tree, coverage,
                              tier="regression", context=ctx)
        _emit_ingest_summary_axi("auto-ingest", resp, summary, project_dir, args.agent)
    return 0 if resp.get("ok") else 1


# --------------------------------------------------------------------------- #
# Docker (parity with rust-crucible.py; for compose-based e2e, NOT DevServices)
# --------------------------------------------------------------------------- #
def _resolve_compose_file(arg_value, project_dir):
    if arg_value:
        return arg_value
    env = os.environ.get("MVN_CRUCIBLE_COMPOSE_FILE")
    if env:
        return env
    return _read_env(project_dir).get("CRUCIBLE_COMPOSE_FILE")


def _resolve_services(arg_value, project_dir):
    if arg_value:
        return arg_value
    raw = _read_env(project_dir).get("CRUCIBLE_DOCKER_SERVICES", "")
    parsed = [s for s in raw.replace(",", " ").split() if s]
    return parsed or None


def _clean_stale_bind_mounts(project_dir):
    raw = _read_env(project_dir).get("CRUCIBLE_BIND_MOUNT_PATHS", "")
    for path in [p for p in raw.replace(",", " ").split() if p]:
        if not os.path.exists(path):
            continue
        try:
            for entry in os.listdir(path):
                full = os.path.join(path, entry)
                try:
                    if os.path.isfile(full):
                        os.remove(full)
                except PermissionError:
                    subprocess.run(
                        ["docker", "run", "--rm", "-v", f"{path}:/data", "alpine",
                         "sh", "-c", "chmod -R 0777 /data && rm -rf /data/*"],
                        capture_output=True,
                    )
                    break
        except PermissionError:
            pass


def _compose_args(arg_value, project_dir, missing_ok):
    compose_file = _resolve_compose_file(arg_value, project_dir)
    if not compose_file:
        return [], None
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
    cmd = ["docker", "compose", *compose_args, "up", "-d"]
    if not args.no_wait:
        cmd += ["--wait"]
    if not getattr(args, "all_services", False):
        services = _resolve_services(getattr(args, "services", None), project_dir)
        if services:
            cmd += services
    print(f"[docker] {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=project_dir, env=env)
    print(f"[docker] up exit={result.returncode}")
    return result.returncode


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
    """ORCHESTRATOR one-shot: docker-up → regression → docker-down (always)."""
    rc = cmd_docker_up(argparse.Namespace(
        project_dir=args.project_dir, compose_file=args.compose_file,
        no_wait=True, services=None, all_services=False, maven_dir=args.maven_dir))
    if rc != 0:
        print("[pre-merge-gate] docker-up failed — aborting.")
        return rc
    reg_rc = 1
    try:
        reg_rc = cmd_regression(argparse.Namespace(
            project_dir=args.project_dir, maven_dir=args.maven_dir, agent=args.agent,
            module=None, also_make=False, update_snapshots=False, native=False,
            profile=None, system_prop=None, goal=args.goal,
            coverage_profile=args.coverage_profile, log=None,
            cycle=getattr(args, "cycle", None)))
    finally:
        cmd_docker_down(argparse.Namespace(
            project_dir=args.project_dir, compose_file=args.compose_file,
            maven_dir=args.maven_dir))
    return reg_rc


# --------------------------------------------------------------------------- #
# CR-CRU-030 §S4/§S6/§S7/§S8 — plan / cycle / status / gate verbs
# --------------------------------------------------------------------------- #
def cmd_plan_file(args):
    # CR-CRU-056 §S2b — plan-file mutates workflow state, so the registered
    # caller identity is REQUIRED and rides the wire as `agentId`. The same
    # registered id IS the plan's stored orchestrator (the free-text
    # --orchestrator label and its $WORKFLOW_ORCHESTRATOR fallback are
    # retired). Resolve it FIRST: the hard stop must happen before any POST.
    agent_id = _agent_id(args)
    project_dir = _resolve_project_dir(args.project_dir)
    labels = [label.strip() for label in args.cycles.split(",") if label.strip()]
    if not labels:
        sys.exit("[crucible] ERROR: --cycles must name at least one cycle")
    payload = {"cr": args.cr, "agentId": agent_id,
               "cycles": [{"label": label} for label in labels]}
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
    if not args.title:
        wt = _axi().no_title_warning(args.cr)
        warnings.append(wt)
        print(f"warning: {wt['code']} — {wt['detail']}", file=sys.stderr)
    track = os.environ.get("WORKFLOW_ROLE")
    if track:
        payload["track"] = track
    # §S2b — the registered caller is the plan's orchestrator; no free text.
    payload["orchestrator"] = agent_id
    resp = _post(_plans_path(project_dir), payload)
    if not resp.get("ok"):
        legacy = f"plan-file: ok=False error={resp.get('error')}"
        _emit_axi("plan-file", False, {"cr": args.cr},
                  _axi_context(project_dir, agent_id=agent_id, cr=args.cr),
                  warnings, legacy)
        return 1
    cycles = resp.get("cycles", [])
    ids = " ".join(f"{c.get('label')}={c.get('id')}" for c in cycles)
    legacy = (f"plan-file: ok=True planId={resp.get('planId')} cr={resp.get('cr')} "
              f"cycles: {ids}")
    _emit_axi("plan-file", True,
              {"planId": resp.get("planId"), "cr": resp.get("cr"), "cycles": cycles,
               "help": ["cycle-activate <id>"]},
              _axi_context(project_dir, agent_id=agent_id, cr=resp.get("cr") or args.cr),
              warnings, legacy)
    return 0


def _cycle_transition(args, status):
    """Cycle ids are unique per PROJECT — resolve the owning OPEN plan by scanning
    GET …/plans, then PATCH that plan's cycle.

    CR-CRU-056 §S2b — the cycle PATCH requires a live registered caller;
    resolve the identity FIRST so the hard stop precedes any request."""
    agent_id = _agent_id(args)
    project_dir = _resolve_project_dir(args.project_dir)
    cycle_id = args.cycle_id
    open_plans = _open_plans(project_dir)
    target = next(
        (p for p in open_plans
         if any(c.get("id") == cycle_id for c in p.get("cycles", []))),
        None,
    )
    verb = "cycle-activate" if status == "active" else "cycle-done"
    # CR-CRU-048 §S1/§S3 — the `help[]` next step is DERIVED from the resolved
    # plan's own cycle state by the shared `_crucible_axi.cycle_transition_help`
    # (ONE implementation for the whole fleet — the hardcoded per-client ternary
    # is exactly how this defect reached five clients).
    help_steps = _axi().cycle_transition_help(status, target, cycle_id)
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
                  {"status": status, "agentId": agent_id})
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
    # CR-CRU-044 §S5 + CR-CRU-056 §S2b — cr-close PATCHes the plan closed and
    # ends by POSTing a `cr-merged` MILESTONE; both require the registered
    # caller identity. Resolve it FIRST: a hard stop must happen before the
    # plan GET/PATCH, never after the CR has already been closed.
    agent_id = _agent_id(args)
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
                  {"status": "closed", "merge": {"commit": args.commit},
                   "agentId": agent_id})
    ok = resp.get("ok", False)
    cr_label = plan.get("cr")
    legacy = (f"cr-close: ok={ok} plan={plan['planId']} cr={cr_label} "
              f"commit={args.commit}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    _emit_axi("cr-close", bool(ok),
              {"plan": plan["planId"], "cr": cr_label, "commit": args.commit,
               "help": _axi().HELP_STEPS["cr-close"]},
              _axi_context(project_dir, cr=cr_label), [], legacy)
    if not ok:
        return 1
    ms_resp = _post_milestone(
        project_dir, agent_id, "cr-merged",
        label=cr_label, commit=args.commit,
        context=_axi().fleet_context(cr=cr_label) or None,
    )
    print(f"cr-merged: ok={ms_resp.get('ok', False)} cr={cr_label} commit={args.commit}"
          + (f" error={ms_resp.get('error')}" if ms_resp.get("error") else ""),
          file=sys.stderr)
    return 0


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
    """§S4 — append a cycle to a plan. Resolve the target plan (ALL plans, optional
    --cr), POST …/plans/<planId>/cycles with ONLY the label; the SERVER rejects a
    CLOSED/absent plan. The assigned numeric id stays machine-readable.

    CR-CRU-056 §S2b — requires a live registered caller (`--agent`), resolved
    FIRST so the hard stop precedes any request."""
    agent_id = _agent_id(args)
    project_dir = _resolve_project_dir(args.project_dir)
    result_fields = {"label": args.label, "help": _axi().HELP_STEPS["cycle-add"]}
    plan, rc = _resolve_plan_or_emit("cycle-add", project_dir, args.cr,
                                     result_fields, open_only=False)
    if plan is None:
        return rc
    resp = _post(f"{_plans_path(project_dir)}/{plan['planId']}/cycles",
                 {"label": args.label, "agentId": agent_id})
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
    """§S7 — checkpoint the resolved OPEN plan (POST …/plans/<id>/checkpoint).

    CR-CRU-056 §S2b — requires a live registered caller (`--agent`), resolved
    FIRST so the hard stop precedes any request."""
    agent_id = _agent_id(args)
    project_dir = _resolve_project_dir(args.project_dir)
    plan, rc = _resolve_plan_or_emit("checkpoint", project_dir, args.cr,
                                     {"help": _axi().HELP_STEPS["checkpoint"]}, open_only=True)
    if plan is None:
        return rc
    resp = _post(f"{_plans_path(project_dir)}/{plan['planId']}/checkpoint",
                 {"agentId": agent_id})
    ok = resp.get("ok", False)
    legacy = (f"checkpoint: ok={ok} plan={plan['planId']}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    _emit_axi("checkpoint", bool(ok),
              {"plan": plan["planId"], "changed": resp.get("changed"),
               "help": _axi().HELP_STEPS["checkpoint"]},
              _axi_context(project_dir, cr=plan.get("cr")), [], legacy)
    return 0 if ok else 1


def cmd_stop(args):
    """§S7 — project-level stop (POST …/projects/<key>/stop). No plan targeting.

    CR-CRU-056 §S2b — requires a live registered caller (`--agent`), resolved
    FIRST so the hard stop precedes any request."""
    agent_id = _agent_id(args)
    project_dir = _resolve_project_dir(args.project_dir)
    resp = _post(f"/api/v2/projects/{_project_key(project_dir)}/stop",
                 {"agentId": agent_id})
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
    409 refusal stays reachable (surfaced as ok:false + non-zero).

    CR-CRU-056 §S2b — requires a live registered caller (`--agent`), resolved
    FIRST so the hard stop precedes any request."""
    agent_id = _agent_id(args)
    project_dir = _resolve_project_dir(args.project_dir)
    plan, rc = _resolve_plan_or_emit("abort", project_dir, args.cr,
                                     {"help": _axi().HELP_STEPS["abort"]}, open_only=True)
    if plan is None:
        return rc
    resp = _post(f"{_plans_path(project_dir)}/{plan['planId']}/abort",
                 {"userApproved": bool(args.user_approved), "agentId": agent_id})
    ok = resp.get("ok", False)
    legacy = (f"abort: ok={ok} plan={plan['planId']} "
              f"userApproved={bool(args.user_approved)}"
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
        # CR-CRU-035 §S1 — hook-safe tolerant degrade: a plans-fetch failure
        # (server unreachable / non-ok) is a DEFINITIVE unavailable data-state
        # (AXI principle 5), NOT a command error. Emit ok:true + a structured
        # status-unavailable warning + an empty board + a concrete help[]
        # next-step, and exit 0 so a session-start hook can never hang or fail.
        # This state is DISTINCT from the no-plan empty state below (that one
        # carries NO warning) — the status-unavailable warning is the signal.
        detail = (f"could not reach the Crucible server to read the board: "
                  f"{resp.get('error')}")
        legacy = f"[crucible] status: board unavailable — {resp.get('error')}"
        _emit_axi("status", True,
                  {"plans": [], "lastRunCr": None, "count": 0,
                   "help": [f"check the Crucible server is running / reachable "
                            f"at {CRUCIBLE_URL}"]},
                  _axi_context(project_dir),
                  [{"code": "status-unavailable", "detail": detail}],
                  legacy)
        return 0
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


# ── CR-CRU-013 §S5 / §S8 — fleet gate / milestone verbs ─────────────────────


def _agent_id(args):
    """CR-CRU-044 §S5 — the agentId for a fleet event: the identity is
    DECLARED (`--agent`) or the verb FAILS. Delegates to the shared fleet
    resolver so all five clients cannot drift apart again.

    There is no fallback: the old filename-derived default
    (`"mvn-crucible"`) fabricated an identity from this script's own
    filename and planted a phantom row on the dashboard agent rail, and
    $WORKFLOW_ROLE is the TRACK LANE (mainline | track-n), not an identity.
    Raises `_crucible_axi.AgentIdentityRequired`, which `main` converts into
    the ok:false hard-stop envelope + a non-zero exit, POSTing nothing."""
    return _axi().require_agent_id(args)


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
    legacy = (f"gate-run: ok={ok} outcome={final_gate.get('outcome')} "
              f"exit={proc.returncode}"
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


# --------------------------------------------------------------------------- #
# §S14 — no-arg live dashboard
# --------------------------------------------------------------------------- #
_DASHBOARD_PURPOSE_LINE = (
    "mvn-crucible.py -- Maven/Quarkus Crucible CLI "
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
    return cmd_status(argparse.Namespace(project_dir=None, maven_dir=None, fields=None))


# --------------------------------------------------------------------------- #
# argparse wiring
# --------------------------------------------------------------------------- #
def _add_project_args(p):
    p.add_argument("--project-dir",
                   help="Override project root (default: $MVN_CRUCIBLE_PROJECT_DIR, else "
                        "the git repo of CWD). The .env there must hold CRUCIBLE_PROJECT_KEY.")
    p.add_argument("--maven-dir",
                   help="Dir holding mvnw + target, relative to project root (e.g. `backend`). "
                        "Default: $MVN_CRUCIBLE_MAVEN_DIR, else CRUCIBLE_MAVEN_DIR in .env, else root.")


def _add_gate_cycle_arg(p):
    """CR-CRU-056 — `--cycle` on a GATED verb (regression/pre-merge-gate): the
    binding for the register-inside-the-run case."""
    p.add_argument("--cycle", type=int, help=_axi().GATE_CYCLE_HELP)


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


def _add_mvn_flags(p):
    p.add_argument("--module", help="Reactor module to scope to (mvn -pl <module>)")
    p.add_argument("--also-make", action="store_true", help="Add -am (build required upstream modules)")
    p.add_argument("--update-snapshots", action="store_true", help="Add -U (force snapshot update)")
    p.add_argument("--native", action="store_true", help="Add -Dnative (GraalVM native build path)")
    p.add_argument("--profile", action="append", help="Maven profile -P<P> (repeatable)")
    p.add_argument("--system-prop", action="append", metavar="K=V",
                   help="System property -DK=V (repeatable), e.g. api.version=1.4.2")


def _add_log_arg(p):
    p.add_argument("--log", help="Write FULL combined stdout+stderr to this file (also streamed). "
                                 "Lets an agent read a long run back instead of re-running.")


def main():
    p = argparse.ArgumentParser(prog="mvn-crucible", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    # §S14 — subcommand is OPTIONAL: a bare invocation falls through to the
    # no-arg live dashboard, never argparse's required-subcommand error.
    sub = p.add_subparsers(dest="cmd", required=False)

    r = sub.add_parser("register",
                       help="Register / heartbeat an agent. TDD phases must bind a "
                            "cycle with --cycle.")
    r.add_argument("--agent", required=True,
                   help="Agent id — a free-form identifier. The phase is declared by "
                        "--phase and is never inferred from the agentId's shape; any "
                        "CR-<PROJ>-NNN-<cycle>-<PHASE> convention is a naming habit only.")
    # CR-CRU-044 §S3 — phase is first-class DATA: --phase is REQUIRED and
    # enum-constrained (supersedes CR-CRU-008's `default="report"`; pass
    # `--phase report` for a non-TDD registration).
    r.add_argument("--phase",
                   choices=["RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report"],
                   required=True,
                   help="Declared phase — the ONLY phase channel. Use `report` for a "
                        "registration that is not exercising a TDD phase.")
    # CR-CRU-056 §S1/§S2 — cycle binding. Optional at the CLI; the SERVER
    # enforces the per-phase requirement.
    r.add_argument("--cycle", type=int,
                   help="Cycle id to BIND this agent to (an ACTIVE cycle of an OPEN "
                        "plan). TDD phases (RED/GREEN/FIX/VERIFY) MUST bind — the "
                        "server refuses an unbound TDD registration (409). "
                        "ORCHESTRATOR/report may register unbound. A bound agent's "
                        "ingests are server-stamped with this cycle.")
    r.add_argument("--message", help="Optional status message")
    _add_project_args(r)
    r.set_defaults(func=cmd_register)

    u = sub.add_parser("unregister", help="Unregister an agent")
    u.add_argument("--agent", required=True)
    _add_project_args(u)
    u.set_defaults(func=cmd_unregister)

    un = sub.add_parser("unit", help="UNIT tier: mvn clean test -Dtest=<pattern>. Surefire ingest.")
    un.add_argument("--test", help="Surefire -Dtest pattern, e.g. FooTest or FooTest#method or 'Foo*'")
    un.add_argument("--agent", help="If set, ingest surefire (compile-fail → /api/v2/runs/compile)")
    _add_mvn_flags(un)
    _add_project_args(un)
    _add_log_arg(un)
    un.set_defaults(func=cmd_unit)

    mo = sub.add_parser("module", help="MODULE tier: mvn clean test [-pl <module> -am]. Surefire ingest.")
    mo.add_argument("--agent", help="If set, ingest surefire (compile-fail → /api/v2/runs/compile)")
    _add_mvn_flags(mo)
    _add_project_args(mo)
    _add_log_arg(mo)
    mo.set_defaults(func=cmd_module)

    co = sub.add_parser("compile", help="mvn clean test-compile → ingest /api/v2/runs/compile (RED compile path).")
    co.add_argument("--agent", help="If set, ingest the build output as a compile result")
    _add_mvn_flags(co)
    _add_project_args(co)
    co.set_defaults(func=cmd_compile)

    e = sub.add_parser("e2e", help="E2E tier: failsafe IT / @QuarkusIntegrationTest. No coverage.")
    e.add_argument("--agent", help="If set, ingest failsafe+surefire results (parsed, no coverage)")
    e.add_argument("--failsafe-only", action="store_true",
                   help="Run only failsafe:integration-test+verify (package assumed already built, e.g. native)")
    e.add_argument("--with-docker", action="store_true", help="docker compose up/down around the run")
    e.add_argument("--compose-file", default=None, help="Compose file (rel to project root); else .env/auto-discovery")
    e.add_argument("--no-wait", action="store_true", help="docker-up without --wait")
    _add_mvn_flags(e)
    _add_project_args(e)
    _add_log_arg(e)
    e.set_defaults(func=cmd_e2e)

    g = sub.add_parser("regression",
                       help="REGRESSION tier: full reactor mvn clean verify + JaCoCo coverage → parsed.")
    g.add_argument("--agent", required=True, help="Agent id (typically the orchestrator's)")
    g.add_argument("--goal", default="verify", help="Maven goal (default: verify; use test for libs without IT)")
    g.add_argument("--coverage-profile", help="Maven profile that activates JaCoCo (else CRUCIBLE_COVERAGE_PROFILE)")
    _add_gate_cycle_arg(g)
    _add_mvn_flags(g)
    _add_project_args(g)
    _add_log_arg(g)
    g.set_defaults(func=cmd_regression)

    ai = sub.add_parser("auto-ingest", help="Ingest EXISTING surefire/failsafe reports (no mvn run).")
    ai.add_argument("--agent", required=True)
    ai.add_argument("--coverage", action="store_true",
                    help="Also attach JaCoCo (ONLY valid after a known-green full regression)")
    _add_mvn_flags(ai)
    _add_project_args(ai)
    ai.set_defaults(func=cmd_auto_ingest)

    du = sub.add_parser("docker-up", help="docker compose up -d [--wait]. Services from .env or --services.")
    du.add_argument("--compose-file", default=None)
    du.add_argument("--no-wait", action="store_true")
    du.add_argument("--services", nargs="+")
    du.add_argument("--all-services", action="store_true")
    _add_project_args(du)
    du.set_defaults(func=cmd_docker_up)

    dd = sub.add_parser("docker-down", help="docker compose down -v.")
    dd.add_argument("--compose-file", default=None)
    _add_project_args(dd)
    dd.set_defaults(func=cmd_docker_down)

    pmg = sub.add_parser("pre-merge-gate", help="ORCHESTRATOR: docker-up → regression → docker-down.")
    pmg.add_argument("--agent", required=True)
    pmg.add_argument("--compose-file", default=None)
    pmg.add_argument("--goal", default="verify")
    pmg.add_argument("--coverage-profile")
    _add_gate_cycle_arg(pmg)
    _add_project_args(pmg)
    pmg.set_defaults(func=cmd_pre_merge_gate)

    # ── CR-CRU-030 fleet-uniform verbs ──────────────────────────────────────
    te = sub.add_parser("test", help="TEST tier: mvn clean test [-Dtest=<pattern>] → surefire ingest (§S2).")
    te.add_argument("--test", help="Surefire -Dtest pattern, e.g. FooTest or FooTest#method")
    te.add_argument("--agent", help="If set, ingest surefire (bound agents are "
                                    "server-stamped with their registered cycle)")
    _add_mvn_flags(te)
    _add_project_args(te)
    _add_log_arg(te)
    te.set_defaults(func=cmd_test)

    ck = sub.add_parser("check", help="CHECK gate: mvn clean test-compile → ingest /api/v2/runs/compile on failure (§S2).")
    ck.add_argument("--agent", help="If set, ingest the build output as a compile result")
    _add_mvn_flags(ck)
    _add_project_args(ck)
    ck.set_defaults(func=cmd_check)

    pf = sub.add_parser("plan-file",
                        help="File a cycle plan; prints the ASSIGNED numeric cycle ids. "
                             "Requires --agent <registered id> (§S2b).")
    pf.add_argument("--cr", required=True, help="CR id, e.g. CR-CRU-008.")
    pf.add_argument("--title", help="Optional plan title.")
    pf.add_argument("--cycles", required=True, help='Comma-separated cycle labels, e.g. "a,b,c".')
    _add_workflow_agent_arg(
        pf, extra=" The registered id is also stored as the plan's orchestrator "
                  "(the free-text --orchestrator label is retired).")
    pf.add_argument("--wave", help="Wave number (§S3). Resolution: --wave > $WORKFLOW_WAVE.")
    _add_project_args(pf)
    pf.set_defaults(func=cmd_plan_file)

    ca = sub.add_parser("cycle-activate",
                        help="Transition a plan cycle to active. "
                             "Requires --agent <registered id> (§S2b).")
    ca.add_argument("cycle_id", type=int, help="Numeric cycle id (unique per project).")
    _add_workflow_agent_arg(ca)
    _add_project_args(ca)
    ca.set_defaults(func=cmd_cycle_activate)

    cdn = sub.add_parser("cycle-done",
                         help="Transition an ACTIVE plan cycle to done. "
                              "Requires --agent <registered id> (§S2b).")
    cdn.add_argument("cycle_id", type=int, help="Numeric cycle id (unique per project).")
    _add_workflow_agent_arg(cdn)
    _add_project_args(cdn)
    cdn.set_defaults(func=cmd_cycle_done)

    cc = sub.add_parser("cr-close",
                        help="Close the single OPEN plan (PATCH status=closed + merge.commit). "
                             "Requires --agent <registered id> (§S2b).")
    cc.add_argument("--commit", required=True, help="Merge commit sha.")
    cc.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    _add_workflow_agent_arg(
        cc, extra=" The same id posts the closing cr-merged milestone (§S5).")
    _add_project_args(cc)
    cc.set_defaults(func=cmd_cr_close)

    cad = sub.add_parser("cycle-add",
                         help="Append a cycle to a plan (POST …/plans/<id>/cycles); prints the "
                              "ASSIGNED id. Requires --agent <registered id> (§S2b).")
    cad.add_argument("label", help="Label for the new cycle.")
    cad.add_argument("--cr", help="Disambiguate when multiple plans exist.")
    _add_workflow_agent_arg(cad)
    _add_project_args(cad)
    cad.set_defaults(func=cmd_cycle_add)

    cp = sub.add_parser("checkpoint",
                        help="Checkpoint the resolved OPEN plan (POST …/plans/<id>/checkpoint). "
                             "Requires --agent <registered id> (§S2b).")
    cp.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    _add_workflow_agent_arg(cp)
    _add_project_args(cp)
    cp.set_defaults(func=cmd_checkpoint)

    stp = sub.add_parser("stop",
                         help="Stop the project — checkpoint every open plan "
                              "(POST …/projects/<key>/stop). "
                              "Requires --agent <registered id> (§S2b).")
    _add_workflow_agent_arg(stp)
    _add_project_args(stp)
    stp.set_defaults(func=cmd_stop)

    ab = sub.add_parser("abort",
                        help="Abort the resolved OPEN plan (POST …/plans/<id>/abort). Requires "
                             "--user-approved and --agent <registered id> (§S2b).")
    ab.add_argument("--user-approved", action="store_true",
                    help="Map to body userApproved:true (the server refuses without it).")
    ab.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    _add_workflow_agent_arg(ab)
    _add_project_args(ab)
    ab.set_defaults(func=cmd_abort)

    for _name in ("status", "plans"):
        sv = sub.add_parser(_name, help="Read the plan queue (GET …/plans) as a TOON-AXI table + lastRunCr.")
        sv.add_argument("--fields",
                        help="Comma-separated EXTRA columns to add to the minimal "
                             "cr,wave,status,activeCycleId set (§S10).")
        _add_project_args(sv)
        sv.set_defaults(func=cmd_status)

    gr = sub.add_parser("gate-run", help="axi PROXY: run `no-mistakes axi run`, post throttled interim + final gates.")
    gr.add_argument("--intent", required=True, help="The intent/goal passed down to `axi run`.")
    gr.add_argument("--agent", help="Agent id for the gate events — REQUIRED (§S5): the "
                          "identity is declared or the verb fails; there is "
                          "no fallback.")
    _add_project_args(gr)
    gr.set_defaults(func=cmd_gate_run)

    grp = sub.add_parser("gate-report", help="Report a single already-run gate → POST /api/v2/gates.")
    grp.add_argument("--outcome", required=True, help="Gate outcome (checks-passed|passed|failed|cancelled).")
    grp.add_argument("--commit", help="The pushed commit sha (gate.push.commit).")
    grp.add_argument("--steps", help='Comma-separated "name:status" step results.')
    grp.add_argument("--intent", help="Gate intent (default: derived from --outcome).")
    grp.add_argument("--agent", help="Agent id — REQUIRED (§S5): the identity is declared or "
                         "the verb fails; there is no fallback.")
    grp.add_argument("--full", action="store_true",
                     help="Emit large text fields untruncated (§S11).")
    _add_project_args(grp)
    grp.set_defaults(func=cmd_gate_report)

    ms = sub.add_parser("milestone", help="POST a workflow milestone → /api/v2/milestones.")
    ms.add_argument("--type", required=True,
                    help="Milestone type (gap-analysis|design-review|stage-flip|custom|cr-merged).")
    ms.add_argument("--label", help="Human-readable milestone label.")
    ms.add_argument("--cr", help="CR id (rides context.cr).")
    ms.add_argument("--commit", help="Optional commit sha.")
    ms.add_argument("--agent", help="Agent id — REQUIRED (§S5): the identity is declared or "
                         "the verb fails; there is no fallback.")
    _add_project_args(ms)
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
