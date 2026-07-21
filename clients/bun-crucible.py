#!/usr/bin/env python3
"""Bun + TypeScript Crucible CLI — single entry point for orchestrator + RED/GREEN/
FIX/VERIFY agent lifecycle ops AND for running TypeScript test targets (`bun test` →
JUnit XML, optional lcov coverage). Replaces inline bun -e / loose curl so each
invocation has a stable command signature.

Modelled exactly on python-crucible.py / rust-crucible.py (same agent lifecycle,
.env project-key resolution, /api/* ingest contract) — only the toolchain differs:
xmlrunner/coverage.py → `bun test --reporter=junit` (+ `--coverage --coverage-reporter=lcov`)
and `tsc --noEmit` for the syntax gate.

This script is tool-specific (bun test / JUnit-XML / lcov / tsc), not project-specific —
the project path, the bun package dir, and the bun binary are parameterizable.

Subcommands:
  register, unregister  Agent lifecycle.
  test                  Run a TARGETED test (file/path) or the whole suite, via
                        `bun test --reporter=junit` → parse → /api/v2/runs/parsed. The
                        per-cycle RED/GREEN workhorse. With --agent the result is ingested
                        regardless of pass/fail (junit captures failures). The reports
                        file is wiped first so only THIS run's XML is ingested.
  regression            Run the FULL suite. With --coverage (bun --coverage-reporter=lcov)
                        posts /api/v2/runs/parsed with line/function coverage; else posts
                        the parsed junit only. Orchestrator pre-merge gate path.
  auto-ingest           Ingest only: parse an already-produced junit file → /api/v2/runs/parsed.
  check                 `tsc --noEmit` typecheck gate over the package; ingest any errors to
                        /api/v2/runs/compile. (Most TS RED failures are runtime, but a type
                        error should still surface.)
  pre-merge-gate        ORCHESTRATOR gate: fail-fast `check` (tsc) → `regression --coverage`.
  plan-file             File a cycle plan: --cr, --title, --cycles "a,b[,c…]" →
                        POST /api/v2/projects/<key>/plans. Prints the assigned NUMERIC
                        cycle ids on stdout (never guess ids — the plan-7 incident).
                        track comes from $WORKFLOW_ROLE; orchestrator from
                        --orchestrator / $WORKFLOW_ORCHESTRATOR when set.
  cycle-activate <id>   Transition a cycle to active. Cycle ids are unique per PROJECT:
                        resolved by scanning the OPEN plans for the id.
  cycle-done <id>       Transition an ACTIVE cycle to done (closes the span).
  cr-close --commit <sha> [--cr <CR>]
                        Close the single OPEN plan (PATCH status=closed + merge.commit).
                        Multiple open plans → --cr picks one; ambiguous without it →
                        non-zero exit naming the open plans.

Project + Crucible endpoint:
  Reads CRUCIBLE_PROJECT_KEY from <project-dir>/.env.
  Project path resolution: --project-dir > $BUN_CRUCIBLE_PROJECT_DIR > the git repo
  containing the current directory > CWD. No project is hardcoded.
  Package (bun cwd) resolution: --package-dir > $BUN_CRUCIBLE_PACKAGE_DIR >
  <project-dir>/integrations/pi (if it has a package.json) > <project-dir>.
  Bun resolution: --bun > $BUN_CRUCIBLE_BUN > `bun` on PATH.
  Posts to $CRUCIBLE_URL (default http://localhost:3849), v2 endpoints ONLY:
  /api/v2/agents/register|unregister, /api/v2/runs/parsed|compile,
  /api/v2/projects/<key>/plans. This in-repo clients/ copy is the SOURCE OF
  TRUTH (CR-CRU-008 Risk section) — ~/.claude/scripts/ mirrors it.

Examples:
  # Targeted RED/GREEN run + ingest in one call
  bun-crucible.py test --tests src/tools/send.test.ts --agent CR-SAN-013-C1-RED

  # Whole suite without ingest (just see if it passes)
  bun-crucible.py test

  # Full regression + coverage + ingest (orchestrator gate)
  bun-crucible.py pre-merge-gate --agent claude-sandesh

Agent naming (agent-protocol): agentId = `<agent-type>-<project>` (e.g. claude-sandesh) for
the orchestrator, or `CR-<PROJ>-NNN-<cycle>-<PHASE>` (e.g. CR-SAN-013-C1-RED) for TDD-phase
agents. Identity carries displayName + source (default claude-md) + repoPath, inside the
`identity` object.
"""

import argparse
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
DEFAULT_REPORTS = "test-reports"
DEFAULT_JUNIT = "junit.xml"


def _resolve_project_dir(arg_value):
    """--project-dir > $BUN_CRUCIBLE_PROJECT_DIR > git repo of CWD > CWD.
    The `.env` holding CRUCIBLE_PROJECT_KEY must live at the resolved root."""
    if arg_value:
        return arg_value
    env_value = os.environ.get("BUN_CRUCIBLE_PROJECT_DIR")
    if env_value:
        return env_value
    r = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True
    )
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else os.getcwd()


def _resolve_package_dir(arg_value, project_dir):
    """--package-dir > $BUN_CRUCIBLE_PACKAGE_DIR > <project>/integrations/pi (if it has a
    package.json) > <project>. This is the cwd `bun test` / `tsc` run in."""
    if arg_value:
        return arg_value if os.path.isabs(arg_value) else os.path.join(project_dir, arg_value)
    env_value = os.environ.get("BUN_CRUCIBLE_PACKAGE_DIR")
    if env_value:
        return env_value
    cand = os.path.join(project_dir, "integrations", "pi")
    if os.path.exists(os.path.join(cand, "package.json")):
        return cand
    return project_dir


def _resolve_bun(arg_value):
    """--bun > $BUN_CRUCIBLE_BUN > `bun` on PATH."""
    return arg_value or os.environ.get("BUN_CRUCIBLE_BUN") or "bun"


def _read_env(project_dir):
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


# ── §S2b (CR-CRU-008) — in-run progress narration ──────────────────────────

# bun's per-test completion line family (piped, non-quiet mode).
_COMPLETION_LINE = re.compile(r"^\((?:pass|fail|skip|todo)\)")
# bun's per-file section header, e.g. `narration.test.ts:`.
_FILE_HEADER_LINE = re.compile(r"^(\S+\.[cm]?[jt]sx?):$")
# A test declaration call site in a test source (`test(`/`it(`, with optional
# modifier chain). The leading guard rejects method calls like `re.test(`.
_TEST_DECL = re.compile(
    r"(?:^|[^\w.])(?:test|it)"
    r"(?:\s*\.\s*(?:only|failing|skip|todo|serial|concurrent|each))*\s*\("
)
_TEST_FILE = re.compile(r"\.(?:test|spec)\.[cm]?[jt]sx?$")
_PRESCAN_SKIP_DIRS = {"node_modules", ".git", "coverage", "test-reports",
                      "dist", "build", "target"}


def _prescan_test_total(package_dir, targets):
    """Best-known total test count — the narration's M. bun's own stream only
    reveals the total AFTER the run ('Ran N tests…'), so M is counted from the
    test SOURCES up front: targeted runs scan the targeted files/dirs, a
    whole-suite run walks the package. Approximate by design (test.each
    expands at runtime); the narrator clamps M to max(M, completions-so-far)
    so it can never read below N."""
    paths = []
    for t in targets or [None]:
        base = package_dir if t is None else (
            t if os.path.isabs(t) else os.path.join(package_dir, t))
        if os.path.isfile(base):
            paths.append(base)
        elif os.path.isdir(base):
            for root, dirnames, filenames in os.walk(base):
                dirnames[:] = [d for d in dirnames if d not in _PRESCAN_SKIP_DIRS]
                paths += [os.path.join(root, f) for f in filenames
                          if _TEST_FILE.search(f)]
    total = 0
    for p in paths:
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                total += len(_TEST_DECL.findall(f.read()))
        except OSError:
            pass
    return total


