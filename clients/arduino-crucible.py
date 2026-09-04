#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
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
client emits a byte-identical §S1 envelope. Cycle attachment (CR-CRU-056 §S3):
agents register BOUND to a cycle (`register --cycle` with an ACTIVE cycle id —
REQUIRED by the server for TDD roles RED/GREEN/FIX/VERIFY; ORCHESTRATOR/report
may register unbound). A bound agent's ingests are stamped with that cycle
SERVER-side — the client resolves and sends no cycle; an unbound agent's runs
attach only via an explicit `context.cycleId`.

The subproject dir (holding `.env` + `tests/native/`) is resolved:
  --project-dir  >  $ARDUINO_CRUCIBLE_PROJECT_DIR  >  CWD
It must contain a `.env`. Examples:
  arduino-crucible.py test    --project-dir /path/to/sheetal-firmware --agent <id>
  (cd sheetal-firmware && arduino-crucible.py check --agent <id>)

Run context (CR-CRU-008 §S2): when any WORKFLOW_* env var is set
(WORKFLOW_CYCLE / WORKFLOW_WAVE / WORKFLOW_ROLE — no cycle-id env read), ingests
carry a `context` object {cycle, wave, orchestrator, git:{branch,commit}}; the
attach cycle is stamped SERVER-side from the agent's registered binding.

Env overrides: CRUCIBLE_URL (legacy alias CRUCIBLE_BASE), ARDUINO_CLI, ARDUINO_FQBN.

CR-CRU-044 §S5 — the agent identity comes from `--agent` ONLY: no env var supplies
one, and there is no fallback. A verb that would POST under an agentId without a
declared identity HARD-STOPS (ok:false, non-zero exit) rather than inventing one.
$AGENT_ID is set FROM `--agent` for child processes; it is not an identity source,
and neither is $WORKFLOW_ROLE (that is the track lane, reported as context.track).

Subcommands:
  register, unregister  Agent lifecycle (TDD roles bind a cycle with --cycle).
  test                  Run native host tests (`make junit`) → /api/v2/runs/parsed.
                        The RED/GREEN workhorse for this stack.
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
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

CRUCIBLE = (os.environ.get("CRUCIBLE_URL") or os.environ.get("CRUCIBLE_BASE")
            or "http://localhost:3849")
ARDUINO_CLI = os.environ.get(
    "ARDUINO_CLI", "/opt/arduino-ide/resources/app/lib/backend/resources/arduino-cli")
FQBN = os.environ.get("ARDUINO_FQBN", "arduino:renesas_uno:minima")

# §S2b cadence (CR-CRU-008 _Narrator default) reused by gate-run's interim poll.


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
    hook-safe bound is applied ONLY on the status/plans read path via `_get`.

    CR-CRU-054 §S2 — a thin delegator to the fleet's ONE transport,
    `_crucible_axi.http_request`, which documents the full contract (including
    the §S2b empty-body correction). The local name is kept deliberately: the
    CR-CRU-030 delegation pattern, addressed unqualified by every call site
    here and by the client test harnesses."""
    return _axi().http_request(CRUCIBLE, method, path, payload, timeout)


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
        base_url=CRUCIBLE)


# ── run context (declared cycle linkage) ─────────────────────────────────────


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


def _emit_ingest_summary_axi(verb, resp, summary, files, project_dir, agent,
                             help_steps=None):
    """Emit the §S1 envelope for a CLIENT-parsed ingest (parsed path).
    CR-CRU-051 §S2 — `files` (the distinct-source count from `_parse_junit`,
    per-FILE when the native harness stamps `file=`, else per-class/per-suite)
    rides alongside the test counts so a suite that silently shrinks is visible
    in the gate output itself.
    CR-CRU-056 §S3 — the client RESOLVES no cycle: a bound agent's run is
    server-stamped with its registered cycle (a stale binding gets a 409,
    surfaced via `error`). C5 — the envelope context ECHOES the attachment the
    SERVER reported (`context.cycleId` on the ingest response), so the agent
    sees which cycle absorbed its evidence without a second
    `GET /api/v2/events`; absent → the key is omitted.

    CR-CRU-058 §S2 — `help_steps` lets a GATE caller supply the STATE-DERIVED
    next step for the run it just made (`_axi().run_help`), instead of the
    canned per-verb `HELP_STEPS` entry; unset keeps today's behaviour exactly."""
    run = {"passed": summary["passed"], "failed": summary["failed"],
           "pending": summary.get("pending", 0),
           "total": summary["total"], "files": files}
    context = _axi_context(project_dir, agent_id=agent,
                           cycle_id=_axi().echoed_cycle_id(resp))
    result_fields = {"run": run,
                     "help": help_steps or _axi().HELP_STEPS.get(verb, ["status"])}
    err = resp.get("error")
    if err is not None:
        result_fields["error"] = err
    _emit_axi(verb, bool(resp.get("ok")), result_fields, context, [])


