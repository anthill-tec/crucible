#!/usr/bin/env python3
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
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
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


def _toon():
    """Lazily load the sibling clients/toon.py TOON codec by file path (the
    hyphen-named client is itself loaded by path, so toon.py is not on sys.path)."""
    global _TOON_MOD
    if _TOON_MOD is None:
        toon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "toon.py")
        spec = importlib.util.spec_from_file_location("mvn_crucible_toon", toon_path)
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
        spec = importlib.util.spec_from_file_location("mvn_crucible_axi_shared", axi_path)
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

    Reads WORKFLOW_CYCLE, WORKFLOW_WAVE and WORKFLOW_ROLE (CR-CRU-036 removed the
    cycle-id env read — the cycle is resolved from the server's active cycle,
    never from the environment). When at least one is set, attaches
    git {branch, commit} from a cheap `git rev-parse` (tolerant of a
    non-repo cwd → omitted). Returns the context dict, or None when no
    workflow env is set. Same pattern as clients/bun-crucible.py.
    """
    context = {}
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


# ── §S9 — active-cycle resolution + register guard + ingest envelopes ────────


def _ingest_context(cycle_id):
    """§S9 — the ingest payload's `context`: env/git `_run_context()` enriched with
    the RESOLVED cycleId so the SERVER-recorded run carries the attach cycle."""
    context = _run_context() or {}
    if cycle_id is not None:
        context["cycleId"] = cycle_id
    return context or None


def _plans_path(project_dir):
    return f"/api/v2/projects/{_project_key(project_dir)}/plans"


def _open_plans(project_dir):
    resp = _get(_plans_path(project_dir))
    if not resp.get("ok"):
        sys.exit(f"[crucible] ERROR: could not list plans: {resp.get('error')}")
    return [p for p in resp.get("plans", []) if p.get("status") == "open"]


def _plans_response(project_dir):
    """Raw `GET .../plans` response, tolerant of any transport failure (a raised
    exception / non-dict is normalised to a not-ok dict so `resolve_attach_cycle`
    treats it as the tolerant fetch-failure case, never a definitive withhold)."""
    try:
        resp = _get(_plans_path(project_dir))
    except Exception:
        return {"ok": False, "error": "plans fetch raised"}
    return resp if isinstance(resp, dict) else {"ok": False, "error": "non-dict plans response"}


def _resolve_ingest_cycle(project_dir):
    """CR-CRU-036 §S9 — resolve the cycle an --agent ingest attaches to FROM THE
    SERVER (the open plan's single `status:"active"` cycle); no cycle-id env
    override is read. Returns (cycle_id, warnings, withhold): a valid cycle or a
    tolerant (None,[],False) proceed; (None,[warning],True) ONLY when an OPEN plan
    carries no active cycle — the caller MUST emit ok:false and SKIP the POST."""
    return _axi().resolve_attach_cycle(_plans_response(project_dir))


def _register_cycle_guard(project_dir):
    """CR-CRU-036 §S9 — register mirrors the ingest withhold: an OPEN plan with no
    active cycle withholds registration rather than bring an agent online against
    untracked work. A plans-fetch failure or no open plan at all is TOLERANT
    (register proceeds). Returns (withhold, warnings)."""
    _cycle, warnings, withhold = _axi().resolve_attach_cycle(_plans_response(project_dir))
    return withhold, warnings


def _emit_ingest_axi_resp(verb, resp, project_dir, agent, cycle_id, warnings):
    """Emit the §S1 envelope for a SERVER-parsed ingest (junit-dir path): run fields
    come from the server response `run`."""
    s = resp.get("run", {}) or {}
    run = {"passed": s.get("passed"), "failed": s.get("failed"), "total": s.get("total")}
    if cycle_id is not None:
        context = _axi_context(project_dir, agent_id=agent, cycle_id=cycle_id)
    else:
        context = _axi_context(project_dir, agent_id=agent)
    for w in warnings:
        print(f"warning: {w['code']} — {w['detail']}", file=sys.stderr)
    _emit_axi(verb, bool(resp.get("ok")),
              {"run": run, "help": _axi().HELP_STEPS.get(verb, ["status"])},
              context, warnings)


def _emit_ingest_summary_axi(verb, resp, summary, project_dir, agent, cycle_id, warnings):
    """Emit the §S1 envelope for a CLIENT-parsed ingest (parsed path): run fields
    come from the client-computed summary."""
    run = {"passed": summary["passed"], "failed": summary["failed"],
           "total": summary["total"]}
    # Tolerant path (no open plan / fetch failure) resolves cycle_id=None → OMIT
    # the cycleId key rather than emit an orphan-signalling explicit null.
    if cycle_id is not None:
        context = _axi_context(project_dir, agent_id=agent, cycle_id=cycle_id)
    else:
        context = _axi_context(project_dir, agent_id=agent)
    for w in warnings:
        print(f"warning: {w['code']} — {w['detail']}", file=sys.stderr)
    _emit_axi(verb, bool(resp.get("ok")),
              {"run": run, "help": _axi().HELP_STEPS.get(verb, ["status"])},
              context, warnings)


def _emit_ingest_withhold(verb, project_dir, agent, warnings):
    """§S9 — emit the ok:false envelope (cycleId=null) on stdout AND stderr when an
    OPEN plan carries no active cycle to attach an ingest to. The run is NOT POSTed
    (no cycleId=NONE orphan)."""
    context = _axi_context(project_dir, agent_id=agent, cycle_id=None)
    for w in warnings:
        print(_axi().withhold_stderr_line(w), file=sys.stderr)
    _emit_axi(verb, False, {}, context, warnings)


# ── §S2b (CR-CRU-008) — in-run progress narration (class granularity) ──────

# surefire/failsafe class-start line, e.g. `[INFO] Running com.acme.AlphaTest`.
_MVN_RUNNING_LINE = re.compile(r"(?:^|\s)Running ([A-Za-z_][\w.$]*)\s*$")


def _narrate_heartbeat(project_dir, agent_id, message):
    """§S2b — one narration heartbeat via the v2 register/heartbeat verb (no
    new API; a heartbeat against an already-existing agent journals no
    lifecycle event server-side). Best-effort and silent: never raises, never
    prints — the stdout data pipe stays pure and the run can never fail on a
    narration hiccup."""
    try:
        _post("/api/v2/agents/register", {
            "agentId": agent_id,
            "projectKey": _project_key(project_dir),
            "status": "online",
            "message": message,
            "identity": {"displayName": agent_id, "source": "openclaw"},
        })
    except (Exception, SystemExit):
        pass


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
    """Register / heartbeat. CR-CRU-036 §S9: an OPEN plan with no active cycle
    WARNS + WITHHOLDS — the agent must never come online against an untracked
    plan; the POST is withheld and the exit code is non-zero. A plans-fetch
    failure or no open plan at all is tolerant (register proceeds)."""
    project_dir = _resolve_project_dir(args.project_dir)
    withhold, warnings = _register_cycle_guard(project_dir)
    if withhold:
        for w in warnings:
            print(_axi().withhold_stderr_line(w), file=sys.stderr)
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
        # displayName MUST go inside `identity` — top-level is silently ignored.
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
    registration). Best-effort: never raises, never pollutes the run verdict or
    stdout. Mirrors clients/bun-crucible.py's _remove_agent_silent."""
    try:
        _post(
            "/api/v2/agents/unregister",
            {"agentId": agent_id, "projectKey": _project_key(project_dir), "silent": True},
        )
    except Exception:
        pass


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
          f"passed={s.get('passed')} failed={s.get('failed')} total={s.get('total')}",
          file=sys.stderr)
    return resp


