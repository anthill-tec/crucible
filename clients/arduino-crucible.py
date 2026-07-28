#!/usr/bin/env python3
"""arduino-crucible.py — Arduino-firmware stack script (global, like bun/rust-crucible.py).

Runs native host tests / firmware compile and reports to Crucible via the v2 API
($CRUCIBLE_URL, default http://localhost:3849). Mirrors the bun/rust/python/mvn
`.env` + /api/v2/* ingest pattern, extended with per-subproject self-registration:
identity from the SUBPROJECT's .env (CRUCIBLE_PROJECT_KEY + CRUCIBLE_PROJECT_NAME),
agent `Vidushi - <NAME>`.

CR-CRU-030 §S1/§S2: every AXI verb prints a clients/toon.py-encoded envelope
`{"axi": {verb, ok, <result fields>, context, warnings}}` on STDOUT (the machine
channel); human-readable lines move to STDERR (interactive only). The envelope
machinery is factored into the shared clients/_crucible_axi.py module so every
client emits a byte-identical §S1 envelope. §S9: the ingest verb (`test`) and
`register` auto-attach to the open plan's ACTIVE cycle resolved FROM THE SERVER
(CR-CRU-036 removed every env override). An OPEN plan with no active cycle WARNS +
WITHHOLDS (ok:false, non-zero exit, no POST — never a silent orphan); a
plans-fetch failure or no open plan at all is tolerant (proceeds). Arduino has NO
separate `auto-ingest` verb, so §S9 rides its `test`
verb (the CR forbids adding new verbs beyond cycle-add/status/checkpoint/stop/abort).

The subproject dir (holding `.env` + `tests/native/`) is resolved:
  --project-dir  >  $ARDUINO_CRUCIBLE_PROJECT_DIR  >  CWD
It must contain a `.env`. Examples:
  arduino-crucible.py test    --project-dir /path/to/sheetal-firmware --agent <id>
  (cd sheetal-firmware && arduino-crucible.py check --agent <id>)

Run context (CR-CRU-008 §S2): when any WORKFLOW_* env var is set
(WORKFLOW_CYCLE / WORKFLOW_WAVE / WORKFLOW_ROLE — CR-CRU-036 removed the cycle-id
env read), ingests carry a `context` object {cycle, wave, orchestrator,
git:{branch,commit}} plus the SERVER-resolved cycleId.

Env overrides: CRUCIBLE_URL (legacy alias CRUCIBLE_BASE), ARDUINO_CLI, ARDUINO_FQBN,
AGENT_ID.

Subcommands:
  register, unregister  Agent lifecycle (§S9 register guard).
  test                  Run native host tests (`make junit`) → /api/v2/runs/parsed
                        (§S9 auto-attach). The RED/GREEN workhorse for this stack.
  check                 arduino-cli compile → /api/v2/runs/compile on failure. Gate.
  plan-file             File a cycle plan → the assigned NUMERIC cycle ids.
  cycle-activate <id>   Transition a cycle to active.
  cycle-done <id>       Transition an ACTIVE cycle to done.
  cr-close --commit <sha> [--cr <CR>]
                        Close the single OPEN plan.
  cycle-add <label>     Append a cycle to a plan (§S4).
  status / plans        Read the plan queue (§S6) as a TOON-AXI table.
  checkpoint / stop / abort
                        CR-024 workflow verbs (§S7).
  gate-run / gate-report / milestone
                        Fleet gate + milestone verbs (§S8).
"""
import argparse
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

CRUCIBLE = (os.environ.get("CRUCIBLE_URL") or os.environ.get("CRUCIBLE_BASE")
            or "http://localhost:3849")
ARDUINO_CLI = os.environ.get(
    "ARDUINO_CLI", "/opt/arduino-ide/resources/app/lib/backend/resources/arduino-cli")
FQBN = os.environ.get("ARDUINO_FQBN", "arduino:renesas_uno:minima")

# §S2b cadence (CR-CRU-008 _Narrator default) reused by gate-run's interim poll.
_GATE_POLL_CADENCE_S = 2.0
_GATE_POLL_TICK_S = 0.4


# ── project dir / .env / agent resolution ────────────────────────────────────