# ── project self-registration + JUnit parsing ────────────────────────────────


def _ensure_project(key, name, pd):
    """Idempotent self-registration; a pre-existing key returns 200 {changed:false}."""
    _post("/api/v2/projects", {"key": key, "name": name, "sutRoot": pd})


def _parse_junit(path):
    """JUnit (the native harness shape) -> (summary, tree, files) for
    /api/v2/runs/parsed.

    CR-CRU-051 §S1 — `files` is the DISTINCT-SOURCE count for THIS report,
    mirroring `bun-crucible.py::_parse_junit_file` (the reference). RESOLVED
    GRANULARITY FOR THIS CLIENT: per-FILE **when the native g++ harness stamps
    `file=` on its testcases**, degrading to per-CLASS (`classname`) and then to
    per-SUITE otherwise — arduino is the one client in the fleet whose emitter
    MAY carry a real `file` attribute, so it is checked first, but the value is
    only as precise as the harness that produced the XML. The chain never
    collapses to zero: a constant zero would make a shrinking suite look
    identical to a healthy one. It rides the printed run envelope only, never
    the ingest payload (CR-CRU-047 §S2)."""
    root = ET.parse(path).getroot()
    suites = root.findall("testsuite") if root.tag == "testsuites" else [root]
    total = passed = failed = pending = 0
    tree = []
    files = set()
    for suite in suites:
        children, sfail = [], 0
        for tc in suite.findall("testcase"):
            source = tc.get("file") or tc.get("classname") or suite.get("name")
            if source:
                files.add(source.replace("\\", "/"))
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
    # `files` is a SIBLING of `summary`, deliberately not a key inside it:
    # `summary` IS the /api/v2/runs/parsed payload's summary field verbatim, and
    # CR-CRU-047 §S2 keeps this count out of the wire.
    return summary, tree, len(files)


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


def _ensure_project_registered(project_dir):
    """arduino's UNIQUE registration bootstrap (DN §3): this client self-registers
    its project before the agent row is posted, reading the subproject `.env` for
    the CRUCIBLE_PROJECT_NAME the other four clients never need. Handed to the
    shared `cmd_register` as its `pre_register` hook — it runs only AFTER the §S5
    identity hard stop, so an undeclared identity still posts nothing."""
    key, name = _load_env(project_dir)
    _ensure_project(key, name, project_dir)


def _register_message(args, role):
    """arduino's own register message convention, a per-client PARAMETER of the
    shared `cmd_register` (the other four send `Starting <role> phase`)."""
    return f"{role} phase" if role else "online"


# CR-CRU-054 §S2b — arduino's own interactive legacy lines. Kept per-client
# PARAMETERS of the shared verbs rather than flattened into fleet constants:
# unifying the wording would be a silent output change in four other clients.
REGISTER_LEGACY_FORMAT = "[crucible] register: {agent_id} online — {message}"
UNREGISTER_LEGACY_FORMAT = "[crucible] unregister: {agent_id} removed (ok={ok})"


def cmd_register(args):
    """Register / heartbeat. CR-CRU-056 §S1/§S2 — `--cycle` binds the agent to
    an ACTIVE cycle of an OPEN plan; the server validates the binding and
    REQUIRES it for TDD roles (RED/GREEN/FIX/VERIFY) — a refused registration
    surfaces the server's 409 envelope (error + help) and exits non-zero.
    ORCHESTRATOR/report may register unbound.

    CR-CRU-054 §S2b — delegates to the shared implementation, which owns the
    §S5 runtime identity hard stop (DN §4 finding #3) and the documented-enum
    `--source` strategy (finding #5).
    arduino's project self-registration, its `report` role floor (a defensive
    floor for a hand-built Namespace — §S3 makes `--role` REQUIRED on the
    subparser), its message convention and its legacy line stay per-client
    PARAMETERS."""
    return _axi().cmd_register(args, _project_dir(args), _ops(),
                               pre_register=_ensure_project_registered,
                               role_default="report",
                               message_fn=_register_message,
                               legacy_format=REGISTER_LEGACY_FORMAT)


def cmd_unregister(args):
    """Remove this agent's row (journals an 'unregistered' lifecycle event).

    CR-CRU-054 §S2b — delegates to the shared implementation, whose §S5 runtime
    identity hard stop replaced argparse `required=True` (DN §4 finding #3).
    arduino's own legacy line stays a per-client PARAMETER."""
    return _axi().cmd_unregister(args, _project_dir(args), _ops(),
                                 legacy_format=UNREGISTER_LEGACY_FORMAT)


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


# ── Toolchain: native host tests + arduino-cli compile ───────────────────────


