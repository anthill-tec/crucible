#!/usr/bin/env python3
"""arduino-crucible.py — Arduino-firmware stack script (global, like bun/rust-crucible.py).

Runs native tests / firmware compile and reports to Crucible via the v2 API
($CRUCIBLE_URL, default http://localhost:3849). Mirrors the bun/rust `.env` +
/api/v2/* ingest pattern, extended with per-subproject self-registration: identity
from the SUBPROJECT's .env (CRUCIBLE_PROJECT_KEY + CRUCIBLE_PROJECT_NAME), agent
`Vidushi - <NAME>`.

The subproject dir (holding `.env` + `tests/native/`) is resolved:
  --project-dir  >  $ARDUINO_CRUCIBLE_PROJECT_DIR  >  CWD
It must contain a `.env`. Examples:
  arduino-crucible.py unit    --project-dir /path/to/sheetal-firmware --agent <id>
  (cd sheetal-firmware && arduino-crucible.py compile --agent <id>)

Run context (CR-CRU-008 §S2): when any WORKFLOW_* env var is set
(WORKFLOW_CYCLE_ID / WORKFLOW_CYCLE / WORKFLOW_WAVE / WORKFLOW_ROLE), ingests carry
a `context` object {cycleId, cycle, wave, orchestrator, git:{branch,commit}}; with
no WORKFLOW_* env, no context key is sent at all.

Env overrides: CRUCIBLE_URL (legacy alias CRUCIBLE_BASE), ARDUINO_CLI, ARDUINO_FQBN,
AGENT_ID.
Subcommands: unit | compile | register | unregister
"""
import argparse, glob, json, os, re, subprocess, sys, urllib.request, urllib.error
import xml.etree.ElementTree as ET

CRUCIBLE = (os.environ.get("CRUCIBLE_URL") or os.environ.get("CRUCIBLE_BASE")
            or "http://localhost:3849")
ARDUINO_CLI = os.environ.get(
    "ARDUINO_CLI", "/opt/arduino-ide/resources/app/lib/backend/resources/arduino-cli")
FQBN = os.environ.get("ARDUINO_FQBN", "arduino:renesas_uno:minima")


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
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    # The SUBPROJECT's .env is authoritative (matches the rest of the fleet —
    # python/rust/bun read only the project .env); ambient env is a fallback
    # only, so a caller's own CRUCIBLE_PROJECT_* (e.g. Bun auto-loading the
    # host repo's .env) can never hijack an explicit --project-dir.
    key = env.get("CRUCIBLE_PROJECT_KEY") or os.environ.get("CRUCIBLE_PROJECT_KEY")
    name = env.get("CRUCIBLE_PROJECT_NAME") or os.environ.get("CRUCIBLE_PROJECT_NAME")
    if not key:
        sys.exit(f"[crucible] CRUCIBLE_PROJECT_KEY not set in {path}")
    if not name:
        sys.exit(f"[crucible] CRUCIBLE_PROJECT_NAME not set in {path}")
    return key, name


def _agent(name):
    # A dispatched phase agent passes --agent (e.g. CR-SHE-005-C1-RED) and shows
    # by that convention id. The default (orchestrator/standalone) is Vidushi - <NAME>.
    override = os.environ.get("AGENT_ID")
    if override:
        return override, override
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return f"vidushi-{slug}", f"Vidushi - {name}"