class _Narrator:
    """§S2b (CR-CRU-008) — throttled in-run 'running N/M' narration.

    Fed the runner's streamed combined output line-by-line; counts bun's
    per-test completion lines ((pass)/(fail)/(skip)/(todo)) and posts progress
    as a heartbeat `message` through the v2 register/heartbeat verb — no new
    API, and it prints NOTHING (the stdout data pipe stays pure; heartbeats on
    an already-existing agent journal no lifecycle event server-side).

    Throttle, read literally from the spec ('update at most every 2s or every
    10 completions'): the FIRST update fires only once ≥2s have elapsed since
    the first completion OR ≥10 completions accumulated — a run that finishes
    inside that first window narrates nothing — and each later update must be
    ≥2s or ≥10 completions past the last POSTED one. Posting is deliberately
    best-effort: narration must never fail or slow the wrapped run.
    """

    def __init__(self, post, total_hint=0, min_seconds=2.0, min_completions=10):
        self._post = post
        self._total_hint = total_hint
        self._min_seconds = min_seconds
        self._min_completions = min_completions
        self._count = 0
        self._current_file = None
        self._first_seen = None   # monotonic ts of the first completion
        self._posted_at = None    # monotonic ts of the last posted update
        self._posted_count = 0
        self.posted = False

    def observe(self, line):
        text = line.rstrip("\r\n")
        header = _FILE_HEADER_LINE.match(text)
        if header:
            self._current_file = header.group(1)
            return
        if _COMPLETION_LINE.match(text):
            self._completed()

    def _completed(self):
        now = time.monotonic()
        self._count += 1
        if self._first_seen is None:
            self._first_seen = now
        since = now - (self._posted_at if self._posted_at is not None
                       else self._first_seen)
        if (since < self._min_seconds
                and self._count - self._posted_count < self._min_completions):
            return
        message = f"running {self._count}/{max(self._total_hint, self._count)}"
        if self._current_file:
            message += f" · {self._current_file}"
        try:
            self._post(message)
        except (Exception, SystemExit):
            return  # best-effort — a failed heartbeat retries next completion
        self.posted = True
        self._posted_at, self._posted_count = now, self._count


def _run_logged(cmd, cwd, env, log_path, narrator=None):
    """Run `cmd`. If `log_path` set, capture combined stdout+stderr, write it, and
    echo. §S2b: the capture is a STREAMING tail (Popen, line-buffered) — the
    optional `narrator` observes every line live for throttled progress
    heartbeats — while the captured output, run.log and echo stay byte-identical
    to the old capture-after-exit behavior (the §S2c failure-marrying parser
    consumes `result.stdout` unchanged)."""
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
    # §S1 — stdout is the TOON AXI channel; the captured run echo is interactive
    # (stderr). The §S2c parser consumes the returned CompletedProcess.stdout,
    # not the stream, so failure-marrying stays byte-identical.
    sys.stderr.write(out)
    return subprocess.CompletedProcess(cmd, returncode, stdout=out)


def _register_agent(project_dir, agent_id, message, display_name=None, source="claude-md"):
    """POST the agent-online heartbeat. Single payload builder shared by
    cmd_register and the gate-run lifecycle brackets (CR-CRU-021 §S5)."""
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
    """POST the agent removal (the v2 unregister VERB — journals a
    'unregistered' lifecycle event, CR-CRU-011 §S1). Used by cmd_unregister."""
    return _post(
        "/api/v2/agents/unregister",
        {"agentId": agent_id, "projectKey": _project_key(project_dir)},
    )


def _remove_agent_silent(project_dir, agent_id):
    """Gated-run cleanup (CR-CRU-021 §S5 anti-ghost, v2 model).

    Under v2, a gated run needs NO explicit register: the run's ingest IS the
    registration (implicit heartbeat — creates the agent row with NO lifecycle
    event). The closing cleanup must be equally silent: a PLAIN v2 unregister
    journals an 'unregistered' lifecycle event into /api/v2/events
    (CR-CRU-011 §S1), which would bury and miscount the run event the gate
    just ingested. CR-CRU-008 §S4 retired the shim's /api/agents/remove; the
    ceremony-free removal is now the v2 unregister VERB with {silent: true} —
    removes the agent row WITHOUT journaling a lifecycle event.
    """
    return _post(
        "/api/v2/agents/unregister",
        {"agentId": agent_id, "projectKey": _project_key(project_dir), "silent": True},
    )


def cmd_register(args):
    project_dir = _resolve_project_dir(args.project_dir)
    resp = _register_agent(
        project_dir, args.agent,
        args.message or f"Starting {args.phase} phase",
        display_name=args.display_name, source=args.source,
    )
    ok = bool(resp.get("ok", False))
    legacy = (f"register: ok={resp.get('ok', False)} agent={args.agent} "
              f"phase={args.phase} source={args.source}")
    _emit_axi("register", ok, {"agent": args.agent},
              _axi_context(project_dir, agent_id=args.agent), [], legacy)
    return 0 if ok else 1


def cmd_unregister(args):
    project_dir = _resolve_project_dir(args.project_dir)
    resp = _unregister_agent(project_dir, args.agent)
    ok = bool(resp.get("ok", False))
    legacy = f"unregister: ok={resp.get('ok', False)} agent={args.agent}"
    _emit_axi("unregister", ok, {"agent": args.agent},
              _axi_context(project_dir, agent_id=args.agent), [], legacy)
    return 0 if ok else 1


def _reports_dir(package_dir, arg_value):
    rd = arg_value or DEFAULT_REPORTS
    return rd if os.path.isabs(rd) else os.path.join(package_dir, rd)


def _junit_path(reports_dir):
    return os.path.join(reports_dir, DEFAULT_JUNIT)


def _wipe(reports_dir):
    jp = _junit_path(reports_dir)
    if os.path.exists(jp):
        try:
            os.remove(jp)
        except OSError:
            pass


def _bun_test_cmd(bun, targets, junit_path, coverage, coverage_dir):
    """Build the `bun test` invocation. Targeted (file paths) or whole-suite."""
    cmd = [bun, "test"]
    if targets:
        cmd += list(targets)
    cmd += ["--reporter=junit", f"--reporter-outfile={junit_path}"]
    if coverage:
        cmd += ["--coverage", "--coverage-reporter=lcov", f"--coverage-dir={coverage_dir}"]
    return cmd


def _parse_junit_file(junit_path):
    """Parse a bun JUnit XML file into (summary, tree) with per-test leaf names."""
    tree_nodes = []
    total = passed = failed = 0
    duration_ms = 0
    root = ET.parse(junit_path).getroot()
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
            entry = {
                "name": tc.get("name", "?"),
                "status": status,
                "duration_ms": tc_time,
            }
            if fail:
                # Interim fidelity fix (CR-CRU-007 dog-food finding): preserve the
                # <failure>/<error> assertion message + trace so drill-ins show
                # WHY a test failed. CR-CRU-008 replaces this whole client-side
                # parse with server-side v2 codec ingestion.
                fnode = tc.find("failure")
                if fnode is None:
                    fnode = tc.find("error")
                if fnode is not None:
                    failure = {}
                    msg = (fnode.get("message") or "").strip()
                    txt = (fnode.text or "").strip()
                    if msg:
                        failure["message"] = msg[:1000]
                    elif txt:
                        failure["message"] = txt.splitlines()[0][:1000]
                    if txt:
                        failure["trace"] = txt[:8000]
                    ftype = fnode.get("type")
                    if ftype:
                        failure["type"] = ftype
                    if failure:
                        entry["failure"] = failure
            children.append(entry)
        if children:
            tree_nodes.append({
                "name": suite.get("name", "?"),
                "status": "fail" if suite_fail else "pass",
                "children": children,
            })
    summary = {"total": total, "passed": passed, "failed": failed,
               "pending": 0, "duration_ms": duration_ms}
    return summary, tree_nodes


