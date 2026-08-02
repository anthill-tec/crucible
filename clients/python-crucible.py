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
with an ACTIVE cycle id — REQUIRED by the server for TDD phases RED/GREEN/FIX/
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
The phase comes from `--phase` alone and is never inferred from the agentId's shape, so
`<agent-type>-<project>` (e.g. claude-sandesh) and `CR-<PROJ>-NNN-<cycle>-<PHASE>` (e.g.
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
import time
import xml.etree.ElementTree as ET

CRUCIBLE_URL = os.environ.get("CRUCIBLE_URL", "http://localhost:3849")
DEFAULT_REPORTS = "test-reports"

# §S2b cadence (CR-CRU-008 _Narrator default) reused by gate-run's interim poll.
_GATE_POLL_CADENCE_S = 2.0
_GATE_POLL_TICK_S = 0.4


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
                    phase=None, cycle_id=None):
    """POST the agent-online heartbeat. Shared by cmd_register.

    CR-CRU-044 §S1 — `phase` is part of the registration wire contract; the
    server rejects a registration that declares none.

    CR-CRU-056 §S1/§S4 — `cycle_id` rides the body as `cycleId`, binding the
    agent to a cycle; the server validates it (ACTIVE cycle in an OPEN plan)
    and REQUIRES it for TDD phases (RED/GREEN/FIX/VERIFY).
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
    if phase is not None:
        payload["phase"] = phase
    if cycle_id is not None:
        payload["cycleId"] = cycle_id
    return _post("/api/v2/agents/register", payload)


def _unregister_agent(project_dir, agent_id):
    return _post(
        "/api/v2/agents/unregister",
        {"agentId": agent_id, "projectKey": _project_key(project_dir)},
    )


def _remove_agent_silent(project_dir, agent_id):
    """CR-CRU-008 §S4 anti-ghost cleanup for a gated run: remove the agent row
    WITHOUT journaling a lifecycle event. Best-effort: never raises, never
    pollutes the run verdict or stdout.

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
                 identity.open_payload(_project_key(project_dir), message=message))
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


def _emit_ingest_axi(verb, resp, summary, project_dir, agent):
    """Emit the §S1 envelope for an ingest verb:
    run{passed,failed,pending,total}. CR-CRU-056 §S3 — the client RESOLVES no
    cycle: a bound agent's run is stamped with its registered cycle SERVER-side
    (a stale binding gets a 409, surfaced via `error`). C5 — the envelope
    context ECHOES the attachment the SERVER reported (`context.cycleId` on the
    ingest response), so the agent sees which cycle absorbed its evidence
    without a second `GET /api/v2/events`; absent → the key is omitted."""
    run = {"passed": summary["passed"], "failed": summary["failed"],
           "pending": summary.get("pending", 0),
           "total": summary["total"]}
    context = _axi_context(project_dir, agent_id=agent,
                           cycle_id=_axi().echoed_cycle_id(resp))
    result_fields = {"run": run, "help": _axi().HELP_STEPS.get(verb, ["status"])}
    err = resp.get("error")
    if err is not None:
        # Faithful pass-through: a 409 (stale binding / unregistered poster)
        # carries the server's structured envelope inside the HTTP error body.
        result_fields["error"] = err
    _emit_axi(verb, bool(resp.get("ok")), result_fields, context, [])