def _post(path, payload):
    req = urllib.request.Request(
        CRUCIBLE + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except urllib.error.URLError as e:
        return 0, str(e)


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


def _ensure_project(key, name, pd):
    """Idempotent self-registration; a pre-existing key returns 200 {changed:false}."""
    _post("/api/v2/projects", {"key": key, "name": name, "sutRoot": pd})


def _heartbeat(key, agent_id, display, msg):
    _post("/api/v2/agents/register", {
        "agentId": agent_id, "projectKey": key, "status": "online", "message": msg,
        "identity": {"displayName": display, "source": "openclaw"}})


def _parse_junit(path):
    """JUnit (the native harness shape) -> (summary, tree) for /api/v2/runs/parsed."""
    root = ET.parse(path).getroot()
    suites = root.findall("testsuite") if root.tag == "testsuites" else [root]
    total = passed = failed = 0
    tree = []
    for suite in suites:
        children, sfail = [], 0
        for tc in suite.findall("testcase"):
            bad = tc.find("failure") is not None or tc.find("error") is not None
            total += 1
            if bad:
                failed += 1; sfail += 1
            else:
                passed += 1
            children.append({"name": tc.get("name", "?"),
                             "status": "fail" if bad else "pass", "duration_ms": 0})
        tree.append({"name": suite.get("name", "native"),
                     "status": "fail" if sfail else "pass", "children": children})
    summary = {"total": total, "passed": passed, "failed": failed,
               "pending": 0, "duration_ms": 0}
    return summary, tree


def _remove_agent_silent(key, agent_id):
    """CR-CRU-008 §S4 anti-ghost cleanup for a gated run: remove the agent row
    WITHOUT journaling a lifecycle event (the run's ingest was the implicit
    registration). Best-effort: never raises, never pollutes the run verdict or
    stdout. Mirrors clients/bun-crucible.py's _remove_agent_silent."""
    try:
        _post("/api/v2/agents/unregister",
              {"agentId": agent_id, "projectKey": key, "silent": True})
    except Exception:
        pass


def cmd_unit(args):
    """Gated native-test run — wraps the ingest body in an anti-ghost silent
    cleanup (CR-CRU-008 §S4): even a failed/raising run removes the implicitly
    registered agent, and never touches the retired /api/agents/remove shim."""
    pd = _project_dir(args)
    key, name = _load_env(pd)
    agent_id, _ = _agent(name)
    try:
        return _unit_run(args)
    finally:
        _remove_agent_silent(key, agent_id)


def _unit_run(args):
    pd = _project_dir(args)
    sub = (getattr(args, "dir", None) or "tests/native").replace("\\", "/")
    native_dir = os.path.join(pd, *sub.split("/"))
    key, name = _load_env(pd)
    agent_id, _ = _agent(name)
    _ensure_project(key, name, pd)
    # NOTE: no heartbeat here — v2 records a lifecycle EVENT on first agent
    # registration, so run subcommands only ingest (fleet convention:
    # `register` is the lifecycle verb, like bun/rust/mvn-crucible).
    run = subprocess.run(["make", "junit"], cwd=native_dir, capture_output=True, text=True)
    reports = sorted(glob.glob(os.path.join(native_dir, "reports", "TEST-*.xml")))
    if not reports:
        sys.stderr.write(run.stdout + run.stderr)
        sys.exit(f"[crucible] no JUnit (reports/TEST-*.xml) under {native_dir}")
    summary = {"total": 0, "passed": 0, "failed": 0, "pending": 0, "duration_ms": 0}
    tree = []
    for junit in reports:
        s, t = _parse_junit(junit)
        for k in ("total", "passed", "failed"):
            summary[k] += s[k]
        tree.extend(t)
    payload = {"projectKey": key, "name": name, "agentId": agent_id,
               "summary": summary, "tree": tree, "tier": "unit"}
    context = _run_context()
    if context:
        payload["context"] = context
    status, _ = _post("/api/v2/runs/parsed", payload)
    print(f"[crucible] unit -> '{name}': {summary['passed']}/{summary['total']} passed, "
          f"{summary['failed']} failed (ingest {status})")
    return 1 if summary["failed"] else 0


def cmd_compile(args):
    pd = _project_dir(args)
    key, name = _load_env(pd)
    agent_id, _ = _agent(name)
    _ensure_project(key, name, pd)
    # No heartbeat — see cmd_unit: run subcommands only ingest under v2.
    run = subprocess.run(
        [ARDUINO_CLI, "compile", "--fqbn", FQBN,
         "--build-path", os.path.join(pd, "build"), pd],
        capture_output=True, text=True)
    if run.returncode != 0:
        errors = re.sub(r"\x1b\[[0-9;]*m", "", (run.stdout + run.stderr).strip())
        payload = {"projectKey": key, "agentId": agent_id, "errors": errors}
        context = _run_context()
        if context:
            payload["context"] = context
        status, _ = _post("/api/v2/runs/compile", payload)
        print(f"[crucible] compile FAILED -> /api/v2/runs/compile ({status})")
        return 1
    print("[crucible] compile OK")
    return 0


def cmd_register(args):
    pd = _project_dir(args)
    key, name = _load_env(pd)
    agent_id, display = _agent(name)
    _ensure_project(key, name, pd)
    phase = getattr(args, "phase", None)
    msg = f"{phase} phase" if phase else "online"
    _heartbeat(key, agent_id, display, msg)
    print(f"[crucible] register: {display} ({agent_id}) online — {msg}")
    return 0


def cmd_unregister(args):
    pd = _project_dir(args)
    key, name = _load_env(pd)
    agent_id, _ = _agent(name)
    status, _ = _post("/api/v2/agents/unregister", {"agentId": agent_id, "projectKey": key})
    print(f"[crucible] unregister: {agent_id} removed (status {status})")
    return 0


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--agent", help="override the derived agent id")
    common.add_argument("--project-dir",
                        help="subproject dir with .env + tests/native "
                             "(default: $ARDUINO_CRUCIBLE_PROJECT_DIR or CWD)")
    p = argparse.ArgumentParser(description="Arduino-firmware Crucible stack script")
    sub = p.add_subparsers(dest="cmd", required=True)
    u = sub.add_parser("unit", parents=[common], help="run native tests -> /api/v2/runs/parsed")
    u.add_argument("--dir", default="tests/native",
                   help="test-target subdir under the project (default tests/native; "
                        "e.g. tests/native-mock for the ArduinoFake L2 tier)")
    sub.add_parser("compile", parents=[common], help="arduino-cli compile -> /api/v2/runs/compile on failure")
    r = sub.add_parser("register", parents=[common], help="register/heartbeat the agent")
    r.add_argument("--phase", help="phase label (RED/GREEN/VERIFY/FIX)")
    sub.add_parser("unregister", parents=[common], help="remove the agent")
    args = p.parse_args()
    if args.agent:
        os.environ["AGENT_ID"] = args.agent
    fn = {"unit": cmd_unit, "compile": cmd_compile,
          "register": cmd_register, "unregister": cmd_unregister}[args.cmd]
    sys.exit(fn(args) or 0)


if __name__ == "__main__":
    main()