def _ingest_parsed(project_dir, agent, summary, tree, coverage=None, tier=None,
                   context=None):
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
    # CR-CRU-036 §S9 — resolve the attach cycle BEFORE ingesting so a
    # no-active-cycle run withholds WITHOUT posting a cycleId=null orphan, and a
    # tracked run carries the SERVER-resolved cycleId in its context.
    cycle_id, warnings, withhold = _resolve_ingest_cycle(project_dir)
    if withhold:
        _emit_ingest_withhold(label, project_dir, args.agent, warnings)
        if narrator is not None:
            narrator.finish()
        return 1
    ctx = _ingest_context(cycle_id)
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
    """Gated regression run — wraps the ingest body in an anti-ghost silent
    cleanup (CR-CRU-008 §S4): even a failed/raising run removes the implicitly
    registered agent, and never touches the retired /api/agents/remove shim."""
    project_dir = _resolve_project_dir(args.project_dir)
    try:
        return _regression_run(args)
    finally:
        if getattr(args, "agent", None):
            _remove_agent_silent(project_dir, args.agent)


def _regression_run(args):
    """REGRESSION tier — full reactor suite WITH JaCoCo coverage. Orchestrator
    pre-merge gate. Parses surefire + failsafe + jacoco.csv → /api/v2/runs/parsed.
    Coverage is published ONLY here, and ONLY when zero failures.
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
    result = _run_logged(cmd, maven_dir, env, getattr(args, "log", None))
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

    # §S9 — resolve/attach the active cycle before the POST (withhold when none).
    cycle_id, warnings, withhold = _resolve_ingest_cycle(project_dir)
    if withhold:
        _emit_ingest_withhold("regression", project_dir, args.agent, warnings)
        return 1
    resp = _ingest_parsed(project_dir, args.agent, summary, tree, coverage,
                          tier="regression", context=_ingest_context(cycle_id))
    _emit_ingest_summary_axi("regression", resp, summary, project_dir, args.agent,
                             cycle_id, warnings)
    return 0 if (resp.get("ok") and summary["failed"] == 0) else 1


def cmd_test(args):
    """§S2 fleet-uniform test verb — `mvn clean test [-Dtest=…]` → surefire
    junit-dir ingest (/api/v2/runs). With --agent §S9 auto-attaches to the active
    cycle; a no-active-cycle run withholds WITHOUT ingesting a cycleId=null orphan."""
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
    cycle_id, warnings, withhold = _resolve_ingest_cycle(project_dir)
    if withhold:
        _emit_ingest_withhold("test", project_dir, args.agent, warnings)
        return 1
    ctx = _ingest_context(cycle_id)
    if len(dirs) == 1:
        resp = _ingest_junit_dir(project_dir, args.agent, dirs[0], tier="unit", context=ctx)
        _emit_ingest_axi_resp("test", resp, project_dir, args.agent, cycle_id, warnings)
        failed = (resp.get("run") or {}).get("failed") or 0
    else:
        summary, tree = _parse_junit(dirs)
        resp = _ingest_parsed(project_dir, args.agent, summary, tree, tier="unit", context=ctx)
        _emit_ingest_summary_axi("test", resp, summary, project_dir, args.agent,
                                 cycle_id, warnings)
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
    """Ingest EXISTING surefire/failsafe reports without running maven. §S9
    auto-attaches to the active cycle. Compile fallback if no reports exist."""
    project_dir = _resolve_project_dir(args.project_dir)
    maven_dir = _resolve_maven_dir(args.maven_dir, project_dir)
    su = _dirs_with_xml(_report_dirs(maven_dir, getattr(args, "module", None), "surefire"))
    fs = _dirs_with_xml(_report_dirs(maven_dir, getattr(args, "module", None), "failsafe"))
    dirs = su + fs
    if not dirs:
        print("[auto-ingest] no reports found", file=sys.stderr)
        return _compile_fallback(maven_dir, project_dir, args.agent, _common_mvn_flags(args))
    _warn_if_stale(dirs)
    cycle_id, warnings, withhold = _resolve_ingest_cycle(project_dir)
    if withhold:
        _emit_ingest_withhold("auto-ingest", project_dir, args.agent, warnings)
        return 1
    ctx = _ingest_context(cycle_id)
    if len(dirs) == 1 and not args.coverage:
        resp = _ingest_junit_dir(project_dir, args.agent, dirs[0], tier="unit", context=ctx)
        _emit_ingest_axi_resp("auto-ingest", resp, project_dir, args.agent, cycle_id, warnings)
    else:
        summary, tree = _parse_junit(dirs)
        coverage = _collect_jacoco(maven_dir) if (args.coverage and summary["failed"] == 0) else None
        resp = _ingest_parsed(project_dir, args.agent, summary, tree, coverage,
                              tier="regression", context=ctx)
        _emit_ingest_summary_axi("auto-ingest", resp, summary, project_dir, args.agent,
                                 cycle_id, warnings)
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
            coverage_profile=args.coverage_profile, log=None))
    finally:
        cmd_docker_down(argparse.Namespace(
            project_dir=args.project_dir, compose_file=args.compose_file,
            maven_dir=args.maven_dir))
    return reg_rc


# --------------------------------------------------------------------------- #
# CR-CRU-030 §S4/§S6/§S7/§S8 — plan / cycle / status / gate verbs
# --------------------------------------------------------------------------- #
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
        _emit_axi("plan-file", False, {"cr": args.cr},
                  _axi_context(project_dir, cr=args.cr), warnings, legacy)
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
    --cr), POST …/plans/<planId>/cycles with ONLY the label; the SERVER rejects a
    CLOSED/absent plan. The assigned numeric id stays machine-readable."""
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


