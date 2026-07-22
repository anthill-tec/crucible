#!/usr/bin/env python3
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
channel); the human-readable line moves to STDERR (interactive only). §S9: ingest
verbs (and register) auto-attach to the open plan's ACTIVE cycle resolved FROM THE
SERVER (CR-CRU-036 removed every env override). An OPEN plan with no active cycle
WARNS + WITHHOLDS (ok:false, non-zero exit, no POST — never a silent orphan); a
plans-fetch failure or no open plan at all is tolerant (the verb proceeds).

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

Agent naming (agent-protocol): agentId = `<agent-type>-<project>` (e.g. claude-sandesh)
for the orchestrator, or `CR-<PROJ>-NNN-<cycle>-<PHASE>` (e.g. CR-SAN-001-A-RED) for
TDD-phase agents. Identity carries displayName + source (default claude-md) + repoPath,
inside the `identity` object.
"""

import argparse
import glob
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
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
        spec = importlib.util.spec_from_file_location("python_crucible_toon", toon_path)
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
        spec = importlib.util.spec_from_file_location("python_crucible_axi_shared", axi_path)
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
    """§S9 — the ingest payload's `context`: the env/git `_run_context()` enriched
    with the RESOLVED cycleId so the SERVER-recorded run carries the attach cycle
    (not just the printed envelope). Returns None only when there is nothing to attach."""
    context = _run_context() or {}
    if cycle_id is not None:
        context["cycleId"] = cycle_id
    return context or None


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


def _register_agent(project_dir, agent_id, message, display_name=None, source="claude-md"):
    """POST the agent-online heartbeat. Shared by cmd_register."""
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
    return _post("/api/v2/agents/register", payload)


def _unregister_agent(project_dir, agent_id):
    return _post(
        "/api/v2/agents/unregister",
        {"agentId": agent_id, "projectKey": _project_key(project_dir)},
    )


def _remove_agent_silent(project_dir, agent_id):
    """CR-CRU-008 §S4 anti-ghost cleanup for a gated run: remove the agent row
    WITHOUT journaling a lifecycle event. Best-effort: never raises, never
    pollutes the run verdict or stdout."""
    try:
        _post(
            "/api/v2/agents/unregister",
            {"agentId": agent_id, "projectKey": _project_key(project_dir), "silent": True},
        )
    except Exception:
        pass


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
    tolerant (None, [], False) proceed; (None, [warning], True) ONLY when an OPEN
    plan carries no active cycle — the caller MUST emit ok:false and SKIP the POST."""
    return _axi().resolve_attach_cycle(_plans_response(project_dir))


def _register_cycle_guard(project_dir):
    """CR-CRU-036 §S9 — register mirrors the ingest withhold: an OPEN plan with no
    active cycle withholds registration rather than bring an agent online against
    untracked work. A plans-fetch failure or no open plan at all is TOLERANT
    (register proceeds). Returns (withhold, warnings)."""
    _cycle, warnings, withhold = _axi().resolve_attach_cycle(_plans_response(project_dir))
    return withhold, warnings


