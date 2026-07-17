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
import json
import os
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

CRUCIBLE_URL = os.environ.get("CRUCIBLE_URL", "http://localhost:3849")
STALE_THRESHOLD_S = 120


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
def _post(path, payload):
    req = urllib.request.Request(
        f"{CRUCIBLE_URL}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req).read())


def _run_context():
    """CR-CRU-008 §S2 — env + git → run context for declared cycle linkage.

    Reads WORKFLOW_CYCLE_ID (int-coerced; invalid → omitted), WORKFLOW_CYCLE,
    WORKFLOW_WAVE and WORKFLOW_ROLE. When at least one is set, attaches
    git {branch, commit} from a cheap `git rev-parse` (tolerant of a
    non-repo cwd → omitted). Returns the context dict, or None when no
    workflow env is set. Same pattern as clients/bun-crucible.py.
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
    """Run `cmd`. If `log_path` set, capture COMBINED stdout+stderr (in order),
    write it to `log_path`, and echo it to stdout so the run stays visible — lets
    an agent read a long mvn run back from a file instead of re-running it
    (per the global rule: grep surefire/failsafe reports, don't re-run).
    """
    if not log_path:
        return subprocess.run(cmd, cwd=cwd, env=env)
    result = subprocess.run(
        cmd, cwd=cwd, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    out = result.stdout or ""
    try:
        with open(log_path, "w") as f:
            f.write(out)
        print(f"[crucible] run log → {log_path} ({len(out)} bytes)")
    except OSError as e:
        print(f"[crucible] WARN: could not write run log to {log_path}: {e}")
    sys.stdout.write(out)
    return result


# --------------------------------------------------------------------------- #
# Agent lifecycle
# --------------------------------------------------------------------------- #
def cmd_register(args):
    project_dir = _resolve_project_dir(args.project_dir)
    payload = {
        "agentId": args.agent,
        "projectKey": _project_key(project_dir),
        "status": "online",
        "message": args.message or f"Starting {args.phase} phase",
        # displayName MUST go inside `identity` — top-level is silently ignored.
        "identity": {"displayName": args.agent, "source": "openclaw"},
    }
    resp = _post("/api/v2/agents/register", payload)
    print(f"register: ok={resp.get('ok', False)} agent={args.agent} phase={args.phase}")
    return 0 if resp.get("ok") else 1


def cmd_unregister(args):
    project_dir = _resolve_project_dir(args.project_dir)
    resp = _post(
        "/api/v2/agents/unregister",
        {"agentId": args.agent, "projectKey": _project_key(project_dir)},
    )
    print(f"unregister: ok={resp.get('ok', False)} agent={args.agent}")
    return 0 if resp.get("ok") else 1


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
def _ingest_junit_dir(project_dir, agent, report_dir, tier=None):
    """Fast path: hand a single reports DIR to Crucible's built-in JUnit parser
    (the v2 junit codec reads a file OR a directory of TEST-*.xml)."""
    payload = {
        "projectKey": _project_key(project_dir),
        "codec": "junit",
        "dataPath": report_dir,
        "agentId": agent,
    }
    if tier:
        payload["tier"] = tier
    context = _run_context()
    if context:
        payload["context"] = context
    resp = _post("/api/v2/runs", payload)
    s = resp.get("run", {})
    print(f"ingest junit: ok={resp.get('ok')} dir={report_dir} "
          f"passed={s.get('passed')} failed={s.get('failed')} total={s.get('total')}")
    return 0 if resp.get("ok") else 1


def _ingest_parsed(project_dir, agent, summary, tree, coverage=None, tier=None):
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
    context = _run_context()
    if context:
        payload["context"] = context
    resp = _post("/api/v2/runs/parsed", payload)
    cov = ""
    if coverage:
        cov = (f" lines={coverage['lines']['percent']}% "
               f"funcs={coverage['functions']['percent']}% "
               f"branches={coverage['branches']['percent']}%")
    print(f"ingest parsed: ok={resp.get('ok')} passed={summary['passed']} "
          f"failed={summary['failed']} pending={summary['pending']} "
          f"total={summary['total']}{cov}")
    return 0 if resp.get("ok") else 1


def _ingest_compile(project_dir, agent, output):
    """Ingest Maven/javac build output. Crucible parses `[ERROR] /path/File.java:
    [line,col] message` into structured per-file errors; raw output kept as fallback.
    """
    err_count = output.count("[ERROR]")
    payload = {
        "projectKey": _project_key(project_dir),
        "agentId": agent,
        "errors": output,
    }
    context = _run_context()
    if context:
        payload["context"] = context
    resp = _post("/api/v2/runs/compile", payload)
    print(f"ingest compile: ok={resp.get('ok')} error_lines={err_count}")
    return 0 if resp.get("ok") else 1


def _smart_ingest(project_dir, agent, dirs, tier=None):
    """One reports dir with XML → fast junit-dir path. Many → parse + parsed.
    None → return False so the caller can run the compile fallback.
    """
    existing = _dirs_with_xml(dirs)
    if not existing:
        return False
    _warn_if_stale(existing)
    if len(existing) == 1:
        _ingest_junit_dir(project_dir, agent, existing[0], tier=tier)
    else:
        summary, tree = _parse_junit(existing)
        _ingest_parsed(project_dir, agent, summary, tree, tier=tier)
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
    result = _run_logged(cmd, maven_dir, env, getattr(args, "log", None))
    print(f"[{label}] mvn exit={result.returncode}")
    if not args.agent:
        return result.returncode
    dirs = _report_dirs(maven_dir, getattr(args, "module", None), "surefire")
    # CR-CRU-008 §S2 tier map: the subcommand name IS the tier (unit/module).
    if _smart_ingest(project_dir, args.agent, dirs, tier=label):
        return 0
    return _compile_fallback(maven_dir, project_dir, args.agent, common)


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
                  "Check the quarkus-jacoco extension / --coverage-profile.")
    else:
        print(f"[regression] {summary['failed']} failure(s) — NOT publishing coverage "
              "(JaCoCo from a failing run is incomplete).")

    return _ingest_parsed(project_dir, args.agent, summary, tree, coverage,
                          tier="regression")


def cmd_auto_ingest(args):
    """Ingest EXISTING surefire/failsafe reports without running maven. With
    --coverage (only on a known-green full run), also attach jacoco. Compile
    fallback if no reports exist."""
    project_dir = _resolve_project_dir(args.project_dir)
    maven_dir = _resolve_maven_dir(args.maven_dir, project_dir)
    su = _dirs_with_xml(_report_dirs(maven_dir, getattr(args, "module", None), "surefire"))
    fs = _dirs_with_xml(_report_dirs(maven_dir, getattr(args, "module", None), "failsafe"))
    dirs = su + fs
    if not dirs:
        print("[auto-ingest] no reports found")
        return _compile_fallback(maven_dir, project_dir, args.agent, _common_mvn_flags(args))
    _warn_if_stale(dirs)
    summary, tree = _parse_junit(dirs)
    coverage = None
    if args.coverage and summary["failed"] == 0:
        coverage = _collect_jacoco(maven_dir)
    return _ingest_parsed(project_dir, args.agent, summary, tree, coverage)


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
    sub = p.add_subparsers(dest="cmd", required=True)

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

    args = p.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