def _run_native_tests(args, verb, tier, want_coverage):
    """§S2/§S3 fleet-uniform native-test workhorse — run native host tests
    (`make junit`) → parse → /api/v2/runs/parsed under the given `tier`; a
    bound agent's run is server-stamped with its registered cycle (CR-CRU-056
    §S3). `unit`/`test` ride tier `unit`; `regression` rides tier `regression`
    and, with `want_coverage`, attaches lcov coverage from
    `<native_dir>/coverage/lcov.info`. A gated run (agent set) opens with a
    heartbeat that DECLARES the run's identity (binding it when `--cycle` is
    given) and wraps the body in an anti-ghost silent cleanup (CR-CRU-008 §S4):
    even a failed/raising run tears that identity down via the v2 silent
    unregister, and never touches the retired /api/agents/remove shim.
    CR-CRU-056 — the cleanup fires ONLY for an identity this run created; a
    caller who registered BEFORE the run keeps its registration and binding."""
    pd = _project_dir(args)
    identity = None
    try:
        if getattr(args, "agent", None):
            # Open under the SAME id the run will ingest under. The body
            # resolves via `_agent_id(args)`, the CR-CRU-044 §S5
            # declared-identity resolver: the explicit `--agent` value or a hard
            # stop. There is no $WORKFLOW_ROLE branch and no
            # `"arduino-crucible"` filename default — both were deleted, and
            # neither may be reinstated. Resolve the bracket id through that
            # identical call so a run can never drift from the registered row
            # and orphan a ghost.
            identity = _open_gate_identity(pd, _agent_id(args),
                                           getattr(args, "cycle", None),
                                           f"gated {verb} run starting")
        return _run_native_tests_body(args, verb, tier, want_coverage, pd)
    finally:
        _close_gate_identity(pd, identity)


def _run_native_tests_body(args, verb, tier, want_coverage, pd):
    key, name = _load_env(pd)
    # CR-CRU-044 §S5 — a run with no `--agent` INGESTS NOTHING (see the
    # no-ingest early return below), so it needs no declared identity; the id is
    # REQUIRED only on the POSTing path, resolved there. Never fabricated either way.
    agent_id = _axi().optional_agent_id(args)
    sub = (getattr(args, "dir", None) or "tests/native").replace("\\", "/")
    native_dir = os.path.join(pd, *sub.split("/"))
    _ensure_project(key, name, pd)
    run = subprocess.run(["make", "junit"], cwd=native_dir, capture_output=True, text=True)
    reports = sorted(glob.glob(os.path.join(native_dir, "reports", "TEST-*.xml")))
    if not reports:
        # CR-CRU-064 §S4 — was `sys.exit(<message>)`, which wrote the message to
        # stderr and exited 1 with EMPTY stdout. The stderr text and the exit
        # code are preserved verbatim (AC5); the envelope is what is added, and
        # it carries the CALLER's `verb` (this body backs test AND regression).
        sys.stderr.write(run.stdout + run.stderr)
        message = f"[crucible] no JUnit (reports/TEST-*.xml) under {native_dir}"
        sys.stderr.write(message + "\n")
        _emit_axi(verb, False,
                  {"help": _axi().no_report_help(verb, "TEST-*.xml")},
                  _axi_context(pd, agent_id=agent_id),
                  [_axi().no_report_warning(verb, "TEST-*.xml", run.returncode,
                                            (run.stdout or "") + (run.stderr or ""))],
                  message)
        return 1
    summary = {"total": 0, "passed": 0, "failed": 0, "pending": 0, "duration_ms": 0}
    tree = []
    files = 0
    for junit in reports:
        s, t, f = _parse_junit(junit)
        # CR-CRU-050 §S1 — `pending` MUST be carried forward here too; without
        # it the per-file parse fix is silently undone by the aggregation and
        # the envelope still reports pending=0.
        for k in ("total", "passed", "failed", "pending"):
            summary[k] += s[k]
        # CR-CRU-051 §S1 — same trap for `files`: without this the count is
        # whatever the LAST report happened to hold. Summed per report rather
        # than de-duplicated across reports, because `make junit` emits one
        # TEST-*.xml per native test binary and their sources are disjoint; a
        # harness that repeated a source across reports would over-count.
        files += f
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
              f"{summary['failed']} failed, {summary.get('pending', 0)} pending, "
              f"{files} files",
              file=sys.stderr)
        return 1 if summary["failed"] else 0

    # §S5 — past this point the run IS ingested under an agentId, so the
    # identity must be DECLARED (hard stop when it is not).
    agent_id = _agent_id(args)
    payload = {"projectKey": key, "name": name, "agentId": agent_id,
               "summary": summary, "tree": tree, "tier": tier}
    if coverage:
        payload["coverage"] = coverage
    context = _run_context()
    if context:
        payload["context"] = context
    # CR-CRU-038 §S2b — the captured make-junit output rides along as `raw` so
    # the server-stored run carries real output for the run-detail raw-toggle.
    raw = (run.stdout or "") + (run.stderr or "")
    if raw:
        payload["raw"] = raw
    resp = _post("/api/v2/runs/parsed", payload)
    print(f"[crucible] {verb} -> '{name}': {summary['passed']}/{summary['total']} passed, "
          f"{summary['failed']} failed, {summary.get('pending', 0)} pending, "
          f"{files} files (ingest ok={resp.get('ok')})", file=sys.stderr)
    # CR-CRU-058 §S2 — a GATE run's next step is derived from the run state it
    # reached (unrecorded / red / green); the plain test verbs keep their canned
    # HELP_STEPS entry, unchanged.
    ok = bool(resp.get("ok")) and summary["failed"] == 0
    help_steps = (_axi().run_help(verb, ok, summary["failed"], CRUCIBLE)
                  if verb == "pre-merge-gate" else None)
    _emit_ingest_summary_axi(verb, resp, summary, files, pd, agent_id,
                             help_steps=help_steps)
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
    state = _compile_run(args, pd)
    legacy = f"{verb}: ok={state['ok']} exit={state['exit']}"
    _emit_axi(verb, state["ok"],
              {"exit": state["exit"], "help": _axi().HELP_STEPS.get(verb, ["status"])},
              _axi_context(pd, agent_id=state["agent_id"]), [], legacy)
    return 0 if state["ok"] else (state["exit"] or 1)