def _project_dir(args):
    d = (getattr(args, "project_dir", None)
         or os.environ.get("ARDUINO_CRUCIBLE_PROJECT_DIR") or os.getcwd())
    d = os.path.abspath(d)
    if not os.path.exists(os.path.join(d, ".env")):
        sys.exit(f"[crucible] no .env at {d} — pass --project-dir <subproject> "
                 f"(the dir holding .env + tests/native, e.g. sheetal-firmware)")
    return d


def _load_env(pd):
    path = os.path.join(pd, ".env")
    env = {}
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    # The SUBPROJECT's .env is authoritative (matches the rest of the fleet —
    # python/rust/bun read only the project .env); ambient env is a fallback
    # only, so a caller's own CRUCIBLE_PROJECT_* can never hijack an explicit
    # --project-dir.
    key = env.get("CRUCIBLE_PROJECT_KEY") or os.environ.get("CRUCIBLE_PROJECT_KEY")
    name = env.get("CRUCIBLE_PROJECT_NAME") or os.environ.get("CRUCIBLE_PROJECT_NAME")
    if not key:
        sys.exit(f"[crucible] CRUCIBLE_PROJECT_KEY not set in {path}")
    if not name:
        sys.exit(f"[crucible] CRUCIBLE_PROJECT_NAME not set in {path}")
    return key, name


def _project_key(pd):
    return _load_env(pd)[0]


# ── HTTP transport seam (mocked in-process by the client test harnesses) ─────


def _request(method, path, payload=None, timeout=None):
    """JSON request to Crucible. Returns parsed JSON, or {ok:False,error} on HTTP/conn error.

    CR-CRU-035 §S1 — `timeout=None` (the default) is UNBOUNDED: ingest POSTs
    (`/api/v2/runs/parsed`) for a large regression/coverage run can legitimately
    take the server >10s, and a short bound there is a false-negative. The short
    hook-safe bound is applied ONLY on the status/plans read path via `_get`."""
    req = urllib.request.Request(
        CRUCIBLE + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode()
        return json.loads(body) if body else {"ok": True}
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        return {"ok": False, "error": f"HTTP {e.code}: {body}"}
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"connection failed: {e.reason} "
                                      f"(is Crucible running at {CRUCIBLE}?)"}


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
        spec = importlib.util.spec_from_file_location("arduino_crucible_toon", toon_path)
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
        spec = importlib.util.spec_from_file_location("arduino_crucible_axi_shared", axi_path)
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


# ── run context (declared cycle linkage) ─────────────────────────────────────


def _run_context():
    """CR-CRU-008 §S2 — env + git → run context for declared cycle linkage.

    Reads WORKFLOW_CYCLE, WORKFLOW_WAVE and WORKFLOW_ROLE (CR-CRU-036 removed the
    cycle-id env read — the cycle is resolved from the server's active cycle,
    never from the environment). When at least one is set, attaches
    git {branch, commit} from a cheap `git rev-parse` (tolerant of a
    non-repo cwd → omitted). Returns the context dict, or None when no
    workflow env is set.
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


def _ingest_context(cycle_id):
    """§S9 — the ingest payload's `context`: env/git `_run_context()` enriched with
    the RESOLVED cycleId so the SERVER-recorded run carries the attach cycle."""
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
    active cycle withholds registration. A plans-fetch failure or no open plan at
    all is TOLERANT (register proceeds). Returns (withhold, warnings)."""
    _cycle, warnings, withhold = _axi().resolve_attach_cycle(_plans_response(project_dir))
    return withhold, warnings


