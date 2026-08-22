#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
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
                        track comes from $WORKFLOW_ROLE; the registered --agent id
                        is the caller AND the plan's orchestrator (§S2b).
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
  Run-lifecycle opt-out (CR-CRU-017 §S4): --no-lifecycle > $BUN_CRUCIBLE_NO_LIFECYCLE.
  Posts to $CRUCIBLE_URL (default http://localhost:3849), v2 endpoints ONLY:
  /api/v2/agents/register|unregister, /api/v2/runs/start|parsed|compile,
  /api/v2/projects/<key>/plans. This in-repo clients/ copy is the SOURCE OF
  TRUTH (CR-CRU-008 Risk section) — ~/.claude/scripts/ mirrors it.

Examples:
  # Targeted RED/GREEN run + ingest in one call
  bun-crucible.py test --tests src/tools/send.test.ts --agent CR-SAN-013-C1-RED

  # Whole suite without ingest (just see if it passes)
  bun-crucible.py test

  # Full regression + coverage + ingest (orchestrator gate)
  bun-crucible.py pre-merge-gate --agent claude-sandesh

Agent naming (CR-CRU-044 §S4/§S5): the agentId is a FREE-FORM identifier carrying no
structure the system reads. It is DECLARED with `--agent` or the verb fails — there is no
filename default and no env fallback ($WORKFLOW_ROLE is the track lane, not an identity).
The role comes from `--role` alone and is never inferred from the agentId's shape, so
`<agent-type>-<project>` (e.g. claude-sandesh) and `CR-<PROJ>-NNN-<cycle>-<ROLE>` (e.g.
CR-SAN-013-C1-RED) are readability habits only. Identity carries displayName + source
(default claude-md) + repoPath, inside the `identity` object.
"""

import argparse
import contextlib
import os
import re
import shutil
import signal
import subprocess
import sys
import time
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


# ── §S2b (CR-CRU-008) — in-run progress narration ──────────────────────────

# bun's per-test completion line family (piped, non-quiet mode). bun ≥1.3
# marks each finished test with a tick/cross glyph — and colourises it EVEN
# THROUGH A PIPE, so the real captured bytes are
# `\x1b[0m\x1b[32m✓\x1b[0m\x1b[0m\x1b[1m <name>…`. An anchored bare `^✓`
# therefore matches ZERO real output; the SGR runs around the glyph must be
# tolerated on both sides. Pass (✓) and fail (✗) both count as completions.
# §S1b (CR-CRU-055): the tick family has a SECOND legal wire form — an
# uncoloured pipe (bun ≥1.3.14 canary) emits PLAIN result lines,
# `(pass) suite > name [0.04ms]` / `(fail) suite > name [0.15ms]`, with no
# SGR runs at all. Both forms must count. Plain `(skip)`/`(todo)` lines are
# NOT completions — mirroring the ANSI family, where skip (») and todo (✎)
# never matched here either.
_ANSI_SGR_RUN = r"(?:\x1b\[[0-9;]*m)*"
_COMPLETION_LINE = re.compile(
    r"^" + _ANSI_SGR_RUN + r"(?:[✓✗]" + _ANSI_SGR_RUN + r"|\((?:pass|fail)\))\s"
)
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
    per-test completion lines (the ANSI-colourised ✓/✗ family) and posts progress
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
    consumes `result.stdout` unchanged).

    CR-CRU-017 §S4: an interruption of the streaming read (the SIGINT/SIGTERM
    trap a wrapped run installs raises THROUGH this loop) reaps the runner
    before it propagates, so a signalled run leaves no orphaned bun behind —
    the same guarantee `subprocess.run` already gives the un-captured branch
    above."""
    if not log_path and narrator is None:
        return subprocess.run(cmd, cwd=cwd, env=env)
    proc = subprocess.Popen(
        cmd, cwd=cwd, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    lines = []
    try:
        for line in proc.stdout:
            lines.append(line)
            if narrator is not None:
                narrator.observe(line)
    except BaseException:
        proc.kill()
        proc.wait()
        raise
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


def _register_agent(project_dir, agent_id, message, display_name=None, source="claude-md",
                    role=None, cycle_id=None):
    """POST the agent-online heartbeat. Single payload builder shared by
    cmd_register and the gate-run lifecycle brackets (CR-CRU-021 §S5).

    CR-CRU-044 §S1 — a real REGISTRATION must declare its role. The
    role-less callers here are the §S2b narration heartbeats, which route to
    /api/v2/agents/heartbeat: the role-optional liveness ping, so a narration
    tick never re-declares — nor blanks — the role the agent registered with.

    CR-CRU-056 §S1/§S4 — `cycle_id` rides the register body as `cycleId`,
    binding the agent to a cycle; the server validates it (ACTIVE cycle in an
    OPEN plan) and REQUIRES it for TDD roles (RED/GREEN/FIX/VERIFY).
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
    if role is None:
        return _post("/api/v2/agents/heartbeat", payload)
    payload["role"] = role
    if cycle_id is not None:
        payload["cycleId"] = cycle_id
    return _post("/api/v2/agents/register", payload)


def _unregister_agent(project_dir, agent_id):
    """POST the agent removal (the v2 unregister VERB — journals a
    'unregistered' lifecycle event, CR-CRU-011 §S1). Used by cmd_unregister."""
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
    """Parse a bun JUnit XML file into (summary, tree, files) with per-test leaf
    names. `files` (CR-CRU-047 §S2) is the number of DISTINCT test FILES the run
    collected — bun stamps each `<testcase>` with `file="tests/..."`; a case
    missing that attribute falls back to its `classname`, then to its suite
    name, so the count degrades to "distinct suites" rather than to zero. It
    rides the printed run envelope only, never the ingest payload, so a
    shrinking suite is visible in the gate output itself."""
    tree_nodes = []
    total = passed = failed = pending = 0
    duration_ms = 0
    files = set()
    root = ET.parse(junit_path).getroot()
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
            # CR-CRU-050 §S1/§S1b — a `<skipped/>` testcase (bun emits it for
            # BOTH `test.skip` and `test.todo`) is PENDING, never passed. Order
            # matters: failure/error first, then skipped, then pass. A skip does
            # NOT fail its suite. Mirrors mvn-crucible.py:641, the reference.
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
               "pending": pending, "duration_ms": duration_ms}
    return summary, tree_nodes, len(files)


# bun's per-test RESULT-line family — the same ANSI trap `_COMPLETION_LINE`
# documents above, and the identical stale-pattern defect. bun colourises these
# lines EVEN THROUGH A PIPE; the real captured bytes of a failing line are
#   \x1b[0m\x1b[31m✗\x1b[0m\x1b[0m\x1b[1m mismatched expectation\x1b[0m \x1b[0m\x1b[2m[0.13ms\x1b[0m\x1b[2m]\x1b[0m
# so SGR runs sit on BOTH sides of the glyph, INSIDE the name (a nested
# describe renders as `suite\x1b[2m >\x1b[0m\x1b[1m name`) and all through the
# `[0.13ms]` duration tail — whose `[` is itself followed by an SGR run. An
# anchored `^\(fail\)` matches ZERO real output; so would a naive `^✗`.
# Matching therefore happens on the WIRE form, while everything STORED (name,
# message, trace) is stripped clean — junit leaf names carry no escapes, so a
# married key must not either.
# §S1b (CR-CRU-055): an uncoloured pipe (bun ≥1.3.14 canary) emits the SECOND
# legal wire form — PLAIN result lines with no SGR runs:
#   (fail) scratch > fails one [0.15ms]
#   (pass) scratch > passes one [0.04ms]
#   (skip) scratch > skipped one        (no duration tail)
#   (todo) scratch > todo one           (no duration tail)
# The `error:` detail block still arrives IMMEDIATELY BEFORE its `(fail)`
# line, so both matcher families accept both forms and the marrying logic
# downstream is unchanged. (`_ANSI_SGR_RUN` is zero-or-more, so the existing
# duration-tail pattern already matches the plain `[0.15ms]` tail.)
_ANSI_SGR_RE = re.compile(_ANSI_SGR_RUN)
_DURATION_TAIL = (r"(?:\s+" + _ANSI_SGR_RUN + r"\[" + _ANSI_SGR_RUN
                  + r"[0-9.]+\s*m?s" + _ANSI_SGR_RUN + r"\])?")
_FAIL_LINE = re.compile(
    r"^" + _ANSI_SGR_RUN + r"(?:✗|\(fail\))" + _ANSI_SGR_RUN + r"\s+(?P<name>.*?)"
    + _ANSI_SGR_RUN + _DURATION_TAIL + _ANSI_SGR_RUN + r"\s*$"
)
# The non-failing result markers — ANSI pass (✓), skip (»), todo (✎) and their
# plain twins `(pass)`/`(skip)`/`(todo)`. Each ends the preceding detail
# block, so an `error:` block can never cross a finished test and marry onto
# the wrong leaf. (Skip/todo lines carry no duration tail.)
_RESULT_BOUNDARY_LINE = re.compile(
    r"^" + _ANSI_SGR_RUN + r"(?:[✓»✎]" + _ANSI_SGR_RUN + r"|\((?:pass|skip|todo)\))\s"
)


def _strip_ansi(text):
    """Drop SGR escape runs. bun colourises its stream even through a pipe, so
    every value lifted off that stream is cleaned before it is stored."""
    return _ANSI_SGR_RE.sub("", text)


def _parse_console_failures(log_text):
    r"""§S2c (CR-CRU-008) — marry bun's console failure detail to leaf names.

    bun's JUnit reporter writes a BARE `<failure type="..."/>` for EVERY
    failure kind (assertion mismatch, thrown Error, timeout alike) — the human
    detail exists only on the console stream. For assertion mismatches and
    thrown Errors an `error: <detail>` block appears IMMEDIATELY BEFORE the
    `✗ <name>` result line; that block is captured here, keyed by leaf name.
    Detail printed AFTER the fail line (e.g. a timeout's `^ this test timed
    out after Nms.`) is structurally NOT a preceding block and stays
    unmatched — the leaf degrades to type-only.

    Every line is ANSI-colourised — including the `error:` prefix, which
    arrives as `\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m ` — so the block is
    accumulated in its stripped form and the result lines are matched on the
    wire form.
    """
    details = {}
    block = []        # stripped lines since the last result-line boundary
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
                name = _strip_ansi(m.group("name")).strip()
                details[name] = married
                # Nested describes print "suite > name"; junit leaves carry
                # the bare test name — index the last segment too.
                details.setdefault(name.split(" > ")[-1], married)
            block, error_idx = [], None
            continue
        if _RESULT_BOUNDARY_LINE.match(line):
            block, error_idx = [], None
            continue
        plain = _strip_ansi(line)
        if plain.startswith("error:"):
            error_idx = len(block)
        block.append(plain)
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
    """CR-CRU-008 §S2 — env + git → run context for declared cycle linkage.

    CR-CRU-054 §S2 — a thin delegator to `_crucible_axi.run_context`, which
    documents the full contract (WORKFLOW_CYCLE/WAVE/ROLE, tolerant git
    provenance, and None — never a bare `{}` — when no workflow env is set).
    The local name is kept deliberately: the CR-CRU-030 delegation pattern,
    addressed unqualified by every call site here and by the client test
    harnesses."""
    return _axi().run_context()


def _ingest_parsed(project_dir, agent_id, summary, tree, coverage=None, tier=None,
                   context=None, raw=None, run_id=None):
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
    # CR-CRU-038 §S2b — the captured runner output rides along as `raw` so the
    # server-stored run carries real output for the run-detail raw-toggle.
    if raw:
        payload["raw"] = raw
    # CR-CRU-017 §S1/§S4 — the runId of the OPEN run this ingest CLOSES. Absent
    # (single-shot, or `--no-lifecycle`) the body is byte-identical to the
    # pre-lifecycle one and the server stores no lifecycle fields at all.
    if run_id:
        payload["runId"] = run_id
    resp = _post("/api/v2/runs/parsed", payload)
    cov_line = ""
    if coverage:
        cov_line = (f" lines={coverage['lines']['percent']}%"
                    f" funcs={coverage['functions']['percent']}%")
    # The human-readable ingest line is interactive-only (stderr); the machine
    # channel is the §S1 TOON AXI envelope the caller emits on stdout.
    print(
        f"ingest: ok={resp.get('ok')} passed={summary['passed']} "
        f"failed={summary['failed']} pending={summary.get('pending', 0)} "
        f"total={summary['total']}{cov_line}"
        + (f" error={resp['error']}" if resp.get("error") else ""),
        file=sys.stderr,
    )
    return resp


def _ingest_compile(project_dir, agent_id, errors_text, run_id=None):
    payload = {
        "projectKey": _project_key(project_dir),
        "format": "typescript",
        "errors": errors_text,
        "agentId": agent_id,
    }
    # CR-CRU-017 §S4 — a collection/compile failure is still an END: it closes
    # the run this client opened, so the span is measured instead of abandoned.
    if run_id:
        payload["runId"] = run_id
    resp = _post("/api/v2/runs/compile", payload)
    # CR-CRU-058 §S3 — the human ingest line is interactive-only (stderr); it
    # used to land on stdout AHEAD of the caller's envelope (`check`'s failure
    # path, and with it `pre-merge-gate`'s), leaving stdout un-decodable.
    print(f"ingest compile (typescript): ok={resp.get('ok')}"
          + (f" error={resp['error']}" if resp.get("error") else ""),
          file=sys.stderr)
    return 0 if resp.get("ok") else 1


# ── CR-CRU-017 §S4 — the RUN LIFECYCLE bracket around a wrapped run ─────────
#
# A wrapped run is two events, not one: `POST /api/v2/runs/start` fires BEFORE
# the tool is spawned (so queue + spawn + teardown time sits INSIDE the
# measured span) and the ordinary ingest CLOSES that run by carrying its
# `runId`. The server then stores `startedAt` + a server-computed `runtime_ms`
# alongside the tool-reported `duration_ms` — the wall-clock the tool's own
# number structurally cannot see.
#
# Everything here is ADDITIVE. Without a runId the ingest body is byte-identical
# to the pre-CR single-shot POST, which is what BOTH degradation paths fall back
# to: the explicit opt-out (`--no-lifecycle` / $BUN_CRUCIBLE_NO_LIFECYCLE), and
# an OLDER SERVER whose /runs/start route does not exist (404) — the latter
# warns, naming the fallback, because it was not asked for.
#
# There is deliberately NO client-side abort. `POST /runs/<id>/abort` is §S2 and
# does not exist yet; §S1 already ships the server-side sweep that settles an
# open run (reason `agent died` when its agent tombstones, `abandoned` past
# CRUCIBLE_RUN_ABANDON_MS). So the signal/no-result paths STATE that the run was
# left to that sweep rather than inventing a route.

NO_LIFECYCLE_ENV = "BUN_CRUCIBLE_NO_LIFECYCLE"
_TRUTHY = ("1", "true", "yes", "on")


def _lifecycle_enabled(args):
    """Should this run be WRAPPED? `--no-lifecycle`, or its env twin
    $BUN_CRUCIBLE_NO_LIFECYCLE, opts out; the argparse default is
    `no_lifecycle=False`, so every real CLI `test`/`regression`/`pre-merge-gate`
    invocation wraps.

    A Namespace carrying NO `no_lifecycle` attribute at all is an internal
    caller written against the pre-lifecycle signature, and gets the unchanged
    single-shot path — the same absent-means-inert reading `log` and `cycle`
    already get at their call sites here."""
    if getattr(args, "no_lifecycle", True):
        return False
    return os.environ.get(NO_LIFECYCLE_ENV, "").strip().lower() not in _TRUTHY


def _run_lifecycle_unavailable_warning(error):
    """The structured warning for a start the SERVER refused — an older build
    with no /runs/start route (404) being the case the CR names. Degradation is
    not failure (the evidence still lands), but it is never SILENT: the caller
    asked for a measured span and got a single-shot event instead."""
    return {
        "code": "run-lifecycle-unavailable",
        "detail": (f"could not open a run lifecycle: {error} — fell back to a "
                   f"single-shot ingest, so this run is stored with the "
                   f"tool-reported duration_ms only (no startedAt, no "
                   f"server-computed runtime_ms)"),
    }


def _run_left_open_warning(run_id, cause):
    """The structured warning for a run this client OPENED and then could not
    close. It names the settlement path precisely, because the alternative
    reading — "the run was lost" — is wrong and would send an operator hunting
    for a missing event."""
    return {
        "code": "run-left-open",
        "detail": (f"{cause} — run {run_id} was never closed by an ingest. The "
                   f"client posts NO abort (POST /api/v2/runs/<id>/abort is "
                   f"CR-CRU-017 §S2 and does not exist yet): the server settles "
                   f"it with its own auto-abort — reason `agent died` as soon as "
                   f"this agent tombstones, else `abandoned` once the run is "
                   f"older than CRUCIBLE_RUN_ABANDON_MS. The run is abandoned, "
                   f"not lost"),
    }


def _run_left_open_help():
    """CR-CRU-048's rule — the state actually reached is "an open run is being
    settled by the server", so the next action is to WATCH that settlement and
    then re-run, never the verb's normal successor."""
    return ["status", "re-run the verb to record a fresh run"]


def _start_run(project_dir, agent_id, tier=None, context=None):
    """Open the run BEFORE the tool is spawned. Returns `(run_id, warnings)`.

    A refusal degrades to single-shot with a warning naming the fallback. An
    `ok` answer that carries no runId is a server that simply did not open one
    (nothing failed, so there is nothing to report): the ingest is then the
    unchanged single-shot POST."""
    payload = {
        "projectKey": _project_key(project_dir),
        "agentId": agent_id,
        "stack": "bun",
    }
    if tier:
        payload["tier"] = tier
    if context:
        payload["context"] = context
    resp = _post("/api/v2/runs/start", payload) or {}
    run_id = resp.get("runId")
    if run_id:
        print(f"[crucible] run started: {run_id}", file=sys.stderr)
        return run_id, []
    if resp.get("ok"):
        return None, []
    error = resp.get("error") or "the server opened no run"
    print(f"[crucible] WARN: run lifecycle unavailable ({error}) — "
          f"single-shot ingest", file=sys.stderr)
    return None, [_run_lifecycle_unavailable_warning(error)]


class _RunAbandoned(Exception):
    """SIGINT/SIGTERM arrived while a WRAPPED run was in flight. Carries the
    signal number so the verb exits on the conventional 128+signum."""

    def __init__(self, signum):
        super().__init__(f"run abandoned on {signal.Signals(signum).name}")
        self.signum = signum


@contextlib.contextmanager
def _abandon_trap(run_id):
    """Trap SIGINT/SIGTERM for as long as `run_id` names an OPEN run, turning
    the signal into a `_RunAbandoned` the verb can report on. Outside a wrapped
    run (`run_id` None) this is inert and the default disposition stands —
    there is nothing open to disclose.

    The previous handlers are always restored, so the trap can never outlive
    the run it guards. A non-main thread cannot install handlers at all
    (`ValueError`); that is not a reason to fail a test run, so the wrap simply
    proceeds untrapped."""
    if run_id is None:
        yield
        return

    def _handler(signum, _frame):
        raise _RunAbandoned(signum)

    previous = {}
    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, _handler)
    except ValueError:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        yield
        return
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def _emit_run_abandoned(verb, project_dir, agent_id, run_id, abandoned):
    """The signal path's ONLY output: one ok:false envelope naming the signal
    and the open run the server will settle. No POST of any kind is made here —
    the closing `_close_gate_identity` tombstone in the caller's `finally` is
    what ARMS the server's `agent died` auto-abort."""
    signame = signal.Signals(abandoned.signum).name
    _emit_axi(
        verb, False,
        {"runId": run_id, "signal": signame, "help": _run_left_open_help()},
        _axi_context(project_dir, agent_id=agent_id),
        [_run_left_open_warning(run_id, f"{signame} interrupted the wrapped run")],
        f"{verb}: ok=False — {signame} interrupted the run; run {run_id} left "
        f"open for the server's auto-abort")
    return 128 + abandoned.signum


def cmd_test(args):
    project_dir = _resolve_project_dir(args.project_dir)
    package_dir = _resolve_package_dir(args.package_dir, project_dir)
    bun = _resolve_bun(args.bun)
    reports_dir = _reports_dir(package_dir, args.reports)
    os.makedirs(reports_dir, exist_ok=True)
    _wipe(reports_dir)
    junit_path = _junit_path(reports_dir)

    # Gate-run lifecycle bracket (CR-CRU-021 §S5): an opening heartbeat DECLARES
    # the run's identity (and binds it when --cycle is given), and AFTER the
    # final ingest the agent row is silently removed — even on a failing run or
    # a mid-ingest exception — so gate/close-out agents never linger as online
    # ghosts. CR-CRU-056: the removal fires ONLY for an identity this run
    # created; a caller who registered BEFORE the run keeps its registration
    # and its cycle binding. Omitted --agent: no lifecycle calls at all.
    identity = None
    # CR-CRU-017 §S4 — the RUN lifecycle rides INSIDE the identity bracket: the
    # server refuses a run-start from an unregistered caller, so the run can
    # only be opened once the identity heartbeat above has landed.
    run_id, run_warnings = None, []
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
            identity = _open_gate_identity(project_dir, args.agent,
                                           getattr(args, "cycle", None),
                                           "gated test run starting")
            # bun ≥1.3 hides per-test completion lines when it detects an agent
            # session (CLAUDECODE / AGENT / REPL_ID / AI_AGENT env). Drop them all for the
            # wrapped runner so the full ✓/✗ line family streams: §S2b counts it
            # live and the §S2c run.log keeps its result-line block boundaries.
            for _quieting_var in ("CLAUDECODE", "AGENT", "REPL_ID", "AI_AGENT"):
                env.pop(_quieting_var, None)
            narrator = _Narrator(
                # Every narration tick is observed too: if the row is pruned
                # mid-run and a tick re-creates it, this run owns that ghost.
                lambda message: identity.observe(
                    _register_agent(project_dir, args.agent, message)),
                total_hint=_prescan_test_total(package_dir, args.tests),
            )
            if _lifecycle_enabled(args):
                run_id, run_warnings = _start_run(project_dir, args.agent,
                                                  tier="unit",
                                                  context=_run_context())
        # §S4 — the wrapped span: the run is already OPEN, so a signal from here
        # on has an open run to disclose (the trap is inert without one).
        try:
            with _abandon_trap(run_id):
                result = _run_logged(cmd, package_dir, env, log_path, narrator)
        except _RunAbandoned as abandoned:
            return _emit_run_abandoned("test", project_dir, args.agent,
                                       run_id, abandoned)
        print(f"[crucible] bun test exit={result.returncode}", file=sys.stderr)

        if not args.agent:
            return result.returncode

        if os.path.exists(junit_path):
            summary, tree, files = _parse_junit_file(junit_path)
            # §S2c — the captured run log IS the failure-detail source.
            _marry_failures(tree, getattr(result, "stdout", None))
            resp = _ingest_parsed(project_dir, args.agent, summary, tree,
                                  tier="unit",
                                  context=_run_context(),
                                  raw=getattr(result, "stdout", None),
                                  run_id=run_id)
            _emit_ingest_axi("test", resp, summary, files, project_dir, args.agent,
                             warnings=run_warnings, run_id=run_id)
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
        rc = _ingest_compile(project_dir, args.agent,
                             synthetic + ("\n\n" + tail if tail else ""),
                             run_id=run_id)
        # CR-CRU-064 §S3 — the synthetic TS0000 ingest above is UNCHANGED
        # (errorCount=1, red card); the envelope is additive and the exit code
        # is still the ingest's own (AC5).
        _emit_axi("test", False,
                  {"help": _axi().no_report_help("test", "junit.xml")},
                  _axi_context(project_dir, agent_id=args.agent),
                  run_warnings + [_axi().no_report_warning("test", "junit.xml",
                                                           result.returncode, tail)],
                  "[crucible] ERROR: no JUnit XML produced — ingested as compile")
        return rc
    finally:
        _close_gate_identity(project_dir, identity)


def cmd_regression(args, verb="regression"):
    """CR-CRU-058 §S1 — `verb` names the envelope this run belongs to:
    `pre-merge-gate` runs this body AS its regression step, so the gate's stdout
    carries ONE document under the GATE's own verb, not the inner one's."""
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

    # Gate-run lifecycle bracket (CR-CRU-021 §S5): identical to cmd_test —
    # opening heartbeat (binding when --cycle is given), silent removal after
    # the final ingest, try/finally, and (CR-CRU-056) removal ONLY of an
    # identity this run created.
    identity = None
    # CR-CRU-017 §S4 — the run lifecycle, opened inside the identity bracket
    # exactly as `cmd_test` does.
    run_id, run_warnings = None, []
    try:
        cmd = _bun_test_cmd(bun, None, junit_path, coverage_on, coverage_dir)
        print(f"[crucible] running: {' '.join(cmd)}  (cwd={package_dir})", file=sys.stderr)
        # §S2c — capture the run output (failure detail lives only there).
        log_path = getattr(args, "log", None)
        if args.agent and not log_path:
            log_path = os.path.join(reports_dir, "run.log")
        narrator = None
        if args.agent:
            identity = _open_gate_identity(project_dir, args.agent,
                                           getattr(args, "cycle", None),
                                           "gated regression run starting")
            # Same §S2b setup as cmd_test (whole-suite M via package walk),
            # including the agent-quieting env strip.
            for _quieting_var in ("CLAUDECODE", "AGENT", "REPL_ID", "AI_AGENT"):
                env.pop(_quieting_var, None)
            narrator = _Narrator(
                lambda message: identity.observe(
                    _register_agent(project_dir, args.agent, message)),
                total_hint=_prescan_test_total(package_dir, None),
            )
            if _lifecycle_enabled(args):
                run_id, run_warnings = _start_run(project_dir, args.agent,
                                                  tier="regression",
                                                  context=_run_context())
        try:
            with _abandon_trap(run_id):
                result = _run_logged(cmd, package_dir, env, log_path, narrator)
        except _RunAbandoned as abandoned:
            return _emit_run_abandoned(verb, project_dir, args.agent,
                                       run_id, abandoned)
        print(f"[crucible] bun test exit={result.returncode}", file=sys.stderr)

        if not os.path.exists(junit_path):
            print("[crucible] ERROR: no JUnit XML produced — nothing to ingest",
                  file=sys.stderr)
            # CR-CRU-064 §S3/AC6 — under the `verb` PARAMETER, so a starved
            # `pre-merge-gate` speaks as the gate, never as the inner
            # `regression`. The capture exists here today and was simply
            # discarded; it now carries the cause.
            # §S4 — nothing was produced, so nothing CLOSES the open run: say
            # which sweep will settle it rather than leaving it silently open.
            warnings = list(run_warnings)
            if run_id:
                warnings.append(_run_left_open_warning(
                    run_id, "the runner produced no JUnit XML, so there was "
                            "nothing to ingest"))
            _emit_axi(verb, False,
                      {"help": _axi().no_report_help(verb, "junit.xml")},
                      _axi_context(project_dir, agent_id=args.agent),
                      warnings + [_axi().no_report_warning(
                          verb, "junit.xml", result.returncode,
                          getattr(result, "stdout", None) or "")],
                      f"{verb}: ok=False — no JUnit XML, nothing to ingest")
            return 1

        summary, tree, files = _parse_junit_file(junit_path)
        _marry_failures(tree, getattr(result, "stdout", None))
        coverage = None
        if coverage_on:
            lcov_path = os.path.join(coverage_dir, "lcov.info")
            coverage = _parse_lcov(lcov_path)
            if coverage is None:
                print(f"[crucible] WARN: lcov coverage unavailable at {lcov_path}",
                      file=sys.stderr)
        resp = _ingest_parsed(project_dir, args.agent, summary, tree, coverage,
                              tier="regression", context=_run_context(),
                              run_id=run_id)
        ok = bool(resp.get("ok")) and summary["failed"] == 0
        # §S2 — a GATE run's next step is derived from the run state it reached
        # (unrecorded / red / green); the plain `regression` verb keeps its
        # canned _HELP_STEPS entry, unchanged.
        help_steps = (_axi().run_help(verb, ok, summary["failed"], CRUCIBLE_URL)
                      if verb != "regression" else None)
        _emit_ingest_axi(verb, resp, summary, files, project_dir, args.agent,
                         help_steps=help_steps, warnings=run_warnings,
                         run_id=run_id)
        return 0 if (resp.get("ok") and summary["failed"] == 0) else 1
    finally:
        _close_gate_identity(project_dir, identity)


def cmd_auto_ingest(args):
    project_dir = _resolve_project_dir(args.project_dir)
    package_dir = _resolve_package_dir(args.package_dir, project_dir)
    reports_dir = _reports_dir(package_dir, args.reports)
    junit_path = _junit_path(reports_dir)
    if not os.path.exists(junit_path):
        print(f"[crucible] no {junit_path} — nothing to ingest", file=sys.stderr)
        return 1
    summary, tree, files = _parse_junit_file(junit_path)
    resp = _ingest_parsed(project_dir, args.agent, summary, tree, tier="e2e",
                          context=_run_context())
    _emit_ingest_axi("auto-ingest", resp, summary, files, project_dir, args.agent)
    return 0 if resp.get("ok") else 1


def cmd_check(args):
    """`tsc --noEmit` typecheck gate over the package. With --agent, ingest errors."""
    project_dir = _resolve_project_dir(args.project_dir)
    state = _check_gate(args, project_dir)
    # §S2/§S13/§S15 — the typecheck gate returns the §S1 envelope (verb=check,
    # ok, exit code, help[]) on BOTH clean and error compile, not ad-hoc prints.
    legacy = f"check: ok={state['ok']} exit={state['exit']}"
    _emit_axi("check", state["ok"],
              {"exit": state["exit"], "help": _HELP_STEPS["check"]},
              _axi_context(project_dir, agent_id=args.agent), [], legacy)
    return 0 if state["ok"] else 1


def _check_gate(args, project_dir):
    """The tsc typecheck itself — CR-CRU-058 §S1: this helper NEVER emits, so
    the two envelope-owning verbs that run it (`check` standalone, and
    `pre-merge-gate`'s fail-fast step 0) each put exactly ONE document on
    stdout. Returns the measured state — `{exit, ok}` — and its caller emits."""
    package_dir = _resolve_package_dir(args.package_dir, project_dir)
    bun = _resolve_bun(args.bun)
    # Prefer the package's local tsc via `bun x tsc`; falls back to a tsc on PATH.
    cmd = [bun, "x", "tsc", "--noEmit"]
    if os.path.exists(os.path.join(package_dir, "tsconfig.json")):
        cmd += ["-p", "tsconfig.json"]
    # §S1 — stdout is the TOON AXI channel; the human-readable run echo is
    # interactive-only (stderr) so the envelope is the sole stdout content.
    print(f"[crucible] running: {' '.join(cmd)}  (cwd={package_dir})", file=sys.stderr)
    result = subprocess.run(cmd, cwd=package_dir, capture_output=True, text=True)
    print(f"[crucible] tsc exit={result.returncode}", file=sys.stderr)
    out = (result.stdout or "") + (result.stderr or "")
    ok = result.returncode == 0
    if not ok:
        sys.stderr.write(out)
        if args.agent:
            _ingest_compile(project_dir, args.agent, out)
    return {"exit": result.returncode, "ok": ok}


def cmd_pre_merge_gate(args):
    """ORCHESTRATOR pre-merge gate — the ONLY path that measures coverage (project policy:
    coverage reserved for the pre-merge gate). fail-fast `check` (tsc) → `regression
    --coverage`. A check failure aborts before the suite."""
    project_dir = _resolve_project_dir(args.project_dir)
    if not getattr(args, "skip_check", False):
        check_args = argparse.Namespace(
            agent=args.agent, bun=args.bun, package_dir=args.package_dir,
            project_dir=args.project_dir,
        )
        # The STEP form (no envelope of its own) — this gate owns stdout.
        state = _check_gate(check_args, project_dir)
        if not state["ok"]:
            # §S3 — the abort narration is interactive-only; §S2 — the state
            # reached is "aborted at step 0, the regression never ran", so the
            # next action is the type errors, never the gate's own successor.
            print("[crucible] pre-merge gate FAILED at the tsc check step — skipped the "
                  "regression. Fix type errors first (or --skip-check to bypass).",
                  file=sys.stderr)
            _emit_axi("pre-merge-gate", False,
                      {"stage": "check", "exit": state["exit"],
                       "help": _axi().gate_step_abort_help(
                           "pre-merge-gate",
                           "fix the tsc type error(s) reported on stderr "
                           "(or --skip-check to bypass)")},
                      _axi_context(project_dir, agent_id=args.agent),
                      [_axi().gate_step_abort_warning(
                          "pre-merge-gate", "tsc typecheck",
                          "the package does not typecheck")],
                      f"pre-merge-gate: ok=False exit={state['exit']} — "
                      f"aborted at the tsc check step")
            return 1
    reg_args = argparse.Namespace(
        agent=args.agent, coverage=True, reports=args.reports, bun=args.bun,
        package_dir=args.package_dir, project_dir=args.project_dir,
        log=getattr(args, "log", None), cycle=getattr(args, "cycle", None),
        # CR-CRU-017 §S4 — the gate's own opt-out decision carries into the
        # regression it runs; the step must never re-decide it.
        no_lifecycle=getattr(args, "no_lifecycle", True),
    )
    # §S1 — the regression body emits under THIS gate's verb, so the gate puts
    # exactly one envelope on stdout under the name the caller invoked.
    return cmd_regression(reg_args, verb="pre-merge-gate")


# ── CR-CRU-008 — plan verbs (plan-file / cycle-activate / cycle-done / cr-close) ──


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


def cmd_plan_file(args):
    """§S4 — file a workflow plan (CR + its cycles). CR-CRU-054 §S2b — delegates
    to the shared implementation, which owns the §S5 identity hard stop, the
    wave/title warnings and `context.cr` on BOTH the success and failure
    envelopes (DN §4 finding #2)."""
    return _axi().cmd_plan_file(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_plan_backfill(args):
    """§S2: resolve the target plan (single plan, or --cr to disambiguate) and
    PATCH its wave via S1. A wave-only PATCH body is closed-plan-safe, so the
    resolver considers ALL plans (open AND closed) — a merged plan's wave is
    exactly what a backfill corrects. Unknown/ambiguous/zero -> non-zero +
    ok=False envelope. A server PATCH failure surfaces the same way.

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
    # Wave-only body: NEVER a `status` key (S1 closed-plan-safe backfill).
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


# ── CR-CRU-030 §S4/§S7 — append-cycle + CR-024 workflow client verbs ────────


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
        spec = importlib.util.spec_from_file_location(f"{__name__}_toon", toon_path)
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
        spec = importlib.util.spec_from_file_location(f"{__name__}_axi_shared", axi_path)
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


# §S15 — per-verb next-step command TEMPLATES: every envelope names the sane
# next move (fixed disambiguating flags carried forward, runtime values as
# `<placeholders>`), so the orchestrator never loses the process thread. The
# plan-file/cycle-activate/cycle-done templates are wired inline at their call
# sites (they carry runtime-derived ids); the rest are the fixed next-step
# suggestions below.
_HELP_STEPS = {
    "register": ["test --agent <agentId>"],
    "unregister": ["status"],
    "test": ["cycle-done <id>", "status"],
    "regression": ["cycle-done <id>", "status"],
    "auto-ingest": ["cycle-done <id>", "status"],
    "check": ["test --agent <agentId>"],
    "cycle-add": ["cycle-activate <id>"],
    "checkpoint": ["status"],
    "stop": ["status"],
    "abort": ["status"],
    "status": ["cycle-activate <id>"],
    "cr-close": ["status"],
}


def _emit_ingest_axi(verb, resp, summary, files, project_dir, agent, help_steps=None,
                     warnings=None, run_id=None):
    """Emit the §S1 envelope for an ingest verb
    (test/regression/auto-ingest): run{passed,failed,pending,total,files}.
    `files` (CR-CRU-047 §S2) is the distinct test-FILE count from
    `_parse_junit_file`, a sibling of the test counts, so a suite that silently
    shrinks is visible in the gate output. CR-CRU-056 §S3 — the client RESOLVES
    no cycle: a bound agent's run is server-stamped with its registered cycle
    (a stale binding gets a 409, surfaced via `error`). C5 — the envelope
    context ECHOES the attachment the SERVER reported (`context.cycleId` on the
    ingest response), so the agent sees which cycle absorbed its evidence
    without a second `GET /api/v2/events`; absent → the key is omitted.

    CR-CRU-017 §S4 — a WRAPPED run also names the `runId` its ingest closed (so
    the caller can correlate the stored span) and carries any lifecycle
    `warnings` the run accumulated; a single-shot run adds neither key."""
    run = {"passed": summary["passed"], "failed": summary["failed"],
           "pending": summary.get("pending", 0),
           "total": summary["total"], "files": files}
    context = _axi_context(project_dir, agent_id=agent,
                           cycle_id=_axi().echoed_cycle_id(resp))
    # §S15 — the ingest envelope names the next step (mark the cycle done once
    # the run is green, else re-list the queue). CR-CRU-058 §S2 — `help_steps`
    # lets a GATE caller supply the STATE-DERIVED next step for the run it just
    # made (`_axi().run_help`); unset keeps today's behaviour exactly.
    result_fields = {"run": run, "help": help_steps or _HELP_STEPS.get(verb, ["status"])}
    if run_id:
        result_fields["runId"] = run_id
    err = resp.get("error")
    if err is not None:
        result_fields["error"] = err
    _emit_axi(verb, bool(resp.get("ok")), result_fields, context, warnings or [])


def _agent_id(args):
    """CR-CRU-044 §S5 — the agentId for a fleet event: the identity is
    DECLARED (`--agent`) or the verb FAILS. Delegates to the shared fleet
    resolver so all five clients cannot drift apart again.

    There is no fallback: the old filename-derived default
    (`"bun-crucible"`) fabricated an identity from this script's own
    filename and planted a phantom row on the dashboard agent rail, and
    $WORKFLOW_ROLE is the TRACK LANE (mainline | track-n), not an identity.
    Raises `_crucible_axi.AgentIdentityRequired`, which `main` converts into
    the ok:false hard-stop envelope + a non-zero exit, POSTing nothing."""
    return _axi().require_agent_id(args)


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
    """POST a gate event (CR-CRU-054 §S2 — delegates to the shared builder)."""
    return _axi().post_gate(_project_key(project_dir), agent_id, gate, _post,
                            context)


def _post_milestone(project_dir, agent_id, mtype, label=None, commit=None,
                    context=None, released_at=None, crs=None,
                    repair_provenance=False):
    """POST a workflow milestone (CR-CRU-054 §S2 — delegates to the shared
    builder). CR-CRU-080 §S4 — `released_at`/`crs` carry a release's
    provenance through the same builder. CR-CRU-081 §S3 —
    `repair_provenance` carries the opt-in that CORRECTS an already-recorded
    release instead of replaying it."""
    return _axi().post_milestone(_project_key(project_dir), agent_id, mtype,
                                 _post, label=label, commit=commit,
                                 context=context, released_at=released_at,
                                 crs=crs, repair_provenance=repair_provenance)


# §S8 (CR-CRU-030): gate-run is the AXI streaming standard; gate-report is
# discouraged. EVERY gate-report invocation emits this warning — in the §S1
# envelope's warnings[] AND on stderr — regardless of the POST outcome (the
# discouragement is a property of using gate-report at all).
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


def _add_project_dir_arg(p):
    p.add_argument("--project-dir",
                   help="Override project root (default: $BUN_CRUCIBLE_PROJECT_DIR, else the "
                        "git repo of CWD). The .env at the root must contain CRUCIBLE_PROJECT_KEY.")


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


def _add_no_lifecycle_arg(p):
    """CR-CRU-017 §S4 — the run-lifecycle opt-out on a RUN verb. Default off:
    a run wraps itself (run-start before the tool, ingest closing it) so the
    board learns the real wall-clock span. Set the flag — or
    $BUN_CRUCIBLE_NO_LIFECYCLE — for the unchanged single-shot ingest."""
    p.add_argument("--no-lifecycle", action="store_true",
                   help="Do NOT wrap the run in the CR-CRU-017 run lifecycle: skip "
                        "POST /api/v2/runs/start and send no runId, so the ingest is "
                        "the single-shot event it was before the lifecycle existed "
                        "(env twin: $BUN_CRUCIBLE_NO_LIFECYCLE=1).")


def _add_gate_cycle_arg(p):
    """CR-CRU-056 — bind `--cycle` on a GATED verb (CR-CRU-054 §S2 — delegates
    to the shared binding so all five clients document it identically)."""
    return _axi().add_gate_cycle_arg(p)


# §S14 — content-first: the one-line tool purpose printed by a bare invocation
# (the no-arg live dashboard), alongside the ~-abbreviated executable path.
_DASHBOARD_PURPOSE_LINE = (
    "bun-crucible.py -- Bun/TypeScript Crucible CLI "
    "(agent lifecycle, test/ingest, plan/cycle verbs)."
)


def _abbrev_home(path):
    """Render an absolute path with `~` for the home dir (§S14) — CR-CRU-054 §S2
    delegator to `_crucible_axi.abbrev_home`."""
    return _axi().abbrev_home(path)


def cmd_dashboard():
    """§S14 — a bare invocation (no args) returns the LIVE board: the §S6
    `status` dashboard envelope on stdout (the machine channel), plus a one-line
    tool purpose and the ~-abbreviated executable path on stderr (interactive) —
    NOT argparse's required-subcommand usage error."""
    print(_DASHBOARD_PURPOSE_LINE, file=sys.stderr)
    print(_abbrev_home(os.path.abspath(__file__)), file=sys.stderr)
    return cmd_status(_axi().status_namespace())


def main():
    p = argparse.ArgumentParser(prog="bun-crucible", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    # §S14 — subcommand is OPTIONAL: a bare invocation falls through to the
    # no-arg live dashboard (below), never argparse's required-subcommand error.
    sub = p.add_subparsers(dest="cmd", required=False)

    r = sub.add_parser("register",
                       help="Register / heartbeat an agent. TDD roles must bind a "
                            "cycle with --cycle.")
    # CR-CRU-054 §S2b (DN §4 finding #3) — NOT argparse-required: the §S5
    # runtime hard stop owns the refusal so it arrives as a structured envelope.
    r.add_argument("--agent",
                   help="Agent id — a free-form identifier. REQUIRED, but enforced at "
                        "RUNTIME by the §S5 hard stop (CR-CRU-054 §S2b) so a missing "
                        "id yields the ok:false AXI envelope, not a bare argparse "
                        "usage error. "
                                                "Agent id — a free-form identifier. The role is declared by "
                        "--role and is never inferred from the agentId's shape; any "
                        "`CR-<PROJ>-NNN-<cycle>-<ROLE>` convention is a naming habit only.")
    # CR-CRU-044 §S3 — role is first-class DATA: --role is REQUIRED and
    # enum-constrained (this supersedes CR-CRU-008 §S2's `default="report"`
    # ergonomics; pass `--role report` for a non-TDD registration).
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
                   choices=["claude-md", "package-json", "git-repo", "manual"])
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

    t = sub.add_parser("test", help="Targeted/whole-suite `bun test` → junit → ingest.")
    t.add_argument("--tests", nargs="+",
                   help="Test file/path target(s) (e.g. src/tools/send.test.ts). Omit for all.")
    t.add_argument("--agent", help="If set, ingest the junit result after the run")
    _add_gate_cycle_arg(t)
    _add_reports_arg(t)
    _add_bun_arg(t)
    _add_package_dir_arg(t)
    _add_project_dir_arg(t)
    _add_log_arg(t)
    _add_no_lifecycle_arg(t)
    t.set_defaults(func=cmd_test)

    g = sub.add_parser("regression", help="Full-suite `bun test` + ingest. --coverage for lcov.")
    g.add_argument("--agent", required=True, help="Agent id (typically the orchestrator)")
    g.add_argument("--coverage", action="store_true",
                   help="Run with bun lcov coverage and post /api/v2/runs/parsed with coverage")
    _add_gate_cycle_arg(g)
    _add_reports_arg(g)
    _add_bun_arg(g)
    _add_package_dir_arg(g)
    _add_project_dir_arg(g)
    _add_log_arg(g)
    _add_no_lifecycle_arg(g)
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
    _add_gate_cycle_arg(pmg)
    _add_reports_arg(pmg)
    _add_bun_arg(pmg)
    _add_package_dir_arg(pmg)
    _add_project_dir_arg(pmg)
    _add_log_arg(pmg)
    _add_no_lifecycle_arg(pmg)
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
                    help="Wave number (§S3). Resolution: --wave > $WORKFLOW_WAVE; "
                         "neither -> filed wave-less (no hard block).")
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

    # ── CR-CRU-030 §S4/§S7 — append-cycle + CR-024 workflow verbs ──
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

    st = sub.add_parser("stop",
                        help="Stop the project — checkpoint every open plan "
                             "(POST …/projects/<key>/stop). "
                             "Requires --agent <registered id> (§S2b).")
    _add_workflow_agent_arg(st)
    _add_project_dir_arg(st)
    st.set_defaults(func=cmd_stop)

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

    # ── CR-CRU-030 §S6 — the plan/status READ verb (alias `plans`, no --agent) ──
    for _name in ("status", "plans"):
        sv = sub.add_parser(_name,
                            help="Read the plan queue (GET …/plans) as a TOON-AXI table "
                                 "+ lastRunCr. Read-only; `plans` is an alias of `status`.")
        sv.add_argument("--fields",
                        help="Comma-separated EXTRA columns to add to the minimal "
                             "cr,wave,status,activeCycleId set (§S10), e.g. "
                             "activeCycleLabel,mergeCommit.")
        _add_project_dir_arg(sv)
        sv.set_defaults(func=cmd_status)

    # ── CR-CRU-081 §S2 — the landing-record READ verb (no --agent) ──
    qv = sub.add_parser("queue",
                        help="Read the registered CR queue (GET …/queue) plus the "
                             "cr-merged milestone ids as a TOON-AXI table. Read-only.")
    _add_project_dir_arg(qv)
    qv.set_defaults(func=cmd_queue)

    # ── CR-CRU-013 §S5 — fleet gate / milestone verbs ──
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
