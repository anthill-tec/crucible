#!/usr/bin/env python3
"""Python + unittest Crucible CLI — single entry point for orchestrator + RED/GREEN/
FIX/VERIFY agent lifecycle ops AND for running Python test targets (unittest via
xmlrunner → JUnit XML, optional coverage.py). Replaces inline python / loose curl so
each invocation has a stable command signature.

Modelled exactly on rust-crucible.py (same agent lifecycle, .env project-key resolution,
/api/v2/* ingest contract) — only the toolchain differs: Cargo/nextest/llvm-cov → a
venv Python interpreter + unittest-xml-reporting (xmlrunner) + coverage.py.

This script is tool-specific (unittest / xmlrunner / JUnit-XML / coverage.py), not
project-specific — the project path and interpreter are parameterizable.

Subcommands:
  register, unregister  Agent lifecycle.
  test                  Run a TARGETED test (dotted path) or discover, via xmlrunner →
                        JUnit XML → /api/v2/runs/parsed (tier unit). The per-cycle
                        RED/GREEN workhorse. The reports dir is wiped first so only THIS
                        run's XML is ingested. If --agent omitted, just runs (exit code
                        only). If NO XML is produced (import/collection failure), the
                        CAPTURED runner output is ingested to /api/v2/runs/compile so
                        the RED is reported instead of silently lost.
  regression            Run the FULL suite (discover) via xmlrunner (tier regression).
                        With --coverage (needs coverage.py), runs under coverage and
                        posts /api/v2/runs/parsed with line/function coverage.
                        Orchestrator pre-merge gate path. The no-XML fallback applies
                        here too.
  auto-ingest           Ingest only: post an already-produced reports dir (parsed).
  check                 python -m py_compile over given paths (default app/ + tests/);
                        ingest any errors to /api/v2/runs/compile. Best-effort syntax
                        gate (most Python RED failures surface as junit errors at
                        import time).

Project + Crucible endpoint:
  Reads CRUCIBLE_PROJECT_KEY from <project-dir>/.env.
  Project path resolution: --project-dir > $PY_CRUCIBLE_PROJECT_DIR > the git repo
  containing the current directory > CWD. No project is hardcoded.
  Interpreter resolution: --python > $PY_CRUCIBLE_PYTHON > <project-dir>/.venv/bin/python
  (if present) > the interpreter running this script. The venv must have xmlrunner
  (and, for --coverage, coverage.py) plus any imports the code-under-test needs.
  Posts to $CRUCIBLE_URL (default http://localhost:3849), v2 endpoints ONLY:
  /api/v2/agents/register|unregister, /api/v2/runs/parsed, /api/v2/runs/compile.

Run context (CR-CRU-008 §S2): when any WORKFLOW_* env var is set
(WORKFLOW_CYCLE_ID / WORKFLOW_CYCLE / WORKFLOW_WAVE / WORKFLOW_ROLE), every ingest
carries a `context` object {cycleId, cycle, wave, orchestrator, git:{branch,commit}}.
With no WORKFLOW_* env, no context key is sent at all.

Examples:
  # Targeted RED/GREEN run + ingest in one call
  python-crucible.py test --tests tests.test_mcp_server --agent CR-SAN-001-A-RED

  # A single test case/method
  python-crucible.py test --tests tests.test_mcp_server.McpServerTest.test_setup_tool --agent CR-SAN-001-A-GREEN

  # Discover everything under tests/ without ingest (just see if it passes)
  python-crucible.py test

  # Full regression + ingest (orchestrator gate); add --coverage for coverage.py
  python-crucible.py regression --agent claude-sandesh

  # Override project path / interpreter
  python-crucible.py register --project-dir /path/to/repo --agent claude-sandesh --phase ORCHESTRATOR
  PY_CRUCIBLE_PYTHON=/path/.venv/bin/python python-crucible.py test --tests tests.test_x --agent CR-SAN-001-A-RED

Agent naming (agent-protocol): agentId = `<agent-type>-<project>` (e.g. claude-sandesh) for
the orchestrator, or `CR-<PROJ>-NNN-<cycle>-<PHASE>` (e.g. CR-SAN-001-A-RED) for TDD-phase
agents. Identity carries displayName + source (default claude-md) + repoPath, inside the
`identity` object.
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

CRUCIBLE_URL = os.environ.get("CRUCIBLE_URL", "http://localhost:3849")
DEFAULT_REPORTS = "test-reports"


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


def _post(path, payload):
    """POST JSON to Crucible. Returns the parsed JSON, or an {ok:False,error} dict on
    HTTP error (so a bad format/endpoint surfaces a message instead of a traceback)."""
    req = urllib.request.Request(
        f"{CRUCIBLE_URL}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        return json.loads(urllib.request.urlopen(req).read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        return {"ok": False, "error": f"HTTP {e.code}: {body}"}
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"connection failed: {e.reason} "
                                      f"(is Crucible running at {CRUCIBLE_URL}?)"}


def _run_context():
    """CR-CRU-008 §S2 — env + git → run context for declared cycle linkage.

    Reads WORKFLOW_CYCLE_ID (int-coerced; invalid → omitted), WORKFLOW_CYCLE,
    WORKFLOW_WAVE and WORKFLOW_ROLE. When at least one is set, attaches
    git {branch, commit} from a cheap `git rev-parse` (tolerant of a
    non-repo cwd → omitted). Returns the context dict, or None when no
    workflow env is set. Same pattern as clients/rust-crucible.py.
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