_FAIL_LINE = re.compile(r"^\(fail\)\s+(?P<name>.*?)(?:\s+\[[0-9.]+m?s\])?\s*$")


def _parse_console_failures(log_text):
    """§S2c (CR-CRU-008) — marry bun's console failure detail to leaf names.

    bun's JUnit reporter writes a BARE `<failure type="..."/>` for EVERY
    failure kind (assertion mismatch, thrown Error, timeout alike) — the human
    detail exists only on the console stream. For assertion mismatches and
    thrown Errors an `error: <detail>` block appears IMMEDIATELY BEFORE the
    `(fail) <name>` line; that block is captured here, keyed by leaf name.
    Detail printed AFTER the fail line (e.g. a timeout's `^ this test timed
    out after Nms.`) is structurally NOT a preceding block and stays
    unmatched — the leaf degrades to type-only.
    """
    details = {}
    block = []        # lines accumulated since the last result-line boundary
    error_idx = None  # index in `block` of the most recent "error:" line
    for line in log_text.splitlines():
        m = _FAIL_LINE.match(line)
        if m:
            if error_idx is not None:
                detail = block[error_idx:]
                message = detail[0][len("error:"):].strip()
                married = {"message": message[:1000]}
                trace = "\n".join(detail).rstrip()
                if trace:
                    married["trace"] = trace[:8000]
                name = m.group("name").strip()
                details[name] = married
                # Nested describes print "suite > name"; junit leaves carry
                # the bare test name — index the last segment too.
                details.setdefault(name.split(" > ")[-1], married)
            block, error_idx = [], None
            continue
        if line.startswith(("(pass)", "(skip)", "(todo)")):
            block, error_idx = [], None
            continue
        if line.startswith("error:"):
            error_idx = len(block)
        block.append(line)
    return details


def _marry_failures(tree, log_text):
    """§S2c — attach console-married {message, trace} to failing leaves whose
    junit <failure> carried no message (bun writes bare nodes). Unmatched
    failing leaves keep their type-only failure object untouched."""
    if not log_text:
        return
    details = _parse_console_failures(log_text)
    if not details:
        return
    for suite in tree:
        for leaf in suite.get("children", []):
            if leaf.get("status") != "fail":
                continue
            if (leaf.get("failure") or {}).get("message"):
                continue
            detail = details.get(leaf.get("name"))
            if detail:
                leaf.setdefault("failure", {}).update(detail)


def _parse_lcov(lcov_path):
    """Sum LF/LH/FNF/FNH from an lcov file into a Crucible coverage object, or None."""
    if not os.path.exists(lcov_path):
        return None
    lf = lh = ff = fh = 0
    with open(lcov_path) as f:
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


