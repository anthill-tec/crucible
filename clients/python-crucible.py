#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Python + unittest Crucible CLI — single entry point for orchestrator + RED/GREEN/
FIX/VERIFY agent lifecycle ops AND for running Python test targets (unittest via
xmlrunner → JUnit XML, optional coverage.py). Replaces inline python / loose curl so
each invocation has a stable command signature.

Modelled exactly on bun-crucible.py / rust-crucible.py (same agent lifecycle,
.env project-key resolution, /api/v2/* ingest contract, and — CR-CRU-030 §S1/§S2 —
the shared TOON-AXI envelope module clients/_crucible_axi.py) — only the toolchain
differs: Cargo/nextest/llvm-cov or bun test → a venv Python interpreter +
unittest-xml-reporting (xmlrunner) + coverage.py, with py_compile as the syntax gate.

This script is tool-specific (unittest / xmlrunner / JUnit-XML / coverage.py), not
project-specific — the project path and interpreter are parameterizable.

Every AXI verb prints a clients/toon.py-encoded envelope
`{"axi": {verb, ok, <result fields>, context, warnings}}` on STDOUT (the machine
channel); the human-readable line moves to STDERR (interactive only). Cycle
attachment (CR-CRU-056 §S3): agents register BOUND to a cycle (`register --cycle`
with an ACTIVE cycle id — REQUIRED by the server for TDD roles RED/GREEN/FIX/
VERIFY; ORCHESTRATOR/report may register unbound). A bound agent's ingests are
stamped with that cycle SERVER-side — the client resolves and sends no cycle;
an unbound agent's runs attach only via an explicit `context.cycleId`.

Subcommands:
  register, unregister  Agent lifecycle.
  test                  Run a TARGETED test (dotted path) or discover, via xmlrunner →
                        JUnit XML → /api/v2/runs/parsed (tier unit). The per-cycle
                        RED/GREEN workhorse. The reports dir is wiped first so only THIS
                        run's XML is ingested. If --agent omitted, just runs (exit code
                        only). If NO XML is produced (import/collection failure), the
                        CAPTURED runner output is ingested to /api/v2/runs/compile.
  regression            Run the FULL suite (discover) via xmlrunner (tier regression).
                        With --coverage (coverage.py), posts /api/v2/runs/parsed with
                        line/function coverage. Orchestrator pre-merge gate path.
  auto-ingest           Ingest only: post an already-produced reports dir (parsed).
  check                 python -m py_compile over given paths (default app/ + tests/);
                        ingest any errors to /api/v2/runs/compile. Syntax gate.
  pre-merge-gate        ORCHESTRATOR gate: fail-fast check → regression --coverage.
  plan-file             File a cycle plan → the assigned NUMERIC cycle ids.
  plan-backfill         Backfill a plan's wave (PATCH wave-only; open OR closed).
  cycle-activate <id>   Transition a cycle to active.
  cycle-done <id>       Transition an ACTIVE cycle to done.
  cr-close --commit <sha> [--cr <CR>]
                        Close the single OPEN plan (PATCH status=closed + merge.commit).
  cycle-add <label>     Append a cycle to a plan (§S4).
  status / plans        Read the plan queue (§S6) as a TOON-AXI table.
  checkpoint / stop / abort
                        CR-024 workflow verbs (§S7).
  gate-run / gate-report / milestone
                        Fleet gate + milestone verbs (§S8).

Project + Crucible endpoint:
  Reads CRUCIBLE_PROJECT_KEY from <project-dir>/.env.
  Project path resolution: --project-dir > $PY_CRUCIBLE_PROJECT_DIR > the git repo
  containing the current directory > CWD. No project is hardcoded.
  Interpreter resolution: --python > $PY_CRUCIBLE_PYTHON > <project-dir>/.venv/bin/python
  (if present) > the interpreter running this script. The venv must have xmlrunner
  (and, for --coverage, coverage.py) plus any imports the code-under-test needs.
  Posts to $CRUCIBLE_URL (default http://localhost:3849), v2 endpoints ONLY:
  /api/v2/agents/register|unregister, /api/v2/runs/parsed, /api/v2/runs/compile,
  /api/v2/projects/<key>/plans, /api/v2/gates, /api/v2/milestones.

Agent naming (CR-CRU-044 §S4/§S5): the agentId is a FREE-FORM identifier carrying no
structure the system reads. It is DECLARED with `--agent` or the verb fails — there is no
filename default and no env fallback ($WORKFLOW_ROLE is the track lane, not an identity).
The role comes from `--role` alone and is never inferred from the agentId's shape, so
`<agent-type>-<project>` (e.g. claude-sandesh) and `CR-<PROJ>-NNN-<cycle>-<ROLE>` (e.g.
CR-SAN-001-A-RED) are readability habits only. Identity carries displayName + source
(default claude-md) + repoPath, inside the `identity` object.
"""

import argparse
import glob
import importlib.util
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

CRUCIBLE_URL = os.environ.get("CRUCIBLE_URL", "http://localhost:3849")
DEFAULT_REPORTS = "test-reports"

# §S2b cadence (CR-CRU-008 _Narrator default) reused by gate-run's interim poll.


def _resolve_project_dir(arg_value):
    """Resolution order: --project-dir > $PY_CRUCIBLE_PROJECT_DIR > git repo of CWD > CWD.

    No project is hardcoded. The `.env` holding CRUCIBLE_PROJECT_KEY must live at that
    resolved root.
    """
    if arg_value:
        return arg_value
    env_value = os.environ.get("PY_CRUCIBLE_PROJECT_DIR")
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


def _resolve_python(arg_value, project_dir):
    """--python > $PY_CRUCIBLE_PYTHON > <project-dir>/.venv/bin/python > this interpreter.

    The chosen interpreter must have xmlrunner importable (and coverage.py for
    --coverage). A project venv is the norm so test-only deps never touch the runtime.
    """
    if arg_value:
        return arg_value
    env = os.environ.get("PY_CRUCIBLE_PYTHON")
    if env:
        return env
    venv_py = os.path.join(project_dir, ".venv", "bin", "python")
    if os.path.exists(venv_py):
        return venv_py
    return sys.executable or "python3"


# ── HTTP transport seam (mocked in-process by the client test harnesses) ────


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


# ── run context (declared cycle linkage) ────────────────────────────────────


def _run_context():
    """CR-CRU-008 §S2 — env + git → run context for declared cycle linkage.

    CR-CRU-054 §S2 — a thin delegator to `_crucible_axi.run_context`, which
    documents the full contract (WORKFLOW_CYCLE/WAVE/ROLE, tolerant git
    provenance, and None — never a bare `{}` — when no workflow env is set).
    The local name is kept deliberately: the CR-CRU-030 delegation pattern,
    addressed unqualified by every call site here and by the client test
    harnesses."""
    return _axi().run_context()


def _run_logged(cmd, cwd, env, log_path):
    """Run `cmd` with combined stdout+stderr ALWAYS captured (the no-XML compile
    fallback needs the real runner output), echoed to STDERR so the machine
    stdout channel stays the TOON-AXI envelope, and additionally written to
    `log_path` when set. Returns CompletedProcess (`.stdout` holds the capture)."""
    result = subprocess.run(
        cmd, cwd=cwd, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    out = result.stdout or ""
    if log_path:
        try:
            with open(log_path, "w") as f:
                f.write(out)
            print(f"[crucible] run log → {log_path} ({len(out)} bytes)", file=sys.stderr)
        except OSError as e:
            print(f"[crucible] WARN: could not write run log to {log_path}: {e}",
                  file=sys.stderr)
    sys.stderr.write(out)
    return result


# ── Agent lifecycle ─────────────────────────────────────────────────────────


def _register_agent(project_dir, agent_id, message, display_name=None, source="claude-md",
                    role=None, cycle_id=None):
    """POST the agent-online heartbeat. Shared by cmd_register.

    CR-CRU-044 §S1 — `role` is part of the registration wire contract; the
    server rejects a registration that declares none.

    CR-CRU-056 §S1/§S4 — `cycle_id` rides the body as `cycleId`, binding the
    agent to a cycle; the server validates it (ACTIVE cycle in an OPEN plan)
    and REQUIRES it for TDD roles (RED/GREEN/FIX/VERIFY).
    """
    payload = {
        "agentId": agent_id,
        "projectKey": _project_key(project_dir),
        "status": "online",
        "message": message,
        "identity": {
            "displayName": display_name or agent_id,
            "source": source,
            "repoPath": project_dir,
        },
    }
    if role is not None:
        payload["role"] = role
    if cycle_id is not None:
        payload["cycleId"] = cycle_id
    return _post("/api/v2/agents/register", payload)


def _unregister_agent(project_dir, agent_id):
    return _post(
        "/api/v2/agents/unregister",
        {"agentId": agent_id, "projectKey": _project_key(project_dir)},
    )


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


def _emit_ingest_axi(verb, resp, summary, files, project_dir, agent, help_steps=None):
    """Emit the §S1 envelope for an ingest verb:
    run{passed,failed,pending,total,files}. `files` (CR-CRU-051 §S2, propagating
    CR-CRU-047 §S2 from the bun reference) is the distinct-source count from
    `_parse_junit_dir` — per-FILE on xmlrunner 4.x (it stamps `file=`),
    degrading to per-CLASS on a report without it — carried as a
    sibling of the test counts so a suite that silently shrinks is visible in
    the gate output itself. CR-CRU-056 §S3 — the client RESOLVES no
    cycle: a bound agent's run is stamped with its registered cycle SERVER-side
    (a stale binding gets a 409, surfaced via `error`). C5 — the envelope
    context ECHOES the attachment the SERVER reported (`context.cycleId` on the
    ingest response), so the agent sees which cycle absorbed its evidence
    without a second `GET /api/v2/events`; absent → the key is omitted.

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
        # Faithful pass-through: a 409 (stale binding / unregistered poster)
        # carries the server's structured envelope inside the HTTP error body.
        result_fields["error"] = err
    _emit_axi(verb, bool(resp.get("ok")), result_fields, context, [])


def cmd_register(args):
    """Register / heartbeat. CR-CRU-056 §S1/§S2 — `--cycle` binds the agent to
    an ACTIVE cycle of an OPEN plan; the server validates the binding and
    REQUIRES it for TDD roles (RED/GREEN/FIX/VERIFY) — a refused registration
    surfaces the server's 409 envelope (error + help) and exits non-zero.
    ORCHESTRATOR/report may register unbound.

    CR-CRU-054 §S2b — delegates to the shared implementation, which owns the
    §S5 runtime identity hard stop (DN §4 finding #3) and the documented-enum
    `--source` strategy (finding #5).
    This client's own `_register_agent` payload builder stays a per-client
    PARAMETER: it sends an `identity.repoPath` and honours `--display-name`."""
    return _axi().cmd_register(args, _resolve_project_dir(args.project_dir), _ops(),
                               register_fn=_register_agent)


def cmd_unregister(args):
    """Remove this agent's row (journals an 'unregistered' lifecycle event).

    CR-CRU-054 §S2b — delegates to the shared implementation, whose §S5 runtime
    identity hard stop replaced argparse `required=True` (DN §4 finding #3).
    This client's own `_unregister_agent` poster stays a per-client PARAMETER."""
    return _axi().cmd_unregister(args, _resolve_project_dir(args.project_dir), _ops(),
                                 unregister_fn=_unregister_agent)


# ── Toolchain: unittest/xmlrunner test + regression + auto-ingest + check ────


def _reports_dir(project_dir, arg_value):
    rd = arg_value or DEFAULT_REPORTS
    return rd if os.path.isabs(rd) else os.path.join(project_dir, rd)


def _wipe(reports_dir):
    """Remove stale TEST-*.xml so only the current run's results get ingested."""
    if os.path.isdir(reports_dir):
        for entry in os.listdir(reports_dir):
            if entry.startswith("TEST-") and entry.endswith(".xml"):
                try:
                    os.remove(os.path.join(reports_dir, entry))
                except OSError:
                    pass


def _xmlrunner_cmd(python, targets, start_dir, pattern, reports_dir):
    """Build the xmlrunner invocation: targeted (dotted paths) or discover."""
    base = [python, "-m", "xmlrunner"]
    if targets:
        return base + list(targets) + ["-o", reports_dir]
    return base + ["discover", "-s", start_dir, "-p", pattern, "-o", reports_dir]


def _parse_junit_dir(reports_dir):
    """Parse every TEST-*.xml in reports_dir into (summary, tree, files) with
    per-method leaf names for the /api/v2/runs/parsed path so the Crucible tree
    shows real names.

    CR-CRU-051 §S1 — `files` is the DISTINCT-SOURCE count, mirroring
    `bun-crucible.py::_parse_junit_file` (the reference).

    RESOLVED GRANULARITY FOR THIS CLIENT: **VERSION-DEPENDENT — per-FILE on the
    xmlrunner we run, per-CLASS on one that predates it.** Measured, not
    assumed: unittest-xml-reporting 4.0.0 stamps each `<testcase>` with BOTH
    `classname` AND a real `file="tests/client/foo.py"`, so the first rung of
    the chain hits and the count is genuinely per test FILE (a whole-module run
    of one file reports files=1, not one-per-TestCase-class). Where `file` is
    absent the count degrades to `classname` — i.e. distinct test CLASSES, NOT
    files, which is the format's contract and is named honestly here rather
    than implying a precision that report cannot give — and then to the suite
    name. The chain never collapses to zero: a constant zero would make a
    shrinking suite look identical to a healthy one. It rides the printed run
    envelope only, never the ingest payload (CR-CRU-047 §S2)."""
    tree_nodes = []
    total = passed = failed = pending = 0
    duration_ms = 0
    files = set()
    for xml_file in sorted(glob.glob(os.path.join(reports_dir, "TEST-*.xml"))):
        root = ET.parse(xml_file).getroot()
        suites = root.findall(".//testsuite") or [root]
        for suite in suites:
            children = []
            suite_fail = False
            for tc in suite.findall("testcase"):
                source = tc.get("file") or tc.get("classname") or suite.get("name")
                if source:
                    files.add(source.replace("\\", "/"))
                tc_time = int(float(tc.get("time", 0)) * 1000)
                fail = tc.find("failure") is not None or tc.find("error") is not None
                # CR-CRU-050 §S1/§S1b — a `<skipped/>` testcase (unittest's
                # skip/skipIf/skipUnless, as emitted by xmlrunner) is PENDING,
                # never passed. Order matters: failure/error first, then
                # skipped, then pass. A skip does NOT fail its suite.
                # Mirrors mvn-crucible.py:641, the reference implementation.
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
            if children:
                tree_nodes.append({
                    "name": suite.get("name", "?"),
                    "status": "fail" if suite_fail else "pass",
                    "children": children,
                })
    summary = {"total": total, "passed": passed, "failed": failed,
               "pending": pending, "duration_ms": duration_ms}
    # `files` is returned as a SIBLING of `summary`, deliberately not a key
    # inside it: `summary` IS the /api/v2/runs/parsed payload's summary field
    # verbatim, and CR-CRU-047 §S2 keeps this count out of the wire.
    return summary, tree_nodes, len(files)


def _produced_xml(reports_dir):
    return os.path.isdir(reports_dir) and any(
        e.startswith("TEST-") and e.endswith(".xml") for e in os.listdir(reports_dir)
    )


def _no_xml_errors_text(result):
    """The REAL captured runner output for the no-XML compile fallback — never the
    empty string /api/v2/runs/compile 400s on."""
    out = (result.stdout or "").strip() if hasattr(result, "stdout") else ""
    return out or "xmlrunner produced no JUnit XML (import/syntax failure, no output captured)"


def _is_zero_discovery(result):
    """CR-CRU-039 §S2 — distinguish an HONEST empty discovery (the start_dir/pattern
    matched nothing → "Ran 0 tests", no traceback) from a GENUINE import/collection
    failure (the runner capture carries a Traceback). Only the former is a definitive
    `no-tests-discovered` AXI error; the latter still routes to the compile-tier
    ingest. Reads the combined runner capture (`result.stdout`, with stderr folded in
    by `_run_logged`)."""
    out = ((result.stdout or "") if hasattr(result, "stdout") else "").strip()
    if "Traceback (most recent call last)" in out:
        return False
    # A bare-empty capture is NOT an honest zero-discovery: a genuine silent
    # crash (OOM/SIGKILL/interpreter abort) produces NO output either, and must
    # NOT be misclassified as the benign `no-tests-discovered`. Only a capture
    # that positively shows an empty collection ("Ran 0 tests", no traceback)
    # is a definitive zero-discovery; a truly empty capture falls through to the
    # compile-tier ingest path (§S2).
    return "Ran 0 tests" in out


def _ingest_parsed(project_dir, agent_id, summary, tree, coverage=None, tier=None,
                   context=None, raw=None, files=None):
    """POST the client-parsed run (per-method leaf names) to /api/v2/runs/parsed.
    Returns the parsed response dict (the caller emits the §S1 envelope).

    CR-CRU-051 §S2 — `files` (the distinct-source count) is a PRINT-ONLY
    argument: it is appended to the human-readable count line and is never
    added to `payload`/`summary`, which go on the wire (CR-CRU-047 §S2)."""
    payload = {
        "projectKey": _project_key(project_dir),
        "agentId": agent_id,
        "summary": summary,
        "tree": tree,
    }
    if coverage:
        payload["coverage"] = coverage
    if tier:
        payload["tier"] = tier
    if context:
        payload["context"] = context
    if raw:
        payload["raw"] = raw
    resp = _post("/api/v2/runs/parsed", payload)
    cov_line = ""
    if coverage:
        cov_line = (f" lines={coverage['lines']['percent']}%"
                    f" funcs={coverage['functions']['percent']}%")
    print(
        f"ingest parsed: ok={resp.get('ok')} passed={summary['passed']} "
        f"failed={summary['failed']} pending={summary.get('pending', 0)} "
        f"total={summary['total']}"
        + (f" files={files}" if files is not None else "")
        + cov_line
        + (f" error={resp['error']}" if resp.get("error") else ""),
        file=sys.stderr,
    )
    return resp


def _ingest_compile(project_dir, agent_id, errors_text, tier=None):
    """Ingest a syntax/collection failure to /api/v2/runs/compile (with run context)."""
    payload = {
        "projectKey": _project_key(project_dir),
        "format": "python",
        "errors": errors_text,
        "agentId": agent_id,
    }
    if tier:
        payload["tier"] = tier
    context = _run_context()
    if context:
        payload["context"] = context
    resp = _post("/api/v2/runs/compile", payload)
    print(f"ingest compile (python): ok={resp.get('ok')}"
          + (f" error={resp['error']}" if resp.get("error") else ""),
          file=sys.stderr)
    return 0 if resp.get("ok") else 1


def _collect_coverage(python, project_dir, env):
    """Run `coverage lcov` and sum LF/LH/FNF/FNH into a Crucible coverage object.
    Returns None if coverage.py or the lcov output is unavailable."""
    lcov_path = os.path.join(project_dir, "coverage.lcov")
    # NOTE: no PYTHONSAFEPATH here (CR-CRU-040 §S1) — matches _regression_run. A real
    # coverage.py install wins over the stray top-level `coverage/` (bun lcov)
    # namespace-dir shadow on its own — a regular package beats a namespace package
    # regardless of cwd on sys.path — so the flag is unnecessary. cwd stays
    # project_dir (to find .coverage) and PYTHONPATH is still honored.
    # OUT OF SCOPE (CR-CRU-045 §S2): this only holds for a BARE `coverage/` dir
    # (bun's real lcov shape, no `__init__.py` — a namespace package). A `coverage/`
    # dir carrying its own `__init__.py` is a REGULAR package and WOULD shadow the
    # real module while cwd is on sys.path; that is inherent to running
    # `python -m coverage` from a project whose tree contains a `coverage` package,
    # not specific to this client, and would cost a 3.11 floor (`python -P`) to
    # defend — deliberately left unguarded.
    cov_env = dict(env)
    r = subprocess.run([python, "-m", "coverage", "lcov", "-o", lcov_path],
                       cwd=project_dir, env=cov_env, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(lcov_path):
        print(f"[crucible] WARN: coverage lcov unavailable ({r.stderr.strip()[:120]})",
              file=sys.stderr)
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
        "lines": {"total": lf, "covered": lh,
                  "percent": round(lh / lf * 100, 1) if lf else 0},
        "functions": {"total": ff, "covered": fh,
                      "percent": round(fh / ff * 100, 1) if ff else 0},
    }


def cmd_test(args):
    """Targeted/discover unittest via xmlrunner → JUnit XML → /api/v2/runs/parsed
    (tier unit). With --agent the result is ingested (regardless of pass/fail); a
    bound agent's run is server-stamped with its registered cycle. Exit code
    reflects the runner."""
    project_dir = _resolve_project_dir(args.project_dir)
    python = _resolve_python(args.python, project_dir)
    reports_dir = _reports_dir(project_dir, args.reports)
    os.makedirs(reports_dir, exist_ok=True)
    _wipe(reports_dir)

    cmd = _xmlrunner_cmd(python, args.tests, args.start_dir, args.pattern, reports_dir)
    env = os.environ.copy()
    print(f"[crucible] running: {' '.join(cmd)}", file=sys.stderr)
    result = _run_logged(cmd, project_dir, env, getattr(args, "log", None))
    print(f"[crucible] xmlrunner exit={result.returncode}", file=sys.stderr)

    if not args.agent:
        return result.returncode

    if _produced_xml(reports_dir):
        summary, tree, files = _parse_junit_dir(reports_dir)
        resp = _ingest_parsed(project_dir, args.agent, summary, tree, tier="unit",
                              context=_run_context(),
                              raw=result.stdout, files=files)
        _emit_ingest_axi("test", resp, summary, files, project_dir, args.agent)
        if summary["failed"] > 0:
            return 1
        return 0 if resp.get("ok") else 1
    # No XML at all → a hard collection/syntax failure. Ingest the CAPTURED runner
    # output as compile so the RED is still reported rather than silently lost.
    _ingest_compile(project_dir, args.agent, _no_xml_errors_text(result), tier="unit")
    # CR-CRU-064 §S2 — the compile ingest above is UNCHANGED; the envelope is
    # additive, so a starved toolchain stops returning an exit code with empty
    # stdout. The exit code is untouched (AC5).
    _emit_axi("test", False,
              {"help": _axi().no_report_help("test", "TEST-*.xml")},
              _axi_context(project_dir, agent_id=args.agent),
              [_axi().no_report_warning("test", "TEST-*.xml", result.returncode,
                                        result.stdout or "")],
              "[crucible] ERROR: no JUnit XML produced — ingested as compile")
    return result.returncode or 1


def cmd_regression(args, verb="regression"):
    """Gated regression run — an opening heartbeat DECLARES the run's identity
    (binding it when `--cycle` is given), and the ingest body is wrapped in the
    anti-ghost silent cleanup (CR-CRU-008 §S4). CR-CRU-056 — the cleanup fires
    ONLY for an identity this run created; a caller who registered BEFORE the
    run keeps its registration and its cycle binding.

    CR-CRU-058 §S1 — `verb` names the envelope this run belongs to:
    `pre-merge-gate` runs this body AS its regression step, so the gate's stdout
    must carry ONE document under the GATE's own verb, not the inner one's."""
    project_dir = _resolve_project_dir(args.project_dir)
    identity = None
    try:
        if getattr(args, "agent", None):
            identity = _open_gate_identity(project_dir, args.agent,
                                           getattr(args, "cycle", None),
                                           "gated regression run starting")
        return _regression_run(args, verb)
    finally:
        _close_gate_identity(project_dir, identity)


def _regression_run(args, verb="regression"):
    """Full-suite discover via xmlrunner (tier regression). With --coverage: run under
    coverage.py and post /api/v2/runs/parsed with coverage. A bound agent's run is
    server-stamped with its registered cycle. `verb` (CR-CRU-058 §S1) names the
    envelope — see `cmd_regression`."""
    project_dir = _resolve_project_dir(args.project_dir)
    python = _resolve_python(args.python, project_dir)
    reports_dir = _reports_dir(project_dir, args.reports)
    os.makedirs(reports_dir, exist_ok=True)
    _wipe(reports_dir)
    env = os.environ.copy()

    run_cmd = _xmlrunner_cmd(python, None, args.start_dir, args.pattern, reports_dir)
    coverage_on = bool(args.coverage)
    if coverage_on:
        run_cmd = [python, "-m", "coverage", "run", "--source", args.cov_source,
                   "-m", "xmlrunner", "discover", "-s", args.start_dir,
                   "-p", args.pattern, "-o", reports_dir]
        # NOTE: no PYTHONSAFEPATH here. A real coverage.py install (CR-CRU-040 §S1)
        # wins over the stray top-level `coverage/` (bun lcov) namespace-dir shadow
        # on its own — a regular package beats a namespace package regardless of cwd
        # on sys.path. Setting PYTHONSAFEPATH would leak into grandchild test
        # subprocesses (the suite's own subprocess-spawning tests), breaking their
        # tmpdir-cwd dotted-name imports; cwd (project_dir) stays on sys.path so
        # discovery still works.
        # OUT OF SCOPE (CR-CRU-045 §S2): as above, this holds only for a BARE
        # `coverage/` dir (no `__init__.py`). One carrying its own `__init__.py` is
        # a regular package and WOULD shadow — inherent to running `python -m
        # coverage` from a tree containing a `coverage` package, not specific to
        # this client, and would cost a 3.11 floor (`python -P`) to defend.
        # Deliberately left unguarded.

    print(f"[crucible] running: {' '.join(run_cmd)}", file=sys.stderr)
    result = _run_logged(run_cmd, project_dir, env, getattr(args, "log", None))
    print(f"[crucible] xmlrunner exit={result.returncode}", file=sys.stderr)

    if not _produced_xml(reports_dir):
        if _is_zero_discovery(result):
            # §S2 — a discovery that COLLECTED ZERO TESTS (start_dir/pattern matched
            # nothing) is a DEFINITIVE `no-tests-discovered` AXI error, NOT a masked
            # compile ingest. The compile path below is reserved for a genuine
            # import/collection failure (its capture carries a traceback).
            detail = (f"0 tests discovered — start_dir={args.start_dir!r} "
                      f"pattern={args.pattern!r} matched nothing")
            warning = {"code": "no-tests-discovered", "detail": detail}
            print(f"[crucible] ERROR: no-tests-discovered — {detail}", file=sys.stderr)
            _emit_axi(verb, False,
                      {"help": ["check --start-dir / --pattern; ensure the test dir "
                                "is a package (has __init__.py)"]},
                      _axi_context(project_dir, agent_id=args.agent), [warning])
            return result.returncode or 1
        print("[crucible] ERROR: no JUnit XML produced — ingesting captured output as compile",
              file=sys.stderr)
        _ingest_compile(project_dir, args.agent, _no_xml_errors_text(result),
                        tier="regression")
        # CR-CRU-064 §S2/AC6 — emitted under the `verb` PARAMETER, never the
        # literal "regression": `pre-merge-gate` runs this body as its
        # regression step, so a starved GATE must speak as the gate. The
        # `no-tests-discovered` branch above keeps its own code (AC7).
        _emit_axi(verb, False,
                  {"help": _axi().no_report_help(verb, "TEST-*.xml")},
                  _axi_context(project_dir, agent_id=args.agent),
                  [_axi().no_report_warning(verb, "TEST-*.xml",
                                            result.returncode,
                                            result.stdout or "")],
                  f"{verb}: ok=False — no JUnit XML, ingested as compile")
        return result.returncode or 1

    summary, tree, files = _parse_junit_dir(reports_dir)
    coverage = _collect_coverage(python, project_dir, env) if coverage_on else None
    resp = _ingest_parsed(project_dir, args.agent, summary, tree, coverage,
                          tier="regression", context=_run_context(), files=files)
    ok = bool(resp.get("ok")) and summary["failed"] == 0
    # §S2 — a GATE run's next step is derived from the run state it reached
    # (unrecorded / red / green); the plain `regression` verb keeps its canned
    # HELP_STEPS entry, unchanged.
    help_steps = (_axi().run_help(verb, ok, summary["failed"], CRUCIBLE_URL)
                  if verb != "regression" else None)
    _emit_ingest_axi(verb, resp, summary, files, project_dir, args.agent,
                     help_steps=help_steps)
    return 0 if (resp.get("ok") and summary["failed"] == 0) else 1


def cmd_auto_ingest(args):
    """Ingest an already-produced reports dir (client-parsed → per-method names).
    A bound agent's run is server-stamped with its registered cycle."""
    project_dir = _resolve_project_dir(args.project_dir)
    reports_dir = _reports_dir(project_dir, args.reports)
    if not _produced_xml(reports_dir):
        print(f"[crucible] no TEST-*.xml in {reports_dir} — nothing to ingest",
              file=sys.stderr)
        # CR-CRU-064 §S2 — this verb runs NO runner of its own (it ingests a
        # pre-existing reports dir), so there is no capture to carry: the
        # helper's blank-capture form is the honest detail here.
        _emit_axi("auto-ingest", False,
                  {"help": _axi().no_report_help("auto-ingest", "TEST-*.xml")},
                  _axi_context(project_dir, agent_id=args.agent),
                  [_axi().no_report_warning("auto-ingest", "TEST-*.xml", 1, "")],
                  f"auto-ingest: ok=False — no TEST-*.xml in {reports_dir}")
        return 1
    summary, tree, files = _parse_junit_dir(reports_dir)
    resp = _ingest_parsed(project_dir, args.agent, summary, tree, tier="unit",
                          context=_run_context(), files=files)
    _emit_ingest_axi("auto-ingest", resp, summary, files, project_dir, args.agent)
    return 0 if resp.get("ok") else 1


def cmd_check(args):
    """python -m py_compile over the given paths (default app/ + tests/). With --agent,
    ingest any errors as a compile failure. §S2/§S15 — returns the §S1 envelope."""
    project_dir = _resolve_project_dir(args.project_dir)
    state = _check_gate(args, project_dir)
    legacy = f"check: ok={state['ok']} exit={state['exit']}"
    _emit_axi("check", state["ok"],
              {"exit": state["exit"], "help": _axi().HELP_STEPS["check"]},
              _axi_context(project_dir, agent_id=args.agent), [], legacy)
    return 0 if state["ok"] else (state["exit"] or 1)


def _check_gate(args, project_dir):
    """The py_compile gate itself — CR-CRU-058 §S1: this helper NEVER emits, so
    the two envelope-owning verbs that run it (`check` standalone, and
    `pre-merge-gate`'s fail-fast step 0) each put exactly ONE document on
    stdout. Returns the measured state — `{exit, ok}` — and its caller emits."""
    python = _resolve_python(args.python, project_dir)
    paths = args.paths or ["app", "tests"]
    files = []
    for p in paths:
        ap = p if os.path.isabs(p) else os.path.join(project_dir, p)
        if os.path.isdir(ap):
            for dirpath, _dirs, names in os.walk(ap):
                files += [os.path.join(dirpath, n) for n in names if n.endswith(".py")]
        elif ap.endswith(".py"):
            files.append(ap)
    cmd = [python, "-m", "py_compile", *files]
    print(f"[crucible] running: py_compile on {len(files)} file(s)", file=sys.stderr)
    result = subprocess.run(cmd, cwd=project_dir, capture_output=True, text=True)
    print(f"[crucible] py_compile exit={result.returncode}", file=sys.stderr)
    ok = result.returncode == 0
    if not ok:
        sys.stderr.write(result.stderr)
        if args.agent:
            _ingest_compile(project_dir, args.agent, result.stderr)
    return {"exit": result.returncode, "ok": ok}


def cmd_pre_merge_gate(args):
    """ORCHESTRATOR pre-merge gate — the ONLY path that measures coverage. Steps:
    fail-fast `check` (py_compile) → full `regression --coverage`."""
    project_dir = _resolve_project_dir(args.project_dir)
    if not getattr(args, "skip_check", False):
        check_args = argparse.Namespace(
            paths=None, agent=args.agent, python=args.python, project_dir=args.project_dir,
        )
        # The STEP form (no envelope of its own) — this gate owns stdout.
        state = _check_gate(check_args, project_dir)
        if not state["ok"]:
            print("[crucible] pre-merge gate FAILED at the py_compile check step — "
                  "skipped the regression. Fix syntax first (or --skip-check to bypass).",
                  file=sys.stderr)
            # §S2 — the state reached is "aborted at step 0, the regression
            # never ran": the next action is the syntax error, never the gate's
            # own successor. A passing gate falls through to the regression
            # envelope below, whose help[] is derived from the RUN state.
            _emit_axi("pre-merge-gate", False,
                      {"stage": "check", "exit": state["exit"],
                       "help": _axi().gate_step_abort_help(
                           "pre-merge-gate",
                           "fix the py_compile syntax error(s) reported on "
                           "stderr (or --skip-check to bypass)")},
                      _axi_context(project_dir, agent_id=args.agent),
                      [_axi().gate_step_abort_warning(
                          "pre-merge-gate", "py_compile check",
                          "the sources do not compile")],
                      f"pre-merge-gate: ok=False exit={state['exit']} — "
                      f"aborted at the py_compile check step")
            return state["exit"] or 1
    reg_args = argparse.Namespace(
        agent=args.agent, coverage=True, cov_source=args.cov_source,
        start_dir=args.start_dir, pattern=args.pattern, reports=args.reports,
        python=args.python, project_dir=args.project_dir, log=getattr(args, "log", None),
        cycle=getattr(args, "cycle", None),
    )
    # §S1 — the regression body emits under THIS gate's verb, so the gate puts
    # exactly one envelope on stdout under the name the caller invoked.
    return cmd_regression(reg_args, verb="pre-merge-gate")


# ── CR-CRU-008/030 — plan verbs ─────────────────────────────────────────────


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
    legacy = (f"plan-backfill: ok={ok} plan={plan['planId']} cr={cr_label} "
              f"wave={args.wave}"
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


# ── CR-CRU-030 §S4/§S7 — append-cycle + CR-024 workflow verbs ────────────────


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
    (`"python-crucible"`) fabricated an identity from this script's own
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


def cmd_queue_file(args):
    """§S2 — parse docs/changes/README.md (or --from-file) into queue entries
    and POST the full set to /api/v2/projects/<key>/queue. Delegates to the
    shared implementation."""
    return _axi().cmd_queue_file(args, _resolve_project_dir(args.project_dir), _ops())


# ── argparse helpers + no-arg dashboard + main ──────────────────────────────


def _add_project_dir_arg(p):
    p.add_argument(
        "--project-dir",
        help="Override project root (default: $PY_CRUCIBLE_PROJECT_DIR, else the git repo "
             "containing the current directory). The .env at the root must contain "
             "CRUCIBLE_PROJECT_KEY.",
    )


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


def _add_python_arg(p):
    p.add_argument(
        "--python",
        help="Interpreter to run tests with (default: $PY_CRUCIBLE_PYTHON, else "
             "<project>/.venv/bin/python if present, else this interpreter). Must have "
             "xmlrunner (and coverage.py for --coverage).",
    )


def _add_discover_args(p):
    p.add_argument("--start-dir", default="tests",
                   help="Discovery start dir (default: tests)")
    p.add_argument("--pattern", default="test_*.py",
                   help="Discovery filename pattern (default: test_*.py)")
    p.add_argument("--reports", help=f"Reports dir (default: {DEFAULT_REPORTS})")


def _add_log_arg(p):
    p.add_argument(
        "--log",
        help="Write the FULL run output (combined stdout+stderr) to this path in addition "
             "to streaming it, so an agent can read the run back for debugging.",
    )


def _add_gate_cycle_arg(p):
    """CR-CRU-056 — bind `--cycle` on a GATED verb (CR-CRU-054 §S2 — delegates
    to the shared binding so all five clients document it identically)."""
    return _axi().add_gate_cycle_arg(p)


_DASHBOARD_PURPOSE_LINE = (
    "python-crucible.py -- Python/unittest Crucible CLI "
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


def main():
    p = argparse.ArgumentParser(prog="python-crucible", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    # §S14 — subcommand is OPTIONAL: a bare invocation falls through to the
    # no-arg live dashboard, never argparse's required-subcommand error.
    sub = p.add_subparsers(dest="cmd", required=False)

    r = sub.add_parser(
        "register",
        help="Register / heartbeat an agent. The role is declared by --role; TDD "
             "roles must bind a cycle with --cycle; the agentId is a free-form "
             "identifier.",
    )
    # CR-CRU-054 §S2b (DN §4 finding #3) — NOT argparse-required: the §S5
    # runtime hard stop owns the refusal so it arrives as a structured envelope.
    r.add_argument("--agent",
                   help="Agent id — a free-form identifier. REQUIRED, but enforced at "
                        "RUNTIME by the §S5 hard stop (CR-CRU-054 §S2b) so a missing "
                        "id yields the ok:false AXI envelope, not a bare argparse "
                        "usage error. "
                                                "Agent id — a free-form identifier. The role is declared by "
                        "--role and is never inferred from the agentId's shape; any "
                        "`<type>-<project>` / `CR-<PROJ>-NNN-<cycle>-<ROLE>` convention "
                        "is a naming habit only.")
    # CR-CRU-044 §S3 — role is first-class DATA: --role is REQUIRED and
    # enum-constrained (it was free text with a "report" default before).
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
    r.add_argument("--display-name", help="Human-readable name (default: the agentId)")
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

    t = sub.add_parser(
        "test",
        help="Targeted/discover unittest via xmlrunner → parsed ingest. With --agent: ingest.",
    )
    t.add_argument("--tests", nargs="+",
                   help="Dotted test target(s), e.g. tests.test_mcp_server or "
                        "tests.test_mcp_server.Cls.test_x. Omit to discover.")
    t.add_argument("--agent", help="If set, ingest the result after the run")
    _add_discover_args(t)
    _add_python_arg(t)
    _add_project_dir_arg(t)
    _add_log_arg(t)
    t.set_defaults(func=cmd_test)

    g = sub.add_parser(
        "regression",
        help="Full-suite discover via xmlrunner + ingest. --coverage for coverage.py.",
    )
    g.add_argument("--agent", required=True, help="Agent id (typically the orchestrator)")
    g.add_argument("--coverage", action="store_true",
                   help="Run under coverage.py and post /api/v2/runs/parsed with coverage")
    g.add_argument("--cov-source", default="crucible_axi,clients",
                   help="coverage --source package/dir (default: crucible_axi,clients)")
    _add_gate_cycle_arg(g)
    _add_discover_args(g)
    _add_python_arg(g)
    _add_project_dir_arg(g)
    _add_log_arg(g)
    g.set_defaults(func=cmd_regression)

    a = sub.add_parser("auto-ingest",
                       help="Ingest an already-produced reports dir (parsed).")
    a.add_argument("--agent", required=True)
    a.add_argument("--reports", help=f"Reports dir (default: {DEFAULT_REPORTS})")
    _add_project_dir_arg(a)
    a.set_defaults(func=cmd_auto_ingest)

    c = sub.add_parser("check",
                       help="py_compile syntax gate over app/ + tests/; ingest errors.")
    c.add_argument("--paths", nargs="+",
                   help="Files/dirs to compile (default: app tests)")
    c.add_argument("--agent", help="If set, ingest compile errors on failure")
    _add_python_arg(c)
    _add_project_dir_arg(c)
    c.set_defaults(func=cmd_check)

    pmg = sub.add_parser(
        "pre-merge-gate",
        help="ORCHESTRATOR pre-merge: fail-fast py_compile check → regression WITH "
             "coverage.py (the only coverage path; coverage is reserved for this gate).",
    )
    pmg.add_argument("--agent", required=True, help="Agent id (typically the orchestrator)")
    pmg.add_argument("--cov-source", default="crucible_axi,clients",
                     help="coverage --source package/dir (default: crucible_axi,clients)")
    pmg.add_argument("--skip-check", action="store_true",
                     help="Bypass the fail-fast py_compile check step")
    _add_gate_cycle_arg(pmg)
    _add_discover_args(pmg)
    _add_python_arg(pmg)
    _add_project_dir_arg(pmg)
    _add_log_arg(pmg)
    pmg.set_defaults(func=cmd_pre_merge_gate)

    pf = sub.add_parser("plan-file",
                        help="File a cycle plan; prints the ASSIGNED numeric cycle ids. "
                             "Requires --agent <registered id> (§S2b).")
    pf.add_argument("--cr", required=True, help="CR id, e.g. CR-CRU-008.")
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

    qf = sub.add_parser(
        "queue-file",
        help="Parse docs/changes/README.md (or --from-file) queue table and "
             "POST the full CR set → /api/v2/projects/<key>/queue (§S2).")
    qf.add_argument("--from-file", dest="from_file",
                    help="Source Markdown file (default: <project>/docs/changes/README.md).")
    _add_project_dir_arg(qf)
    qf.set_defaults(func=cmd_queue_file)

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