def _run_logged(cmd, cwd, env, log_path):
    """Run `cmd` with combined stdout+stderr ALWAYS captured (the no-XML compile
    fallback needs the real runner output — CR-CRU-008 Implementation Notes), echoed
    to this process's stdout so the run stays visible, and additionally written to
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
            print(f"[crucible] run log → {log_path} ({len(out)} bytes)")
        except OSError as e:
            print(f"[crucible] WARN: could not write run log to {log_path}: {e}")
    sys.stdout.write(out)
    return result


def cmd_register(args):
    """Register / heartbeat. agentId follows `<agent-type>-<project>` (agent-protocol),
    or the TDD-phase form `CR-<PROJ>-NNN-<cycle>-<PHASE>` for RED/GREEN/FIX/VERIFY agents.
    Identity fields (displayName/source/repoPath) go INSIDE `identity` — top-level is
    ignored by Crucible."""
    project_dir = _resolve_project_dir(args.project_dir)
    payload = {
        "agentId": args.agent,
        "projectKey": _project_key(project_dir),
        "status": "online",
        "message": args.message or f"Starting {args.phase} phase",
        "identity": {
            "displayName": args.display_name or args.agent,
            "source": args.source,
            "repoPath": project_dir,
        },
    }
    resp = _post("/api/v2/agents/register", payload)
    print(f"register: ok={resp.get('ok', False)} agent={args.agent} "
          f"phase={args.phase} source={args.source}")
    return 0 if resp.get("ok") else 1


def cmd_unregister(args):
    project_dir = _resolve_project_dir(args.project_dir)
    resp = _post(
        "/api/v2/agents/unregister",
        {"agentId": args.agent, "projectKey": _project_key(project_dir)},
    )
    print(f"unregister: ok={resp.get('ok', False)} agent={args.agent}")
    return 0 if resp.get("ok") else 1


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
    names. Mirrors rust-crucible's parser; used for the /api/v2/runs/parsed path so the
    Crucible tree shows real test-method names."""
    import glob
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


def _ingest_parsed_dir(project_dir, agent_id, reports_dir, tier):
    """Parse the reports dir client-side (per-method leaf names) and POST to
    /api/v2/runs/parsed with the given tier + run context. The server-side codec=junit
    parser historically labeled leaves by classname, so the local parser is the
    reliable path for real test-method names. No coverage (that stays the
    pre-merge-gate's job)."""
    summary, tree = _parse_junit_dir(reports_dir)
    payload = {
        "projectKey": _project_key(project_dir),
        "agentId": agent_id,
        "summary": summary,
        "tree": tree,
        "tier": tier,
    }
    context = _run_context()
    if context:
        payload["context"] = context
    resp = _post("/api/v2/runs/parsed", payload)
    print(
        f"ingest parsed: ok={resp.get('ok')} "
        f"passed={summary['passed']} failed={summary['failed']} total={summary['total']}"
        + (f" error={resp['error']}" if resp.get("error") else "")
    )
    return 0 if resp.get("ok") else 1


def _produced_xml(reports_dir):
    return os.path.isdir(reports_dir) and any(
        e.startswith("TEST-") and e.endswith(".xml") for e in os.listdir(reports_dir)
    )