def _emit_ingest_summary_axi(verb, resp, summary, project_dir, agent, cycle_id, warnings):
    """Emit the §S1 envelope for a CLIENT-parsed ingest (parsed path)."""
    run = {"passed": summary["passed"], "failed": summary["failed"],
           "pending": summary.get("pending", 0),
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


# ── project self-registration + JUnit parsing ────────────────────────────────


def _ensure_project(key, name, pd):
    """Idempotent self-registration; a pre-existing key returns 200 {changed:false}."""
    _post("/api/v2/projects", {"key": key, "name": name, "sutRoot": pd})


def _parse_junit(path):
    """JUnit (the native harness shape) -> (summary, tree) for /api/v2/runs/parsed."""
    root = ET.parse(path).getroot()
    suites = root.findall("testsuite") if root.tag == "testsuites" else [root]
    total = passed = failed = pending = 0
    tree = []
    for suite in suites:
        children, sfail = [], 0
        for tc in suite.findall("testcase"):
            bad = tc.find("failure") is not None or tc.find("error") is not None
            total += 1
            # CR-CRU-050 §S1/§S1b — a `<skipped/>` testcase is PENDING, never
            # passed. Order matters: failure/error first, then skipped, then
            # pass. A skip does NOT fail its suite. Mirrors mvn-crucible.py:641.
            if bad:
                status = "fail"
                failed += 1
                sfail += 1
            elif tc.find("skipped") is not None:
                status = "pending"
                pending += 1
            else:
                status = "pass"
                passed += 1
            children.append({"name": tc.get("name", "?"),
                             "status": status, "duration_ms": 0})
        tree.append({"name": suite.get("name", "native"),
                     "status": "fail" if sfail else "pass", "children": children})
    summary = {"total": total, "passed": passed, "failed": failed,
               "pending": pending, "duration_ms": 0}
    return summary, tree


def _collect_lcov(path):
    """Sum an lcov `.info` file's LF/LH (lines) and FNF/FNH (functions) into a
    Crucible coverage object. Returns None when the file is absent (a --coverage
    run with no coverage output ingests WITHOUT coverage rather than fabricating)."""
    if not os.path.exists(path):
        return None
    lf = lh = ff = fh = 0
    with open(path) as f:
        for line in f:
            if line.startswith("LF:"):
                lf += int(line[3:].strip() or 0)
            elif line.startswith("LH:"):
                lh += int(line[3:].strip() or 0)
            elif line.startswith("FNF:"):
                ff += int(line[4:].strip() or 0)
            elif line.startswith("FNH:"):
                fh += int(line[4:].strip() or 0)
    return {
        "lines": {"total": lf, "covered": lh,
                  "percent": round(lh / lf * 100, 1) if lf else 0},
        "functions": {"total": ff, "covered": fh,
                      "percent": round(fh / ff * 100, 1) if ff else 0},
    }


def _ingest_compile(project_dir, key, agent_id, errors, context=None):
    """Ingest an arduino-cli compile failure to /api/v2/runs/compile (with run context)."""
    payload = {"projectKey": key, "agentId": agent_id, "errors": errors}
    ctx = context if context is not None else _run_context()
    if ctx:
        payload["context"] = ctx
    resp = _post("/api/v2/runs/compile", payload)
    print(f"[crucible] compile FAILED -> /api/v2/runs/compile (ok={resp.get('ok')})",
          file=sys.stderr)
    return resp


# ── Agent lifecycle ──────────────────────────────────────────────────────────


def cmd_register(args):
    """Register / heartbeat. CR-CRU-036 §S9: an OPEN plan with no active cycle
    WARNS + WITHHOLDS — the agent must never come online against an untracked
    plan; the heartbeat is withheld and the exit code is non-zero. A plans-fetch
    failure or no open plan at all is tolerant (register proceeds)."""
    pd = _project_dir(args)
    key, name = _load_env(pd)
    agent_id = _agent_id(args)
    withhold, warnings = _register_cycle_guard(pd)
    if withhold:
        for w in warnings:
            print(_axi().withhold_stderr_line(w), file=sys.stderr)
        _emit_axi("register", False,
                  {"agent": agent_id, "help": _axi().HELP_STEPS["register"]},
                  _axi_context(pd, agent_id=agent_id, cycle_id=None), warnings)
        return 1
    _ensure_project(key, name, pd)
    phase = getattr(args, "phase", None)
    msg = f"{phase} phase" if phase else "online"
    resp = _post("/api/v2/agents/register", {
        "agentId": agent_id, "projectKey": key, "status": "online", "message": msg,
        # CR-CRU-044 §S1 — the declared phase is part of the registration wire
        # contract; this client's --phase is optional, so an undeclared phase
        # registers as "report" (the same default the other clients carry).
        "phase": phase or "report",
        "identity": {"displayName": agent_id, "source": "openclaw"}})
    ok = bool(resp.get("ok", False))
    legacy = f"[crucible] register: {agent_id} online — {msg}"
    _emit_axi("register", ok,
              {"agent": agent_id, "help": _axi().HELP_STEPS["register"]},
              _axi_context(pd, agent_id=agent_id), [], legacy)
    return 0 if ok else 1


def cmd_unregister(args):
    pd = _project_dir(args)
    key, name = _load_env(pd)
    agent_id = _agent_id(args)
    resp = _post("/api/v2/agents/unregister", {"agentId": agent_id, "projectKey": key})
    ok = bool(resp.get("ok", False))
    legacy = f"[crucible] unregister: {agent_id} removed (ok={ok})"
    _emit_axi("unregister", ok,
              {"agent": agent_id, "help": _axi().HELP_STEPS["unregister"]},
              _axi_context(pd, agent_id=agent_id), [], legacy)
    return 0 if ok else 1


def _remove_agent_silent(project_dir, agent_id):
    """CR-CRU-008 §S4 anti-ghost cleanup for a gated run: remove the agent row
    WITHOUT journaling a lifecycle event (the run's ingest was the implicit
    registration — a plain unregister would journal an 'unregistered' event and
    bury the run just ingested). Best-effort: never raises, never pollutes the
    run verdict or stdout. Mirrors clients/rust-crucible.py's _remove_agent_silent
    (v2 silent unregister, never the retired /api/agents/remove shim)."""
    try:
        _post(
            "/api/v2/agents/unregister",
            {"agentId": agent_id, "projectKey": _project_key(project_dir), "silent": True},
        )
    except Exception:
        pass


# ── Toolchain: native host tests + arduino-cli compile ───────────────────────


def _run_native_tests(args, verb, tier, want_coverage):
    """§S2/§S3 fleet-uniform native-test workhorse — run native host tests
    (`make junit`) → parse → /api/v2/runs/parsed under the given `tier`, §S9
    auto-attaching to the server's active cycle. `unit`/`test` ride tier `unit`;
    `regression` rides tier `regression` and, with `want_coverage`, attaches
    lcov coverage from `<native_dir>/coverage/lcov.info`. A no-active-cycle run
    withholds WITHOUT ingesting a cycleId=null orphan. A gated run (agent set)
    wraps the body in an anti-ghost silent cleanup (CR-CRU-008 §S4): even a
    failed/raising/withheld run removes the implicitly registered agent via the
    v2 silent unregister, and never touches the retired /api/agents/remove shim."""
    pd = _project_dir(args)
    try:
        return _run_native_tests_body(args, verb, tier, want_coverage, pd)
    finally:
        if getattr(args, "agent", None):
            # Remove the SAME id the run ingested under. The body resolves via
            # `_agent_id(args)` (raw --agent > $WORKFLOW_ROLE > "arduino-crucible",
            # fleet-uniform with python/rust/mvn); resolve the cleanup id through
            # the identical derivation so a run can never drift from the
            # registered row and orphan a ghost.
            _remove_agent_silent(pd, _agent_id(args))


def _run_native_tests_body(args, verb, tier, want_coverage, pd):
    key, name = _load_env(pd)
    agent_id = _agent_id(args)
    sub = (getattr(args, "dir", None) or "tests/native").replace("\\", "/")
    native_dir = os.path.join(pd, *sub.split("/"))
    _ensure_project(key, name, pd)
    run = subprocess.run(["make", "junit"], cwd=native_dir, capture_output=True, text=True)
    reports = sorted(glob.glob(os.path.join(native_dir, "reports", "TEST-*.xml")))
    if not reports:
        sys.stderr.write(run.stdout + run.stderr)
        sys.exit(f"[crucible] no JUnit (reports/TEST-*.xml) under {native_dir}")
    summary = {"total": 0, "passed": 0, "failed": 0, "pending": 0, "duration_ms": 0}
    tree = []
    for junit in reports:
        s, t = _parse_junit(junit)
        # CR-CRU-050 §S1 — `pending` MUST be carried forward here too; without
        # it the per-file parse fix is silently undone by the aggregation and
        # the envelope still reports pending=0.
        for k in ("total", "passed", "failed", "pending"):
            summary[k] += s[k]
        tree.extend(t)

    coverage = None
    if want_coverage:
        coverage = _collect_lcov(os.path.join(native_dir, "coverage", "lcov.info"))
        if coverage is None:
            print(f"[crucible] WARN: --coverage set but no lcov at "
                  f"{native_dir}/coverage/lcov.info — ingesting WITHOUT coverage",
                  file=sys.stderr)

    if not args.agent and not os.environ.get("AGENT_ID"):
        # No ingest requested — just report the run outcome.
        print(f"[crucible] {verb} -> '{name}': {summary['passed']}/{summary['total']} passed, "
              f"{summary['failed']} failed, {summary.get('pending', 0)} pending",
              file=sys.stderr)
        return 1 if summary["failed"] else 0

    # §S9 — resolve the cycle BEFORE the POST so a no-active-cycle run withholds
    # WITHOUT ever ingesting a cycleId=null orphan.
    cycle_id, warnings, withhold = _resolve_ingest_cycle(pd)
    if withhold:
        _emit_ingest_withhold(verb, pd, agent_id, warnings)
        return 1
    payload = {"projectKey": key, "name": name, "agentId": agent_id,
               "summary": summary, "tree": tree, "tier": tier}
    if coverage:
        payload["coverage"] = coverage
    context = _ingest_context(cycle_id)
    if context:
        payload["context"] = context
    # CR-CRU-038 §S2b — the captured make-junit output rides along as `raw` so
    # the server-stored run carries real output for the run-detail raw-toggle.
    raw = (run.stdout or "") + (run.stderr or "")
    if raw:
        payload["raw"] = raw
    resp = _post("/api/v2/runs/parsed", payload)
    print(f"[crucible] {verb} -> '{name}': {summary['passed']}/{summary['total']} passed, "
          f"{summary['failed']} failed, {summary.get('pending', 0)} pending "
          f"(ingest ok={resp.get('ok')})", file=sys.stderr)
    _emit_ingest_summary_axi(verb, resp, summary, pd, agent_id, cycle_id, warnings)
    if summary["failed"]:
        return 1
    return 0 if resp.get("ok") else 1


def cmd_test(args):
    """§S2 fleet-uniform test verb — native host tests (`make junit`) → tier
    `unit`. Retained (byte-compatible verb + envelope) alongside the `unit` alias."""
    return _run_native_tests(args, "test", "unit", False)


def cmd_unit(args):
    """§S3 fleet-uniform `unit` verb — native host tests (`make junit`) → tier
    `unit`. The RED/GREEN workhorse; identical toolchain to `test`."""
    return _run_native_tests(args, "unit", "unit", False)


def cmd_regression(args):
    """§S3 fleet-uniform `regression` verb — full native suite → tier
    `regression`; with `--coverage`, attach lcov coverage from
    `<native_dir>/coverage/lcov.info` (uniform with bun/python/mvn/rust)."""
    return _run_native_tests(args, "regression", "regression", bool(getattr(args, "coverage", False)))


def _compile_gate(args, verb):
    """§S2/§S3 shared arduino-cli compile gate — compile; on failure ingest the
    build output to /api/v2/runs/compile. Returns the §S1 envelope under `verb`
    (`check` and `compile` expose the SAME gate under fleet-uniform names)."""
    pd = _project_dir(args)
    key, name = _load_env(pd)
    agent_id = _agent_id(args)
    _ensure_project(key, name, pd)
    run = subprocess.run(
        [ARDUINO_CLI, "compile", "--fqbn", FQBN,
         "--build-path", os.path.join(pd, "build"), pd],
        capture_output=True, text=True)
    ok = run.returncode == 0
    if not ok:
        errors = re.sub(r"\x1b\[[0-9;]*m", "", (run.stdout + run.stderr).strip())
        if args.agent or os.environ.get("AGENT_ID"):
            _ingest_compile(pd, key, agent_id, errors)
        else:
            sys.stderr.write(errors + "\n")
    else:
        print("[crucible] compile OK", file=sys.stderr)
    legacy = f"{verb}: ok={ok} exit={run.returncode}"
    _emit_axi(verb, ok,
              {"exit": run.returncode, "help": _axi().HELP_STEPS.get(verb, ["status"])},
              _axi_context(pd, agent_id=agent_id), [], legacy)
    return 0 if ok else (run.returncode or 1)


def cmd_check(args):
    """§S2 fleet-uniform compile gate — arduino-cli compile; on failure ingest the
    build output to /api/v2/runs/compile. Returns the §S1 envelope."""
    return _compile_gate(args, "check")


def cmd_compile(args):
    """§S3 fleet-uniform `compile` verb — arduino-cli compile; on failure ingest
    the captured build output to /api/v2/runs/compile (never the v1 shim). The
    firmware-compile counterpart of the fleet's `compile`/`check` gate."""
    return _compile_gate(args, "compile")


def cmd_auto_ingest(args):
    """§S3 fleet-uniform `auto-ingest` verb — ingest a PRE-EXISTING native reports
    dir (default `<native_dir>/reports`) with NO toolchain invocation, §S9
    auto-attaching to the server's active cycle. Uniform with bun/python/mvn/rust."""
    pd = _project_dir(args)
    key, name = _load_env(pd)
    agent_id = _agent_id(args)
    sub = (getattr(args, "dir", None) or "tests/native").replace("\\", "/")
    native_dir = os.path.join(pd, *sub.split("/"))
    reports_dir = args.reports or os.path.join(native_dir, "reports")
    if not os.path.isabs(reports_dir):
        reports_dir = os.path.join(pd, reports_dir)
    reports = sorted(glob.glob(os.path.join(reports_dir, "TEST-*.xml")))
    if not reports:
        sys.exit(f"[crucible] no JUnit (TEST-*.xml) under {reports_dir} — nothing to ingest")
    _ensure_project(key, name, pd)
    summary = {"total": 0, "passed": 0, "failed": 0, "pending": 0, "duration_ms": 0}
    tree = []
    for junit in reports:
        s, t = _parse_junit(junit)
        # CR-CRU-050 §S1 — carry `pending` through the aggregation too.
        for k in ("total", "passed", "failed", "pending"):
            summary[k] += s[k]
        tree.extend(t)
    cycle_id, warnings, withhold = _resolve_ingest_cycle(pd)
    if withhold:
        _emit_ingest_withhold("auto-ingest", pd, agent_id, warnings)
        return 1
    payload = {"projectKey": key, "name": name, "agentId": agent_id,
               "summary": summary, "tree": tree, "tier": "unit"}
    context = _ingest_context(cycle_id)
    if context:
        payload["context"] = context
    resp = _post("/api/v2/runs/parsed", payload)
    print(f"[crucible] auto-ingest -> '{name}': {summary['passed']}/{summary['total']} passed, "
          f"{summary['failed']} failed, {summary.get('pending', 0)} pending "
          f"(ingest ok={resp.get('ok')})", file=sys.stderr)
    _emit_ingest_summary_axi("auto-ingest", resp, summary, pd, agent_id, cycle_id, warnings)
    if summary["failed"]:
        return 1
    return 0 if resp.get("ok") else 1


def cmd_pre_merge_gate(args):
    """§S3 ORCHESTRATOR pre-merge gate — fail-fast arduino-cli `compile` →
    `regression --coverage`. On compile failure the compile-failure event is
    posted and regression is SKIPPED (non-zero exit); on compile success the
    regression run posts the tier:'regression' event with coverage attached."""
    if not getattr(args, "skip_check", False):
        check_args = argparse.Namespace(agent=args.agent, project_dir=args.project_dir)
        rc = _compile_gate(check_args, "compile")
        if rc != 0:
            print("[crucible] pre-merge gate FAILED at the arduino-cli compile step — "
                  "skipped the regression. Fix the compile first (or --skip-check to bypass).",
                  file=sys.stderr)
            return rc
    reg_args = argparse.Namespace(
        agent=args.agent, project_dir=args.project_dir,
        dir=getattr(args, "dir", None), coverage=True)
    return cmd_regression(reg_args)


# ── CR-CRU-030 §S4/§S6/§S7/§S8 — plan / cycle / status / gate verbs ──────────


def cmd_plan_file(args):
    project_dir = _project_dir(args)
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
    if not args.title:
        wt = _axi().no_title_warning(args.cr)
        warnings.append(wt)
        print(f"warning: {wt['code']} — {wt['detail']}", file=sys.stderr)
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
    project_dir = _project_dir(args)
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
    project_dir = _project_dir(args)
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
    project_dir = _project_dir(args)
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
    project_dir = _project_dir(args)
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
    project_dir = _project_dir(args)
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
    project_dir = _project_dir(args)
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
    project_dir = _project_dir(args)
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
                            f"at {CRUCIBLE}"]},
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
    """The agentId for a fleet event. Explicit --agent > $WORKFLOW_ROLE > a stable
    fallback (these verbs never assert on the id, but the server requires one)."""
    explicit = getattr(args, "agent", None)
    if explicit:
        return explicit
    return os.environ.get("WORKFLOW_ROLE") or "arduino-crucible"


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
    project_dir = _project_dir(args)
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
    project_dir = _project_dir(args)
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
    project_dir = _project_dir(args)
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