def _run_context():
    """CR-CRU-019 §P1 — env + git → run context for declared cycle linkage.

    Reads WORKFLOW_CYCLE_ID (int-coerced; invalid → omitted) and
    WORKFLOW_CYCLE (string). When at least one is set, attaches
    git {branch, commit} from a cheap `git rev-parse` (tolerant of a
    non-repo cwd → omitted). Returns the context dict, or None when no
    workflow env is set.
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
    # CR-CRU-008 §S2 — wave + orchestrator enrichment (alongside cycleId/cycle/git).
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
    """§S9 — the ingest payload's `context`: the env/git `_run_context()`
    enriched with the RESOLVED cycleId, so the SERVER-recorded run carries the
    attach cycle (not just the printed envelope). When `WORKFLOW_CYCLE_ID` is
    unset (auto-resolved case) `_run_context()` is None, so the cycleId is the
    sole classifying field. Returns None only when there is nothing to attach."""
    context = _run_context() or {}
    if cycle_id is not None:
        context["cycleId"] = cycle_id
    return context or None


def _ingest_parsed(project_dir, agent_id, summary, tree, coverage=None, tier=None,
                   context=None):
    payload = {
        "projectKey": _project_key(project_dir),
        "agentId": agent_id,
        "summary": summary,
        "tree": tree,
    }
    if coverage:
        payload["coverage"] = coverage
    # Regression sweeps must be distinguishable from focused unit runs
    # (storyboard F7). Server-side tier passthrough: CR-CRU-016 §S4.
    if tier:
        payload["tier"] = tier
    # CR-CRU-019 §P1 — declared cycle linkage: env/git context rides the
    # payload verbatim when present (server passthrough on the v1 shim).
    if context:
        payload["context"] = context
    resp = _post("/api/v2/runs/parsed", payload)
    cov_line = ""
    if coverage:
        cov_line = (f" lines={coverage['lines']['percent']}%"
                    f" funcs={coverage['functions']['percent']}%")
    # The human-readable ingest line is interactive-only (stderr); the machine
    # channel is the §S1 TOON AXI envelope the caller emits on stdout.
    print(
        f"ingest: ok={resp.get('ok')} passed={summary['passed']} "
        f"failed={summary['failed']} total={summary['total']}{cov_line}"
        + (f" error={resp['error']}" if resp.get("error") else ""),
        file=sys.stderr,
    )
    return resp


def _ingest_compile(project_dir, agent_id, errors_text):
    payload = {
        "projectKey": _project_key(project_dir),
        "format": "typescript",
        "errors": errors_text,
        "agentId": agent_id,
    }
    resp = _post("/api/v2/runs/compile", payload)
    print(f"ingest compile (typescript): ok={resp.get('ok')}"
          + (f" error={resp['error']}" if resp.get("error") else ""))
    return 0 if resp.get("ok") else 1


def cmd_test(args):
    project_dir = _resolve_project_dir(args.project_dir)
    package_dir = _resolve_package_dir(args.package_dir, project_dir)
    bun = _resolve_bun(args.bun)
    reports_dir = _reports_dir(package_dir, args.reports)
    os.makedirs(reports_dir, exist_ok=True)
    _wipe(reports_dir)
    junit_path = _junit_path(reports_dir)

    # Gate-run lifecycle bracket (CR-CRU-021 §S5, v2 model): the ingest itself
    # registers the agent (implicit heartbeat); AFTER the final ingest the
    # agent row is silently removed — even on a failing run or a mid-ingest
    # exception — so gate/close-out agents never linger as online ghosts.
    # Omitted --agent: no lifecycle calls at all.
    try:
        cmd = _bun_test_cmd(bun, args.tests, junit_path, False, None)
        env = os.environ.copy()
        print(f"[crucible] running: {' '.join(cmd)}  (cwd={package_dir})", file=sys.stderr)
        # Capture output whenever an ingest may be needed: bun's JUnit reporter
        # writes NOTHING when collection crashes, and the failure detail only
        # exists on stdout/stderr.
        log_path = getattr(args, "log", None)
        if args.agent and not log_path:
            log_path = os.path.join(reports_dir, "run.log")
        narrator = None
        if args.agent:
            # bun ≥1.3 hides per-test (pass) lines when it detects Claude Code
            # (CLAUDECODE env). Drop it for the wrapped runner so the full
            # (pass)/(fail) line family streams: §S2b counts it live and the
            # §S2c run.log keeps its result-line block boundaries.
            env.pop("CLAUDECODE", None)
            narrator = _Narrator(
                lambda message: _register_agent(project_dir, args.agent, message),
                total_hint=_prescan_test_total(package_dir, args.tests),
            )
        result = _run_logged(cmd, package_dir, env, log_path, narrator)
        print(f"[crucible] bun test exit={result.returncode}", file=sys.stderr)

        if not args.agent:
            return result.returncode

        if os.path.exists(junit_path):
            summary, tree = _parse_junit_file(junit_path)
            # §S2c — the captured run log IS the failure-detail source.
            _marry_failures(tree, getattr(result, "stdout", None))
            # §S9 — resolve the cycle BEFORE the POST so a no-active-cycle run
            # hard-errors WITHOUT ever ingesting a cycleId=null orphan.
            cycle_id, warnings, hard_error = _resolve_ingest_cycle(project_dir)
            if hard_error:
                _emit_ingest_hard_error("test", project_dir, args.agent, warnings)
                return 1
            resp = _ingest_parsed(project_dir, args.agent, summary, tree,
                                  tier="unit",
                                  context=_ingest_context(cycle_id))
            _emit_ingest_axi("test", resp, summary, project_dir, args.agent,
                             cycle_id, warnings)
            # A failing run exits non-zero even when the ingest succeeded —
            # the exit code carries the RUNNER verdict, not the POST's.
            if summary["failed"] > 0:
                return 1
            return 0 if resp.get("ok") else 1
        # No XML → a hard collection/compile failure. Ingest as a FAILING compile:
        # one synthetic tsc-format diagnostic (so errorCount=1 and the card reads
        # red — never a misleading clean '0 errors') + the captured output as raw.
        tail = (getattr(result, "stdout", None) or "")[-4000:]
        synthetic = ("bun-test(1,1): error TS0000: "
                     "bun test produced no JUnit XML (collection/compile failure)")
        return _ingest_compile(project_dir, args.agent,
                               synthetic + ("\n\n" + tail if tail else ""))
    finally:
        if args.agent:
            cleanup_resp = _remove_agent_silent(project_dir, args.agent)
            print(f"cleanup: ok={cleanup_resp.get('ok', False)} agent={args.agent}",
                  file=sys.stderr)


def cmd_regression(args):
    project_dir = _resolve_project_dir(args.project_dir)
    package_dir = _resolve_package_dir(args.package_dir, project_dir)
    bun = _resolve_bun(args.bun)
    reports_dir = _reports_dir(package_dir, args.reports)
    os.makedirs(reports_dir, exist_ok=True)
    _wipe(reports_dir)
    junit_path = _junit_path(reports_dir)
    coverage_on = bool(args.coverage)
    coverage_dir = os.path.join(package_dir, "coverage")
    env = os.environ.copy()

    # Gate-run lifecycle bracket (CR-CRU-021 §S5, v2 model): identical to
    # cmd_test — implicit registration via the ingest, silent removal after
    # the final ingest, try/finally.
    try:
        cmd = _bun_test_cmd(bun, None, junit_path, coverage_on, coverage_dir)
        print(f"[crucible] running: {' '.join(cmd)}  (cwd={package_dir})", file=sys.stderr)
        # §S2c — capture the run output (failure detail lives only there).
        log_path = getattr(args, "log", None)
        if args.agent and not log_path:
            log_path = os.path.join(reports_dir, "run.log")
        narrator = None
        if args.agent:
            # Same §S2b setup as cmd_test (whole-suite M via package walk).
            env.pop("CLAUDECODE", None)
            narrator = _Narrator(
                lambda message: _register_agent(project_dir, args.agent, message),
                total_hint=_prescan_test_total(package_dir, None),
            )
        result = _run_logged(cmd, package_dir, env, log_path, narrator)
        print(f"[crucible] bun test exit={result.returncode}", file=sys.stderr)

        if not os.path.exists(junit_path):
            print("[crucible] ERROR: no JUnit XML produced — nothing to ingest",
                  file=sys.stderr)
            return 1

        summary, tree = _parse_junit_file(junit_path)
        _marry_failures(tree, getattr(result, "stdout", None))
        coverage = None
        if coverage_on:
            lcov_path = os.path.join(coverage_dir, "lcov.info")
            coverage = _parse_lcov(lcov_path)
            if coverage is None:
                print(f"[crucible] WARN: lcov coverage unavailable at {lcov_path}",
                      file=sys.stderr)
        # §S9 — resolve/attach the active cycle before the POST (hard-error
        # when none, never a cycleId=null orphan).
        cycle_id, warnings, hard_error = _resolve_ingest_cycle(project_dir)
        if hard_error:
            _emit_ingest_hard_error("regression", project_dir, args.agent, warnings)
            return 1
        resp = _ingest_parsed(project_dir, args.agent, summary, tree, coverage,
                              tier="regression", context=_ingest_context(cycle_id))
        _emit_ingest_axi("regression", resp, summary, project_dir, args.agent,
                         cycle_id, warnings)
        return 0 if (resp.get("ok") and summary["failed"] == 0) else 1
    finally:
        if args.agent:
            cleanup_resp = _remove_agent_silent(project_dir, args.agent)
            print(f"cleanup: ok={cleanup_resp.get('ok', False)} agent={args.agent}",
                  file=sys.stderr)


def cmd_auto_ingest(args):
    project_dir = _resolve_project_dir(args.project_dir)
    package_dir = _resolve_package_dir(args.package_dir, project_dir)
    reports_dir = _reports_dir(package_dir, args.reports)
    junit_path = _junit_path(reports_dir)
    if not os.path.exists(junit_path):
        print(f"[crucible] no {junit_path} — nothing to ingest", file=sys.stderr)
        return 1
    summary, tree = _parse_junit_file(junit_path)
    # CR-CRU-030 §S9 — resolve/attach the active cycle BEFORE the POST so the
    # ingested e2e run carries the resolved cycleId in the SERVER record (not
    # just the envelope); no active cycle → hard error, never a cycleId=null orphan.
    cycle_id, warnings, hard_error = _resolve_ingest_cycle(project_dir)
    if hard_error:
        _emit_ingest_hard_error("auto-ingest", project_dir, args.agent, warnings)
        return 1
    resp = _ingest_parsed(project_dir, args.agent, summary, tree, tier="e2e",
                          context=_ingest_context(cycle_id))
    _emit_ingest_axi("auto-ingest", resp, summary, project_dir, args.agent,
                     cycle_id, warnings)
    return 0 if resp.get("ok") else 1


def cmd_check(args):
    """`tsc --noEmit` typecheck gate over the package. With --agent, ingest errors."""
    project_dir = _resolve_project_dir(args.project_dir)
    package_dir = _resolve_package_dir(args.package_dir, project_dir)
    bun = _resolve_bun(args.bun)
    # Prefer the package's local tsc via `bun x tsc`; falls back to a tsc on PATH.
    cmd = [bun, "x", "tsc", "--noEmit"]
    if os.path.exists(os.path.join(package_dir, "tsconfig.json")):
        cmd += ["-p", "tsconfig.json"]
    print(f"[crucible] running: {' '.join(cmd)}  (cwd={package_dir})")
    result = subprocess.run(cmd, cwd=package_dir, capture_output=True, text=True)
    print(f"[crucible] tsc exit={result.returncode}")
    out = (result.stdout or "") + (result.stderr or "")
    if result.returncode != 0:
        sys.stderr.write(out)
        if args.agent:
            _ingest_compile(project_dir, args.agent, out)
    return result.returncode


def cmd_pre_merge_gate(args):
    """ORCHESTRATOR pre-merge gate — the ONLY path that measures coverage (project policy:
    coverage reserved for the pre-merge gate). fail-fast `check` (tsc) → `regression
    --coverage`. A check failure aborts before the suite."""
    if not getattr(args, "skip_check", False):
        check_args = argparse.Namespace(
            agent=args.agent, bun=args.bun, package_dir=args.package_dir,
            project_dir=args.project_dir,
        )
        rc = cmd_check(check_args)
        if rc != 0:
            print("[crucible] pre-merge gate FAILED at the tsc check step — skipped the "
                  "regression. Fix type errors first (or --skip-check to bypass).")
            return rc
    reg_args = argparse.Namespace(
        agent=args.agent, coverage=True, reports=args.reports, bun=args.bun,
        package_dir=args.package_dir, project_dir=args.project_dir,
        log=getattr(args, "log", None),
    )
    return cmd_regression(reg_args)


# ── CR-CRU-008 — plan verbs (plan-file / cycle-activate / cycle-done / cr-close) ──


def _plans_path(project_dir):
    return f"/api/v2/projects/{_project_key(project_dir)}/plans"


def _open_plans(project_dir):
    resp = _get(_plans_path(project_dir))
    if not resp.get("ok"):
        sys.exit(f"[crucible] ERROR: could not list plans: {resp.get('error')}")
    return [p for p in resp.get("plans", []) if p.get("status") == "open"]


def cmd_plan_file(args):
    project_dir = _resolve_project_dir(args.project_dir)
    labels = [label.strip() for label in args.cycles.split(",") if label.strip()]
    if not labels:
        sys.exit("[crucible] ERROR: --cycles must name at least one cycle")
    payload = {"cr": args.cr, "cycles": [{"label": label} for label in labels]}
    if args.title:
        payload["title"] = args.title
    # §S3: wave resolution is `--wave` > $WORKFLOW_WAVE. Neither resolvable ->
    # NO `wave` key at all (no hard block; the env/flag is the prevention lever).
    wave = args.wave if getattr(args, "wave", None) is not None else os.environ.get("WORKFLOW_WAVE")
    if wave:
        payload["wave"] = wave
    # Track identity comes from the workflow env; the orchestrator NAME is a
    # separate concept — explicit flag or $WORKFLOW_ORCHESTRATOR.
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
                  _axi_context(project_dir), [], legacy)
        return 1
    # Emit the ASSIGNED numeric cycle ids — never guess them (plan-7 incident);
    # they stay machine-readable in the envelope's `cycles` table (AC 124).
    cycles = resp.get("cycles", [])
    ids = " ".join(f"{c.get('label')}={c.get('id')}" for c in cycles)
    legacy = (f"plan-file: ok=True planId={resp.get('planId')} cr={resp.get('cr')} "
              f"cycles: {ids}")
    _emit_axi("plan-file", True,
              {"planId": resp.get("planId"), "cr": resp.get("cr"), "cycles": cycles},
              _axi_context(project_dir), [], legacy)
    return 0


def cmd_plan_backfill(args):
    """§S2: resolve the target plan (single plan, or --cr to disambiguate) and
    PATCH its wave via S1. A wave-only PATCH body is closed-plan-safe, so the
    resolver considers ALL plans (open AND closed) — a merged plan's wave is
    exactly what a backfill corrects. Unknown/ambiguous/zero -> non-zero +
    ok=False envelope. A server PATCH failure surfaces the same way."""
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
    # Wave-only body: NEVER a `status` key (S1 closed-plan-safe backfill).
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
    """Cycle ids are unique per PROJECT — resolve the owning OPEN plan by
    scanning GET …/plans, then PATCH that plan's cycle."""
    project_dir = _resolve_project_dir(args.project_dir)
    cycle_id = args.cycle_id
    open_plans = _open_plans(project_dir)
    target = next(
        (p for p in open_plans
         if any(c.get("id") == cycle_id for c in p.get("cycles", []))),
        None,
    )
    verb = "cycle-activate" if status == "active" else "cycle-done"
    if target is None:
        known = "; ".join(
            f"plan {p.get('planId')} ({p.get('cr')}): "
            + ", ".join(str(c.get("id")) for c in p.get("cycles", []))
            for p in open_plans
        ) or "none"
        legacy = (f"[crucible] ERROR: cycle {cycle_id} is not in any OPEN plan. "
                  f"Open plans' cycle ids: {known}")
        _emit_axi(verb, False, {"cycle": cycle_id},
                  _axi_context(project_dir), [], legacy)
        return 1
    resp = _patch(f"{_plans_path(project_dir)}/{target['planId']}/cycles/{cycle_id}",
                  {"status": status})
    ok = resp.get("ok", False)
    legacy = (f"{verb}: ok={ok} cycle={cycle_id} plan={target['planId']}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    _emit_axi(verb, bool(ok), {"cycle": cycle_id, "plan": target["planId"]},
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
        _emit_axi("cr-close", False, {"commit": args.commit},
                  _axi_context(project_dir, cr=args.cr), [], legacy)
        return 1
    if len(open_plans) > 1:
        names = ", ".join(f"{p.get('cr')} (plan {p.get('planId')})" for p in open_plans)
        legacy = (f"[crucible] ERROR: {len(open_plans)} open plans — ambiguous cr-close. "
                  f"Pass --cr to pick one of: {names}")
        _emit_axi("cr-close", False, {"commit": args.commit},
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
              {"plan": plan["planId"], "cr": cr_label, "commit": args.commit},
              _axi_context(project_dir, cr=cr_label), [], legacy)
    if not ok:
        return 1
    # §S4c / AC 141 — a SUCCESSFUL close emits a cr-merged milestone marker
    # (label=CR id, the merge commit, env auto-context). Withheld on a failed
    # close: the CR is not actually merged, so no marker fires.
    ms_resp = _post_milestone(
        project_dir, _agent_id(args), "cr-merged",
        label=cr_label, commit=args.commit,
        context=_fleet_context(cr=cr_label) or None,
    )
    print(f"cr-merged: ok={ms_resp.get('ok', False)} cr={cr_label} commit={args.commit}"
          + (f" error={ms_resp.get('error')}" if ms_resp.get("error") else ""),
          file=sys.stderr)
    return 0


# ── CR-CRU-030 §S4/§S7 — append-cycle + CR-024 workflow client verbs ────────


def _resolve_plan_or_emit(verb, project_dir, cr, result_fields, open_only):
    """Shared prelude for the plan-targeting write verbs (cycle-add /
    checkpoint / abort): GET the plans, resolve exactly ONE target via the
    shared `resolve_single_plan`, and on any failure (GET error, zero, or
    ambiguous) emit the ok:false envelope + return `(None, 1)`. On success
    returns `(plan, None)`."""
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
    """§S4 — append a cycle to a plan (the append-cycle verb no client exposed;
    CR-013 had to curl it). Resolve the target plan exactly like plan-backfill
    (ALL plans, optional --cr), POST …/plans/<planId>/cycles with ONLY the
    label, and let the SERVER reject a CLOSED/absent plan (400) — never a
    client-side pre-filter that would make the "closed plan" AC unreachable.
    The assigned numeric id stays machine-readable in the envelope."""
    project_dir = _resolve_project_dir(args.project_dir)
    result_fields = {"label": args.label}
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
              {"plan": plan["planId"], "id": resp.get("id"), "label": args.label},
              _axi_context(project_dir, cr=cr_label), [], legacy)
    return 0 if ok else 1