def _no_xml_errors_text(result):
    """The REAL captured runner output for the no-XML compile fallback — never the
    empty string /api/v2/runs/compile 400s on (CR-CRU-008 Implementation Notes:
    the 'no-XML fallback 400 bug')."""
    out = (result.stdout or "").strip() if hasattr(result, "stdout") else ""
    return out or "xmlrunner produced no JUnit XML (import/syntax failure, no output captured)"


def cmd_test(args):
    """Targeted/discover unittest via xmlrunner → JUnit XML → /api/v2/runs/parsed
    (tier unit). With --agent the result is ingested regardless of pass/fail. Exit
    code reflects the runner (non-zero on failing tests / collection failure)."""
    project_dir = _resolve_project_dir(args.project_dir)
    python = _resolve_python(args.python, project_dir)
    reports_dir = _reports_dir(project_dir, args.reports)
    os.makedirs(reports_dir, exist_ok=True)
    _wipe(reports_dir)

    cmd = _xmlrunner_cmd(python, args.tests, args.start_dir, args.pattern, reports_dir)
    env = os.environ.copy()
    print(f"[crucible] running: {' '.join(cmd)}")
    result = _run_logged(cmd, project_dir, env, getattr(args, "log", None))
    print(f"[crucible] xmlrunner exit={result.returncode}")

    if not args.agent:
        return result.returncode

    if _produced_xml(reports_dir):
        rc = _ingest_parsed_dir(project_dir, args.agent, reports_dir, "unit")
        return rc if rc != 0 else result.returncode
    # No XML at all → a hard collection/syntax failure. Ingest the CAPTURED runner
    # output as compile so the RED is still reported rather than silently lost —
    # and exit non-zero regardless of ingest success.
    _ingest_compile(project_dir, args.agent, _no_xml_errors_text(result), tier="unit")
    return result.returncode or 1


def cmd_regression(args):
    """Full-suite discover via xmlrunner (tier regression). With --coverage: run under
    coverage.py and post /api/v2/runs/parsed with coverage. Ingests regardless of
    pass/fail. Returns non-zero if any test failed or ingest failed. A no-XML run
    posts the captured output to /api/v2/runs/compile before exiting non-zero."""
    project_dir = _resolve_project_dir(args.project_dir)
    python = _resolve_python(args.python, project_dir)
    reports_dir = _reports_dir(project_dir, args.reports)
    os.makedirs(reports_dir, exist_ok=True)
    _wipe(reports_dir)
    env = os.environ.copy()

    run_cmd = _xmlrunner_cmd(python, None, args.start_dir, args.pattern, reports_dir)
    coverage_on = bool(args.coverage)
    if coverage_on:
        # coverage run -m xmlrunner discover ... — drop the leading interpreter.
        run_cmd = [python, "-m", "coverage", "run", "--source", args.cov_source,
                   "-m", "xmlrunner", "discover", "-s", args.start_dir,
                   "-p", args.pattern, "-o", reports_dir]

    print(f"[crucible] running: {' '.join(run_cmd)}")
    result = _run_logged(run_cmd, project_dir, env, getattr(args, "log", None))
    print(f"[crucible] xmlrunner exit={result.returncode}")

    if not _produced_xml(reports_dir):
        # Same no-XML compile fallback as `test` — never a silent return 1 with
        # no ingest at all (CR-CRU-008 Implementation Notes).
        print("[crucible] ERROR: no JUnit XML produced — ingesting captured output as compile")
        _ingest_compile(project_dir, args.agent, _no_xml_errors_text(result),
                        tier="regression")
        return result.returncode or 1

    if not coverage_on:
        rc = _ingest_parsed_dir(project_dir, args.agent, reports_dir, "regression")
        return rc

    # Coverage path: parse junit locally + coverage lcov → /api/v2/runs/parsed.
    summary, tree = _parse_junit_dir(reports_dir)
    coverage = _collect_coverage(python, project_dir, env)
    payload = {
        "projectKey": _project_key(project_dir),
        "agentId": args.agent,
        "summary": summary,
        "tree": tree,
        "tier": "regression",
    }
    if coverage:
        payload["coverage"] = coverage
    context = _run_context()
    if context:
        payload["context"] = context
    resp = _post("/api/v2/runs/parsed", payload)
    cov_line = ""
    if coverage:
        cov_line = (f" lines={coverage['lines']['percent']}%"
                    f" funcs={coverage['functions']['percent']}%")
    print(
        f"regression: ok={resp.get('ok')} passed={summary['passed']} "
        f"failed={summary['failed']} total={summary['total']}{cov_line}"
        + (f" error={resp['error']}" if resp.get("error") else "")
    )
    return 0 if (resp.get("ok") and summary["failed"] == 0) else 1


