#!/usr/bin/env python3
# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Python + unittest Crucible CLI — single entry point for orchestrator + RED/GREEN/
FIX/VERIFY agent lifecycle ops AND for running Python test targets (unittest through
Crucible's own runner, which streams the run as Crucible events; optional
coverage.py). Replaces inline python / loose curl so each invocation has a stable
command signature.

Modelled exactly on bun-crucible.py / rust-crucible.py (same agent lifecycle,
.env project-key resolution, /api/v2/* ingest contract, and — CR-CRU-030 §S1/§S2 —
the shared TOON-AXI envelope module clients/_crucible_axi.py) — only the toolchain
differs: Cargo/nextest/llvm-cov or bun test → a venv Python interpreter +
clients/subtest_runner.py (stdlib unittest) + coverage.py, with py_compile as the
syntax gate.

This script is tool-specific (unittest streamed by default, or pytest when the
project's `[python] runner` or --runner chooses it / JUnit-XML / coverage.py), not
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
  test                  Run a TARGETED test (dotted path) or discover. Under unittest
                        the runner writes its event stream to
                        <reports>/crucible-events.ndjson (CRUCIBLE_STREAM), the relay
                        sends it to the open run while it works, and the run is
                        closed with codec crucible-events; under pytest every JUnit
                        report is sent inline. No tier claimed. The per-cycle
                        RED/GREEN workhorse. The reports dir is wiped first so only
                        THIS run's record is ingested. If --agent omitted, just runs
                        (exit code only). If the runner exits non-zero having written
                        no test (import/collection failure), the CAPTURED runner
                        output is ingested to /api/v2/runs/compile.
  regression            Run the FULL suite (discover; tier regression), streamed as
                        `test` is. With --coverage (coverage.py) the `coverage lcov`
                        report travels with the close, for the board to decode.
                        Orchestrator pre-merge gate path.
  auto-ingest           Ingest only: send an already-produced reports dir's JUnit
                        reports to /api/v2/runs.
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
  (if present) > the interpreter running this script. The unittest runner needs
  only the standard library (Python 3.12 or later); the pytest runner needs pytest
  (and, for --coverage, coverage.py) plus any imports the code-under-test needs.
  Posts to the board the project's `crucible.toml` declares (`[client] url`,
  shipped default http://localhost:3849), v2 endpoints ONLY:
  /api/v2/agents/register|unregister, /api/v2/runs, /api/v2/runs/compile,
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
import contextlib
import glob
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib

DEFAULT_REPORTS = "test-reports"
# The STACK this client's runs belong to — the server's own `{tier, stack,
# context}` field (`src/v2.ts`). CR-CRU-112 AC5, measured at cycle 388's RED:
# this client sent NO stack key at all, so nothing this project had ever
# ingested from its python suite was attributable to it.
_STACK = "python"


def _resolve_project_dir(arg_value):
    """Resolution order: --project-dir > $PY_CRUCIBLE_PROJECT_DIR > git repo of CWD > CWD.

    No project is hardcoded. The `.env` holding CRUCIBLE_PROJECT_KEY must live at that
    resolved root.

    CR-CRU-131 §S1b — the resolved root is BOUND into the shared module, which reads
    this project's `crucible.toml` beside that `.env` for the three display limits.
    Bound HERE, on the client's own boot path, because project-dir resolution stays
    client-specific and the shared module takes it ALREADY RESOLVED.
    """
    if arg_value:
        root = arg_value
    elif (env_value := os.environ.get("PY_CRUCIBLE_PROJECT_DIR")):
        root = env_value
    else:
        r = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True
        )
        root = (r.stdout.strip() if r.returncode == 0 and r.stdout.strip()
                else os.getcwd())
    root = os.path.abspath(root)
    _axi().bind_project_dir(root)
    return root


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
    key = _read_env(project_dir).get("CRUCIBLE_PROJECT_KEY", "").strip()
    if not key:  # an empty or whitespace-only key is a missing one
        sys.exit(f"[crucible] ERROR: CRUCIBLE_PROJECT_KEY not found in {project_dir}/.env")
    return key


def _resolve_python(arg_value, project_dir):
    """--python > $PY_CRUCIBLE_PYTHON > <project-dir>/.venv/bin/python > this interpreter.

    The chosen interpreter runs the stdlib unittest runner (pytest needs pytest
    importable; coverage.py for --coverage). A project venv is the norm so test-only deps never touch the runtime.
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


# The runners a project's tests can run under, and the one that runs when
# neither the project nor the call chooses.
_UNITTEST = "unittest"
_PYTEST = "pytest"
_RUNNERS = (_UNITTEST, _PYTEST)
_RUNNER_FLAG = "--runner"
_PYTHON_TABLE = "python"
_RUNNER_FIELD = "runner"


class RunnerRefused(Exception):
    """A runner that cannot be run: a value that is neither runner's name, or
    `pytest` with an interpreter that cannot import it. The message names the
    value and where it came from, or the interpreter and that it needs pytest.

    Deliberately NOT an `OSError`/`ValueError`: the shared dispatch turns
    those into a failed verb and lets a gate record its outcome on the board,
    while a refused runner has run nothing and must post nothing; `main`
    emits its envelope instead."""


def _declared_runner(project_dir):
    """`(value, path)` \u2014 `[python] runner` as the PROJECT's own
    `crucible.toml` states it, or `(None, path)` when it declares none. Never
    the install's file: an install-wide runner would make one project
    everyone's default. A file that is absent or does not parse declares
    nothing."""
    path = os.path.join(project_dir, "crucible.toml")
    try:
        with open(path, "rb") as fh:
            parsed = tomllib.load(fh)
    except (OSError, ValueError):
        return None, path
    table = parsed.get(_PYTHON_TABLE)
    if not isinstance(table, dict) or _RUNNER_FIELD not in table:
        return None, path
    return table[_RUNNER_FIELD], path


def _resolve_runner(args, project_dir):
    """--runner > `[python] runner` in the project's own crucible.toml >
    unittest. A valid flag wins and the declaration is not consulted.

    Raises `RunnerRefused` for a value that is neither runner's name, and for
    `pytest` with an interpreter that cannot import it."""
    flag = getattr(args, "runner", None)
    if flag is not None:
        value, source = flag, f"`{_RUNNER_FLAG}`"
    else:
        value, path = _declared_runner(project_dir)
        source = f"`[{_PYTHON_TABLE}] {_RUNNER_FIELD}` in {path}"
    if value is None:
        return _UNITTEST
    if value not in _RUNNERS:
        raise RunnerRefused(
            f"{source} is {value!r}, which is not a runner this client runs; "
            f"choose one of {', '.join(_RUNNERS)}")
    if value == _PYTEST:
        python = _resolve_python(getattr(args, "python", None), project_dir)
        if not _imports_pytest(python, project_dir):
            raise RunnerRefused(
                f"the runner is {_PYTEST} (from {source}), but the interpreter "
                f"{python} cannot import {_PYTEST}; install {_PYTEST} into it, "
                f"or choose another interpreter with --python")
    return value


# How long the pytest import probe may take before the interpreter is refused.
_PYTEST_PROBE_TIMEOUT_S = 60


def _imports_pytest(python, project_dir):
    """Whether `python` can import pytest. An interpreter that cannot be
    started at all cannot import it either. A probe that does not answer
    within `_PYTEST_PROBE_TIMEOUT_S` is refused, naming the interpreter."""
    try:
        probe = subprocess.run([python, "-c", f"import {_PYTEST}"],
                               cwd=project_dir, capture_output=True, text=True,
                               check=False, timeout=_PYTEST_PROBE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        raise RunnerRefused(
            f"the runner is {_PYTEST}, but the interpreter {python} did not "
            f"answer whether it can import {_PYTEST} within "
            f"{_PYTEST_PROBE_TIMEOUT_S}s; check that interpreter, or choose "
            f"another with --python") from None
    except OSError:
        return False
    return probe.returncode == 0


# ── HTTP transport seam (mocked in-process by the client test harnesses) ────


def _base_url():
    """CR-CRU-139 §S2 — the BOARD this client posts to, read at the POINT OF
    USE from the fleet's ONE resolver: the project's own `crucible.toml`
    (`[client] url`), else the install's, else the distribution's shipped
    declaration.

    A call rather than the module constant this line used to hold. A constant
    bound at import was a setting no edit an operator made could reach, and it
    froze the board for the whole process — so a verb handed a different
    `--project-dir` posted to the previous one's board. `resolve_base_url()` in
    `_crucible_axi.py` documents the resolution and the environment channel it
    retired."""
    return _axi().resolve_base_url()


def _request(method, path, payload=None, timeout=None):
    """JSON request to Crucible. Returns parsed JSON, or {ok:False,error} on HTTP/conn error.

    CR-CRU-035 §S1 — `timeout=None` (the default) is UNBOUNDED: ingest POSTs
    (`/api/v2/runs`) for a large regression/coverage run can legitimately
    take the server >10s, and a short bound there is a false-negative. The short
    hook-safe bound is applied ONLY on the status/plans read path via `_get`.

    CR-CRU-054 §S2 — a thin delegator to the fleet's ONE transport,
    `_crucible_axi.http_request`, which documents the full contract (including
    the §S2b empty-body correction). The local name is kept deliberately: the
    CR-CRU-030 delegation pattern, addressed unqualified by every call site
    here and by the client test harnesses."""
    return _axi().http_request(_base_url(), method, path, payload, timeout)


def _post(path, payload, timeout=None):
    return _request("POST", path, payload, timeout=timeout)


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
# The `--reports` help every running verb carries: the shared per-agent rule.
_REPORTS_HELP = _axi().REPORTS_HELP


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
        base_url=_base_url())


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


def _run_logged(cmd, cwd, env, log_path, narrator=None):
    """Run `cmd` on the shared run path (`run_streamed`): the combined
    stdout+stderr streams live to STDERR (the machine stdout channel stays the
    TOON-AXI envelope) and to `log_path` while the runner works, the optional
    `narrator` observes every line, and the output is ALWAYS captured (the
    no-XML compile fallback needs the real runner output). Returns
    CompletedProcess (`.stdout` holds the capture)."""
    return _axi().run_streamed(cmd, cwd, env, log_path, narrator, capture=True)


# unittest's verbose (`-v`) verdict for one finished test: the line ends
# `<description> ... <verdict>` (maybe followed by ` (<elapsed>s)`), or the
# verdict starts its own line when the test printed after the ` ... `.
_UNITTEST_VERDICT_LINE = re.compile(
    r"(?:\s\.\.\.\s+|^)"
    r"(?:ok|FAIL|ERROR|expected failure|unexpected success|skip(?:ped)?)"
    r"(?: \(\d+(?:\.\d+)?s\)| '.*')?\s*$")


def _recognise_completion(line):
    """python's half of the shared narration: one unittest verbose verdict
    line is one completed test. unittest states its total only once the run
    (and its JUnit XML) is written, so the narration carries no denominator."""
    return _UNITTEST_VERDICT_LINE.search(line.rstrip("\r\n")) is not None


def _narrator(project_dir, agent_id, identity=None, runner=None, streamed=False):
    """This client's `RunNarrator`: python's recogniser, an unknown total
    (`running N`, then `ran N/N`), and the shared role-optional heartbeat
    tick (`narration_poster`), observed by a gated `identity` when there is one.
    Under pytest the recogniser is pytest's, against the total it selected.
    A `streamed` run counts nothing in flight (the board shows its stream's
    count): its narrator only says the closing messages."""
    post = _axi().narration_poster(_post, _project_key(project_dir), agent_id,
                                   identity)
    if streamed:
        return _axi().RunNarrator(post, lambda _line: False)
    if runner == _PYTEST:
        progress = _PytestProgress()
        return _axi().RunNarrator(post, progress.recognise,
                                  total=lambda: progress.selected)
    return _axi().RunNarrator(post, _recognise_completion)


# pytest's `-v` lines: the line ending collection (`collected N items`, maybe
# `/ D deselected / S selected`, maybe after `collecting ... `), and one verdict
# line per finished test (`<nodeid> PASSED [ 33%]`). A subtest's `SUB...`
# verdict and the short summary's `FAILED <nodeid> - ...` are no finished test.
_PYTEST_COLLECTED_LINE = re.compile(
    r"^(?:collecting \.\.\. )?collected (\d+) items?\b(.*)$")
_PYTEST_SELECTED = re.compile(r"/ (\d+) selected\b")
_PYTEST_VERDICT_LINE = re.compile(
    r"^\S+::\S+.*\s(?:PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)(?:\s|$)")


class _PytestProgress:
    """pytest's half of the shared narration: reads the selected total from
    the line ending collection and counts one completion per verdict line."""

    def __init__(self):
        self.selected = 0

    def recognise(self, line):
        """True when `line` is one finished test; records the selected total."""
        text = line.rstrip("\r\n")
        collected = _PYTEST_COLLECTED_LINE.match(text)
        if collected:
            stated = _PYTEST_SELECTED.search(collected.group(2))
            self.selected = int(stated.group(1) if stated else collected.group(1))
            return False
        return _PYTEST_VERDICT_LINE.match(text) is not None


# pytest's report of a passing subtest: a `SUBPASSED` verdict line, or the
# closing summary's `N subtests passed`.
_PYTEST_SUBTESTS_PASSED = re.compile(r"\sSUBPASSED\b|\b[1-9]\d* subtests? passed\b")

_PYTEST_SUBTESTS_DETAIL = ("pytest writes no test case for a passing subtest "
                           "in its JUnit report, so passing subtests were not "
                           "counted")


class _FallbackWatch:
    """Watches the runner's output for a sign that passing subtests went
    uncounted, passing every line on to the run's narrator (if any). Only
    pytest can leave them uncounted: any report of a passing subtest, read
    through the whole output. What it saw rides every envelope the run
    produces as one `subtests-uncounted` warning. A unittest run counts every
    subtest (its runner is Crucible's own), so it never warns."""

    def __init__(self, narrator=None, runner=None):
        self._narrator = narrator
        self._pytest = runner == _PYTEST
        self._watching = True

    def observe(self, line):
        """Feed one line of the runner's output."""
        if (self._watching and self._pytest
                and _PYTEST_SUBTESTS_PASSED.search(line)):
            self._watching = False
        if self._narrator is not None:
            self._narrator.observe(line)

    def warnings(self):
        """`[{code: subtests-uncounted, detail}]` when passing subtests went
        uncounted, else `[]`."""
        if not self._pytest or self._watching:
            return []
        return [{"code": "subtests-uncounted",
                 "detail": _PYTEST_SUBTESTS_DETAIL}]


def _start_run(project_dir, agent_id, tier=None, context=None, release=None):
    """Open the run BEFORE the runner is spawned, through the shared
    `open_run`. Returns `(run_id, warnings)`; a refusal degrades to a
    single-shot ingest with a warning naming the fallback."""
    return _axi().open_run(_post, _project_key(project_dir), agent_id, _STACK,
                           tier=tier, context=context, release=release)


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


def _emit_ingest_axi(verb, resp, project_dir, agent, help_steps=None,
                     warnings=None):
    """Emit the envelope of an ingest verb through the shared run emitter,
    `emit_run_axi`: its `run:` block, `help` (a gate caller's state-derived
    `help_steps`, else the verb's `HELP_STEPS` entry), the answer's `error`
    and `warnings[]` after the caller's `warnings` (the run's pre-flight
    finding among them). The context echoes the cycle the board attached the
    run to."""
    return _axi().emit_run_axi(
        verb, resp,
        _axi_context(project_dir, agent_id=agent,
                     cycle_id=_axi().echoed_cycle_id(resp)),
        _emit_axi, ok=None, help_steps=help_steps, warnings=warnings,
        fields={}, coverage=False)


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


# ── Toolchain: unittest/pytest test + regression + auto-ingest + check ──────


def _reports_dir(project_dir, arg_value, agent_id=None):
    """The run's reports dir (the shared rule, `run_reports_dir`)."""
    return _axi().run_reports_dir(project_dir, arg_value, agent_id)


def _wipe(reports_dir):
    """Remove stale TEST-*.xml and a stale stream file, so only the current
    run's results get ingested."""
    if os.path.isdir(reports_dir):
        for entry in os.listdir(reports_dir):
            if entry == STREAM_FILE or (entry.startswith("TEST-")
                                        and entry.endswith(".xml")):
                with contextlib.suppress(OSError):
                    os.remove(os.path.join(reports_dir, entry))


def _subtest_runner_path():
    """The sibling clients/subtest_runner.py: unittest with every subtest
    counted, streaming the run to the file `CRUCIBLE_STREAM` names."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "subtest_runner.py")


# unittest discovery's selection when the caller states none. pytest has no
# such default here: unstated, the project's own pytest configuration decides.
_UNITTEST_START_DIR = "tests"
_UNITTEST_PATTERN = "test_*.py"


def _runner_args(targets, start_dir, pattern):
    """The runner's arguments, unittest's own: targeted (dotted paths) or
    discover, an unstated start dir or pattern taking unittest's defaults.
    `-v` makes unittest print one verdict line per test."""
    if targets:
        return list(targets) + ["-v"]
    return ["discover", "-s", start_dir or _UNITTEST_START_DIR,
            "-p", pattern or _UNITTEST_PATTERN, "-v"]


def _unittest_cmd(python, targets, start_dir, pattern):
    """Build the suite invocation: the project's interpreter running the
    subtest runner by path, with unittest's arguments."""
    return [python, _subtest_runner_path(),
            *_runner_args(targets, start_dir, pattern)]


def _pytest_args(targets, start_dir, pattern, reports_dir):
    """pytest's arguments: verbose, a JUnit report in the reports dir in the
    xunit1 family (the one that stamps `file=` on each test case) with its
    suite name pinned to `pytest` (the board groups such a suite's cases by
    module, whatever the project's own configuration names it), and what to
    run. Node ids given, they alone are passed, as unittest's dotted paths
    are; otherwise a stated start dir is the path pytest is given and a
    stated pattern its `python_files`, and whatever is unstated is left to the
    project's own pytest configuration."""
    args = ["-v", "-o", "junit_family=xunit1", "-o", "junit_suite_name=pytest",
            f"--junitxml={os.path.join(reports_dir, 'TEST-pytest.xml')}"]
    if targets:
        return args + list(targets)
    if pattern:
        args += ["-o", f"python_files={pattern}"]
    if start_dir:
        args.append(start_dir)
    return args


def _suite_cmd(python, runner, targets, start_dir, pattern, reports_dir):
    """The suite invocation under the chosen runner."""
    if runner == _PYTEST:
        return [python, "-m", _PYTEST,
                *_pytest_args(targets, start_dir, pattern, reports_dir)]
    return _unittest_cmd(python, targets, start_dir, pattern)


def _report_paths(reports_dir):
    """Every TEST-*.xml report in `reports_dir`, in sorted path order: the
    reports a run sends to the board, which decodes them; this client parses
    none of them."""
    return sorted(glob.glob(os.path.join(reports_dir, "TEST-*.xml")))


def _produced_xml(reports_dir):
    return os.path.isdir(reports_dir) and any(
        e.startswith("TEST-") and e.endswith(".xml") for e in os.listdir(reports_dir)
    )


def _no_xml_errors_text(result, runner=_UNITTEST):
    """The REAL captured runner output for the no-XML compile fallback — never the
    empty string /api/v2/runs/compile 400s on."""
    out = (result.stdout or "").strip() if hasattr(result, "stdout") else ""
    if out:
        return out
    if runner == _PYTEST:
        return (f"{_PYTEST} produced no JUnit XML "
                f"(collection/usage failure, no output captured)")
    return (f"{_UNITTEST} wrote no event stream ({STREAM_FILE}) "
            f"(import/syntax failure, no output captured)")


def _runner_label(runner):
    """The name the printed text gives the runner that ran."""
    return _PYTEST if runner == _PYTEST else _UNITTEST


def _no_report_artifact(runner):
    """What the runner writes as its record: pytest's JUnit reports, or the
    unittest runner's event stream."""
    return "TEST-*.xml" if runner == _PYTEST else STREAM_FILE


# pytest's exit codes for a run it could not carry out as a runner: an
# internal error (3) and a usage error (4: a node id it cannot find, a
# conftest it cannot load). Whatever JUnit it wrote then is no test result.
_PYTEST_RUNNER_FAILURES = (3, 4)

# pytest's own report of why it failed as a runner (under `-v` it may follow
# the `collecting ... ` it printed on the same line).
_PYTEST_ERROR_LINE = re.compile(
    r"^(?:collecting \.\.\. )?"
    r"(?P<error>(?:ERROR:|INTERNALERROR|ImportError while loading conftest).*)")


def _pytest_failed_as_runner(runner, result):
    """Whether pytest exited as a runner that failed, not with a result."""
    return runner == _PYTEST and result.returncode in _PYTEST_RUNNER_FAILURES


def _pytest_error_line(output):
    """pytest's own error line in its captured output (the last one), or
    None when it printed none."""
    found = [m.group("error").strip()
             for m in map(_PYTEST_ERROR_LINE.match, (output or "").splitlines())
             if m]
    return found[-1] if found else None


def _no_report_subject(verb, runner):
    """What a no-report detail says produced no report: the verb, and under
    pytest the runner too."""
    return f"{verb} under {_PYTEST}" if runner == _PYTEST else verb


def _no_report_warning(verb, runner, result):
    """The shared no-report warning for a run that produced no report to
    file. Under pytest it names pytest and carries pytest's own error line."""
    cause = _pytest_error_line(result.stdout) if runner == _PYTEST else None
    return _axi().no_report_warning(_no_report_subject(verb, runner),
                                    _no_report_artifact(runner),
                                    result.returncode, result.stdout or "",
                                    cause=cause)


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


JUNIT_CODEC = "junit"
LCOV_CODEC = "lcov"
# CR-CRU-224 §S3 — a unittest run's record is its runner's event stream: the
# runner writes it to `<reports dir>/crucible-events.ndjson`, named through
# `CRUCIBLE_STREAM`, and the shared relay sends it to the open run.
STREAM_CODEC = "crucible-events"
STREAM_FILE = "crucible-events.ndjson"
STREAM_VAR = "CRUCIBLE_STREAM"
# How long the relay's `finish` may take once the runner exited, and once a
# signal interrupted the run.
_STREAM_FINISH_SECONDS = 60.0
_INTERRUPTED_FINISH_SECONDS = 5.0


def _file_reports(project_dir, agent_id, report_paths, *, raw=None,
                  coverage_paths=(), tier=None, context=None, run_id=None,
                  release=None, runner_exit=None):
    """Send a run's JUnit reports to the board for it to decode: the shared
    `ingest_reports`, which reads the board's health first and, unless it
    refuses, makes ONE `POST /api/v2/runs` carrying `codec: "junit"`, every
    report's text inline, the lcov coverage report when one is given, `raw`
    and `runnerExit`. This client parses none of them. Returns the board's
    answer. The stack rides on the body through the shared ingest."""
    return _axi().ingest_reports(
        _post, _get, stack=_STACK, project_key=_project_key(project_dir),
        agent_id=agent_id, codec=JUNIT_CODEC, report_paths=report_paths,
        raw=raw, coverage_codec=LCOV_CODEC if coverage_paths else None,
        coverage_paths=coverage_paths, tier=tier, context=context,
        run_id=run_id, release=release, runner_exit=runner_exit)


def _ingest_compile(project_dir, agent_id, errors_text, run_id=None, release=None,
                    cycle_id=None):
    """Ingest a syntax/collection failure to /api/v2/runs/compile (with run context).

    CR-CRU-111 AC13a — no COMPILE ingest carries a test tier, so this helper takes
    none: it is the shape `arduino-crucible.py:_ingest_compile` already had, and the
    only way to keep a build event out of the board's test-tier record for good.
    `run_id` is the OPEN run this ingest closes, as on the parsed ingest.
    `cycle_id` is a `--cycle` the result is filed under."""
    payload = {
        "projectKey": _project_key(project_dir),
        "format": "python",
        "errors": errors_text,
        "agentId": agent_id,
    }
    context = _axi().cycle_context(_run_context(), cycle_id)
    if context:
        payload["context"] = context
    if run_id:
        payload["runId"] = run_id
    resp = _axi().post_ingest(_post, "/api/v2/runs/compile", payload, stack=_STACK,
                              release=release)
    print(f"ingest compile (python): ok={resp.get('ok')}"
          + (f" error={resp['error']}" if resp.get("error") else ""),
          file=sys.stderr)
    return 0 if resp.get("ok") else 1


def _collect_coverage(python, project_dir, env, data_file=None):
    """Run `coverage lcov` and return the path of the lcov report it wrote,
    which the run sends for the board to decode; the client sums nothing.
    Returns None if coverage.py or the lcov output is unavailable.

    `data_file` is where the run wrote coverage.py's data when it reported
    into the agent's own directory; the lcov is derived beside it. Absent, the
    data file and the lcov keep their project-root locations."""
    if data_file:
        lcov_path = os.path.join(os.path.dirname(data_file), "coverage.lcov")
        lcov_cmd = [python, "-m", "coverage", "lcov", f"--data-file={data_file}",
                    "-o", lcov_path]
    else:
        lcov_path = os.path.join(project_dir, "coverage.lcov")
        lcov_cmd = [python, "-m", "coverage", "lcov", "-o", lcov_path]
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
    # not specific to this client. `python -P` would defend against it, and the
    # 3.14 floor makes that flag available, but adopting it is a separate
    # decision — deliberately left unguarded.
    cov_env = dict(env)
    r = subprocess.run(lcov_cmd,
                       cwd=project_dir, env=cov_env, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(lcov_path):
        print(f"[crucible] WARN: coverage lcov unavailable ({r.stderr.strip()[:120]})",
              file=sys.stderr)
        return None
    return lcov_path


# Read in the run's interpreter (the client never imports coverage.py itself):
# coverage.py's own effective config, from the same files and environment
# `coverage run` reads, answering whether the project declares what to measure.
_COVERAGE_SOURCE_PROBE = (
    "import json\n"
    "import coverage\n"
    "cfg = coverage.Coverage().config\n"
    "declared = (cfg.source, cfg.source_pkgs,\n"
    "            getattr(cfg, 'source_dirs', None), cfg.run_include)\n"
    "print(json.dumps(any(bool(v) for v in declared)))\n"
)

# Erases the data file the run will write and every suffixed parallel file
# beside it, whether or not the config is parallel. argv[1], when given, is the
# run's own `--data-file`; otherwise coverage.py resolves the data file.
_COVERAGE_ERASE_PROBE = (
    "import sys\n"
    "import coverage\n"
    "data_file = sys.argv[1] if len(sys.argv) > 1 else "
    "coverage.Coverage().config.data_file\n"
    "coverage.CoverageData(basename=data_file).erase(parallel=True)\n"
)

_COVERAGE_PROBE_TIMEOUT = 120

_UNDECLARED_SOURCE_DETAIL = (
    "the project's coverage configuration declares no source, so the project "
    "root was measured; declare one under [tool.coverage.run] source (or "
    "source_pkgs / include), or pass --cov-source")


def _run_coverage_probe(python, project_dir, env, script, *argv):
    """Run a coverage.py probe in the run's interpreter, cwd and environment.
    Silent: it announces no `[crucible] running:` line and prints nothing.
    Returns `(stdout, cause)`: `cause` is None on success, else one line
    naming why the probe failed -- the type of the error raised (the last line
    of the probe's traceback, or the client's own `TimeoutExpired`/`OSError`),
    never the probe's source."""
    try:
        r = subprocess.run([python, "-c", script, *argv], cwd=project_dir,
                           env=env, capture_output=True, text=True,
                           timeout=_COVERAGE_PROBE_TIMEOUT)
    except subprocess.TimeoutExpired as exc:
        return "", f"TimeoutExpired: no answer within {exc.timeout}s"
    except OSError as exc:
        return "", f"{type(exc).__name__}: {exc}"
    if r.returncode != 0:
        lines = [line.strip() for line in (r.stderr or "").splitlines()
                 if line.strip()]
        return r.stdout, lines[-1] if lines else f"exit {r.returncode}"
    return r.stdout, None


def _coverage_source_declared(python, project_dir, env):
    """Whether the project's coverage.py configuration declares what to
    measure (`source`, `source_pkgs`, `source_dirs` or `include`). A config
    that cannot be read (no coverage.py, a failed read, unreadable output)
    counts as declared, so the run passes no `--source` and fails, if it
    must, for its own cause."""
    stdout, cause = _run_coverage_probe(python, project_dir, env,
                                        _COVERAGE_SOURCE_PROBE)
    if cause is not None:
        print(f"[crucible] coverage config not read ({cause}); passing no "
              f"--source", file=sys.stderr)
        return True
    try:
        declared = json.loads(stdout.strip())
    except ValueError:
        return True
    return declared if isinstance(declared, bool) else True


def _erase_coverage_data(python, project_dir, env, data_file=None):
    """Erase an earlier run's coverage data for the data file this run writes,
    suffixed parallel files included, so the report-time combine folds in
    only this run's data. A failed erase never fails the run."""
    _stdout, cause = _run_coverage_probe(
        python, project_dir, env, _COVERAGE_ERASE_PROBE,
        *([data_file] if data_file else []))
    if cause is not None:
        print(f"[crucible] coverage erase skipped ({cause}); earlier data not "
              f"erased", file=sys.stderr)


def cmd_test(args, tier=None, verb="test"):
    """Targeted/discover unittest (streamed) or pytest (JUnit XML) → /api/v2/runs.
    With --agent the result is ingested (regardless of pass/fail); a bound agent's
    run is server-stamped with its registered cycle. Exit code reflects the runner.

    CR-CRU-111 §S2/AC3 — `tier` is the tier the CALLER stated, and the only caller
    that can state one is a §S1 tier VERB, which passes it here as a parameter the
    way mvn's `unit`/`module` pass theirs to `_run_surefire_tier`. There is no
    `--tier` flag (AC11 retires the one CR-CRU-008's contract named). A dotted path
    says nothing about the dependency that target takes, so absent a stated tier
    this run claims none: the `tier` key is ABSENT from the ingest body and the
    server applies its own documented default.

    §S6 ruling 1 — python's declaration surface IS this invocation, so a tier
    verb whose `--start-dir`/`--pattern` the caller stated runs THIS body under
    that tier, and `verb` names the envelope the run belongs to (the tier the
    caller invoked), exactly as the gate verbs elsewhere pass theirs.

    `--cycle` binds the run the way `cmd_regression` binds its own: an
    opening heartbeat DECLARES the run's identity under the cycle, and the
    closing anti-ghost cleanup fires ONLY for an identity this run created.
    Without `--agent` nothing is opened, so nothing is posted."""
    project_dir = _resolve_project_dir(args.project_dir)
    # The runner is chosen, and refused, before anything reaches the board.
    runner = _resolve_runner(args, project_dir)
    with _axi().gated_run(project_dir, args.agent,
                          getattr(args, "cycle", None),
                          "gated test run starting",
                          open_fn=_open_gate_identity,
                          close_fn=_close_gate_identity) as identity:
        return _test_run(args, tier, verb, project_dir, identity, runner)


def _test_run(args, tier, verb, project_dir, identity, runner=_UNITTEST):
    """`cmd_test`'s run body, inside its gated-identity bracket."""
    python = _resolve_python(args.python, project_dir)
    reports_dir = _reports_dir(project_dir, args.reports, args.agent)
    os.makedirs(reports_dir, exist_ok=True)
    _wipe(reports_dir)

    cmd = _suite_cmd(python, runner, getattr(args, "tests", None), args.start_dir,
                     args.pattern, reports_dir)
    env = os.environ.copy()
    # Only a streamed run hands its runner a stream (`_streamed_run`).
    env.pop(STREAM_VAR, None)
    # §S1 — the release this run is filed under (None: a cycle's run).
    release = getattr(args, "release", None)
    # CR-CRU-094 §S3 — PRE-FLIGHT, before the runner spawns and while `--cycle`
    # can still be supplied: ask the board whether this agent is bound and say
    # so on both channels if it is not. Best-effort — a failed lookup warns
    # about nothing and never delays the run. One implementation, shared.
    preflight_warnings = _axi().preflight_cycle_warnings(
        _get, _project_key(project_dir), args.agent,
        cycle_id=getattr(args, "cycle", None),
        context=_run_context(), release=release)
    print(f"[crucible] running: {' '.join(cmd)}", file=sys.stderr)
    if args.agent and runner == _UNITTEST:
        # CR-CRU-224 §S3 — a unittest run's record is its runner's stream.
        return _streamed_run(verb, args, project_dir, args.agent, identity,
                             cmd, env, reports_dir=reports_dir, tier=tier,
                             release=release, warnings=preflight_warnings,
                             measure_wall=True)
    narrator, run_id = None, None
    if args.agent:
        # The shared run path: narrate per-test progress, and open the run
        # BEFORE the runner is spawned so the board shows it running.
        narrator = _narrator(project_dir, args.agent, identity, runner)
        run_id, run_warnings = _start_run(project_dir, args.agent, tier=tier,
                                          context=_run_context(),
                                          release=release)
        preflight_warnings = list(preflight_warnings) + run_warnings
    # CR-CRU-111 §S4/AC6b — the ONE child this verb spawns, bracketed: the day
    # this project declares a `unit` start-dir, that cell runs THIS body and a
    # run of it that spends its wall clock waiting says so in its own envelope.
    # The shared check is scoped to `unit` by the tier it is handed, so an
    # untiered targeted run measures and warns about nothing.
    # A signal while the run is open is trapped and the open run disclosed.
    # The runner's fallback line, once seen, rides every envelope below.
    watch = _FallbackWatch(narrator, runner)
    try:
        with _axi().ChildRunTiming() as timing, _axi().abandon_trap(run_id):
            result = _run_logged(cmd, project_dir, env,
                                 getattr(args, "log", None), watch)
    except _axi().RunAbandoned as abandoned:
        return _axi().emit_run_abandoned(verb, _project_key(project_dir),
                                         args.agent, run_id, abandoned,
                                         list(preflight_warnings)
                                         + watch.warnings(),
                                         post_fn=_post)
    print(f"[crucible] {_runner_label(runner)} exit={result.returncode}",
          file=sys.stderr)
    envelope_warnings = list(preflight_warnings) + watch.warnings()

    if not args.agent:
        return result.returncode
    # The final count, then `ingesting…`, both ahead of the ingest below.
    _axi().close_narration(narrator)

    # A pytest that failed as a runner wrote no result, whatever JUnit it left.
    if (_produced_xml(reports_dir)
            and not _pytest_failed_as_runner(runner, result)):
        report_paths = _report_paths(reports_dir)
        # The client decides one thing locally, from the runner's exit and
        # the count of the report's test cases; everything else is the board's.
        if _axi().ran_nothing(result.returncode,
                              _axi().junit_testcase_count(report_paths)):
            return _axi().emit_ran_nothing(
                verb, "TEST-*.xml", result.returncode, result.stdout or "",
                run_id, envelope_warnings, post_fn=_post,
                project_key=_project_key(project_dir), agent_id=args.agent,
                subject=_no_report_subject(verb, runner))
        runner_exit = _axi().runner_exit_code(result.returncode)
        resp = _file_reports(project_dir, args.agent, report_paths,
                             raw=result.stdout, tier=tier,
                             context=_run_context(), run_id=run_id,
                             release=release, runner_exit=runner_exit)
        # The envelope states the run as the board filed it.
        _emit_ingest_axi(verb, resp, project_dir, args.agent,
                         warnings=(envelope_warnings
                                   + _axi().unit_run_wall_vs_cpu_warnings(
                                       tier, "python", timing)))
        # The exit carries the runner's verdict and the filed run's, and a
        # refused ingest is never green.
        return _axi().verb_exit(runner_exit, resp)
    # No XML at all → a hard collection/syntax failure. Ingest the CAPTURED runner
    # output as compile so the RED is still reported rather than silently lost.
    # CR-CRU-111 AC13a — a COMPILE ingest is a build event and carries NO test
    # tier, whatever verb reached it.
    _ingest_compile(project_dir, args.agent, _no_xml_errors_text(result, runner),
                    run_id=run_id, release=release)
    # CR-CRU-064 §S2 — the compile ingest above is UNCHANGED; the envelope is
    # additive, so a starved toolchain stops returning an exit code with empty
    # stdout. The exit code is untouched (AC5).
    _emit_axi(verb, False,
              {"help": _axi().no_report_help(verb, "TEST-*.xml")},
              _axi_context(project_dir, agent_id=args.agent),
              envelope_warnings
              + [_no_report_warning(verb, runner, result)],
              "[crucible] ERROR: no JUnit XML produced — ingested as compile")
    return result.returncode or 1


def cmd_regression(args, verb="regression", runner=None, carried_warnings=()):
    """Gated regression run — an opening heartbeat DECLARES the run's identity
    (binding it when `--cycle` is given), and the ingest body is wrapped in the
    anti-ghost silent cleanup (CR-CRU-008 §S4). CR-CRU-056 — the cleanup fires
    ONLY for an identity this run created; a caller who registered BEFORE the
    run keeps its registration and its cycle binding.

    CR-CRU-058 §S1 — `verb` names the envelope this run belongs to:
    `pre-merge-gate` runs this body AS its regression step, so the gate's stdout
    must carry ONE document under the GATE's own verb, not the inner one's.
    The gate also hands over the `runner` it already chose, so the interpreter
    is probed once per gate, and its check step's `carried_warnings`, which
    ride every envelope this run emits."""
    # A coverage-only flag on a coverage-free run is refused first, before the
    # project, the board, a lock or the interpreter is touched.
    _axi().refuse_coverage_only_flags(args, {"cov_source": "--cov-source"})
    project_dir = _resolve_project_dir(args.project_dir)
    # The runner is chosen, and refused, before anything reaches the board.
    if runner is None:
        runner = _resolve_runner(args, project_dir)
    with _axi().gated_run(project_dir, getattr(args, "agent", None),
                          getattr(args, "cycle", None),
                          "gated regression run starting",
                          open_fn=_open_gate_identity,
                          close_fn=_close_gate_identity) as identity:
        preflight_warnings = list(carried_warnings)
        if getattr(args, "agent", None):
            # CR-CRU-094 §S3 — the same pre-flight attribution check `cmd_test`
            # makes, before this (far longer) sweep burns its minutes.
            preflight_warnings += _axi().preflight_cycle_warnings(
                _get, _project_key(project_dir), args.agent,
                cycle_id=getattr(args, "cycle", None),
                context=_run_context(), release=getattr(args, "release", None))
        return _regression_run(args, verb, preflight_warnings, identity, runner)


def _regression_run(args, verb="regression", preflight_warnings=(), identity=None,
                    runner=_UNITTEST):
    """Full-suite discover (tier regression): a unittest run with --agent is
    streamed (`_streamed_run`), a pytest run files its JUnit reports. With
    --coverage: run under coverage.py and send its lcov report to
    /api/v2/runs with the run's record. A bound agent's run is
    server-stamped with its registered cycle. `verb` (CR-CRU-058 §S1) names the
    envelope — see `cmd_regression`.

    CR-CRU-094 §S3 — `preflight_warnings` is the caller's pre-flight finding,
    decided BEFORE the sweep started; it rides every envelope this body can
    emit, ahead of whatever the run itself discovers. `identity` is the gated
    run's identity, observing every narration tick."""
    preflight_warnings = list(preflight_warnings)
    project_dir = _resolve_project_dir(args.project_dir)
    python = _resolve_python(args.python, project_dir)
    agent = getattr(args, "agent", None)
    # §S1 — the release this run is filed under (None: a cycle's run).
    release = getattr(args, "release", None)
    reports_dir = _reports_dir(project_dir, args.reports, agent)
    os.makedirs(reports_dir, exist_ok=True)
    _wipe(reports_dir)
    env = os.environ.copy()
    # Only a streamed run hands its runner a stream (`_streamed_run`).
    env.pop(STREAM_VAR, None)

    run_cmd = _suite_cmd(python, runner, None, args.start_dir, args.pattern,
                         reports_dir)
    coverage_on = bool(args.coverage)
    # Coverage follows the run: an agent's own directory holds coverage.py's
    # data file too; otherwise it stays where coverage.py puts it (cwd).
    data_file = (os.path.join(reports_dir, ".coverage")
                 if _axi().reports_dir_is_agents_own(args.reports, agent) else None)
    if coverage_on:
        # The project's own coverage config decides the source unless one is
        # given; with nothing declared the project root is measured, and every
        # envelope this run produces says so.
        cov_source = args.cov_source
        if not cov_source and not _coverage_source_declared(python, project_dir, env):
            cov_source = os.path.abspath(project_dir)
            preflight_warnings.append({"code": "coverage-source-undeclared",
                                       "detail": _UNDECLARED_SOURCE_DETAIL})
        _erase_coverage_data(python, project_dir, env, data_file)
        run_cmd = [python, "-m", "coverage", "run",
                   *(["--source", cov_source] if cov_source else []),
                   *([f"--data-file={data_file}"] if data_file else []),
                   *run_cmd[1:]]
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
        # this client. `python -P` would defend against it, and the 3.14 floor
        # makes that flag available, but adopting it is a separate decision.
        # Deliberately left unguarded.

    print(f"[crucible] running: {' '.join(run_cmd)}", file=sys.stderr)
    if agent and runner == _UNITTEST:
        # CR-CRU-224 §S3 — a unittest run's record is its runner's stream.
        def collect():
            if not coverage_on:
                return [], []
            lcov_path = _collect_coverage(python, project_dir, env, data_file)
            if lcov_path:
                return [lcov_path], []
            return [], [_axi().coverage_not_measured_warning(
                "`coverage lcov` left no lcov coverage report")]
        return _streamed_run(verb, args, project_dir, agent, identity, run_cmd,
                             env, reports_dir=reports_dir, tier="regression",
                             release=release, warnings=preflight_warnings,
                             collect_coverage=collect,
                             gate=verb != "regression")
    narrator, run_id = None, None
    if agent:
        # The shared run path: narrate per-test progress, and open the run
        # BEFORE the sweep is spawned so the board shows it running.
        narrator = _narrator(project_dir, agent, identity, runner)
        run_id, run_warnings = _start_run(project_dir, agent, tier="regression",
                                          context=_run_context(),
                                          release=release)
        preflight_warnings += run_warnings
    # The runner's fallback line, once seen, rides every envelope below.
    watch = _FallbackWatch(narrator, runner)
    try:
        with _axi().abandon_trap(run_id):
            result = _run_logged(run_cmd, project_dir, env,
                                 getattr(args, "log", None), watch)
    except _axi().RunAbandoned as abandoned:
        return _axi().emit_run_abandoned(verb, _project_key(project_dir), agent,
                                         run_id, abandoned,
                                         preflight_warnings + watch.warnings(),
                                         post_fn=_post)
    print(f"[crucible] {_runner_label(runner)} exit={result.returncode}",
          file=sys.stderr)
    envelope_warnings = preflight_warnings + watch.warnings()

    # A pytest that failed as a runner wrote no result, whatever JUnit it left.
    if (_pytest_failed_as_runner(runner, result)
            or not _produced_xml(reports_dir)):
        if _is_zero_discovery(result):
            # §S2 — a discovery that COLLECTED ZERO TESTS (start_dir/pattern matched
            # nothing) is a DEFINITIVE `no-tests-discovered` AXI error, NOT a masked
            # compile ingest. The compile path below is reserved for a genuine
            # import/collection failure (its capture carries a traceback).
            detail = (f"0 tests discovered — "
                      f"start_dir={args.start_dir or _UNITTEST_START_DIR!r} "
                      f"pattern={args.pattern or _UNITTEST_PATTERN!r} matched nothing")
            warning = {"code": "no-tests-discovered", "detail": detail}
            print(f"[crucible] ERROR: no-tests-discovered — {detail}", file=sys.stderr)
            # Nothing ran, so nothing will ever file the run this verb opened:
            # close it through the shared `abort_run`.
            _emit_axi(verb, False,
                      {"help": ["check --start-dir / --pattern; ensure the test dir "
                                "is a package (has __init__.py)"]},
                      _axi_context(project_dir, agent_id=args.agent),
                      envelope_warnings + [warning]
                      + _axi().no_report_left_open_warnings(
                          run_id, "TEST-*.xml", post_fn=_post,
                          project_key=_project_key(project_dir),
                          agent_id=args.agent))
            return result.returncode or 1
        print("[crucible] ERROR: no JUnit XML produced — ingesting captured output as compile",
              file=sys.stderr)
        # CR-CRU-111 AC13a — this ingest is a build event, not a run of the
        # `regression` tier: an earned verb name does not make a compile event a
        # test tier, so no tier goes on this body.
        _axi().close_narration(narrator)
        _ingest_compile(project_dir, args.agent, _no_xml_errors_text(result, runner),
                        run_id=run_id, release=release)
        # CR-CRU-064 §S2/AC6 — emitted under the `verb` PARAMETER, never the
        # literal "regression": `pre-merge-gate` runs this body as its
        # regression step, so a starved GATE must speak as the gate. The
        # `no-tests-discovered` branch above keeps its own code (AC7).
        _emit_axi(verb, False,
                  {"help": _axi().no_report_help(verb, "TEST-*.xml")},
                  _axi_context(project_dir, agent_id=args.agent),
                  envelope_warnings
                  + [_no_report_warning(verb, runner, result)],
                  f"{verb}: ok=False — no JUnit XML, ingested as compile")
        return result.returncode or 1

    report_paths = _report_paths(reports_dir)
    # The client decides one thing locally, from the runner's exit and the
    # count of the report's test cases; everything else is the board's.
    if _axi().ran_nothing(result.returncode,
                          _axi().junit_testcase_count(report_paths)):
        return _axi().emit_ran_nothing(
            verb, "TEST-*.xml", result.returncode, result.stdout or "",
            run_id, envelope_warnings, post_fn=_post,
            project_key=_project_key(project_dir), agent_id=args.agent,
            subject=_no_report_subject(verb, runner))
    coverage_paths = []
    if coverage_on:
        lcov_path = _collect_coverage(python, project_dir, env, data_file)
        if lcov_path:
            coverage_paths = [lcov_path]
        else:
            envelope_warnings.append(_axi().coverage_not_measured_warning(
                "`coverage lcov` left no lcov coverage report"))
    # The final count, then `ingesting…`, both ahead of the ingest below.
    _axi().close_narration(narrator)
    runner_exit = _axi().runner_exit_code(result.returncode)
    resp = _file_reports(project_dir, args.agent, report_paths,
                         raw=result.stdout, coverage_paths=coverage_paths,
                         tier="regression", context=_run_context(),
                         run_id=run_id, release=release,
                         runner_exit=runner_exit)
    exit_code = _axi().verb_exit(runner_exit, resp)
    ok = exit_code == 0
    # §S2 — a GATE run's next step is derived from the run state it reached
    # (unrecorded / red / green); the plain `regression` verb keeps its canned
    # HELP_STEPS entry, unchanged.
    gate = verb != "regression"
    help_steps = (_axi().run_help(verb, ok,
                                  _axi().filed_run(resp).get("failed"),
                                  _base_url())
                  if gate else None)
    # A gate whose one whole-suite run was not filed cannot say what it
    # covered: it names that suite unreported, as a composed gate does.
    if gate:
        envelope_warnings += _axi().whole_suite_unreported_warnings(_STACK, resp)
    _emit_ingest_axi(verb, resp, project_dir, args.agent,
                     help_steps=help_steps, warnings=envelope_warnings)
    return exit_code


def _stream_health(coverage):
    """The board's health, read before a streamed run opens: `(health,
    refusal, unreachable)`. `refusal` names why a readable board cannot take
    the stream (no `crucible-events`, or no `lcov` for a `coverage` run);
    `unreachable` names the board whose health could not be read."""
    health = _get(_axi().INGEST_HEALTH_PATH)
    if not isinstance(health, dict) or health.get("ok") is False:
        error = health.get("error") if isinstance(health, dict) else None
        return None, None, (f"the board at {_base_url()} could not be reached "
                            f"({error or 'its health could not be read'}); the "
                            f"suite ran with no stream and nothing was filed")
    refusal = _axi()._ingest_health_refusal(
        health, STREAM_CODEC, LCOV_CODEC if coverage else None)
    return health, refusal, None


def _open_streamed_run(project_dir, agent, tier, release):
    """Open the streamed run: `(run_id, None, [])`, or `(None, why,
    warnings)` naming the board when it opened none, with `open_run`'s own
    warnings (a refused start's `run-lifecycle-unavailable`; none when the
    board simply opened no run)."""
    run_id, warnings = _start_run(project_dir, agent, tier=tier,
                                  context=_run_context(), release=release)
    if run_id:
        return run_id, None, []
    cause = (warnings[0].get("detail") if warnings and isinstance(warnings[0], dict)
             else None) or "it answered no runId"
    return None, (f"the board at {_base_url()} opened no run ({cause}); the "
                  f"suite ran with no stream and nothing was filed"), warnings


def _stream_counts(path):
    """The client's one reading of the stream file: `(test_ends,
    run_end_total)`, the second None when the stream holds no `run-end`."""
    count, total = 0, None
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                if event.get("event") == "test-end":
                    count += 1
                elif event.get("event") == "run-end":
                    stated = event.get("total")
                    total = (stated if isinstance(stated, int)
                             and not isinstance(stated, bool) else count)
    except FileNotFoundError:
        return 0, None
    except OSError as exc:
        print(f"[crucible] WARN: could not read the stream {path} ({exc}) — "
              f"it counts as holding no test", file=sys.stderr)
        return 0, None
    return count, total


def _finish_relay(relay, deadline_seconds):
    """Stop the relay (when one runs), sending what the board has not
    acknowledged within `deadline_seconds`; answer the `held` the board
    confirmed (0 when no relay ran)."""
    if relay is None:
        return 0
    held, _stopped = relay.finish(deadline_seconds)
    return held


_ZERO_DISCOVERY_HELP = ("check --start-dir / --pattern; ensure the test dir "
                        "is a package (has __init__.py)")


def _zero_discovery_warning(args):
    """CR-CRU-039 §S2 — the `no-tests-discovered` warning, said on stderr."""
    detail = (f"0 tests discovered — "
              f"start_dir={args.start_dir or _UNITTEST_START_DIR!r} "
              f"pattern={args.pattern or _UNITTEST_PATTERN!r} matched nothing")
    print(f"[crucible] ERROR: no-tests-discovered — {detail}", file=sys.stderr)
    return {"code": "no-tests-discovered", "detail": detail}


def _emit_zero_discovery(verb, args, project_dir, agent, warnings, run_id,
                         artifact):
    """CR-CRU-039 §S2 — a discovery that collected zero tests is a
    definitive `no-tests-discovered` error, never a compile ingest; the run
    this verb opened is aborted. Returns the exit code."""
    _emit_axi(verb, False, {"help": [_ZERO_DISCOVERY_HELP]},
              _axi_context(project_dir, agent_id=agent),
              list(warnings) + [_zero_discovery_warning(args)]
              + _axi().no_report_left_open_warnings(
                  run_id, artifact, post_fn=_post,
                  project_key=_project_key(project_dir), agent_id=agent))
    return 1


def _emit_unfiled(verb, args, project_dir, agent, unfiled, warnings, result,
                  gate):
    """The exit of a unittest run whose board could not be reached or opened
    no run: the suite ran and nothing was filed. The envelope is `ok: false`
    naming the board, carries `warnings` (`run-lifecycle-unavailable` when
    the board could not be reached or refused the run), and says what the
    runner did: a discovery that found nothing, or a runner that exited
    non-zero having written no test. Returns the exit code."""
    print(f"[crucible] ERROR: {unfiled}", file=sys.stderr)
    found = list(warnings)
    help_steps = [f"re-run {verb} --agent <agentId> once the board answers",
                  "status"]
    if _is_zero_discovery(result):
        found.append(_zero_discovery_warning(args))
        help_steps = [_ZERO_DISCOVERY_HELP, *help_steps]
    elif result.returncode:
        found.append(_no_report_warning(verb, _UNITTEST, result))
        help_steps = _axi().no_report_help(verb, STREAM_FILE)
    if gate:
        found += _axi().whole_suite_unreported_warnings(
            _STACK, {"ok": False, "error": unfiled})
    _emit_axi(verb, False, {"error": unfiled, "help": help_steps},
              _axi_context(project_dir, agent_id=agent), found,
              f"{verb}: ok=False — {unfiled}")
    return result.returncode or 1


def _streamed_run(verb, args, project_dir, agent, identity, cmd, env, *,
                  reports_dir, tier, release, warnings, collect_coverage=None,
                  gate=False, measure_wall=False):
    """CR-CRU-224 §S3 — a unittest run with `--agent`, its record its
    runner's event stream. The board's health is read first: a board that
    decodes no `crucible-events` refuses the run before it is opened or
    spawned; one that cannot be reached, or opens no run, runs the suite
    with no stream and files nothing. Otherwise the runner is handed
    `CRUCIBLE_STREAM`, the relay sends what it writes, and once it exits the
    stream file decides: zero discovery, ran nothing, no test written (the
    compile ingest), or the stream's close. Returns the exit code."""
    key = _project_key(project_dir)
    warnings = list(warnings)
    health, refusal, unfiled = _stream_health(collect_coverage is not None)
    if refusal is not None:
        print(f"[crucible] ERROR: {refusal}", file=sys.stderr)
        _emit_axi(verb, False, {"error": refusal,
                                "help": ["status", f"re-run {verb} on a board that "
                                         f"decodes `{STREAM_CODEC}`"]},
                  _axi_context(project_dir, agent_id=agent), warnings,
                  f"{verb}: ok=False — {refusal}")
        return 1
    run_id, relay, narrator = None, None, None
    if unfiled is None:
        run_id, unfiled, lifecycle = _open_streamed_run(project_dir, agent,
                                                        tier, release)
    else:
        lifecycle = [{"code": _axi().RUN_LIFECYCLE_UNAVAILABLE_CODE,
                      "detail": unfiled}]
    stream_path = os.path.join(reports_dir, STREAM_FILE)
    # The runner alone is handed the stream, in its own copy of `env`: the
    # caller's `env` (the one `coverage lcov` runs under) never carries it.
    runner_env = env
    if run_id:
        runner_env = {**env, STREAM_VAR: stream_path}
        narrator = _narrator(project_dir, agent, identity, streamed=True)
        relay = _axi().StreamRelay(_post, key, agent, run_id, stream_path,
                                   STREAM_CODEC, _axi()._ingest_body_limit(health))
        relay.start()
    try:
        with _axi().ChildRunTiming() as timing, _axi().abandon_trap(run_id):
            result = _run_logged(cmd, project_dir, runner_env,
                                 getattr(args, "log", None))
    except _axi().RunAbandoned as abandoned:
        # The tests the runner wrote before the signal reach the board
        # before the run is aborted.
        _finish_relay(relay, _INTERRUPTED_FINISH_SECONDS)
        return _axi().emit_run_abandoned(verb, key, agent, run_id, abandoned,
                                         warnings, post_fn=_post)
    except BaseException:
        _finish_relay(relay, 0)
        raise
    held = _finish_relay(relay, _STREAM_FINISH_SECONDS)
    print(f"[crucible] {_runner_label(_UNITTEST)} exit={result.returncode}",
          file=sys.stderr)
    if run_id is None:
        return _emit_unfiled(verb, args, project_dir, agent, unfiled,
                             warnings + lifecycle, result, gate)
    count, total = _stream_counts(stream_path)
    if count == 0 and _is_zero_discovery(result):
        return _emit_zero_discovery(verb, args, project_dir, agent, warnings,
                                    run_id, STREAM_FILE)
    if _axi().ran_nothing(result.returncode, count if total is not None else None):
        return _axi().emit_ran_nothing(
            verb, STREAM_FILE, result.returncode, result.stdout or "", run_id,
            warnings, post_fn=_post, project_key=key, agent_id=agent,
            subject=_no_report_subject(verb, _UNITTEST))
    # The compile path needs all three: no `test-end` in the local stream,
    # nothing of it the board holds, and a failed runner. A stream the board
    # holds (a `run-start` the runner wrote before it died) is closed as a
    # stream.
    wrote_no_test = bool(result.returncode) and count == 0 and held == 0
    coverage_paths = []
    if collect_coverage is not None and not wrote_no_test:
        coverage_paths, missing = collect_coverage()
        warnings += missing
    if narrator is not None:
        # The final count, then `ingesting…`, both ahead of the close.
        narrator.say(f"ran {count}/{count if total is None else total}")
        narrator.say(_axi().INGESTING_MESSAGE)
    if wrote_no_test:
        # No test written and a failed runner: its captured output is filed
        # as a compile failure, closing the run (a compile ingest states no
        # tier).
        _ingest_compile(project_dir, agent, _no_xml_errors_text(result, _UNITTEST),
                        run_id=run_id, release=release)
        _emit_axi(verb, False,
                  {"help": _axi().no_report_help(verb, STREAM_FILE)},
                  _axi_context(project_dir, agent_id=agent),
                  warnings + [_no_report_warning(verb, _UNITTEST, result)],
                  f"{verb}: ok=False — no {STREAM_FILE} test, ingested as compile")
        return result.returncode or 1
    runner_exit = _axi().runner_exit_code(result.returncode)
    resp = _axi().close_stream(
        _post, stack=_STACK, project_key=key, agent_id=agent, run_id=run_id,
        codec=STREAM_CODEC, raw=result.stdout,
        coverage_codec=LCOV_CODEC if coverage_paths else None,
        coverage_paths=coverage_paths, tier=tier, context=_run_context(),
        release=release, runner_exit=runner_exit)
    exit_code = _axi().verb_exit(runner_exit, resp)
    if measure_wall:
        warnings += _axi().unit_run_wall_vs_cpu_warnings(tier, "python", timing)
    help_steps = None
    if gate:
        help_steps = _axi().run_help(verb, exit_code == 0,
                                     _axi().filed_run(resp).get("failed"),
                                     _base_url())
        warnings += _axi().whole_suite_unreported_warnings(_STACK, resp)
    _emit_ingest_axi(verb, resp, project_dir, agent, help_steps=help_steps,
                     warnings=warnings)
    return exit_code


def cmd_auto_ingest(args):
    """Ingest an already-produced reports dir: its JUnit reports are sent to
    /api/v2/runs for the board to decode. A bound agent's run is server-stamped with its registered cycle."""
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
    # CR-CRU-094 §S3 — this verb runs no runner and offers no `--cycle`, so its
    # ingest is the furthest from the run that produced the reports and an
    # unattributed store here is the hardest to notice; checked before the POST.
    preflight_warnings = _axi().preflight_cycle_warnings(
        _get, _project_key(project_dir), args.agent,
        cycle_id=getattr(args, "cycle", None),
        context=_run_context())
    # CR-CRU-111 §S2/AC3 — this verb runs NO tests: it ingests reports it merely
    # found, so it cannot know their tier by construction and states none.
    # It ran no runner either, so it sends neither `raw` nor `runnerExit`.
    resp = _file_reports(project_dir, args.agent, _report_paths(reports_dir),
                         context=_axi().cycle_context(
                             _run_context(), getattr(args, "cycle", None)))
    _emit_ingest_axi("auto-ingest", resp, project_dir, args.agent,
                     warnings=preflight_warnings)
    return 0 if resp.get("ok") else 1


def cmd_check(args):
    """python -m py_compile over the given paths (default app/ + tests/). With --agent,
    ingest any errors as a compile failure. §S2/§S15 — returns the §S1 envelope."""
    project_dir = _resolve_project_dir(args.project_dir)
    # CR-CRU-094 §S3 — `check` INGESTS on a failing compile, so it is one of
    # the five ingesting verbs. The seam is HERE and not in `_check_gate`:
    # that helper is also `pre-merge-gate`'s step 0, whose regression step
    # already makes this check and whose step form must stay emit-free
    # (CR-CRU-058 §S1). Before py_compile spawns.
    preflight_warnings = _axi().preflight_cycle_warnings(
        _get, _project_key(project_dir), args.agent,
        cycle_id=getattr(args, "cycle", None),
        context=_run_context())
    state = _check_gate(args, project_dir)
    legacy = f"check: ok={state['ok']} exit={state['exit']}"
    _emit_axi("check", state["ok"],
              {"exit": state["exit"], "help": _axi().HELP_STEPS["check"]},
              _axi_context(project_dir, agent_id=args.agent),
              list(preflight_warnings) + state["warnings"], legacy)
    return 0 if state["ok"] else (state["exit"] or 1)


def _check_gate(args, project_dir):
    """The py_compile gate itself — CR-CRU-058 §S1: this helper NEVER emits, so
    the two envelope-owning verbs that run it (`check` standalone, and
    `pre-merge-gate`'s fail-fast step 0) each put exactly ONE document on
    stdout. Returns the measured state — `{exit, ok, warnings}` — and its
    caller emits, carrying `warnings` into its envelope.

    Only the paths that exist are compiled. With no Python file among them
    nothing is compiled and the check passes: the compiler is never invoked
    (an empty argument list is its usage error, not a syntax error), no
    compile record is filed, and the state carries `check-compiled-nothing`."""
    python = _resolve_python(args.python, project_dir)
    paths = args.paths or ["app", "tests"]
    files = []
    for p in paths:
        ap = p if os.path.isabs(p) else os.path.join(project_dir, p)
        if os.path.isdir(ap):
            for dirpath, _dirs, names in os.walk(ap):
                files += [os.path.join(dirpath, n) for n in names if n.endswith(".py")]
        elif ap.endswith(".py") and os.path.isfile(ap):
            files.append(ap)
    if not files:
        detail = (f"nothing to compile: no Python file found under "
                  f"{', '.join(paths)}; name the paths to compile with --paths")
        print(f"[crucible] py_compile skipped — {detail}", file=sys.stderr)
        return {"exit": 0, "ok": True,
                "warnings": [{"code": "check-compiled-nothing", "detail": detail}]}
    cmd = [python, "-m", "py_compile", *files]
    print(f"[crucible] running: py_compile on {len(files)} file(s)", file=sys.stderr)
    result = subprocess.run(cmd, cwd=project_dir, capture_output=True, text=True,
                            check=False)
    print(f"[crucible] py_compile exit={result.returncode}", file=sys.stderr)
    ok = result.returncode == 0
    if not ok:
        sys.stderr.write(result.stderr)
        if args.agent:
            _ingest_compile(project_dir, args.agent, result.stderr,
                            cycle_id=getattr(args, "cycle", None))
    return {"exit": result.returncode, "ok": ok, "warnings": []}


def cmd_pre_merge_gate(args):
    """ORCHESTRATOR pre-merge gate — the ONLY path that measures coverage. Steps:
    fail-fast `check` (py_compile) → full `regression --coverage`."""
    # A gate scoped to named suites is refused before anything else: this
    # surface enumerates no declaration, so every `--suites` is.
    _axi().refuse_unrunnable_scoped_gate(
        args, surface=_TIER_DECLARATION_SURFACE, stack=_STACK, get=_get,
        project_key=lambda: _project_key(_resolve_project_dir(args.project_dir)))
    project_dir = _resolve_project_dir(args.project_dir)
    # The runner is chosen, and refused, before the check step and before
    # anything reaches the board.
    runner = _resolve_runner(args, project_dir)
    # The gate files from its first step on (a failing py_compile files a
    # compile result), so an unattributed gate is refused before that step.
    _axi().refuse_unattributed_run(
        _get, _project_key(project_dir), args.agent,
        cycle_id=getattr(args, "cycle", None),
        release=getattr(args, "release", None), context=_run_context())
    # The check step's warnings (a step that compiled nothing says so) ride
    # the one envelope this gate emits.
    check_warnings = []
    if not getattr(args, "skip_check", False):
        check_args = argparse.Namespace(
            paths=None, agent=args.agent, python=args.python, project_dir=args.project_dir,
            cycle=getattr(args, "cycle", None),
        )
        # The STEP form (no envelope of its own) — this gate owns stdout.
        state = _check_gate(check_args, project_dir)
        check_warnings = state["warnings"]
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
        release=getattr(args, "release", None), runner=runner,
    )
    # CR-CRU-112 §S1/§S2 — the gate's scope is the project's DECLARED suites,
    # composed once for the fleet. This stack's surface enumerates none (the
    # declaration IS the invocation), so the composition answers with the
    # fallback below — this client's own regression, which is the one suite the
    # invocation declared. The hooks a dispatch would take are stated as the
    # None they are rather than as lambdas that could never run.
    # §S1 (CR-CRU-058) — that body emits under THIS gate's verb, so the gate
    # puts exactly one envelope on stdout under the name the caller invoked.
    return _axi().gate_regression(
        args, surface=_TIER_DECLARATION_SURFACE, stack=_STACK,
        verb="pre-merge-gate", dispatch=None,
        whole_suite=lambda: cmd_regression(reg_args, verb="pre-merge-gate",
                                           runner=runner,
                                           carried_warnings=check_warnings),
        context=_axi_context(project_dir, agent_id=args.agent),
        crucible_url=_base_url())


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


def cmd_cycle_skip(args):
    """S2 -- mark a PENDING cycle skipped (exceptional; recorded
    with reason, cause and spec reference). Delegates to the shared
    implementation."""
    return _axi().cmd_cycle_skip(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_cr_close(args):
    """§S4c — close the resolved OPEN plan and post the cr-merged milestone,
    requiring a live registered caller. CR-CRU-054 §S2 — delegates to the
    shared implementation."""
    return _axi().cmd_cr_close(args, _resolve_project_dir(args.project_dir), _ops(),
                               surface=_TIER_DECLARATION_SURFACE, stack=_STACK)


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
    """§S6 — the work-in-flight READ verb (alias `plans`, no --agent): GET
    …/plans?status=open and return the open plans as a uniform-table §S1
    envelope plus the server's lastClosedCr and filed, encoded per --format
    (toon, the default, or json — one JSON object).
    CR-CRU-054 §S2 — delegates to the shared implementation."""
    return _axi().cmd_status(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_queue(args):
    """CR-CRU-081 §S2 — the queue READ verb (no --agent): the registered CR
    queue (GET …/queue) plus the CR ids a `cr-merged` milestone covers, the two
    landing-record sources the release ceremony's provenance needs. Delegates
    to the shared implementation."""
    return _axi().cmd_queue(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_landings(args):
    """§S9 — the closed plans and the merge commit each recorded, for programs
    such as the release ceremony (read-only, no --agent): GET
    …/plans?status=closed, one {cr, mergeCommit} row per closed plan, encoded
    per --format. Delegates to the shared implementation."""
    return _axi().cmd_landings(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_history(args):
    """§S4 — a project's releases through its client (read-only,
    no --agent): GET …/history as one TOON-AXI table — the default seven
    columns, --fields/--full extras, or --release <label>'s gate runs.
    Delegates to the shared implementation."""
    return _axi().cmd_history(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_runs(args):
    """List a cycle's or a release's stored test and compile runs
    (read-only, no --agent). Delegates to the shared implementation."""
    return _axi().cmd_runs(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_run(args):
    """Show one stored test or compile run of this project (read-only, no
    --agent). Delegates to the shared implementation."""
    return _axi().cmd_run(args, _resolve_project_dir(args.project_dir), _ops())

def cmd_project_meta(args):
    """§S4 — a project's metadata map: a read (GET …/metadata, no
    --agent) or, with --set/--unset, a write (PATCH …/metadata, --agent
    required). Delegates to the shared implementation."""
    return _axi().cmd_project_meta(args, _resolve_project_dir(args.project_dir), _ops())

# ── CR-CRU-091 §S3/§S9 — roadmap registration: five thin delegators ────────
#
# The verbs land ONCE in `clients/_crucible_axi.py` (the CR-CRU-054 DRY rule);
# what lives here is the `queue-file` shape and nothing more. §S9: the client
# half owns argument parsing, the asking, exit codes and the envelope — never
# a business rule, so every one of these bodies is a single delegating call.


def cmd_release_propose(args):
    """§S3 — record or REVISE a proposed release → POST …/release-proposals.
    Delegates to the shared implementation."""
    return _axi().cmd_release_propose(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_cr_plan(args):
    """§S3/§S6 — declare one CR's release, wave and title → POST …/queue/plan;
    with either undeclared the client ASKS instead of guessing. Delegates to
    the shared implementation."""
    return _axi().cmd_cr_plan(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_wave_sequence(args):
    """§S4 — author a whole wave's order in ONE call → POST …/queue/sequence.
    Delegates to the shared implementation."""
    return _axi().cmd_wave_sequence(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_cr_depends(args):
    """CR-CRU-106 §S1 — declare one CR's COMPLETE dependency set → POST
    …/queue/depends; with `--on` undeclared the client ASKS instead of
    guessing. Delegates to the shared implementation."""
    return _axi().cmd_cr_depends(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_cr_supersede(args):
    """§S3 — record that a CR's work moves to a successor → POST
    …/queue/<cr>/supersede. Delegates to the shared implementation."""
    return _axi().cmd_cr_supersede(args, _resolve_project_dir(args.project_dir), _ops())


def cmd_cr_void(args):
    """§S3 — record that a CR's work is not happening → POST
    …/queue/<cr>/void. Delegates to the shared implementation."""
    return _axi().cmd_cr_void(args, _resolve_project_dir(args.project_dir), _ops())


# ── CR-CRU-092 §S6/§S9 — `next`: one thin delegator ────────────────────────


def cmd_next(args):
    """§S2 — ask the DECLARED roadmap what is actionable now → GET …/next,
    answering NEXT | HOLD | DRAINED. Read-only (§S4): no --agent, no write.
    Delegates to the shared implementation."""
    return _axi().cmd_next(args, _resolve_project_dir(args.project_dir), _ops())


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


def _post_gate(project_dir, agent_id, gate, context=None, release=None):
    """POST a gate event (CR-CRU-054 §S2 — delegates to the shared builder).
    `release` is the label of the release the gate gates; it rides on to the
    builder untouched and reaches the wire as the event's top-level
    `version`."""
    return _axi().post_gate(_project_key(project_dir), agent_id, gate, _post,
                            context, release)


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


def cmd_gate_respond(args):
    """§S1 — axi PROXY wrapper around `no-mistakes axi respond`: delegates to
    the shared implementation, which records the decision and drives the run
    through the runner `gate-run` uses; tool discovery stays HERE (this
    module's own `shutil`) so each client's harness keeps its patch seam."""
    return _axi().cmd_gate_respond(
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
             "<project>/.venv/bin/python if present, else this interpreter). Under "
             "unittest it needs only the standard library (Python 3.12 or later); "
             "under pytest it must have pytest (and coverage.py for --coverage).",
    )


def _add_runner_arg(p):
    """`--runner` on a RUNNING verb only: a free string the client validates,
    so a bad value is refused in an envelope rather than by argparse."""
    p.add_argument(
        _RUNNER_FLAG,
        help=f"Runner for this call: {_UNITTEST} or {_PYTEST}. Overrides the "
             f"project's `[{_PYTHON_TABLE}] {_RUNNER_FIELD}` declaration in its own "
             f"crucible.toml; with neither, the runner is {_UNITTEST} (the default). "
             f"With {_PYTEST} the interpreter must be able to import pytest.")


# Under pytest the project's own pytest configuration chooses what is
# collected; a discovery flag only narrows it when the caller states it.
_PYTEST_DISCOVERY_RULE = (
    f"Under {_PYTEST} the project's own configuration decides unless this "
    f"is given.")

_PATTERN_HELP = (f"Discovery filename pattern ({_UNITTEST} default: "
                 f"{_UNITTEST_PATTERN}). {_PYTEST_DISCOVERY_RULE}")


def _add_discover_args(p):
    p.add_argument("--start-dir",
                   help=f"Discovery start dir ({_UNITTEST} default: "
                        f"{_UNITTEST_START_DIR}). {_PYTEST_DISCOVERY_RULE}")
    p.add_argument("--pattern", help=_PATTERN_HELP)
    p.add_argument("--reports", help=_REPORTS_HELP)


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


def _add_run_release_arg(p):
    """§S1 — `--release` on a test-run verb, beside `--cycle` where it has one
    (delegates to the shared declaration so all five clients document it
    identically)."""
    return _axi().add_run_release_arg(p)


_COV_SOURCE_HELP = (
    "coverage --source package/dir. Omitted, the project's coverage config "
    "([tool.coverage.run] source / source_pkgs / include, or .coveragerc) "
    "decides what is measured; with nothing declared there, the project root "
    "is measured and the run warns coverage-source-undeclared. Subprocess "
    "coverage ([run] patch = [\"subprocess\"]) needs coverage.py 7.14 or later. "
    "On regression it applies only with --coverage; pre-merge-gate always "
    "measures coverage, so there it always applies.")


def _add_regression_tier_args(p):
    """CR-CRU-111 §S1/AC5 — `regression`'s OWN flags. The verb pre-dates the
    shared tier registration and keeps every flag it had; the registrar
    supplies the name, the help and the tier binding, this supplies the rest."""
    p.add_argument("--agent", required=True, help="Agent id (typically the orchestrator)")
    _axi().add_regression_coverage_arg(p, "coverage.py")
    p.add_argument("--cov-source", default=None, help=_COV_SOURCE_HELP)


# CR-CRU-111 §S3/AC6a — WHERE this stack declares a tier, in one line, carried
# by every refusal the shared registrar builds here. `unittest` discovery has
# no tier notion, so every cell but `regression` is a DECLARED cell and the
# declaration this runner can actually READ is the discovery selection itself.
def _add_declared_tier_args(p):
    """§S6 ruling 4 — a DECLARED cell's flag surface: the one its test-running
    sibling (`regression`) already takes, so the instruction a refusal gives
    can actually be typed (AC14b — the measured defect was exactly this verb
    exiting 2 on the `--start-dir`/`--pattern` its own refusal instructs).

    `--start-dir` carries NO default here, where `_add_discover_args` defaults
    it to `tests`: on this stack the declaration IS the invocation (ruling 1),
    so a defaulted start-dir would declare every cell silently and the refusal
    could never fire. `--agent` is accepted and not required for the same
    reason bun's is: argparse's usage error is not a refusal."""
    p.add_argument("--agent", help="If set, ingest the declared run's result")
    p.add_argument("--start-dir",
                   help="Discovery start dir DECLARING this tier's target. No "
                        "default: with none stated the tier has no declared "
                        "target and the verb refuses.")
    p.add_argument("--pattern", help=_PATTERN_HELP)
    p.add_argument("--reports", help=_REPORTS_HELP)
    _add_python_arg(p)
    _add_runner_arg(p)
    _add_log_arg(p)
    _add_gate_cycle_arg(p)
    _add_run_release_arg(p)


def _read_declared_discovery(args, _target):
    """§S6, python's READ — the discovery selection the caller stated (ruling 1:
    "python's surface is the INVOCATION, not a project file"). `unittest` has
    no project config this repo has agreed, and inventing a format would be a
    new artifact nobody asked for.

    The templated target is UNUSED here, and that asymmetry is this stack's:
    on the other four it is the NAME a declaration is looked up under, while
    here it is the example start-dir the refusal prints — the same string from
    the same template, but a value the flag accepts rather than a key."""
    return getattr(args, "start_dir", None)


def _run_declared_discovery(args, tier, start_dir):
    """§S6, python's RUN — that discovery, under the tier of the VERB that
    asked for it. `start_dir` is already on `args`, where `cmd_test` reads it;
    it is named here because the seam hands the run what it detected."""
    args.start_dir = start_dir
    return cmd_test(args, tier=tier, verb=tier)


_TIER_DECLARATION_SURFACE = _axi().DeclaredTierSurface(
    target="tests/<tier>",
    names="a discovery start-dir/pattern for it "
          "(`--start-dir <target> --pattern 'test_*.py'`)",
    read=_read_declared_discovery,
    run=_run_declared_discovery,
    add_args=(_add_declared_tier_args,),
    # CR-CRU-112 §S1 — this surface enumerates NOTHING, and that is CR-CRU-111
    # ruling 1 restated: on this stack the declaration is the INVOCATION, not a
    # project artefact, so there is no set of declared targets to read. A gate
    # here therefore composes exactly what its invocation declared — its own
    # regression — which is the single-suite case, not a hole.
    suites=None,
)


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


# CR-CRU-097 §S2/AC2 — the ROOT help's description, and deliberately NOT
# `__doc__`. The module docstring is this client's design record: it cites the
# CRs that shaped it, and argparse printed all of it to every user of every
# project. The docstring stays exactly as it is (AC8 — provenance intact);
# what the CLI RENDERS states the tool's behaviour and names no backlog.
_CLI_DESCRIPTION = (
    "Python Crucible CLI — one entry point for the orchestrator and for the\n"
    "RED/GREEN/FIX/VERIFY agent lifecycle, and for running Python test targets\n"
    "under unittest (streamed as Crucible events, the default) or pytest (its own\n"
    "JUnit XML) — the project's `[python] runner` in its crucible.toml, or\n"
    "--runner, chooses — optional coverage.py, with the result ingested to\n"
    "Crucible.\n"
    "\n"
    "Tool-specific (unittest streamed, or pytest / JUnit-XML / coverage.py),\n"
    "never "
    "project-specific: the project path and the interpreter are parameterizable.\n"
    "Run `<verb> --help` for a verb's own flags.\n"
    "\n" + _axi().BOARD_CONFIGURATION_HELP
)


def main():
    p = argparse.ArgumentParser(prog="python-crucible", description=_CLI_DESCRIPTION,
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
                        "RUNTIME by the §S5 hard stop so a missing "
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
    # CR-CRU-054 §S2b — the same runtime hard stop `register` uses: --agent is
    # NOT argparse-required, so the refusal arrives as the §S5 structured
    # envelope. Lineage lives here rather than in the help line, which every
    # project's users read (CR-CRU-097 §S2/AC2).
    u.add_argument("--agent",
                   help="Agent id — REQUIRED, but enforced at RUNTIME by the §S5 "
                        "hard stop so a missing id yields "
                        "the ok:false AXI envelope, not a bare argparse "
                        "usage error.")
    _add_project_dir_arg(u)
    u.set_defaults(func=cmd_unregister)

    t = sub.add_parser(
        "test",
        help="Targeted/discover run under the declared runner (unittest or pytest) "
             "→ parsed ingest. With --agent: ingest.",
    )
    t.add_argument("--tests", nargs="+",
                   help="Dotted test target(s), e.g. tests.test_mcp_server or "
                        "tests.test_mcp_server.Cls.test_x; under pytest, pytest "
                        "node ids, e.g. tests/test_x.py::Cls::test_x. Omit to "
                        "discover.")
    t.add_argument("--agent", help="If set, ingest the result after the run")
    _add_gate_cycle_arg(t)
    _add_run_release_arg(t)
    _add_discover_args(t)
    _add_python_arg(t)
    _add_runner_arg(t)
    _add_project_dir_arg(t)
    _add_log_arg(t)
    t.set_defaults(func=cmd_test)

    # ── CR-CRU-111 §S1 — the SIX tier verbs, from the fleet's own registrar ─
    #
    # `regression` migrates onto it and keeps its handler, its flags and its
    # behaviour; `unittest` discovery splits no tiers of its own, so the other
    # five cells answer their help and refuse until this project declares a
    # target for them. A `dict(...)` rather than a `{...}` literal,
    # deliberately: the six values live in ONE place (the shared module's
    # mirror) and a client dict keyed by tier NAMES would be the second copy
    # that is forbidden.
    tier_verb = _axi().TierVerb
    _axi().add_tier_verbs(
        sub,
        # pi-lens-ignore: C408 — the keyword form keeps the tier names out of a string-keyed literal, which the tier-mirror guard reads as a copy of the tier vocabulary
        dict(regression=tier_verb(  # noqa: C408
            cmd_regression,
            "Runs the full suite under the declared runner — unittest discovery "
            "streamed by default, or pytest when the project's "
            "`[python] runner` or --runner chooses it — and ingests it; "
            "--coverage adds coverage.py.",
            (_add_regression_tier_args, _add_gate_cycle_arg,
             _add_run_release_arg, _add_discover_args, _add_python_arg,
             _add_runner_arg, _add_log_arg))),
        declares=_TIER_DECLARATION_SURFACE,
        add_args=(_add_project_dir_arg,))

    a = sub.add_parser("auto-ingest",
                       help="Ingest an already-produced reports dir (parsed).")
    a.add_argument("--agent", required=True,
                   help="Agent id to ingest under — REQUIRED. A free-form identifier that "
                        "must already be registered (`register --agent <id> --role <role>`); "
                        "a cycle-bound agent's ingests are server-stamped with its registered "
                        "cycle.")
    a.add_argument("--reports", help=f"Reports dir (default: {DEFAULT_REPORTS})")
    _axi().add_filing_cycle_arg(a)
    _add_project_dir_arg(a)
    a.set_defaults(func=cmd_auto_ingest)

    c = sub.add_parser("check",
                       help="py_compile syntax gate over app/ + tests/; ingest errors.")
    c.add_argument("--paths", nargs="+",
                   help="Files/dirs to compile (default: app tests)")
    c.add_argument("--agent", help="If set, ingest compile errors on failure")
    _axi().add_filing_cycle_arg(c)
    _add_python_arg(c)
    _add_project_dir_arg(c)
    c.set_defaults(func=cmd_check)

    pmg = sub.add_parser(
        "pre-merge-gate",
        help="ORCHESTRATOR pre-merge: fail-fast py_compile check → regression WITH "
             "coverage.py (always measured here; regression --coverage measures it too).",
    )
    pmg.add_argument("--agent", required=True, help="Agent id (typically the orchestrator)")
    pmg.add_argument("--cov-source", default=None, help=_COV_SOURCE_HELP)
    pmg.add_argument("--skip-check", action="store_true",
                     help="Bypass the fail-fast py_compile check step")
    _add_gate_cycle_arg(pmg)
    _add_run_release_arg(pmg)
    _axi().add_gate_suites_arg(pmg)
    _add_discover_args(pmg)
    _add_python_arg(pmg)
    _add_runner_arg(pmg)
    _add_project_dir_arg(pmg)
    _add_log_arg(pmg)
    pmg.set_defaults(func=cmd_pre_merge_gate)

    pf = sub.add_parser("plan-file",
                        help="File a cycle plan; prints the ASSIGNED numeric cycle ids. "
                             "Requires --agent <registered id> (§S2b).")
    pf.add_argument("--cr", required=True,
                    help="CR id — caller-owned free text, e.g. CR-<PROJECT>-<n>.")
    pf.add_argument("--title", help="Optional plan title.")
    pf.add_argument("--cycle", action="append",
                    help="One cycle label, never split; repeat --cycle per cycle.")
    _axi().add_plan_file_cycle_kind_arg(pf)
    pf.add_argument(
        "--cycles",
        help='Legacy comma-split form, REFUSED for filing (§S4a): a filed '
             'cycle declares its kind, so repeat --cycle with its own '
             '--cycle-kind instead.')
    _add_workflow_agent_arg(
        pf, extra=" The registered id is also stored as the plan's orchestrator "
                  "(the free-text --orchestrator label is retired).")
    pf.add_argument("--wave",
                    help="Wave number (§S3). Resolution: --wave > $WORKFLOW_WAVE.")
    _axi().add_plan_file_release_arg(pf)
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

    # S2 -- the shared registrar builds the subparser once.
    _axi().add_cycle_skip_verb(sub, cmd_cycle_skip,
                               add_args=(_add_workflow_agent_arg, _add_project_dir_arg))

    cc = sub.add_parser("cr-close",
                        help="Close the single OPEN plan (PATCH status=closed + merge.commit). "
                             "Requires --agent <registered id> (§S2b).")
    cc.add_argument("--commit", required=True, help="Merge commit sha.")
    cc.add_argument("--cr", help="Disambiguate when multiple plans are open.")
    _axi().add_cr_close_gate_arg(cc)
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
    _axi().add_cycle_add_target_args(cad)
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
    _axi().add_change_record_args(ab)  # S2b: abort is recorded
    _add_workflow_agent_arg(ab)
    _add_project_dir_arg(ab)
    ab.set_defaults(func=cmd_abort)

    for _name in ("status", "plans"):
        sv = sub.add_parser(_name,
                            help="Read the open plans, the work in flight (GET "
                                 "…/plans?status=open), as a TOON-AXI table + "
                                 "lastClosedCr (the last CR to close) and filed "
                                 "(the project's plan count). Read-only; `plans` "
                                 "is an alias of `status`; --format json writes "
                                 "one JSON object.")
        sv.add_argument("--fields",
                        help="Comma-separated EXTRA columns to add to the minimal "
                             "cr,wave,status,activeCycleId set (§S10).")
        _add_project_dir_arg(sv)
        _axi().add_status_format_arg(sv)
        sv.set_defaults(func=cmd_status)

    # ── CR-CRU-081 §S2 — the landing-record READ verb (no --agent) ──
    qv = sub.add_parser("queue",
                        help="Read the registered CR queue (GET …/queue) plus the "
                             "cr-merged milestone ids as a TOON-AXI table. Read-only; "
                             "--format json writes one JSON object.")
    _add_project_dir_arg(qv)
    _axi().add_queue_view_args(qv)
    qv.set_defaults(func=cmd_queue)

    # §S9 — the closed plans' landing commits READ verb (no --agent)
    lv = sub.add_parser("landings",
                        help="The closed plans and the merge commit each recorded — for "
                             "programs such as the release ceremony (GET "
                             "…/plans?status=closed). Read-only; --format json "
                             "writes one JSON object.")
    _add_project_dir_arg(lv)
    _axi().add_status_format_arg(lv)
    lv.set_defaults(func=cmd_landings)

    # §S4 — a project's release history READ verb (no --agent)
    hv = sub.add_parser("history",
                        help="A project's releases, their states, waves, gate runs "
                             "and verification (GET …/history) as a TOON-AXI table; "
                             "--release <label> lists that release's gate runs. "
                             "Read-only; --format json writes one JSON object.")
    _add_project_dir_arg(hv)
    _axi().add_history_args(hv)
    hv.set_defaults(func=cmd_history)

    # §S4 — the project metadata map: read, or write with --set/--unset
    pmv = sub.add_parser("project-meta",
                         help="A project's metadata map (a copy of its .env facts). "
                              "Readable by anything that reaches the board: "
                              "non-secret facts only. No flags reads it; "
                              "--set KEY=VALUE / --unset KEY write it (requires "
                              "--agent); --format json writes one JSON object.")
    _axi().add_project_meta_args(pmv)
    pmv.add_argument("--agent",
                     help="Registered agent id — required only for a write "
                          "(--set/--unset), which posts as a live registered "
                          "ORCHESTRATOR caller; a read (no --set/--unset) needs "
                          "none. An unregistered id is refused by the server (409).")
    _add_project_dir_arg(pmv)
    pmv.set_defaults(func=cmd_project_meta)

    # ── CR-CRU-091 §S3 — roadmap registration (ORCHESTRATOR only). The five
    # subparsers are built by the SHARED registrar so the five clients cannot
    # drift into five different flag surfaces for one verb.
    _axi().add_roadmap_verbs(
        sub,
        {"release-propose": cmd_release_propose, "cr-plan": cmd_cr_plan,
          "wave-sequence": cmd_wave_sequence, "cr-supersede": cmd_cr_supersede,
          "cr-void": cmd_cr_void},
        add_args=(_add_workflow_agent_arg, _add_project_dir_arg))

    # ── CR-CRU-106 §S1 — the DEPENDENCY axis, its own verb and its own
    # registrar (`add_roadmap_verbs`' contract is CR-CRU-091's frozen five).
    _axi().add_cr_depends_verb(
        sub, cmd_cr_depends,
        add_args=(_add_workflow_agent_arg, _add_project_dir_arg))

    # ── CR-CRU-092 §S6 — the roadmap READ verb. Its subparser is built by the
    # SHARED registrar for the same reason; only `--project-dir` is this
    # client's own. No --agent: `next` is read-only (§S4).
    _axi().add_next_verb(sub, cmd_next, add_args=(_add_project_dir_arg,))

    # The stored-run READ verbs, built by the shared registrar; only this
    # client's project-dir argument is its own. No --agent: both are read-only.
    _axi().add_run_read_verbs(sub, {"runs": cmd_runs, "run": cmd_run},
                              add_args=(_add_project_dir_arg,))

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
                          "to watch — skipping nothing, the gate blocks until "
                          "ci_timeout. Omitted, the project's declared "
                          "`[gate] skip` (crucible.toml) applies; a value "
                          "REPLACES it, and --skip \"\" skips nothing.")
    _axi().add_gate_release_arg(gr)
    _add_project_dir_arg(gr)
    gr.set_defaults(func=cmd_gate_run)

    # §S1 — the gate DECISION verb, through the shared registrar so five
    # clients cannot fork its flag surface; it drives the run through the
    # same runner as gate-run.
    _axi().add_gate_respond_verb(sub, cmd_gate_respond,
                                 add_args=(_add_workflow_agent_arg, _add_project_dir_arg))

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
    _axi().add_gate_release_arg(grp)
    _add_project_dir_arg(grp)
    grp.set_defaults(func=cmd_gate_report)

    ms = sub.add_parser("milestone", help="POST a workflow milestone → /api/v2/milestones.")
    ms.add_argument("--type", required=True,
                    help="Milestone type. The vocabulary is this project's own, not this "
                         "CLI's: PATCH /api/v2/projects/<key> {milestoneTypes: [...]} "
                         "declares it, GET /api/v2/projects reads back what this project "
                         "declared, and a refused milestone names the live accepted set "
                         "back to you.")
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
    ms.add_argument("--agent", help="Agent id — REQUIRED (§S5): the identity is declared or "
                         "the verb fails; there is no fallback.")
    _add_project_dir_arg(ms)
    ms.set_defaults(func=cmd_milestone)

    # ── CR-CRU-075 §S1 — the queue REGISTRATION verb. This client hand-rolled
    # the subparser CR-CRU-014 §S2 shipped, which is what let one verb have a
    # flag surface here and none at all on the other four. It now registers
    # through the shared registrar like every verb since CR-CRU-091, wired in
    # place so the verb order this client's --help has always printed is
    # unchanged (§S1 is a mechanism change, not a surface one). No --agent: it
    # registers a PROJECT's queue, not an agent's work.
    _axi().add_queue_file_verb(sub, cmd_queue_file,
                               add_args=(_add_project_dir_arg,))

    args = p.parse_args()
    # §S14 — no subcommand: run the no-arg live dashboard, not argparse usage.
    if getattr(args, "func", None) is None:
        sys.exit(_axi().run_dashboard(
            cmd_dashboard,
            lambda a: _project_key(_resolve_project_dir(getattr(a, "project_dir", None)))))
    # CR-CRU-044 §S5 — dispatch through the shared `run_verb`, which turns an
    # UNDECLARED agent identity into the ok:false hard-stop envelope + a
    # non-zero exit (POSTing nothing) instead of an unhandled traceback.
    try:
        code = _axi().run_verb(
            args.func, args,
            lambda a: _project_key(_resolve_project_dir(getattr(a, "project_dir", None))),
            ops_fn=_ops,
            project_dir_fn=lambda a: _resolve_project_dir(getattr(a, "project_dir", None)))
    except RunnerRefused as refusal:
        code = _emit_runner_refused(args, refusal)
    sys.exit(code)


def _emit_runner_refused(args, refusal):
    """The `ok:false` envelope for a runner that cannot be run, and the exit
    code. Nothing was run and nothing was posted; the context is best-effort,
    since a project without a key must still be told why."""
    project_dir = _resolve_project_dir(getattr(args, "project_dir", None))
    agent = getattr(args, "agent", None)
    context = (_axi_context(project_dir, agent_id=agent)
               if _read_env(project_dir).get("CRUCIBLE_PROJECT_KEY", "").strip()
               else {})
    hint = "correct the runner or interpreter this error names, then re-run the verb"
    _emit_axi(args.cmd, False,
              {"error": str(refusal),
               "help": [hint]},
              context, [], legacy_line=f"error: runner-refused \u2014 {refusal}")
    return 1


if __name__ == "__main__":
    main()