def _emit_ingest_axi(verb, resp, summary, project_dir, agent, cycle_id, warnings):
    """Emit the §S1 envelope for a SUCCESSFUL ingest verb: run{passed,failed,total}
    + cycle-aware context. Any warnings are also surfaced on stderr."""
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
    """§S9 — emit the ok:false envelope (cycleId=null) on stdout AND stderr when
    an OPEN plan carries no active cycle to attach an ingest to. The run is NOT
    POSTed, so it can never land as a silent cycleId=NONE orphan."""
    context = _axi_context(project_dir, agent_id=agent, cycle_id=None)
    for w in warnings:
        print(_axi().withhold_stderr_line(w), file=sys.stderr)
    _emit_axi(verb, False, {}, context, warnings)


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
    resp = _register_agent(
        project_dir, args.agent,
        args.message or f"Starting {args.phase} phase",
        display_name=args.display_name, source=args.source,
    )
    ok = bool(resp.get("ok", False))
    legacy = (f"register: ok={resp.get('ok', False)} agent={args.agent} "
              f"phase={args.phase} source={args.source}")
    _emit_axi("register", ok,
              {"agent": args.agent, "help": _axi().HELP_STEPS["register"]},
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
    total = passed = failed = 0
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
            if children:
                tree_nodes.append({
                    "name": suite.get("name", "?"),
                    "status": "fail" if suite_fail else "pass",
                    "children": children,
                })
    summary = {"total": total, "passed": passed, "failed": failed,
               "pending": 0, "duration_ms": duration_ms}
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
        f"failed={summary['failed']} total={summary['total']}{cov_line}"
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
    # PYTHONSAFEPATH=1 keeps cwd (project_dir) OFF sys.path for this `-m coverage`
    # subprocess, so a stray `coverage/` directory in project_dir cannot shadow the
    # installed coverage.py. cwd stays project_dir (to find .coverage/source) and
    # PYTHONPATH is still honored.
    cov_env = dict(env)
    cov_env["PYTHONSAFEPATH"] = "1"
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
    (tier unit). With --agent the result is ingested (regardless of pass/fail) and
    §S9 auto-attaches it to the active cycle. Exit code reflects the runner."""
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
        # §S9 — resolve the cycle BEFORE the POST so a no-active-cycle run
        # withholds WITHOUT ever ingesting a cycleId=null orphan.
        cycle_id, warnings, withhold = _resolve_ingest_cycle(project_dir)
        if withhold:
            _emit_ingest_withhold("test", project_dir, args.agent, warnings)
            return 1
        resp = _ingest_parsed(project_dir, args.agent, summary, tree, tier="unit",
                              context=_ingest_context(cycle_id),
                              raw=result.stdout)
        _emit_ingest_axi("test", resp, summary, project_dir, args.agent,
                         cycle_id, warnings)
        if summary["failed"] > 0:
            return 1
        return 0 if resp.get("ok") else 1
    # No XML at all → a hard collection/syntax failure. Ingest the CAPTURED runner
    # output as compile so the RED is still reported rather than silently lost.
    _ingest_compile(project_dir, args.agent, _no_xml_errors_text(result), tier="unit")
    return result.returncode or 1


def cmd_regression(args):
    """Gated regression run — wraps the ingest body in an anti-ghost silent
    cleanup (CR-CRU-008 §S4)."""
    project_dir = _resolve_project_dir(args.project_dir)
    try:
        return _regression_run(args)
    finally:
        if getattr(args, "agent", None):
            _remove_agent_silent(project_dir, args.agent)


def _regression_run(args):
    """Full-suite discover via xmlrunner (tier regression). With --coverage: run under
    coverage.py and post /api/v2/runs/parsed with coverage. §S9 auto-attaches."""
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
        # PYTHONSAFEPATH=1 keeps cwd (project_dir) OFF sys.path for this `-m coverage`
        # subprocess, so a stray `coverage/` directory in project_dir cannot shadow
        # the installed coverage.py. cwd stays project_dir and PYTHONPATH is honored.
        env["PYTHONSAFEPATH"] = "1"

    print(f"[crucible] running: {' '.join(run_cmd)}", file=sys.stderr)
    result = _run_logged(run_cmd, project_dir, env, getattr(args, "log", None))
    print(f"[crucible] xmlrunner exit={result.returncode}", file=sys.stderr)

    if not _produced_xml(reports_dir):
        print("[crucible] ERROR: no JUnit XML produced — ingesting captured output as compile",
              file=sys.stderr)
        _ingest_compile(project_dir, args.agent, _no_xml_errors_text(result),
                        tier="regression")
        return result.returncode or 1

    summary, tree = _parse_junit_dir(reports_dir)
    coverage = _collect_coverage(python, project_dir, env) if coverage_on else None
    # §S9 — resolve/attach the active cycle before the POST (withhold when none).
    cycle_id, warnings, withhold = _resolve_ingest_cycle(project_dir)
    if withhold:
        _emit_ingest_withhold("regression", project_dir, args.agent, warnings)
        return 1
    resp = _ingest_parsed(project_dir, args.agent, summary, tree, coverage,
                          tier="regression", context=_ingest_context(cycle_id))
    _emit_ingest_axi("regression", resp, summary, project_dir, args.agent,
                     cycle_id, warnings)
    return 0 if (resp.get("ok") and summary["failed"] == 0) else 1


def cmd_auto_ingest(args):
    """Ingest an already-produced reports dir (client-parsed → per-method names).
    §S9 auto-attaches the run to the active cycle."""
    project_dir = _resolve_project_dir(args.project_dir)
    reports_dir = _reports_dir(project_dir, args.reports)
    if not _produced_xml(reports_dir):
        print(f"[crucible] no TEST-*.xml in {reports_dir} — nothing to ingest",
              file=sys.stderr)
        return 1
    summary, tree = _parse_junit_dir(reports_dir)
    cycle_id, warnings, withhold = _resolve_ingest_cycle(project_dir)
    if withhold:
        _emit_ingest_withhold("auto-ingest", project_dir, args.agent, warnings)
        return 1
    resp = _ingest_parsed(project_dir, args.agent, summary, tree, tier="unit",
                          context=_ingest_context(cycle_id))
    _emit_ingest_axi("auto-ingest", resp, summary, project_dir, args.agent,
                     cycle_id, warnings)
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
    )
    return cmd_regression(reg_args)


# ── CR-CRU-008/030 — plan verbs ─────────────────────────────────────────────


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
                  _axi_context(project_dir), warnings, legacy)
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
    patch_resp = _patch(f"{_plans_path(project_dir)}/{plan['planId']}",
                        {"wave": args.wave})
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


# ── CR-CRU-030 §S4/§S7 — append-cycle + CR-024 workflow verbs ────────────────


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


# ── CR-CRU-013 §S5 — fleet gate / milestone verbs ───────────────────────────


def _agent_id(args):
    """The agentId for a fleet event. Explicit --agent > $WORKFLOW_ROLE > a stable
    fallback (these verbs never assert on the id, but the server requires one)."""
    explicit = getattr(args, "agent", None)
    if explicit:
        return explicit
    return os.environ.get("WORKFLOW_ROLE") or "python-crucible"


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


_DASHBOARD_PURPOSE_LINE = (
    "python-crucible.py -- Python/unittest Crucible CLI "
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


def main():
    p = argparse.ArgumentParser(prog="python-crucible", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    # §S14 — subcommand is OPTIONAL: a bare invocation falls through to the
    # no-arg live dashboard, never argparse's required-subcommand error.
    sub = p.add_subparsers(dest="cmd", required=False)

    r = sub.add_parser(
        "register",
        help="Register / heartbeat an agent. agentId convention: `<agent-type>-<project>` "
             "(e.g. claude-sandesh) or TDD-phase `CR-<PROJ>-NNN-<cycle>-<PHASE>`.",
    )
    r.add_argument("--agent", required=True,
                   help="Agent id — `<type>-<project>` or `CR-<PROJ>-NNN-<cycle>-<PHASE>`")
    r.add_argument("--phase", default="report",
                   help="Phase label (RED/GREEN/FIX/VERIFY/ORCHESTRATOR; default: report)")
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
    g.add_argument("--cov-source", default="app",
                   help="coverage --source package/dir (default: app)")
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
    pmg.add_argument("--cov-source", default="app",
                     help="coverage --source package/dir (default: app)")
    pmg.add_argument("--skip-check", action="store_true",
                     help="Bypass the fail-fast py_compile check step")
    _add_discover_args(pmg)
    _add_python_arg(pmg)
    _add_project_dir_arg(pmg)
    _add_log_arg(pmg)
    pmg.set_defaults(func=cmd_pre_merge_gate)

    pf = sub.add_parser("plan-file",
                        help="File a cycle plan; prints the ASSIGNED numeric cycle ids.")
    pf.add_argument("--cr", required=True, help="CR id, e.g. CR-CRU-008.")
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