def _collect_coverage(python, project_dir, env):
    """Run `coverage lcov` and sum LF/LH/FNF/FNH into a Crucible coverage object.
    Returns None if coverage.py or the lcov output is unavailable."""
    lcov_path = os.path.join(project_dir, "coverage.lcov")
    r = subprocess.run([python, "-m", "coverage", "lcov", "-o", lcov_path],
                       cwd=project_dir, env=env, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(lcov_path):
        print(f"[crucible] WARN: coverage lcov unavailable ({r.stderr.strip()[:120]})")
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


def cmd_auto_ingest(args):
    """Ingest an already-produced reports dir (client-parsed → per-method names). For when
    the caller ran xmlrunner separately."""
    project_dir = _resolve_project_dir(args.project_dir)
    reports_dir = _reports_dir(project_dir, args.reports)
    if not _produced_xml(reports_dir):
        print(f"[crucible] no TEST-*.xml in {reports_dir} — nothing to ingest")
        return 1
    return _ingest_parsed_dir(project_dir, args.agent, reports_dir, "unit")


def _ingest_compile(project_dir, agent_id, errors_text, tier=None):
    """Ingest a syntax/collection failure to /api/v2/runs/compile."""
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
          + (f" error={resp['error']}" if resp.get("error") else ""))
    return 0 if resp.get("ok") else 1


def cmd_check(args):
    """python -m py_compile over the given paths (default app/ + tests/). With --agent,
    ingest any errors as a compile failure. Best-effort syntax gate."""
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
    print(f"[crucible] running: py_compile on {len(files)} file(s)")
    result = subprocess.run(cmd, cwd=project_dir, capture_output=True, text=True)
    print(f"[crucible] py_compile exit={result.returncode}")
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
    if args.agent and result.returncode != 0:
        _ingest_compile(project_dir, args.agent, result.stderr)
    return result.returncode


def cmd_pre_merge_gate(args):
    """ORCHESTRATOR pre-merge gate — the ONLY path that measures coverage (project
    policy: coverage is reserved for the pre-merge gate, never per-cycle). Steps:
    fail-fast `check` (py_compile syntax gate) → full `regression --coverage` (junit +
    coverage.py lcov → /api/v2/runs/parsed). A check failure aborts before the suite."""
    project_dir = _resolve_project_dir(args.project_dir)
    if not getattr(args, "skip_check", False):
        check_args = argparse.Namespace(
            paths=None, agent=args.agent, python=args.python, project_dir=args.project_dir,
        )
        rc = cmd_check(check_args)
        if rc != 0:
            print("[crucible] pre-merge gate FAILED at the py_compile check step — "
                  "skipped the regression. Fix syntax first (or --skip-check to bypass).")
            return rc
    reg_args = argparse.Namespace(
        agent=args.agent, coverage=True, cov_source=args.cov_source,
        start_dir=args.start_dir, pattern=args.pattern, reports=args.reports,
        python=args.python, project_dir=args.project_dir, log=getattr(args, "log", None),
    )
    return cmd_regression(reg_args)


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


def main():
    p = argparse.ArgumentParser(prog="python-crucible", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser(
        "register",
        help="Register / heartbeat an agent. agentId convention: `<agent-type>-<project>` "
             "(e.g. claude-sandesh) or TDD-phase `CR-<PROJ>-NNN-<cycle>-<PHASE>` "
             "(e.g. CR-SAN-001-A-RED).",
    )
    r.add_argument("--agent", required=True,
                   help="Agent id — `<type>-<project>` (claude-sandesh) or "
                        "`CR-<PROJ>-NNN-<cycle>-<PHASE>` (CR-SAN-001-A-RED)")
    r.add_argument("--phase", default="report",
                   help="Phase label (RED/GREEN/FIX/VERIFY/ORCHESTRATOR; "
                        "default: report)")
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

    args = p.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