# ── CR-CRU-013 §S5 / §S8 — fleet gate / milestone verbs ─────────────────────


def _agent_id(args):
    """The agentId for a fleet event. Explicit --agent > $WORKFLOW_ROLE > a stable
    fallback (these verbs never assert on the id, but the server requires one)."""
    explicit = getattr(args, "agent", None)
    if explicit:
        return explicit
    return os.environ.get("WORKFLOW_ROLE") or "mvn-crucible"


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
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path.startswith(home) else path


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

    r = sub.add_parser("register", help="Register / heartbeat an agent")
    r.add_argument("--agent", required=True, help="Agent id, e.g. CR-ES-12-C1-RED")
    # CR-CRU-008 register ergonomics: --phase optional, defaulting to "report".
    r.add_argument("--phase",
                   choices=["RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report"],
                   default="report")
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
    _add_project_args(pmg)
    pmg.set_defaults(func=cmd_pre_merge_gate)

    # ── CR-CRU-030 fleet-uniform verbs ──────────────────────────────────────
    te = sub.add_parser("test", help="TEST tier: mvn clean test [-Dtest=<pattern>] → surefire ingest (§S2/§S9).")
    te.add_argument("--test", help="Surefire -Dtest pattern, e.g. FooTest or FooTest#method")
    te.add_argument("--agent", help="If set, ingest surefire and §S9 auto-attach")
    _add_mvn_flags(te)
    _add_project_args(te)
    _add_log_arg(te)
    te.set_defaults(func=cmd_test)

    ck = sub.add_parser("check", help="CHECK gate: mvn clean test-compile → ingest /api/v2/runs/compile on failure (§S2).")
    ck.add_argument("--agent", help="If set, ingest the build output as a compile result")
    _add_mvn_flags(ck)
    _add_project_args(ck)
    ck.set_defaults(func=cmd_check)

    pf = sub.add_parser("plan-file", help="File a cycle plan; prints the ASSIGNED numeric cycle ids.")
    pf.add_argument("--cr", required=True, help="CR id, e.g. CR-CRU-008.")
    pf.add_argument("--title", help="Optional plan title.")
    pf.add_argument("--cycles", required=True, help='Comma-separated cycle labels, e.g. "a,b,c".')
    pf.add_argument("--orchestrator", help="Orchestrator name (default: $WORKFLOW_ORCHESTRATOR).")
    pf.add_argument("--wave", help="Wave number (§S3). Resolution: --wave > $WORKFLOW_WAVE.")
    _add_project_args(pf)
    pf.set_defaults(func=cmd_plan_file)

    ca = sub.add_parser("cycle-activate", help="Transition a plan cycle to active.")
    ca.add_argument("cycle_id", type=int, help="Numeric cycle id (unique per project).")
    _add_project_args(ca)
    ca.set_defaults(func=cmd_cycle_activate)

    cdn = sub.add_parser("cycle-done", help="Transition an ACTIVE plan cycle to done.")
    cdn.add_argument("cycle_id", type=int, help="Numeric cycle id (unique per project).")
    _add_project_args(cdn)
    cdn.set_defaults(func=cmd_cycle_done)

    cc = sub.add_parser("cr-close", help="Close the single OPEN plan (PATCH status=closed + merge.commit).")
    cc.add_argument("--commit", required=True, help="Merge commit sha.")
    cc.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    cc.add_argument("--agent", help="Agent id for the cr-merged milestone (default: $WORKFLOW_ROLE).")
    _add_project_args(cc)
    cc.set_defaults(func=cmd_cr_close)

    cad = sub.add_parser("cycle-add", help="Append a cycle to a plan (POST …/plans/<id>/cycles); prints the ASSIGNED id.")
    cad.add_argument("label", help="Label for the new cycle.")
    cad.add_argument("--cr", help="Disambiguate when multiple plans exist.")
    _add_project_args(cad)
    cad.set_defaults(func=cmd_cycle_add)

    cp = sub.add_parser("checkpoint", help="Checkpoint the resolved OPEN plan (POST …/plans/<id>/checkpoint).")
    cp.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    _add_project_args(cp)
    cp.set_defaults(func=cmd_checkpoint)

    stp = sub.add_parser("stop", help="Stop the project — checkpoint every open plan (POST …/projects/<key>/stop).")
    _add_project_args(stp)
    stp.set_defaults(func=cmd_stop)

    ab = sub.add_parser("abort", help="Abort the resolved OPEN plan (POST …/plans/<id>/abort). Requires --user-approved.")
    ab.add_argument("--user-approved", action="store_true",
                    help="Map to body userApproved:true (the server refuses without it).")
    ab.add_argument("--cr", help="Disambiguate when multiple plans are open.")
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
    gr.add_argument("--agent", help="Agent id for the gate events (default: $WORKFLOW_ROLE).")
    _add_project_args(gr)
    gr.set_defaults(func=cmd_gate_run)

    grp = sub.add_parser("gate-report", help="Report a single already-run gate → POST /api/v2/gates.")
    grp.add_argument("--outcome", required=True, help="Gate outcome (checks-passed|passed|failed|cancelled).")
    grp.add_argument("--commit", help="The pushed commit sha (gate.push.commit).")
    grp.add_argument("--steps", help='Comma-separated "name:status" step results.')
    grp.add_argument("--intent", help="Gate intent (default: derived from --outcome).")
    grp.add_argument("--agent", help="Agent id (default: $WORKFLOW_ROLE).")
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
    ms.add_argument("--agent", help="Agent id (default: $WORKFLOW_ROLE).")
    _add_project_args(ms)
    ms.set_defaults(func=cmd_milestone)

    args = p.parse_args()
    # §S14 — no subcommand: run the no-arg live dashboard, not argparse usage.
    if getattr(args, "func", None) is None:
        sys.exit(cmd_dashboard())
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