def cmd_checkpoint(args):
    """§S7 — checkpoint the resolved OPEN plan (POST …/plans/<id>/checkpoint).
    Resolves the single open plan, or --cr among several — the /shutdown
    emergency flow checkpoints the CURRENTLY open work, never a numeric id the
    caller doesn't have."""
    project_dir = _resolve_project_dir(args.project_dir)
    plan, rc = _resolve_plan_or_emit("checkpoint", project_dir, args.cr, {}, open_only=True)
    if plan is None:
        return rc
    resp = _post(f"{_plans_path(project_dir)}/{plan['planId']}/checkpoint", {})
    ok = resp.get("ok", False)
    legacy = (f"checkpoint: ok={ok} plan={plan['planId']}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    _emit_axi("checkpoint", bool(ok),
              {"plan": plan["planId"], "changed": resp.get("changed")},
              _axi_context(project_dir, cr=plan.get("cr")), [], legacy)
    return 0 if ok else 1


def cmd_stop(args):
    """§S7 — project-level stop (POST …/projects/<key>/stop). No plan targeting;
    checkpoints every open plan server-side and reports the count."""
    project_dir = _resolve_project_dir(args.project_dir)
    resp = _post(f"/api/v2/projects/{_project_key(project_dir)}/stop", {})
    ok = resp.get("ok", False)
    legacy = (f"stop: ok={ok} checkpointed={resp.get('checkpointed')}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    _emit_axi("stop", bool(ok), {"checkpointed": resp.get("checkpointed")},
              _axi_context(project_dir), [], legacy)
    return 0 if ok else 1