def _compile_run(args, pd):
    """The arduino-cli compile itself — CR-CRU-058 §S1: this helper NEVER emits,
    so the envelope-owning verbs that run it (`check`/`compile` via
    `_compile_gate`, and `pre-merge-gate`'s fail-fast step 0) each put exactly
    ONE document on stdout. Returns `{exit, ok, agent_id}`; its caller emits."""
    key, name = _load_env(pd)
    # CR-CRU-044 §S5 — the gate only INGESTS when an identity was declared, so
    # the id is optional here (omitted from the envelope context when absent)
    # and REQUIRED only on the ingest branch below. Never fabricated either way.
    agent_id = _axi().optional_agent_id(args)
    _ensure_project(key, name, pd)
    run = subprocess.run(
        [ARDUINO_CLI, "compile", "--fqbn", FQBN,
         "--build-path", os.path.join(pd, "build"), pd],
        capture_output=True, text=True)
    ok = run.returncode == 0
    if not ok:
        errors = re.sub(r"\x1b\[[0-9;]*m", "", (run.stdout + run.stderr).strip())
        if args.agent or os.environ.get("AGENT_ID"):
            agent_id = _agent_id(args)
            _ingest_compile(pd, key, agent_id, errors)
        else:
            sys.stderr.write(errors + "\n")
    else:
        print("[crucible] compile OK", file=sys.stderr)
    return {"exit": run.returncode, "ok": ok, "agent_id": agent_id}


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
    dir (default `<native_dir>/reports`) with NO toolchain invocation; a bound
    agent's run is server-stamped with its registered cycle. Uniform with
    bun/python/mvn/rust."""
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
        # CR-CRU-064 §S4 — same `sys.exit(<message>)` → emit + return 1 swap.
        # This verb invokes NO toolchain, so there is no capture to carry and
        # the helper's blank-capture detail is the honest one.
        message = (f"[crucible] no JUnit (TEST-*.xml) under {reports_dir} "
                   f"— nothing to ingest")
        sys.stderr.write(message + "\n")
        _emit_axi("auto-ingest", False,
                  {"help": _axi().no_report_help("auto-ingest", "TEST-*.xml")},
                  _axi_context(pd, agent_id=agent_id),
                  [_axi().no_report_warning("auto-ingest", "TEST-*.xml", 1, "")],
                  message)
        return 1
    _ensure_project(key, name, pd)
    summary = {"total": 0, "passed": 0, "failed": 0, "pending": 0, "duration_ms": 0}
    tree = []
    files = 0
    for junit in reports:
        s, t, f = _parse_junit(junit)
        # CR-CRU-050 §S1 — carry `pending` through the aggregation too.
        for k in ("total", "passed", "failed", "pending"):
            summary[k] += s[k]
        # CR-CRU-051 §S1 — and `files`, per the same aggregation trap.
        files += f
        tree.extend(t)
    payload = {"projectKey": key, "name": name, "agentId": agent_id,
               "summary": summary, "tree": tree, "tier": "unit"}
    context = _run_context()
    if context:
        payload["context"] = context
    resp = _post("/api/v2/runs/parsed", payload)
    print(f"[crucible] auto-ingest -> '{name}': {summary['passed']}/{summary['total']} passed, "
          f"{summary['failed']} failed, {summary.get('pending', 0)} pending, "
          f"{files} files (ingest ok={resp.get('ok')})", file=sys.stderr)
    _emit_ingest_summary_axi("auto-ingest", resp, summary, files, pd, agent_id)
    if summary["failed"]:
        return 1
    return 0 if resp.get("ok") else 1


def cmd_pre_merge_gate(args):
    """§S3 ORCHESTRATOR pre-merge gate — fail-fast arduino-cli `compile` →
    `regression --coverage`. On compile failure the compile-failure event is
    posted and regression is SKIPPED (non-zero exit); on compile success the
    regression run posts the tier:'regression' event with coverage attached."""
    pd = _project_dir(args)
    if not getattr(args, "skip_check", False):
        check_args = argparse.Namespace(agent=args.agent, project_dir=args.project_dir)
        # The STEP form (no envelope of its own) — this gate owns stdout.
        state = _compile_run(check_args, pd)
        if not state["ok"]:
            print("[crucible] pre-merge gate FAILED at the arduino-cli compile step — "
                  "skipped the regression. Fix the compile first (or --skip-check to bypass).",
                  file=sys.stderr)
            # §S2 — the state reached is "aborted at step 0, the regression
            # never ran": the next action is the compile error, never the
            # gate's own successor. A passing gate falls through to the
            # regression envelope, whose help[] is derived from the RUN state.
            _emit_axi("pre-merge-gate", False,
                      {"stage": "compile", "exit": state["exit"],
                       "help": _axi().gate_step_abort_help(
                           "pre-merge-gate",
                           "fix the arduino-cli compile error(s) reported on "
                           "stderr (or --skip-check to bypass)")},
                      _axi_context(pd, agent_id=state["agent_id"]),
                      [_axi().gate_step_abort_warning(
                          "pre-merge-gate", "arduino-cli compile",
                          "the firmware does not compile")],
                      f"pre-merge-gate: ok=False exit={state['exit']} — "
                      f"aborted at the arduino-cli compile step")
            return state["exit"] or 1
    reg_args = argparse.Namespace(
        agent=args.agent, project_dir=args.project_dir,
        dir=getattr(args, "dir", None), coverage=True,
        cycle=getattr(args, "cycle", None))
    # §S1 — the native-test body emits under THIS gate's verb, so the gate puts
    # exactly one envelope on stdout under the name the caller invoked.
    return _run_native_tests(reg_args, "pre-merge-gate", "regression", True)


# ── CR-CRU-030 §S4/§S6/§S7/§S8 — plan / cycle / status / gate verbs ──────────


def cmd_plan_file(args):
    """§S4 — file a workflow plan (CR + its cycles). CR-CRU-054 §S2b — delegates
    to the shared implementation, which owns the §S5 identity hard stop, the
    wave/title warnings and `context.cr` on BOTH the success and failure
    envelopes (DN §4 finding #2)."""
    return _axi().cmd_plan_file(args, _project_dir(args), _ops())


def _cycle_transition(args, status):
    """§S4 — transition a cycle to `status`, resolving its owning OPEN plan
    first. CR-CRU-054 §S2 — delegates to the shared implementation."""
    return _axi().cycle_transition(args, _project_dir(args), _ops(), status)


def cmd_cycle_activate(args):
    return _cycle_transition(args, "active")


def cmd_cycle_done(args):
    return _cycle_transition(args, "done")


def cmd_cr_close(args):
    """§S4c — close the resolved OPEN plan and post the cr-merged milestone,
    requiring a live registered caller. CR-CRU-054 §S2 — delegates to the
    shared implementation."""
    return _axi().cmd_cr_close(args, _project_dir(args), _ops())


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
    return _axi().cmd_cycle_add(args, _project_dir(args), _ops())


def cmd_checkpoint(args):
    """§S7 — checkpoint the resolved OPEN plan, requiring a live registered
    caller. CR-CRU-054 §S2 — delegates to the shared implementation."""
    return _axi().cmd_checkpoint(args, _project_dir(args), _ops())


def cmd_stop(args):
    """§S7 — project-level stop (POST …/projects/<key>/stop), requiring a live
    registered caller. CR-CRU-054 §S2 — delegates to the shared
    implementation."""
    return _axi().cmd_stop(args, _project_dir(args), _ops())


def cmd_abort(args):
    """§S7 — abort the resolved OPEN plan, requiring a live registered caller.
    CR-CRU-054 §S2 — delegates to the shared implementation."""
    return _axi().cmd_abort(args, _project_dir(args), _ops())


def cmd_status(args):
    """§S6 — the plan/status READ verb (alias `plans`, no --agent): GET …/plans
    and return the queue as a uniform-table §S1 envelope plus a top-level
    lastRunCr. CR-CRU-054 §S2 — delegates to the shared implementation."""
    return _axi().cmd_status(args, _project_dir(args), _ops())


def cmd_queue(args):
    """CR-CRU-081 §S2 — the queue READ verb (no --agent): the registered CR
    queue (GET …/queue) plus the CR ids a `cr-merged` milestone covers, the two
    landing-record sources the release ceremony's provenance needs. Delegates
    to the shared implementation."""
    return _axi().cmd_queue(args, _project_dir(args), _ops())

# ── CR-CRU-091 §S3/§S9 — roadmap registration: five thin delegators ────────
#
# The verbs land ONCE in `clients/_crucible_axi.py` (the CR-CRU-054 DRY rule);
# what lives here is the `queue-file` shape and nothing more. §S9: the client
# half owns argument parsing, the asking, exit codes and the envelope — never
# a business rule, so every one of these bodies is a single delegating call.


def cmd_release_propose(args):
    """§S3 — record or REVISE a proposed release → POST …/release-proposals.
    Delegates to the shared implementation."""
    return _axi().cmd_release_propose(args, _project_dir(args), _ops())


def cmd_cr_plan(args):
    """§S3/§S6 — declare one CR's release, wave and title → POST …/queue/plan;
    with either undeclared the client ASKS instead of guessing. Delegates to
    the shared implementation."""
    return _axi().cmd_cr_plan(args, _project_dir(args), _ops())


def cmd_wave_sequence(args):
    """§S4 — author a whole wave's order in ONE call → POST …/queue/sequence.
    Delegates to the shared implementation."""
    return _axi().cmd_wave_sequence(args, _project_dir(args), _ops())


def cmd_cr_depends(args):
    """CR-CRU-106 §S1 — declare one CR's COMPLETE dependency set → POST
    …/queue/depends; with `--on` undeclared the client ASKS instead of
    guessing. Delegates to the shared implementation."""
    return _axi().cmd_cr_depends(args, _project_dir(args), _ops())


def cmd_cr_supersede(args):
    """§S3 — record that a CR's work moves to a successor → POST
    …/queue/<cr>/supersede. Delegates to the shared implementation."""
    return _axi().cmd_cr_supersede(args, _project_dir(args), _ops())


def cmd_cr_void(args):
    """§S3 — record that a CR's work is not happening → POST
    …/queue/<cr>/void. Delegates to the shared implementation."""
    return _axi().cmd_cr_void(args, _project_dir(args), _ops())


# ── CR-CRU-092 §S6/§S9 — `next`: one thin delegator ────────────────────────


def cmd_next(args):
    """§S2 — ask the DECLARED roadmap what is actionable now → GET …/queue,
    answering NEXT | HOLD | DRAINED. Read-only (§S4): no --agent, no write.
    Delegates to the shared implementation."""
    return _axi().cmd_next(args, _project_dir(args), _ops())


def _add_project_dir_arg(p):
    """§S4/AC10 — the project-dir flag ALONE, named exactly as the other four
    clients name theirs. This client's `common` parent bundles `--agent` with
    `--project-dir`, and `next` must declare no identity flag at all, so the
    read-only verbs get the one flag they do need without the one they must
    not have."""
    p.add_argument("--project-dir",
                   help="Override project root (default: "
                        "$ARDUINO_CRUCIBLE_PROJECT_DIR, else CWD). The .env "
                        "there must hold CRUCIBLE_PROJECT_KEY.")


# ── CR-CRU-013 §S5 / §S8 — fleet gate / milestone verbs ─────────────────────


def _agent_id(args):
    """CR-CRU-044 §S5 — the agentId for a fleet event: the identity is
    DECLARED (`--agent`) or the verb FAILS. Delegates to the shared fleet
    resolver so all five clients cannot drift apart again.

    There is no fallback: the old filename-derived default
    (`"arduino-crucible"`) fabricated an identity from this script's own
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
    return _axi().cmd_gate_report(args, _project_dir(args), _ops())


def cmd_gate_run(args):
    """§S8 — axi PROXY wrapper around `no-mistakes axi run`. CR-CRU-054 §S2 —
    delegates to the shared implementation; tool discovery stays HERE (this
    module's own `shutil`) so each client's harness keeps its patch seam."""
    return _axi().cmd_gate_run(
        args, _project_dir(args), shutil.which("no-mistakes"), _ops())


def cmd_milestone(args):
    """POST a workflow milestone. §S4b — CR-CRU-054 §S2b delegator to the shared
    implementation, which writes the legacy line to STDERR so it can never
    corrupt the §S1 envelope stream (DN §4 finding #1)."""
    return _axi().cmd_milestone(args, _project_dir(args), _ops())


# ── §S14 — no-arg live dashboard ─────────────────────────────────────────────

_DASHBOARD_PURPOSE_LINE = (
    "arduino-crucible.py -- Arduino-firmware Crucible CLI "
    "(agent lifecycle, native-test/compile ingest, plan/cycle verbs)."
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


def _add_gate_cycle_arg(p):
    """CR-CRU-056 — bind `--cycle` on a GATED verb (CR-CRU-054 §S2 — delegates
    to the shared binding so all five clients document it identically)."""
    return _axi().add_gate_cycle_arg(p)


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--agent",
                        help="Agent id — a free-form identifier. Nothing derives one: "
                             "there is no filename default and no env fallback, so any "
                             "verb that POSTs under an agentId hard-stops without it. "
                             "The role is declared by --role and is never inferred "
                             "from the agentId's shape.")
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
                       help="run native host tests (make junit) -> /api/v2/runs/parsed (§S2)")
    t.add_argument("--dir", default="tests/native", help=_dir_help)
    _add_gate_cycle_arg(t)
    t.set_defaults(func=cmd_test)

    un = sub.add_parser("unit", parents=[common],
                        help="run native host tests (make junit) -> /api/v2/runs/parsed, tier unit (§S3)")
    un.add_argument("--dir", default="tests/native", help=_dir_help)
    _add_gate_cycle_arg(un)
    un.set_defaults(func=cmd_unit)

    rg = sub.add_parser("regression", parents=[common],
                        help="full native suite -> /api/v2/runs/parsed, tier regression (§S3)")
    rg.add_argument("--dir", default="tests/native", help=_dir_help)
    rg.add_argument("--coverage", action="store_true",
                    help="attach lcov coverage from <native_dir>/coverage/lcov.info")
    _add_gate_cycle_arg(rg)
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
    _add_gate_cycle_arg(pmg)
    pmg.set_defaults(func=cmd_pre_merge_gate)

    r = sub.add_parser("register", parents=[common],
                       help="register/heartbeat the agent (TDD roles must bind a "
                            "cycle with --cycle)")
    # CR-CRU-044 §S3 — role is first-class DATA: --role is REQUIRED and
    # enum-constrained (it was unconstrained free text before).
    r.add_argument("--role", required=True,
                   choices=["RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report"],
                   help="Declared role — the ONLY role channel. Use `report` for a "
                        "registration that is not exercising a TDD role.")
    # CR-CRU-056 §S1/§S2 — cycle binding. Optional at the CLI; the SERVER
    # enforces the per-role requirement.
    r.add_argument("--cycle", type=int,
                   help="Cycle id to BIND this agent to (an ACTIVE cycle of an OPEN "
                        "plan). TDD roles (RED/GREEN/FIX/VERIFY) MUST bind — the "
                        "server refuses an unbound TDD registration (409). "
                        "ORCHESTRATOR/report may register unbound. A bound agent's "
                        "ingests are server-stamped with this cycle.")
    r.add_argument("--source", default="claude-md",
                   choices=["claude-md", "package-json", "git-repo", "manual"],
                   help="Identity discovery source per agent-protocol (default: claude-md)")
    r.set_defaults(func=cmd_register)

    u = sub.add_parser("unregister", parents=[common], help="remove the agent")
    u.set_defaults(func=cmd_unregister)

    pf = sub.add_parser("plan-file", parents=[common],
                        help="File a cycle plan; prints the ASSIGNED numeric cycle ids. "
                             "Requires --agent <registered id> (§S2b) — the registered id is "
                             "also stored as the plan's orchestrator (the free-text "
                             "--orchestrator label is retired).")
    pf.add_argument("--cr", required=True,
                    help="CR id — caller-owned free text, e.g. CR-<PROJECT>-<n>.")
    pf.add_argument("--title", help="Optional plan title.")
    pf.add_argument("--cycles", required=True, help='Comma-separated cycle labels, e.g. "a,b,c".')
    pf.add_argument("--wave", help="Wave number (§S3). Resolution: --wave > $WORKFLOW_WAVE.")
    pf.set_defaults(func=cmd_plan_file)

    ca = sub.add_parser("cycle-activate", parents=[common],
                        help="Transition a plan cycle to active. "
                             "Requires --agent <registered id> (§S2b).")
    ca.add_argument("cycle_id", type=int, help="Numeric cycle id (unique per project).")
    ca.set_defaults(func=cmd_cycle_activate)

    cdn = sub.add_parser("cycle-done", parents=[common],
                         help="Transition an ACTIVE plan cycle to done. "
                              "Requires --agent <registered id> (§S2b).")
    cdn.add_argument("cycle_id", type=int, help="Numeric cycle id (unique per project).")
    cdn.set_defaults(func=cmd_cycle_done)

    cc = sub.add_parser("cr-close", parents=[common],
                        help="Close the single OPEN plan (PATCH status=closed + merge.commit). "
                             "Requires --agent <registered id> (§S2b).")
    cc.add_argument("--commit", required=True, help="Merge commit sha.")
    cc.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    cc.set_defaults(func=cmd_cr_close)

    cad = sub.add_parser("cycle-add", parents=[common],
                         help="Append a cycle to a plan (POST …/plans/<id>/cycles). "
                              "Requires --agent <registered id> (§S2b).")
    cad.add_argument("label", help="Label for the new cycle.")
    cad.add_argument("--cr", help="Disambiguate when multiple plans exist.")
    cad.set_defaults(func=cmd_cycle_add)

    cp = sub.add_parser("checkpoint", parents=[common],
                        help="Checkpoint the resolved OPEN plan (POST …/plans/<id>/checkpoint). "
                             "Requires --agent <registered id> (§S2b).")
    cp.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    cp.set_defaults(func=cmd_checkpoint)

    stp = sub.add_parser("stop", parents=[common],
                         help="Stop the project — checkpoint every open plan. "
                              "Requires --agent <registered id> (§S2b).")
    stp.set_defaults(func=cmd_stop)

    ab = sub.add_parser("abort", parents=[common],
                        help="Abort the resolved OPEN plan. Requires --user-approved "
                             "and --agent <registered id> (§S2b).")
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

    # ── CR-CRU-081 §S2 — the landing-record READ verb (no --agent) ──
    qv = sub.add_parser("queue", parents=[common],
                        help="Read the registered CR queue (GET …/queue) plus the "
                             "cr-merged milestone ids as a TOON-AXI table. Read-only.")
    qv.set_defaults(func=cmd_queue)

    # ── CR-CRU-091 §S3 — roadmap registration (ORCHESTRATOR only). The five
    # subparsers are built by the SHARED registrar so the five clients cannot
    # drift into five different flag surfaces for one verb.
    _axi().add_roadmap_verbs(
        sub,
        {"release-propose": cmd_release_propose, "cr-plan": cmd_cr_plan,
          "wave-sequence": cmd_wave_sequence, "cr-supersede": cmd_cr_supersede,
          "cr-void": cmd_cr_void},
        parents=[common])

    # ── CR-CRU-106 §S1 — the DEPENDENCY axis, its own verb and its own
    # registrar (`add_roadmap_verbs`' contract is CR-CRU-091's frozen five).
    # `common` is the parent for the same reason it is above: the verb
    # writes, so it carries --agent.
    _axi().add_cr_depends_verb(sub, cmd_cr_depends, parents=[common])

    # ── CR-CRU-092 §S6 — the roadmap READ verb. Its subparser is built by the
    # SHARED registrar for the same reason; only `--project-dir` is this
    # client's own. No --agent: `next` is read-only (§S4), so `common` (which
    # bundles --agent) is deliberately NOT the parent here.
    _axi().add_next_verb(sub, cmd_next, add_args=(_add_project_dir_arg,))

    gr = sub.add_parser("gate-run", parents=[common],
                        help="axi PROXY: run `no-mistakes axi run`, post throttled interim + final gates.")
    gr.add_argument("--intent", required=True, help="The intent/goal passed down to `axi run`.")
    gr.add_argument("--skip", help="Pipeline steps to skip, forwarded VERBATIM to "
                          "`no-mistakes axi run --skip` (pure passthrough — the "
                          "client never validates or rewrites the value). Exists "
                          "because no-mistakes' `ci` step is PR-based, and a "
                          "git-flow project that merges directly has no PR for it "
                          "to watch — without --skip the gate blocks until "
                          "ci_timeout.")
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
    # reaches the wire; on a RECORDING, `--packages ""` means "this release
    # delivered none", which is a different and recordable fact (§S3/AC4). On
    # `--repair-provenance` the empty value writes NOTHING instead: an empty
    # derivation never overwrites a stored set, and a repair left with nothing
    # to write is REFUSED (CR-CRU-086 §S2).
    ms.add_argument("--packages",
                    help="Comma-separated `registry:name:version` entries the "
                         "release DELIVERED, e.g. `pypi:crucible-axi:0.4.0,"
                         "npm:@anthill-tec/crucible-server:0.4.0`. Pass an "
                         "empty string to record that it delivered none "
                         "(§S1/§S3) — on a recording only: with "
                         "--repair-provenance an empty value writes nothing "
                         "(it never overwrites a stored set) and the repair is "
                         "REFUSED.")
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
    ms.set_defaults(func=cmd_milestone)

    args = p.parse_args()
    if getattr(args, "agent", None):
        os.environ["AGENT_ID"] = args.agent
    # §S14 — no subcommand: run the no-arg live dashboard, not argparse usage.
    if getattr(args, "func", None) is None:
        sys.exit(cmd_dashboard())
    # CR-CRU-044 §S5 — dispatch through the shared `run_verb`, which turns an
    # UNDECLARED agent identity into the ok:false hard-stop envelope + a
    # non-zero exit (POSTing nothing) instead of an unhandled traceback.
    sys.exit(_axi().run_verb(
        args.func, args, lambda a: _project_key(_project_dir(a))) or 0)


if __name__ == "__main__":
    main()