def cmd_register(args):
    """Register / heartbeat. CR-CRU-056 §S1/§S2 — `--cycle` binds the agent to
    an ACTIVE cycle of an OPEN plan; the server validates the binding and
    REQUIRES it for TDD phases (RED/GREEN/FIX/VERIFY) — a refused registration
    surfaces the server's 409 envelope (error + help) and exits non-zero.
    ORCHESTRATOR/report may register unbound."""
    project_dir = _resolve_project_dir(args.project_dir)
    resp = _register_agent(
        project_dir, args.agent,
        args.message or f"Starting {args.phase} phase",
        display_name=args.display_name, source=args.source,
        phase=args.phase, cycle_id=args.cycle,
    )
    ok = bool(resp.get("ok", False))
    legacy = (f"register: ok={resp.get('ok', False)} agent={args.agent} "
              f"phase={args.phase} source={args.source}")
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
    resp = _unregister_agent(project_dir, args.agent)
    ok = bool(resp.get("ok", False))
    legacy = f"unregister: ok={resp.get('ok', False)} agent={args.agent}"
    _emit_axi("unregister", ok,
              {"agent": args.agent, "help": _axi().HELP_STEPS["unregister"]},
              _axi_context(project_dir, agent_id=args.agent), [], legacy)
    return 0 if ok else 1


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
    """Parse every TEST-*.xml in reports_dir into (summary, tree) with per-method leaf
    names for the /api/v2/runs/parsed path so the Crucible tree shows real names."""
    tree_nodes = []
    total = passed = failed = pending = 0
    duration_ms = 0
    for xml_file in sorted(glob.glob(os.path.join(reports_dir, "TEST-*.xml"))):
        root = ET.parse(xml_file).getroot()
        suites = root.findall(".//testsuite") or [root]
        for suite in suites:
            children = []
            suite_fail = False
            for tc in suite.findall("testcase"):
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
    return summary, tree_nodes


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
                   context=None, raw=None):
    """POST the client-parsed run (per-method leaf names) to /api/v2/runs/parsed.
    Returns the parsed response dict (the caller emits the §S1 envelope)."""
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
        f"total={summary['total']}{cov_line}"
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
        summary, tree = _parse_junit_dir(reports_dir)
        resp = _ingest_parsed(project_dir, args.agent, summary, tree, tier="unit",
                              context=_run_context(),
                              raw=result.stdout)
        _emit_ingest_axi("test", resp, summary, project_dir, args.agent)
        if summary["failed"] > 0:
            return 1
        return 0 if resp.get("ok") else 1
    # No XML at all → a hard collection/syntax failure. Ingest the CAPTURED runner
    # output as compile so the RED is still reported rather than silently lost.
    _ingest_compile(project_dir, args.agent, _no_xml_errors_text(result), tier="unit")
    return result.returncode or 1


def cmd_regression(args):
    """Gated regression run — an opening heartbeat DECLARES the run's identity
    (binding it when `--cycle` is given), and the ingest body is wrapped in the
    anti-ghost silent cleanup (CR-CRU-008 §S4). CR-CRU-056 — the cleanup fires
    ONLY for an identity this run created; a caller who registered BEFORE the
    run keeps its registration and its cycle binding."""
    project_dir = _resolve_project_dir(args.project_dir)
    identity = None
    try:
        if getattr(args, "agent", None):
            identity = _open_gate_identity(project_dir, args.agent,
                                           getattr(args, "cycle", None),
                                           "gated regression run starting")
        return _regression_run(args)
    finally:
        _close_gate_identity(project_dir, identity)


def _regression_run(args):
    """Full-suite discover via xmlrunner (tier regression). With --coverage: run under
    coverage.py and post /api/v2/runs/parsed with coverage. A bound agent's run is
    server-stamped with its registered cycle."""
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
            _emit_axi("regression", False,
                      {"help": ["check --start-dir / --pattern; ensure the test dir "
                                "is a package (has __init__.py)"]},
                      _axi_context(project_dir, agent_id=args.agent), [warning])
            return result.returncode or 1
        print("[crucible] ERROR: no JUnit XML produced — ingesting captured output as compile",
              file=sys.stderr)
        _ingest_compile(project_dir, args.agent, _no_xml_errors_text(result),
                        tier="regression")
        return result.returncode or 1

    summary, tree = _parse_junit_dir(reports_dir)
    coverage = _collect_coverage(python, project_dir, env) if coverage_on else None
    resp = _ingest_parsed(project_dir, args.agent, summary, tree, coverage,
                          tier="regression", context=_run_context())
    _emit_ingest_axi("regression", resp, summary, project_dir, args.agent)
    return 0 if (resp.get("ok") and summary["failed"] == 0) else 1


def cmd_auto_ingest(args):
    """Ingest an already-produced reports dir (client-parsed → per-method names).
    A bound agent's run is server-stamped with its registered cycle."""
    project_dir = _resolve_project_dir(args.project_dir)
    reports_dir = _reports_dir(project_dir, args.reports)
    if not _produced_xml(reports_dir):
        print(f"[crucible] no TEST-*.xml in {reports_dir} — nothing to ingest",
              file=sys.stderr)
        return 1
    summary, tree = _parse_junit_dir(reports_dir)
    resp = _ingest_parsed(project_dir, args.agent, summary, tree, tier="unit",
                          context=_run_context())
    _emit_ingest_axi("auto-ingest", resp, summary, project_dir, args.agent)
    return 0 if resp.get("ok") else 1