def cmd_abort(args):
    """§S7 — abort the resolved OPEN plan (POST …/plans/<id>/abort). The body's
    `userApproved` maps from --user-approved; WITHOUT the flag it is `false`,
    so the server's discouraging 409 refusal stays reachable by default (and
    surfaces here as ok:false + non-zero, never a silent no-op)."""
    project_dir = _resolve_project_dir(args.project_dir)
    plan, rc = _resolve_plan_or_emit("abort", project_dir, args.cr, {}, open_only=True)
    if plan is None:
        return rc
    resp = _post(f"{_plans_path(project_dir)}/{plan['planId']}/abort",
                 {"userApproved": bool(args.user_approved)})
    ok = resp.get("ok", False)
    legacy = (f"abort: ok={ok} plan={plan['planId']} "
              f"userApproved={bool(args.user_approved)}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    _emit_axi("abort", bool(ok), {"plan": plan["planId"]},
              _axi_context(project_dir, cr=plan.get("cr")), [], legacy)
    return 0 if ok else 1


def cmd_status(args):
    """§S6 — the plan/status READ verb (alias `plans`, no --agent). GET …/plans
    and return the queue as a uniform-table §S1 envelope
    (`plans[]{cr,wave,status,activeCycleId,activeCycleLabel,mergeCommit}`) plus
    a top-level `lastRunCr` (the plan with the latest `closedAt`). Read-only —
    the counterpart to the write/lifecycle verbs. An empty queue is an EXPLICIT
    ok:true empty-queue envelope with a definitive message, never bare stdout;
    a failed GET surfaces as ok:false + non-zero."""
    project_dir = _resolve_project_dir(args.project_dir)
    resp = _get(_plans_path(project_dir))
    if not resp.get("ok"):
        legacy = f"[crucible] ERROR: could not list plans: {resp.get('error')}"
        _emit_axi("status", False, {"plans": [], "lastRunCr": None},
                  _axi_context(project_dir), [], legacy)
        return 1
    plans = resp.get("plans", [])
    rows = _axi().build_status_rows(plans)
    last = _axi().last_run_cr(plans)
    if not rows:
        legacy = "status: ok=True — no plans filed for this project"
        _emit_axi("status", True, {"plans": [], "lastRunCr": None},
                  _axi_context(project_dir), [], legacy)
        return 0
    legacy = f"status: ok=True plans={len(rows)} lastRunCr={last}"
    _emit_axi("status", True, {"plans": rows, "lastRunCr": last},
              _axi_context(project_dir), [], legacy)
    return 0


# ── CR-CRU-013 §S5 — fleet gate / milestone verbs ──────────────────────────
#
# `gate-run`    axi PROXY: launch `no-mistakes axi run`, poll `axi status`
#               while it is in flight for throttled INTERIM gates, seal a FINAL
#               gate from the run's own resolved outcome, relay the axi detail
#               to the caller (the caller issues NO POST itself). AC 148.
# `gate-report` report-only: flags (or an `axi status` TOON) → one POST
#               /api/v2/gates. AC 147.
# `milestone`   POST /api/v2/milestones. §S4b / AC 149.
# `cr-close`    now also emits a `type:"cr-merged"` milestone on a successful
#               close (withheld on a failed close). §S4c / AC 141.

# Valid server-side gate outcomes (CR-CRU-013 §S1). An interim (in-flight)
# snapshot has no resolved outcome of its own, so gate-run synthesises one from
# the current step set — it must still be a member of this set (server 400s
# otherwise).
GATE_OUTCOMES = ("checks-passed", "passed", "failed", "cancelled")

# §S2b cadence — the ONLY concrete throttle constant this codebase defines
# (CR-CRU-008 `_Narrator` default). gate-run reuses it for its interim-poll
# cadence so at most one interim gate posts per >=2-second window.
_GATE_POLL_CADENCE_S = 2.0
_GATE_POLL_TICK_S = 0.4

_TOON_MOD = None


def _toon():
    """Lazily load the sibling `clients/toon.py` (C4) TOON codec by file path.

    The hyphenated `bun-crucible.py` is itself loaded by path (not importable),
    so `toon.py` sitting next to it is not on `sys.path` for a plain `import`.
    """
    global _TOON_MOD
    if _TOON_MOD is None:
        import importlib.util
        toon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "toon.py")
        spec = importlib.util.spec_from_file_location("bun_crucible_toon", toon_path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"could not load TOON codec at {toon_path}")
        _TOON_MOD = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_TOON_MOD)
    return _TOON_MOD


# ── CR-CRU-013 C51 §S1 — the TOON AXI envelope on stdout ────────────────────
#
# Every AXI verb prints a `clients/toon.py`-encoded envelope
# `{"axi": {verb, ok, <result fields>, context, warnings}}` on STDOUT (the
# machine channel); the former human-readable line moves to STDERR
# (interactive only). §S3: an unresolved classifying field (cycleId) is emitted
# as an EXPLICIT null AND raises a `warnings[]` entry — never silently dropped.

_AXI_MOD = None


def _axi():
    """Lazily load the shared `clients/_crucible_axi.py` envelope module (§S1)
    by file path — like `_toon()`, it sits next to this hyphen-named script and
    is not guaranteed to be on `sys.path` for a plain `import`."""
    global _AXI_MOD
    if _AXI_MOD is None:
        import importlib.util
        axi_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_crucible_axi.py")
        spec = importlib.util.spec_from_file_location("bun_crucible_axi_shared", axi_path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"could not load shared AXI module at {axi_path}")
        _AXI_MOD = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_AXI_MOD)
    return _AXI_MOD


# §S1: the envelope + context builders now live in the shared module; the
# bun-local wrappers keep bun's project_dir-based signatures (resolving the key
# from `.env` first) and DELEGATE, so extraction is byte-identical.
_AXI_UNSET = _axi().AXI_UNSET


def _axi_context(project_dir, agent_id=None, cr=None, cycle_id=_AXI_UNSET):
    """§S1 envelope context: { projectKey, agentId?, cycleId?, wave, cr, track? }.
    Resolves the project_key from `.env`, then delegates to the shared
    `_crucible_axi.axi_context`."""
    return _axi().axi_context(
        _project_key(project_dir), agent_id=agent_id, cr=cr, cycle_id=cycle_id)


def _emit_axi(verb, ok, result_fields, context, warnings, legacy_line=None):
    """Write the §S1 TOON AXI envelope (delegates to the shared module)."""
    return _axi().emit_axi(verb, ok, result_fields, context, warnings, legacy_line)


def _active_cycle_id(project_dir):
    """First ACTIVE cycle id among the project's OPEN plans, or None. Tolerant
    of any lookup failure — the §S3 guard must never break an ingest. Delegates
    the pure resolution to the shared `_crucible_axi.resolve_active_cycle_id`."""
    try:
        resp = _get(_plans_path(project_dir))
    except Exception:
        return None
    if not isinstance(resp, dict) or not resp.get("ok"):
        return None
    return _axi().resolve_active_cycle_id(resp.get("plans", []))


def _resolve_ingest_cycle(project_dir):
    """§S9 — resolve the cycle an --agent ingest attaches to.

    An explicit `WORKFLOW_CYCLE_ID` (valid int) is authoritative — the optional
    override. Otherwise the open plan's single `status:"active"` cycle is
    auto-resolved from the server (the orchestrator's `cycle-activate` is then
    the only input). Returns `(cycle_id, warnings, hard_error)`:
      - `(int, [], False)`  — explicit override, or an auto-resolved active cycle
      - `(None, [warning], True)`  — NO active cycle: a HARD ERROR. The caller
        MUST emit the ok:false envelope and SKIP the ingest POST rather than
        orphan the run (cycleId=null). §S9 supersedes §S3's soft `no-cycle-id`
        warn-and-proceed for the cycle-attach case.
    """
    raw = os.environ.get("WORKFLOW_CYCLE_ID")
    if raw is not None:
        try:
            return int(raw), [], False
        except ValueError:
            pass  # malformed override → fall through to server auto-resolution
    active = _active_cycle_id(project_dir)
    if active is not None:
        return active, [], False
    warning = {
        "code": "no-active-cycle",
        "detail": "no active cycle — activate one first",
    }
    return None, [warning], True