# ── §S14 — no-arg live dashboard ─────────────────────────────────────────────

_DASHBOARD_PURPOSE_LINE = (
    "arduino-crucible.py -- Arduino-firmware Crucible CLI "
    "(agent lifecycle, native-test/compile ingest, plan/cycle verbs)."
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


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--agent", help="override the derived agent id")
    common.add_argument("--project-dir",
                        help="subproject dir with .env + tests/native "
                             "(default: $ARDUINO_CRUCIBLE_PROJECT_DIR or CWD)")
    p = argparse.ArgumentParser(description="Arduino-firmware Crucible stack script")
    # §S14 — subcommand is OPTIONAL: a bare invocation falls through to the
    # no-arg live dashboard, never argparse's required-subcommand error.
    sub = p.add_subparsers(dest="cmd", required=False)

    _dir_help = ("test-target subdir under the project (default tests/native; "
                 "e.g. tests/native-mock for the ArduinoFake L2 tier)")

    t = sub.add_parser("test", parents=[common],
                       help="run native host tests (make junit) -> /api/v2/runs/parsed (§S9)")
    t.add_argument("--dir", default="tests/native", help=_dir_help)
    t.set_defaults(func=cmd_test)

    un = sub.add_parser("unit", parents=[common],
                        help="run native host tests (make junit) -> /api/v2/runs/parsed, tier unit (§S9)")
    un.add_argument("--dir", default="tests/native", help=_dir_help)
    un.set_defaults(func=cmd_unit)

    rg = sub.add_parser("regression", parents=[common],
                        help="full native suite -> /api/v2/runs/parsed, tier regression (§S3)")
    rg.add_argument("--dir", default="tests/native", help=_dir_help)
    rg.add_argument("--coverage", action="store_true",
                    help="attach lcov coverage from <native_dir>/coverage/lcov.info")
    rg.set_defaults(func=cmd_regression)

    ai = sub.add_parser("auto-ingest", parents=[common],
                        help="ingest a PRE-EXISTING native reports dir (no toolchain) (§S3)")
    ai.add_argument("--dir", default="tests/native", help=_dir_help)
    ai.add_argument("--reports",
                    help="reports dir holding TEST-*.xml (default <native_dir>/reports)")
    ai.set_defaults(func=cmd_auto_ingest)

    ck = sub.add_parser("check", parents=[common],
                        help="arduino-cli compile -> /api/v2/runs/compile on failure")
    ck.set_defaults(func=cmd_check)

    cpl = sub.add_parser("compile", parents=[common],
                         help="arduino-cli compile -> /api/v2/runs/compile on failure (§S3)")
    cpl.set_defaults(func=cmd_compile)

    pmg = sub.add_parser("pre-merge-gate", parents=[common],
                         help="fail-fast compile -> regression --coverage (§S3)")
    pmg.add_argument("--dir", default="tests/native", help=_dir_help)
    pmg.add_argument("--skip-check", action="store_true",
                     help="skip the fail-fast arduino-cli compile step")
    pmg.set_defaults(func=cmd_pre_merge_gate)

    r = sub.add_parser("register", parents=[common], help="register/heartbeat the agent")
    r.add_argument("--phase", help="phase label (RED/GREEN/VERIFY/FIX)")
    r.set_defaults(func=cmd_register)

    u = sub.add_parser("unregister", parents=[common], help="remove the agent")
    u.set_defaults(func=cmd_unregister)

    pf = sub.add_parser("plan-file", parents=[common],
                        help="File a cycle plan; prints the ASSIGNED numeric cycle ids.")
    pf.add_argument("--cr", required=True, help="CR id, e.g. CR-CRU-008.")
    pf.add_argument("--title", help="Optional plan title.")
    pf.add_argument("--cycles", required=True, help='Comma-separated cycle labels, e.g. "a,b,c".')
    pf.add_argument("--orchestrator", help="Orchestrator name (default: $WORKFLOW_ORCHESTRATOR).")
    pf.add_argument("--wave", help="Wave number (§S3). Resolution: --wave > $WORKFLOW_WAVE.")
    pf.set_defaults(func=cmd_plan_file)

    ca = sub.add_parser("cycle-activate", parents=[common], help="Transition a plan cycle to active.")
    ca.add_argument("cycle_id", type=int, help="Numeric cycle id (unique per project).")
    ca.set_defaults(func=cmd_cycle_activate)

    cdn = sub.add_parser("cycle-done", parents=[common], help="Transition an ACTIVE plan cycle to done.")
    cdn.add_argument("cycle_id", type=int, help="Numeric cycle id (unique per project).")
    cdn.set_defaults(func=cmd_cycle_done)

    cc = sub.add_parser("cr-close", parents=[common],
                        help="Close the single OPEN plan (PATCH status=closed + merge.commit).")
    cc.add_argument("--commit", required=True, help="Merge commit sha.")
    cc.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    cc.set_defaults(func=cmd_cr_close)

    cad = sub.add_parser("cycle-add", parents=[common],
                         help="Append a cycle to a plan (POST …/plans/<id>/cycles).")
    cad.add_argument("label", help="Label for the new cycle.")
    cad.add_argument("--cr", help="Disambiguate when multiple plans exist.")
    cad.set_defaults(func=cmd_cycle_add)

    cp = sub.add_parser("checkpoint", parents=[common],
                        help="Checkpoint the resolved OPEN plan (POST …/plans/<id>/checkpoint).")
    cp.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    cp.set_defaults(func=cmd_checkpoint)

    stp = sub.add_parser("stop", parents=[common],
                         help="Stop the project — checkpoint every open plan.")
    stp.set_defaults(func=cmd_stop)

    ab = sub.add_parser("abort", parents=[common],
                        help="Abort the resolved OPEN plan. Requires --user-approved.")
    ab.add_argument("--user-approved", action="store_true",
                    help="Map to body userApproved:true (the server refuses without it).")
    ab.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    ab.set_defaults(func=cmd_abort)

    for _name in ("status", "plans"):
        sv = sub.add_parser(_name, parents=[common],
                            help="Read the plan queue (GET …/plans) as a TOON-AXI table + lastRunCr.")
        sv.add_argument("--fields",
                        help="Comma-separated EXTRA columns to add to the minimal "
                             "cr,wave,status,activeCycleId set (§S10).")
        sv.set_defaults(func=cmd_status)

    gr = sub.add_parser("gate-run", parents=[common],
                        help="axi PROXY: run `no-mistakes axi run`, post throttled interim + final gates.")
    gr.add_argument("--intent", required=True, help="The intent/goal passed down to `axi run`.")
    gr.set_defaults(func=cmd_gate_run)

    grp = sub.add_parser("gate-report", parents=[common],
                         help="Report a single already-run gate → POST /api/v2/gates.")
    grp.add_argument("--outcome", required=True, help="Gate outcome (checks-passed|passed|failed|cancelled).")
    grp.add_argument("--commit", help="The pushed commit sha (gate.push.commit).")
    grp.add_argument("--steps", help='Comma-separated "name:status" step results.')
    grp.add_argument("--intent", help="Gate intent (default: derived from --outcome).")
    grp.add_argument("--full", action="store_true",
                     help="Emit large text fields untruncated (§S11).")
    grp.set_defaults(func=cmd_gate_report)

    ms = sub.add_parser("milestone", parents=[common],
                        help="POST a workflow milestone → /api/v2/milestones.")
    ms.add_argument("--type", required=True,
                    help="Milestone type (gap-analysis|design-review|stage-flip|custom|cr-merged).")
    ms.add_argument("--label", help="Human-readable milestone label.")
    ms.add_argument("--cr", help="CR id (rides context.cr).")
    ms.add_argument("--commit", help="Optional commit sha.")
    ms.set_defaults(func=cmd_milestone)

    args = p.parse_args()
    if getattr(args, "agent", None):
        os.environ["AGENT_ID"] = args.agent
    # §S14 — no subcommand: run the no-arg live dashboard, not argparse usage.
    if getattr(args, "func", None) is None:
        sys.exit(cmd_dashboard())
    sys.exit(args.func(args) or 0)


if __name__ == "__main__":
    main()