def cmd_check(args):
    """python -m py_compile over the given paths (default app/ + tests/). With --agent,
    ingest any errors as a compile failure. §S2/§S15 — returns the §S1 envelope."""
    project_dir = _resolve_project_dir(args.project_dir)
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
    legacy = f"check: ok={ok} exit={result.returncode}"
    _emit_axi("check", ok,
              {"exit": result.returncode, "help": _axi().HELP_STEPS["check"]},
              _axi_context(project_dir, agent_id=args.agent), [], legacy)
    return 0 if ok else (result.returncode or 1)


def cmd_pre_merge_gate(args):
    """ORCHESTRATOR pre-merge gate — the ONLY path that measures coverage. Steps:
    fail-fast `check` (py_compile) → full `regression --coverage`."""
    if not getattr(args, "skip_check", False):
        check_args = argparse.Namespace(
            paths=None, agent=args.agent, python=args.python, project_dir=args.project_dir,
        )
        rc = cmd_check(check_args)
        if rc != 0:
            print("[crucible] pre-merge gate FAILED at the py_compile check step — "
                  "skipped the regression. Fix syntax first (or --skip-check to bypass).",
                  file=sys.stderr)
            return rc
    reg_args = argparse.Namespace(
        agent=args.agent, coverage=True, cov_source=args.cov_source,
        start_dir=args.start_dir, pattern=args.pattern, reports=args.reports,
        python=args.python, project_dir=args.project_dir, log=getattr(args, "log", None),
        cycle=getattr(args, "cycle", None),
    )
    return cmd_regression(reg_args)


# ── CR-CRU-008/030 — plan verbs ─────────────────────────────────────────────


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
                  _axi_context(project_dir, agent_id=agent_id), warnings, legacy)
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
    """§S4 — append a cycle to a plan. Resolve the target plan (ALL plans, optional
    --cr), POST …/plans/<planId>/cycles with ONLY the label, and let the SERVER
    reject a CLOSED/absent plan. The assigned numeric id stays machine-readable.

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
    """CR-CRU-056 — `--cycle` on a GATED verb (regression/pre-merge-gate): the
    binding for the register-inside-the-run case."""
    p.add_argument("--cycle", type=int, help=_axi().GATE_CYCLE_HELP)


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
    return cmd_status(argparse.Namespace(project_dir=None, fields=None))


def main():
    p = argparse.ArgumentParser(prog="python-crucible", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    # §S14 — subcommand is OPTIONAL: a bare invocation falls through to the
    # no-arg live dashboard, never argparse's required-subcommand error.
    sub = p.add_subparsers(dest="cmd", required=False)

    r = sub.add_parser(
        "register",
        help="Register / heartbeat an agent. The phase is declared by --phase; TDD "
             "phases must bind a cycle with --cycle; the agentId is a free-form "
             "identifier.",
    )
    r.add_argument("--agent", required=True,
                   help="Agent id — a free-form identifier. The phase is declared by "
                        "--phase and is never inferred from the agentId's shape; any "
                        "`<type>-<project>` / `CR-<PROJ>-NNN-<cycle>-<PHASE>` convention "
                        "is a naming habit only.")
    # CR-CRU-044 §S3 — phase is first-class DATA: --phase is REQUIRED and
    # enum-constrained (it was free text with a "report" default before).
    r.add_argument("--phase", required=True,
                   choices=["RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report"],
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
    r.add_argument("--display-name", help="Human-readable name (default: the agentId)")
    r.add_argument("--source", default="claude-md",
                   choices=["claude-md", "package-json", "git-repo", "manual"],
                   help="Identity discovery source per agent-protocol (default: claude-md)")
    r.add_argument("--message", help="Optional status message")
    _add_project_dir_arg(r)
    r.set_defaults(func=cmd_register)

    u = sub.add_parser("unregister", help="Unregister an agent")
    u.add_argument("--agent", required=True)
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

    gr = sub.add_parser("gate-run",
                        help="axi PROXY: run `no-mistakes axi run`, post throttled interim "
                             "+ final gates, relay the axi detail to the caller.")
    gr.add_argument("--intent", required=True, help="The intent/goal passed down to `axi run`.")
    gr.add_argument("--agent", help="Agent id for the gate events — REQUIRED (§S5): the "
                          "identity is declared or the verb fails; there is "
                          "no fallback.")
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