def _emit_ingest_axi(verb, resp, summary, project_dir, agent, cycle_id, warnings):
    """Emit the §S1 envelope for a SUCCESSFUL ingest verb
    (test/regression/auto-ingest): run{passed,failed,total} + cycle-aware
    context. Any warnings are also surfaced on stderr."""
    run = {"passed": summary["passed"], "failed": summary["failed"],
           "total": summary["total"]}
    context = _axi_context(project_dir, agent_id=agent, cycle_id=cycle_id)
    for w in warnings:
        print(f"warning: {w['code']} — {w['detail']}", file=sys.stderr)
    _emit_axi(verb, bool(resp.get("ok")), {"run": run}, context, warnings)


def _emit_ingest_hard_error(verb, project_dir, agent, warnings):
    """§S9 — emit the ok:false envelope (cycleId=null) on stdout AND stderr when
    there is no active cycle to attach an ingest to. The run is NOT POSTed, so
    it can never land as a silent orphan; the caller returns non-zero."""
    context = _axi_context(project_dir, agent_id=agent, cycle_id=None)
    for w in warnings:
        print(f"error: {w['code']} — {w['detail']}", file=sys.stderr)
    _emit_axi(verb, False, {}, context, warnings)


def _agent_id(args):
    """The agentId for a fleet event. Explicit --agent > $WORKFLOW_ROLE >
    a stable fallback (these verbs never assert on the id, but the server
    requires a non-empty agentId)."""
    explicit = getattr(args, "agent", None)
    if explicit:
        return explicit
    return os.environ.get("WORKFLOW_ROLE") or "bun-crucible"


def _fleet_context(cr=None):
    """Env auto-context shared by gates + milestones: `cr` (when supplied),
    `wave` from $WORKFLOW_WAVE, `track` from $WORKFLOW_ROLE. Absent env keys are
    OMITTED (never fabricated) so an unset WORKFLOW_WAVE yields no `wave` key."""
    ctx = {}
    if cr:
        ctx["cr"] = cr
    wave = os.environ.get("WORKFLOW_WAVE")
    if wave:
        ctx["wave"] = wave
    role = os.environ.get("WORKFLOW_ROLE")
    if role:
        ctx["track"] = role
    return ctx


def _parse_steps_flag(steps_raw):
    """Parse a `--steps "name:status,name:status"` flag into gate step dicts.
    A malformed entry (no colon, or an empty name/status) raises ValueError —
    the caller must surface it as a non-zero exit WITHOUT posting garbage."""
    steps = []
    for entry in steps_raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if ":" not in entry:
            raise ValueError(
                f"malformed --steps entry (expected name:status): {entry!r}")
        name, status = entry.split(":", 1)
        name, status = name.strip(), status.strip()
        if not name or not status:
            raise ValueError(
                f"malformed --steps entry (empty name or status): {entry!r}")
        steps.append({"name": name, "status": status})
    return steps


def _map_axi_step_status(status):
    """Map a no-mistakes axi step status onto a gate step status."""
    return {
        "completed": "passed",
        "skipped": "skipped",
        "failed": "failed",
        "running": "running",
    }.get(status, status or "passed")


def _gate_from_axi(decoded, intent, final):
    """Build a `gate` object from a decoded `no-mistakes axi` TOON snapshot.

    An in-flight snapshot (`final=False`) synthesises a valid interim outcome
    from its steps; the sealing snapshot (`final=True`) takes the run's own
    resolved top-level `outcome`. Returns (gate_dict, step_count)."""
    run = decoded.get("run") if isinstance(decoded, dict) else None
    run = run or {}
    axi_steps = run.get("steps") or []
    steps = []
    any_failed = False
    for s in axi_steps:
        st = s.get("status")
        if st == "failed":
            any_failed = True
        steps.append({"name": s.get("step"), "status": _map_axi_step_status(st)})
    if final:
        raw = decoded.get("outcome")
        outcome = raw if raw in GATE_OUTCOMES else ("failed" if any_failed else "passed")
    else:
        outcome = "failed" if any_failed else "checks-passed"
    gate = {"intent": intent, "outcome": outcome, "steps": steps}
    head = run.get("head")
    if final and head:
        gate["push"] = {"commit": head}
    return gate, len(steps)


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


# §S8 (CR-CRU-030): gate-run is the AXI streaming standard; gate-report is
# discouraged. EVERY gate-report invocation emits this warning — in the §S1
# envelope's warnings[] AND on stderr — regardless of the POST outcome (the
# discouragement is a property of using gate-report at all).
_PREFER_GATE_RUN_WARNING = {
    "code": "prefer-gate-run",
    "detail": ("gate-run is the AXI streaming standard (it posts throttled "
               "interim snapshots while the run is in flight then a final sealed "
               "gate); gate-report posts a single one-shot gate and is "
               "discouraged wherever an axi proxy exists"),
}


def cmd_gate_report(args):
    """Report a single already-run gate (flags path). AC 147.

    §S8 — emits the §S1 TOON-AXI envelope on stdout (verb/ok/outcome +
    warnings) plus the interactive line on stderr, and always raises the
    `prefer-gate-run` discouragement warning (envelope + stderr)."""
    project_dir = _resolve_project_dir(args.project_dir)
    warnings = [dict(_PREFER_GATE_RUN_WARNING)]
    print(f"warning: {_PREFER_GATE_RUN_WARNING['code']} — "
          f"{_PREFER_GATE_RUN_WARNING['detail']}", file=sys.stderr)
    context = _axi_context(project_dir, agent_id=_agent_id(args))
    try:
        steps = _parse_steps_flag(args.steps) if args.steps else []
    except ValueError as e:
        legacy = f"gate-report: ERROR: {e}"
        _emit_axi("gate-report", False, {"outcome": args.outcome}, context, warnings, legacy)
        return 1
    # gate.intent is REQUIRED server-side (400 if missing/empty); when no
    # explicit intent is given, derive a non-empty one from the outcome.
    intent = args.intent or f"{args.outcome} gate"
    gate = {"intent": intent, "outcome": args.outcome, "steps": steps}
    if args.commit:
        gate["push"] = {"commit": args.commit}
    resp = _post_gate(project_dir, _agent_id(args), gate, _fleet_context() or None)
    ok = resp.get("ok", False)
    legacy = (f"gate-report: ok={ok} outcome={args.outcome}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    _emit_axi("gate-report", bool(ok), {"outcome": args.outcome}, context, warnings, legacy)
    return 0 if ok else 1


def cmd_gate_run(args):
    """axi PROXY wrapper: launch `no-mistakes axi run`, poll `axi status` for
    throttled interim gates, seal a final gate from the run's outcome, and
    relay the axi detail to the caller. The caller issues NO POST. AC 148."""
    project_dir = _resolve_project_dir(args.project_dir)
    nm = shutil.which("no-mistakes")
    if not nm:
        print("gate-run: ERROR: `no-mistakes` not found on PATH — cannot proxy axi run",
              file=sys.stderr)
        return 1

    intent = args.intent
    agent_id = _agent_id(args)
    context = _fleet_context()

    try:
        proc = subprocess.Popen(
            [nm, "axi", "run", "--intent", intent],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
    except OSError as e:
        print(f"gate-run: ERROR: could not launch `no-mistakes axi run`: {e}",
              file=sys.stderr)
        return 1

    # Poll `axi status` while the run is in flight; post throttled INTERIM
    # gates decoded from each (partial) snapshot.
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
                    gate, nsteps = _gate_from_axi(decoded, intent, final=False)
                    # Post only a genuine PARTIAL ladder (never a resolved /
                    # full 9-step snapshot masquerading as interim).
                    if in_flight and 0 < nsteps < 9:
                        _post_gate(project_dir, agent_id, gate, context or None)
                        last_post = now
        time.sleep(_GATE_POLL_TICK_S)

    out, _err = proc.communicate()
    # Proxy role: relay the axi detail to the caller's OWN stdout.
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

    final_gate, _ = _gate_from_axi(final_decoded, intent, final=True)
    resp = _post_gate(project_dir, agent_id, final_gate, context or None)
    ok = resp.get("ok", False)
    overall = bool(ok and proc.returncode == 0)
    # §S8 — gate-run emits its OWN §S1 envelope on stdout ALONGSIDE the relayed
    # axi detail (already written above), with NO prefer-gate-run warning: it is
    # itself the streaming standard. The interactive line moves to stderr.
    legacy = (f"gate-run: ok={ok} outcome={final_gate.get('outcome')} "
              f"exit={proc.returncode}"
              + (f" error={resp.get('error')}" if resp.get("error") else ""))
    _emit_axi("gate-run", overall, {"outcome": final_gate.get("outcome")},
              _axi_context(project_dir, agent_id=agent_id), [], legacy)
    return 0 if overall else 1


def cmd_milestone(args):
    """POST a workflow milestone. §S4b / AC 149."""
    project_dir = _resolve_project_dir(args.project_dir)
    context = _fleet_context(cr=args.cr)
    resp = _post_milestone(project_dir, _agent_id(args), args.type,
                           label=args.label, commit=getattr(args, "commit", None),
                           context=context or None)
    ok = resp.get("ok", False)
    print(f"milestone: ok={ok} type={args.type}"
          + (f" label={args.label}" if args.label else "")
          + (f" error={resp.get('error')}" if resp.get("error") else ""))
    return 0 if ok else 1


def _add_project_dir_arg(p):
    p.add_argument("--project-dir",
                   help="Override project root (default: $BUN_CRUCIBLE_PROJECT_DIR, else the "
                        "git repo of CWD). The .env at the root must contain CRUCIBLE_PROJECT_KEY.")


def _add_package_dir_arg(p):
    p.add_argument("--package-dir",
                   help="Bun package dir / test cwd (default: $BUN_CRUCIBLE_PACKAGE_DIR, else "
                        "<project>/integrations/pi if it has package.json, else <project>).")


def _add_bun_arg(p):
    p.add_argument("--bun", help="bun binary (default: $BUN_CRUCIBLE_BUN, else `bun`).")


def _add_reports_arg(p):
    p.add_argument("--reports", help=f"Reports dir under the package (default: {DEFAULT_REPORTS}).")


def _add_log_arg(p):
    p.add_argument("--log", help="Write the FULL run output (combined stdout+stderr) to this path "
                                 "in addition to streaming it.")


def main():
    p = argparse.ArgumentParser(prog="bun-crucible", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("register", help="Register / heartbeat an agent.")
    r.add_argument("--agent", required=True,
                   help="Agent id — `<type>-<project>` or `CR-<PROJ>-NNN-<cycle>-<PHASE>`.")
    # Ergonomics fix (CR-CRU-008 §S2): --phase is OPTIONAL, defaulting to
    # "report" — the old hard requirement forced orchestrator-side
    # implicit-heartbeat workarounds.
    r.add_argument("--phase", default="report",
                   choices=["RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report"])
    r.add_argument("--display-name", help="Human-readable name (default: the agentId)")
    r.add_argument("--source", default="claude-md",
                   choices=["claude-md", "package-json", "git-repo", "manual"])
    r.add_argument("--message", help="Optional status message")
    _add_project_dir_arg(r)
    r.set_defaults(func=cmd_register)

    u = sub.add_parser("unregister", help="Unregister an agent")
    u.add_argument("--agent", required=True)
    _add_project_dir_arg(u)
    u.set_defaults(func=cmd_unregister)

    t = sub.add_parser("test", help="Targeted/whole-suite `bun test` → junit → ingest.")
    t.add_argument("--tests", nargs="+",
                   help="Test file/path target(s) (e.g. src/tools/send.test.ts). Omit for all.")
    t.add_argument("--agent", help="If set, ingest the junit result after the run")
    _add_reports_arg(t)
    _add_bun_arg(t)
    _add_package_dir_arg(t)
    _add_project_dir_arg(t)
    _add_log_arg(t)
    t.set_defaults(func=cmd_test)

    g = sub.add_parser("regression", help="Full-suite `bun test` + ingest. --coverage for lcov.")
    g.add_argument("--agent", required=True, help="Agent id (typically the orchestrator)")
    g.add_argument("--coverage", action="store_true",
                   help="Run with bun lcov coverage and post /api/v2/runs/parsed with coverage")
    _add_reports_arg(g)
    _add_bun_arg(g)
    _add_package_dir_arg(g)
    _add_project_dir_arg(g)
    _add_log_arg(g)
    g.set_defaults(func=cmd_regression)

    a = sub.add_parser("auto-ingest", help="Ingest an already-produced junit file.")
    a.add_argument("--agent", required=True)
    _add_reports_arg(a)
    _add_package_dir_arg(a)
    _add_project_dir_arg(a)
    a.set_defaults(func=cmd_auto_ingest)

    c = sub.add_parser("check", help="`tsc --noEmit` typecheck gate; ingest errors on failure.")
    c.add_argument("--agent", help="If set, ingest type errors on failure")
    _add_bun_arg(c)
    _add_package_dir_arg(c)
    _add_project_dir_arg(c)
    c.set_defaults(func=cmd_check)

    pmg = sub.add_parser("pre-merge-gate",
                         help="ORCHESTRATOR pre-merge: fail-fast tsc check → regression WITH "
                              "coverage (the only coverage path).")
    pmg.add_argument("--agent", required=True, help="Agent id (typically the orchestrator)")
    pmg.add_argument("--skip-check", action="store_true", help="Bypass the fail-fast tsc check")
    _add_reports_arg(pmg)
    _add_bun_arg(pmg)
    _add_package_dir_arg(pmg)
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
                    help="Wave number (§S3). Resolution: --wave > $WORKFLOW_WAVE; "
                         "neither -> filed wave-less (no hard block).")
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
    _add_project_dir_arg(cc)
    cc.set_defaults(func=cmd_cr_close)

    # ── CR-CRU-030 §S4/§S7 — append-cycle + CR-024 workflow verbs ──
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

    st = sub.add_parser("stop",
                        help="Stop the project — checkpoint every open plan "
                             "(POST …/projects/<key>/stop).")
    _add_project_dir_arg(st)
    st.set_defaults(func=cmd_stop)

    ab = sub.add_parser("abort",
                        help="Abort the resolved OPEN plan (POST …/plans/<id>/abort). "
                             "Requires --user-approved to pass the server's 409 gate.")
    ab.add_argument("--user-approved", action="store_true",
                    help="Map to body userApproved:true (the server refuses without it).")
    ab.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    _add_project_dir_arg(ab)
    ab.set_defaults(func=cmd_abort)

    # ── CR-CRU-030 §S6 — the plan/status READ verb (alias `plans`, no --agent) ──
    for _name in ("status", "plans"):
        sv = sub.add_parser(_name,
                            help="Read the plan queue (GET …/plans) as a TOON-AXI table "
                                 "+ lastRunCr. Read-only; `plans` is an alias of `status`.")
        _add_project_dir_arg(sv)
        sv.set_defaults(func=cmd_status)

    # ── CR-CRU-013 §S5 — fleet gate / milestone verbs ──
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
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
