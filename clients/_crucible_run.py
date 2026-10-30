"""The run and ingest pipeline the client fleet shares.

Every suite-running verb of every stack client opens a run on the board, runs
its runner with the output streamed and narrated, files the runner's reports
through one ingest, and settles the run however it ends (filed, aborted, or
left to the server's sweep after a signal). That pipeline lives here, beside
`_crucible_axi.py`, the core every client loads, so the core stays under the
size the citation guard can read (`BARE_LINE_IMPLAUSIBLE_THRESHOLD` in
`tests/citations-cite-by-symbol.test.ts`).

No client loads this module. The core loads it by file path from its own
directory, eagerly, under a name derived from its own (`f"{__name__}_run"`),
so each client's core instance gets a run module of its own, and re-exports
every name it defines: `_axi().ingest_reports` and a test's
`axi.ingest_reports` keep working. Once loaded, the core binds `_core` to a
live view of its own namespace, and every core name this module uses
(`post_ingest`, `emit_axi`, the gated-run bookkeeping, ...) is read through
that view at call time, so a test that patches a core name reaches the code
here. A call between two functions of this module resolves here.

It imports only the standard library.
"""

import contextlib
import json
import os
import re
import resource
import signal
import subprocess
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET

#: The core this module is bound to: a live view of `_crucible_axi.py`'s
#: namespace, set by the core's loader once this module has run. Every core
#: name is read through it at call time, never copied.
_core = None


# ── CR-CRU-111 §S4 — a `unit` run that WAITS says so (AC6b) ───────────────
#
# `unit` is the one tier of the six whose MEANING forbids waiting ("no wait on
# the clock", the core's `TIER_MEANINGS`), so a run of it that spends its wall clock
# not computing has taken a dependency its tier does not name. The check is
# scoped to that tier alone and it is deliberate: `integration`, `e2e`,
# `regression` and `bdd` name real elapsed time as a dependency by definition,
# and a warning there would be noise, not a finding.
#
# It WARNS and never refuses. Classification is the project's decision, so the
# client reports the contradiction rather than vetoing it: `ok` and the exit
# code are the run's own, untouched, and a check that turned a passing suite
# red would be a worse defect than the one it detects.
#
# The measurement is `resource.getrusage(RUSAGE_CHILDREN)` deltas taken around
# the client's OWN `subprocess.run` — stdlib, no dependency. Measured
# discrimination: a sleeping child reads 38.4x, a CPU-bound child 1.00x, and
# this repo's own unit target 1.09x (17.8 s wall / 16.3 s CPU), so 2x sits ~1.8x
# above a real unit suite and ~19x below a sleeping one. `RUSAGE_CHILDREN` sums
# CPU across cores, so a PARALLEL runner reads BELOW 1x and can never
# false-positive — the asymmetry is the reason this factor is safe.
#
# BOUND, stated where the mechanism is: `RUSAGE_CHILDREN` is a per-PROCESS
# cumulative counter, so a delta taken around one `subprocess.run` is
# attributable to that child only while the bracketed call spawns exactly ONE.
# Every `unit` run in the fleet does. Widening this check past `unit` would
# demand a delta per `subprocess.run` rather than one per verb (a gate that
# brings a compose stack up spawns two), which is why widening it is not a
# wording change.
UNIT_RUN_WALL_EXCEEDS_CPU_CODE = "unit-run-wall-exceeds-cpu"

# The tier the check is scoped to, and the factor §S4 states: wall at or over
# 2x CPU. Named rather than spelled at the comparison so the one definition the
# fleet shares is also the one it prints.
WALL_VS_CPU_TIER = "unit"
WALL_VS_CPU_FACTOR = 2.0


class ChildRunTiming:
    """§S4 — the bracket around a child run: wall seconds, child CPU seconds,
    and the ratio between them.

    Used as a context manager around the ONE `subprocess.run` a test verb makes
    (`with ChildRunTiming() as timing: result = _run_logged(...)`), so the
    rusage delta covers that child and nothing else. `wall` and `cpu` are 0.0
    until the block exits, and never negative: a monotonic clock cannot go
    backwards, and a rusage counter is cumulative, but clamping costs nothing
    and keeps a nonsense figure out of a warning.

    `ratio` is None when no CPU was measurable at all rather than raising or
    reporting an infinity — a child that consumed no measurable CPU is the
    STRONGEST form of the condition this exists to detect, so the division is
    guarded and the caller words that case for itself."""

    __slots__ = ("wall", "cpu", "_wall_at", "_cpu_at")

    def __init__(self):
        self.wall = 0.0
        self.cpu = 0.0
        self._wall_at = None
        self._cpu_at = None

    @staticmethod
    def _child_cpu():
        """CPU seconds this process's waited-for children have consumed, user
        plus system — the whole cost of a child, since a run that spends its
        time in the kernel is computing just as much as one in user space."""
        usage = resource.getrusage(resource.RUSAGE_CHILDREN)
        return usage.ru_utime + usage.ru_stime

    def __enter__(self):
        self._wall_at = time.monotonic()
        self._cpu_at = self._child_cpu()
        return self

    def __exit__(self, exc_type, exc, tb):
        wall_at, cpu_at = self._wall_at, self._cpu_at
        if wall_at is None or cpu_at is None:
            raise RuntimeError("ChildRunTiming exited without being entered")
        self.wall = max(time.monotonic() - wall_at, 0.0)
        self.cpu = max(self._child_cpu() - cpu_at, 0.0)
        return False

    @property
    def ratio(self):
        """wall / cpu, or None when no child CPU was measurable."""
        return self.wall / self.cpu if self.cpu > 0 else None


def unit_run_wall_vs_cpu_warnings(tier, client, timing,
                                  factor=WALL_VS_CPU_FACTOR):
    """§S4/AC6b — the envelope `warnings[]` fragment for a `unit` run that spent
    its wall clock waiting: `[]` or exactly one `{code, detail}`, in the shape
    `preflight_cycle_warnings` returns its finding, so a call site adds it to
    the warnings it already carries and changes nothing else.

    ONE definition for the fleet: five clients reach this, and a consumer
    matches on `UNIT_RUN_WALL_EXCEEDS_CPU_CODE`, so `client` (this client's own
    name — its own fact, like the declaration surface it hands
    `add_tier_verbs`) is what tells a reader of the board WHICH stack waited.

    `tier` is the tier the caller STATED, so an untiered run (`tier=None`) and
    every tier but `unit` return `[]` without measuring anything twice. A run
    with no wall time at all — nothing was bracketed — is not a finding
    either."""
    if tier != WALL_VS_CPU_TIER or timing is None or timing.wall <= 0.0:
        return []
    if timing.wall < factor * timing.cpu:
        return []
    ratio = timing.ratio
    measured = (f"{ratio:.1f}x" if ratio is not None
                else "no child CPU was measurable at all")
    return [{
        "code": UNIT_RUN_WALL_EXCEEDS_CPU_CODE,
        "detail": (f"{client} {tier}: this run spent {timing.wall:.3f}s of "
                   f"wall time against {timing.cpu:.3f}s of child CPU "
                   f"({measured}, at or over the {factor:g}x mark) — a "
                   f"{tier} run that spends its time WAITING is taking a "
                   f"dependency its tier does not name (a process, a socket, "
                   f"a live service, or the clock itself). Reclassify the "
                   f"run, or find what it waits on; it is reported either "
                   f"way, because which tier these tests belong to is the "
                   f"project's call and not this client's"),
    }]


# \u2500\u2500 THE SHARED RUN PATH \u2014 open, stream live, narrate, finalize \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
#
# Every suite-running verb of every stack client walks the same four steps,
# and they live HERE so a stack contributes only the two facts that are its
# own: how a completed test reads in its runner's output (the `recognise`
# callable) and its best-known total.
#
#   1. `open_run` \u2014 `POST /api/v2/runs/start` BEFORE the suite is spawned, so
#      the board draws the running card for the whole span.
#   2. `run_streamed` \u2014 the runner's combined output reaches stderr and the
#      `--log` file AS IT IS PRODUCED, while the returned capture stays
#      byte-identical to what a capture-after-exit would have held (the
#      parsers that read it afterwards see no difference).
#   3. `RunNarrator` \u2014 throttled `running N/M` heartbeats while in flight.
#   4. `close_narration` \u2014 the final `ran M/M`, whatever the throttle last
#      allowed, then `ingesting\u2026` ahead of the ingest POST itself.

RUN_START_PATH = "/api/v2/runs/start"
# The client's own close of a run it opened and can no longer file: `POST
# /api/v2/runs/<runId>/abort {projectKey, agentId, reason}`. Filled in per run
# by `run_abort_path` and posted ONLY by `abort_run`, below.
RUN_ABORT_PATH = "/api/v2/runs/{run_id}/abort"
RUN_LIFECYCLE_UNAVAILABLE_CODE = "run-lifecycle-unavailable"
RUN_LEFT_OPEN_CODE = "run-left-open"
RUN_ABORTED_CODE = "run-aborted"
RUN_MAY_BE_FILED_CODE = "run-may-be-filed"
INGESTING_MESSAGE = "ingesting\u2026"
NARRATION_LABEL_JOINER = " \u00b7 "


class RunNarrator:
    """Throttled in-run `running N[/M]` narration, shared by every stack.

    `post(message)` delivers one heartbeat message; it is best-effort, so any
    failure it raises is reported once on stderr and never reaches the wrapped
    run. `recognise(line)` is the stack's own reading of one output line: a
    bool (is it one completed test/class?) or a `(completed, label)` pair,
    where a non-None `label` replaces the current file/class shown after the
    count (`running 1843/2936 \u00b7 roadmap.test.ts`) whether or not that line
    completed anything.

    `total` is an int or a zero-arg callable re-read at every post; at or below
    zero it is unknown and the denominator is dropped (`running N`). A known
    total is clamped to at least the completed count, so M never reads below N.
    `unit` names what the count counts when it is not tests (mvn's `classes`)
    and follows the count: `running N/M classes`.

    Throttle: the first update fires once `min_seconds` have passed since the
    first completion OR `min_completions` have accumulated; each later one
    needs the same distance past the last POSTED update. `finish()` posts the
    final count unconditionally and without the label: `ran <counted>/<M>`,
    what was actually observed over the best-known total, so a run that
    stopped short never claims the whole suite ran (`ran N/N` when no total
    was ever known)."""

    def __init__(self, post, recognise, total=0, min_seconds=2.0,
                 min_completions=10, unit=None):
        self._post = post
        self._recognise = recognise
        self._total = total
        self._unit_suffix = f" {unit}" if unit else ""
        self._min_seconds = min_seconds
        self._min_completions = min_completions
        self._count = 0
        self._label = None
        self._first_seen = None   # monotonic ts of the first completion
        self._posted_at = None    # monotonic ts of the last posted update
        self._posted_count = 0
        self._post_failed = False

    @property
    def count(self):
        """Completions observed so far."""
        return self._count

    def observe(self, line):
        """Feed one line of the runner's output."""
        verdict = self._recognise(line)
        if isinstance(verdict, tuple):
            completed, label = verdict
            if label is not None:
                self._label = label
        else:
            completed = verdict
        if completed:
            self._completed()

    def finish(self):
        """Post the final count \u2014 always, with no label: the completions
        observed over the best-known total (`ran N/M`), or over themselves when
        no total was ever known (`ran N/N`)."""
        total = self._resolved_total()
        final = total if total > 0 else self._count
        self._deliver(f"ran {self._count}/{final}{self._unit_suffix}")

    def say(self, message):
        """Post one message outside the throttle, as best-effort as the rest."""
        self._deliver(message)

    def _resolved_total(self):
        total = self._total() if callable(self._total) else self._total
        total = total or 0
        return max(total, self._count) if total > 0 else 0

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
        total = self._resolved_total()
        message = (f"running {self._count}/{total}" if total > 0
                   else f"running {self._count}") + self._unit_suffix
        if self._label:
            message += NARRATION_LABEL_JOINER + self._label
        if self._deliver(message):
            self._posted_at, self._posted_count = now, self._count

    def _deliver(self, message):
        """Post `message`; True when it was delivered. Narration must never
        fail the run it reports on, so a failing post is caught \u2014 and said
        once on stderr, never silently \u2014 and the next completion retries."""
        try:
            self._post(message)
        except (Exception, SystemExit) as exc:  # the poster may sys.exit on a refused POST
            if not self._post_failed:
                self._post_failed = True
                print(f"[crucible] WARN: narration heartbeat not delivered "
                      f"({exc!r}) \u2014 the run continues", file=sys.stderr)
            return False
        return True


def narration_poster(post_fn, project_key, agent_id, identity=None):
    """The `post(message)` a client hands its `RunNarrator`: one role-OPTIONAL
    heartbeat per message (`GatedRunIdentity.PATH`, the body its `open_payload`
    builds, with no cycle \u2014 a tick never re-declares a binding), so a tick
    never re-declares nor blanks the role the agent registered with. Under a
    gated `identity`, every tick's response is observed: a tick that RE-CREATES
    a pruned row makes that row this run's to clean up (CR-CRU-056)."""
    body = _core.GatedRunIdentity(agent_id)

    def _post(message):
        resp = post_fn(_core.GatedRunIdentity.PATH,
                       body.open_payload(project_key, message=message))
        if identity is not None:
            identity.observe(resp)
        return resp
    return _post


def close_narration(narrator):
    """The run has ended: land the final count, then say the result is being
    ingested \u2014 in that order, and both BEFORE the ingest POST, so the message
    follows the run to its end instead of keeping a stale count. Inert without
    a narrator (a run with no agent narrates nothing)."""
    if narrator is None:
        return
    narrator.finish()
    narrator.say(INGESTING_MESSAGE)


def run_lifecycle_unavailable_warning(error):
    """The structured warning for a run start the SERVER refused. Degradation
    is not failure (the evidence still lands), but it is never SILENT: the
    caller asked for a measured span and got a single-shot event instead."""
    return {
        "code": RUN_LIFECYCLE_UNAVAILABLE_CODE,
        "detail": (f"could not open a run lifecycle: {error} \u2014 fell back to a "
                   f"single-shot ingest, so this run is stored with the "
                   f"tool-reported duration_ms only (no startedAt, no "
                   f"server-computed runtime_ms)"),
    }


def run_left_open_warning(run_id, cause):
    """The structured warning for a run this client OPENED and then could not
    close. It names the settlement path precisely, because the alternative
    reading \u2014 "the run was lost" \u2014 is wrong and would send an operator hunting
    for a missing event. ONE wording for the fleet, built only by `abort_run`:
    an exit that files nothing first posts the client's own abort, and this
    warning rides its envelope when that abort itself failed (the board refused
    it, or could not be reached), so the server's own sweep still settles it."""
    # THE DETAIL NAMES NO CR AND NO ROUTE (CR-CRU-097 AC3a). This string is
    # emitted to the user in the AXI envelope on ANY project's board, so it
    # states what settles the run \u2014 the server's own auto-abort \u2014 and nothing
    # about our backlog. The lineage lives here: the client-side abort route
    # CR-CRU-017 \u00a7S2 designed now exists and `abort_run` posts it first; this
    # warning means that post did not settle the run.
    return {
        "code": RUN_LEFT_OPEN_CODE,
        "detail": (f"{cause} \u2014 run {run_id} was never closed by an ingest, "
                   f"and the client's abort of it was not accepted (refused, "
                   f"or the board could not be reached), so the server "
                   f"settles it with its own auto-abort \u2014 reason `agent "
                   f"died` as soon as this agent tombstones, else `abandoned` "
                   f"once the run is older than the `run_abandon_ms` limit "
                   f"the server resolves from the crucible.toml beside its "
                   f"database. The run is abandoned, not lost"),
    }


def run_left_open_help():
    """CR-CRU-048's rule \u2014 the state actually reached is "an open run is being
    settled by the server", so the next action is to WATCH that settlement and
    then re-run, never the verb's normal successor."""
    return ["status", "re-run the verb to record a fresh run"]


def run_aborted_warning(run_id, reason):
    """The structured warning for a run this client OPENED, could not file, and
    closed itself: the board settled it `aborted` with `reason`, so nothing is
    left open for the server's sweep."""
    return {
        "code": RUN_ABORTED_CODE,
        "detail": (f"run {run_id} was aborted: {reason} \u2014 nothing was "
                   f"ingested for it"),
    }


#: The board's refusals of an abort for a run that is no longer open, as its
#: run-close and abort answers word them (`resolveRunClose`, `handleRunAbort`, src/v2.ts).
_SETTLED_ABORT_REFUSAL = re.compile(r"\bHTTP 409\b.*(?:a settled run cannot be closed twice|settled before it could be aborted)")


def run_may_be_filed_warning(run_id, error):
    """The structured warning for a run whose ingest answer was lost with its
    connection and whose abort the board refused because the run is already
    settled: the board may have filed the run before the connection dropped,
    so it is not left open, and the client never saw its figures."""
    return {
        "code": RUN_MAY_BE_FILED_CODE,
        "detail": (f"the connection to the board was lost before it answered "
                   f"the ingest, and it refused the abort because the run is "
                   f"already settled ({error}) \u2014 the board may hold the run, "
                   f"filed before the connection dropped; read it back with "
                   f"`run {run_id}` or `runs --cycle <id>`. This envelope's "
                   f"figures are null because the client never saw the answer"),
    }


def run_abort_path(run_id):
    """`RUN_ABORT_PATH` for ONE run."""
    return RUN_ABORT_PATH.format(run_id=urllib.parse.quote(str(run_id), safe=""))


def abort_run(post_fn, project_key, agent_id, run_id, reason, *,
              answer_lost=False):
    """Close a run this client opened and can no longer file: ONE `POST
    /api/v2/runs/<runId>/abort {projectKey, agentId, reason}` through the
    client's own `post_fn`, `reason` naming the exit that reached it.

    Returns the ONE warning that exit's envelope carries for the run:
    `run-aborted` when the board settled it, else `run-left-open` (the abort
    was refused or never reached the board, so the server's own sweep still
    settles the run). The fleet's every abort goes through here.

    `answer_lost` says the ingest's connection was lost before its answer
    arrived: a board that then refuses the abort because the run is already
    settled may have filed it, and the warning says so instead
    (`run_may_be_filed_warning`)."""
    resp = post_fn(run_abort_path(run_id),
                   {"projectKey": project_key, "agentId": agent_id,
                    "reason": reason}) or {}
    _core._settle_gated_run(run_id)
    if resp.get("ok"):
        print(f"[crucible] run {run_id} aborted: {reason}", file=sys.stderr)
        return run_aborted_warning(run_id, reason)
    error = resp.get("error") or "the board did not settle it"
    if answer_lost and _SETTLED_ABORT_REFUSAL.search(error):
        print(f"[crucible] WARN: run {run_id} is already settled on the board "
              f"\u2014 it may have filed the run before the connection dropped",
              file=sys.stderr)
        return run_may_be_filed_warning(run_id, error)
    print(f"[crucible] WARN: the abort of run {run_id} was not accepted "
          f"({error}) \u2014 it is left to the server's auto-abort", file=sys.stderr)
    return run_left_open_warning(
        run_id, f"{reason} (the abort answered: {error})")


def no_report_left_open_warnings(run_id, artifact, *, post_fn, project_key,
                                 agent_id):
    """The run-closing step a suite verb takes when its runner produced no
    `artifact`, so nothing will ever file the run it opened: `abort_run`'s one
    warning, or `[]` when no run was opened (a single-shot run leaves nothing
    on the board to settle)."""
    if not run_id:
        return []
    return [abort_run(
        post_fn, project_key, agent_id, run_id,
        f"the runner produced no {artifact}, so there was nothing to ingest")]


def junit_testcase_count(paths):
    """The number of `<testcase>` elements across the JUnit reports at
    `paths` \u2014 the result count of a run whose report is decoded by the BOARD,
    taken before that report is offered to it.

    `None` when a report cannot be read or parsed: the count is then unknown,
    so `ran_nothing` cannot claim the run ran nothing, and the report goes to
    the board as it stands (whose own decoder names what is wrong with it)."""
    count = 0
    for path in paths:
        try:
            # pi-lens-ignore: opengrep:python.lang.security.use-defused-xml-parse.use-defused-xml-parse, Semgrep:python.lang.security.use-defused-xml-parse.use-defused-xml-parse — parses the JUnit report the local runner just wrote; the clients are stdlib-only
            root = ET.parse(path).getroot()  # noqa: S314
        except (ET.ParseError, OSError) as exc:
            print(f"[crucible] WARN: could not count the results in {path} "
                  f"({exc}) \u2014 it is filed as it stands", file=sys.stderr)
            return None
        count += sum(1 for _ in root.iter("testcase"))
    return count


def junit_non_skipped_count(paths):
    """The number of `<testcase>` elements carrying no `<skipped>` child across
    the JUnit reports at `paths` \u2014 the cases a run actually ran, taken before
    its reports are offered to the board.

    `None` when a report cannot be read or parsed, as `junit_testcase_count`
    answers: the count is then unknown."""
    count = 0
    for path in paths:
        try:
            # pi-lens-ignore: opengrep:python.lang.security.use-defused-xml-parse.use-defused-xml-parse, Semgrep:python.lang.security.use-defused-xml-parse.use-defused-xml-parse — parses the JUnit report the local runner just wrote; the clients are stdlib-only
            root = ET.parse(path).getroot()  # noqa: S314
        except (ET.ParseError, OSError) as exc:
            print(f"[crucible] WARN: could not count the results in {path} "
                  f"({exc}) \u2014 it is filed as it stands", file=sys.stderr)
            return None
        count += sum(1 for case in root.iter("testcase")
                     if case.find("skipped") is None)
    return count


# The health route the shared ingest reads before it sends, and the board
# version from which a board decodes the reports the clients send inline.
INGEST_HEALTH_PATH = "/api/health"
INGEST_CODEC_VERSION_FLOOR = "0.4.0"
INGEST_RUNS_PATH = "/api/v2/runs"
INGEST_BODY_LIMIT_KEY = "ingest_body_bytes"
_HTTP_413 = re.compile(r"^HTTP 413\b")


def _read_report_texts(paths):
    """`(texts, None)`: each report file's text, in path order \u2014 or
    `(None, refusal)`: the refusal before sending that names the first path
    that could not be read (a directory where the file should be, a file
    without read permission)."""
    texts = []
    for path in paths:
        try:
            with open(path, encoding="utf-8", errors="replace") as handle:
                texts.append(handle.read())
        except OSError as exc:
            reason = exc.strerror or type(exc).__name__
            return None, (f"the report {path} could not be read ({reason}); "
                          f"nothing was sent")
    return texts, None


def _ingest_health_refusal(health, codec, coverage_codec):
    """(PURE) Why the board whose health is `health` cannot take this run's
    reports \u2014 its health unreadable, or it decodes no codec the run needs \u2014
    or `None` when it can."""
    if not isinstance(health, dict) or health.get("ok") is False:
        error = health.get("error") if isinstance(health, dict) else None
        return (f"the board's {INGEST_HEALTH_PATH} could not be read "
                f"({error or 'no error was given'}), so nothing shows that it "
                f"decodes this run's reports; nothing was sent")
    version = health.get("version") or "an unstated version"
    codecs = health.get("codecs")
    needed = [("test", codec)]
    if coverage_codec is not None:
        needed.append(("coverage", coverage_codec))
    if not isinstance(codecs, dict):
        lacking = [name for _kind, name in needed]
    else:
        lacking = [name for kind, name in needed
                   if not (isinstance(codecs.get(kind), list)
                           and name in codecs[kind])]
    if not lacking:
        return None
    return (f"the board (version {version}) does not decode "
            f"{', '.join(f'`{name}`' for name in lacking)} reports: the client "
            f"sends its reports for the board to decode, which needs a board of "
            f"version {INGEST_CODEC_VERSION_FLOOR} or later; nothing was sent")


def _ingest_body_limit(health):
    """(PURE) Health's `limits.ingest_body_bytes`, or `None` when health
    advertises no limit."""
    limits = health.get("limits")
    limit = (limits.get(INGEST_BODY_LIMIT_KEY)
             if isinstance(limits, dict) else None)
    if isinstance(limit, bool) or not isinstance(limit, int):
        return None
    return limit


def ingest_reports(post_fn, get_fn, *, stack, project_key, agent_id, codec,
                   report_paths, raw=None, coverage_codec=None,
                   coverage_paths=(), tier=None, context=None, run_id=None,
                   release=None, runner_exit=None):
    """The one ingest of a run's reports: the board's health is read first,
    once, through `get_fn`, and the run is refused before anything is sent when
    that health cannot be read, when it names no codec the run needs (the
    refusal names its `version` and the version floor), when a report or
    coverage file cannot be read (the refusal names its path), or when the
    body as `post_ingest` stamps it is larger than `limits.ingest_body_bytes`.

    Otherwise ONE `POST /api/v2/runs` goes out through `post_ingest`, carrying
    `codec`, `data` (each report's text, in path order), `coverage` when a
    coverage codec and its reports are given, `raw`, and `tier`, `context`,
    `runId`, `release` and `runnerExit` when given; the board's answer is
    returned, a 413 reported naming `ingest_body_bytes`.

    A refusal before sending answers `{ok: False, error, warnings}`; with a
    run open it is aborted through `abort_run`, the refusal its reason, and
    `warnings` carries the warning that abort produced.

    On every path it returns by it prints the run's one human ingest line on
    stderr (`_print_ingest_line`), the last line it prints: after a refusal's
    `[crucible] ERROR:` line and, with a run open, after the abort's line."""
    measures_coverage = coverage_codec is not None and bool(coverage_paths)
    health = get_fn(INGEST_HEALTH_PATH)
    refusal = _ingest_health_refusal(
        health, codec, coverage_codec if measures_coverage else None)
    payload = None
    data = coverage_data = None
    if refusal is None:
        data, refusal = _read_report_texts(report_paths)
    if refusal is None and measures_coverage:
        coverage_data, refusal = _read_report_texts(coverage_paths)
    if refusal is None:
        payload = {"projectKey": project_key, "agentId": agent_id,
                   "codec": codec, "data": data}
        if measures_coverage:
            payload["coverage"] = {"codec": coverage_codec,
                                   "data": coverage_data}
        optional = (("raw", raw), ("tier", tier), ("context", context),
                    ("runId", run_id), ("runnerExit", runner_exit))
        payload.update({key: value for key, value in optional
                        if value is not None})
        limit = _ingest_body_limit(health)
        if limit is not None:
            # Measured as `post_ingest` stamps the body and `http_request`
            # encodes it.
            stamped = {**payload, "stack": stack}
            if release:
                stamped["release"] = release
            size = len(json.dumps(stamped).encode())
            if size > limit:
                refusal = (f"the run's ingest body is {size} bytes, over the "
                           f"board's {INGEST_BODY_LIMIT_KEY} limit of {limit}; "
                           f"nothing was sent")
    if refusal is not None:
        print(f"[crucible] ERROR: {refusal}", file=sys.stderr)
        warnings = ([abort_run(post_fn, project_key, agent_id, run_id, refusal)]
                    if run_id else [])
        resp = {"ok": False, "error": refusal, "warnings": warnings}
    else:
        resp = _core.post_ingest(post_fn, INGEST_RUNS_PATH, payload, stack=stack,
                           release=release)
        error = resp.get("error") if isinstance(resp, dict) else None
        if isinstance(error, str) and _HTTP_413.match(error):
            resp = {**resp, "error": (
                f"{error} \u2014 the body was larger than the board's "
                f"{INGEST_BODY_LIMIT_KEY} limit")}
    _print_ingest_line(resp, codec)
    return resp


def _print_ingest_line(resp, codec):
    """Print a run's human ingest line on stderr from the board's answer: its
    `run` block's figures (`None` without one), the coverage axes it kept,
    and its error when it carries one."""
    run, answer = filed_run(resp), resp if isinstance(resp, dict) else {}
    coverage = run.get("coverage")
    coverage = coverage if isinstance(coverage, dict) else {}
    cov_line = "".join(
        f" {label}={coverage[key].get('percent')}%"
        for key, label in (("lines", "lines"), ("functions", "funcs"))
        if isinstance(coverage.get(key), dict))
    error = f" error={answer['error']}" if answer.get("error") else ""
    print(f"ingest: ok={answer.get('ok')} codec={codec} "
          f"passed={run.get('passed')} failed={run.get('failed')} "
          f"pending={run.get('pending')} total={run.get('total')} "
          f"files={run.get('files')}{cov_line}{error}", file=sys.stderr)


def filed_run(resp):
    """(PURE) The `run` block of the board's ingest answer, `{}` when the run
    was not filed (refused, unreachable, too large) and so has no figures."""
    run = resp.get("run") if isinstance(resp, dict) else None
    return run if isinstance(run, dict) else {}


#: The figures a run envelope's `run:` block states, in order.
RUN_FIGURE_KEYS = ("passed", "failed", "pending", "total", "files")


def emit_run_axi(verb, resp, context, emit_fn, *, ok=None, help_steps=None,
                 warnings=(), fields=None, coverage=False):
    """Emit the envelope of a run a client filed, through the client's own
    `context` and emit function `emit_fn(verb, ok, result_fields, context,
    warnings)`; returns what `emit_fn` returns.

    Its `run:` block is the board's ingest answer (`filed_run`): `passed`,
    `failed`, `pending`, `total` and `files`, each an int or null. A run that
    was not filed (refused, unreachable, too large, its answer lost) states no
    figures: each is null beside the envelope's `error`, the answer's own.
    `help` is the caller's `help_steps` (a state-derived next step), else the
    verb's `HELP_STEPS` entry. The caller's `fields` follow `help`, in their
    order; with `coverage`, the answer's kept lines and functions percents
    follow them, absent when the board kept none (it discards a red run's
    coverage). The answer's `warnings[]` join the caller's `warnings`, after
    them. `ok` overrides the envelope's verdict (default: the answer's `ok`).

    The client builds `context`, so the cycle it echoes (`echoed_cycle_id`)
    stays the client's."""
    filed = filed_run(resp)
    run = {key: (filed.get(key) if isinstance(filed.get(key), int)
                 and not isinstance(filed.get(key), bool) else None)
           for key in RUN_FIGURE_KEYS}
    result_fields = {"run": run,
                     "help": help_steps or _core.HELP_STEPS.get(verb, ["status"])}
    result_fields.update(fields or {})
    if coverage:
        kept = filed.get("coverage")
        kept = kept if isinstance(kept, dict) else {}
        percents = {axis: kept[axis].get("percent")
                    for axis in ("lines", "functions")
                    if isinstance(kept.get(axis), dict)
                    and isinstance(kept[axis].get("percent"), (int, float))
                    and not isinstance(kept[axis].get("percent"), bool)}
        if percents:
            result_fields["coverage"] = percents
    err = resp.get("error")
    if err is not None:
        result_fields["error"] = err
    board_warnings = [w for w in (resp.get("warnings") or [])
                      if isinstance(w, dict)]
    return emit_fn(verb, bool(resp.get("ok")) if ok is None else ok,
                   result_fields, context, list(warnings or []) + board_warnings)


COVERAGE_NOT_MEASURED_CODE = "coverage-not-measured"


def coverage_not_measured_warning(where):
    """The warning a `--coverage` run carries when it left no coverage report
    to send: the run is filed with no coverage at all."""
    return {"code": COVERAGE_NOT_MEASURED_CODE,
            "detail": (f"--coverage was requested, and {where}: no coverage "
                       f"report was sent, so this run is filed with no "
                       f"coverage")}


def ran_nothing(exit_code, total):
    """(PURE) A runner that exited non-zero and whose report holds ZERO results
    ran nothing: the report EXISTS (what Playwright writes when it cannot
    start), but there is no result in it to file. Such a run takes the same
    exit as a runner that wrote no report at all (`emit_ran_nothing`).

    A runner that exits 0 with zero results, and a report whose count is
    unknown (`total` None), are NOT this shape: they are filed as before."""
    return bool(exit_code) and total == 0


def runner_exit_code(returncode):
    """(PURE) The exit a shell reports for a `subprocess` return code: a
    runner killed by a signal (a negative return code) is `128 + <signal>`,
    so SIGKILL is `137`; every ordinary exit is returned unchanged. This is
    the value a client sends as `runnerExit`."""
    return 128 - returncode if returncode < 0 else returncode


def verb_exit(runner_exit, response):
    """(PURE) The exit of a verb that ran a test runner and filed its run:
    1 when the runner exited non-zero, when the ingest `response` is not `ok`
    (refused, unreachable, too large), or when the run it filed
    (`response["run"]`) records a failure; 0 only when none of the three
    holds. Pending cases alone never make it non-zero."""
    if runner_exit:
        return 1
    if not (response or {}).get("ok"):
        return 1
    run = response.get("run")
    failed = run.get("failed") if isinstance(run, dict) else None
    if isinstance(failed, int) and failed > 0:
        return 1
    return 0


def filed_summary(resp, summary=None):
    """(PURE) The counts of the run as the BOARD filed it \u2014 the ingest
    response's `run`, which includes any case the board added \u2014 else
    `summary`: the client's own parse on a parsed route, `None` where the
    board decoded the report and the response carries no counts."""
    run = resp.get("run") if isinstance(resp, dict) else None
    if isinstance(run, dict) and all(
            isinstance(run.get(k), int) for k in ("total", "passed", "failed")):
        pending = run.get("pending")
        return {"passed": run["passed"], "failed": run["failed"],
                "pending": pending if isinstance(pending, int) else 0,
                "total": run["total"]}
    return summary


def emit_ran_nothing(verb, artifact, exit_code, output, run_id, warnings=(),
                     *, post_fn, project_key, agent_id, subject=None):
    """The exit of a run `ran_nothing` describes \u2014 the no-report exit, never
    an ingest: the run this client opened is aborted
    (`no_report_left_open_warnings`: `run-aborted`, or `run-left-open` when
    the abort is refused), and ONE ok:false envelope carries the caller's
    `warnings` and the `no_report_warning` naming the runner's exit code and
    the tail of its `output`. Returns the exit code, never 0.

    `subject` is what the warning's detail says produced no report, when it
    is more than the verb (a client that runs one of several runners names
    the one that ran); unset, it is the verb."""
    closing = no_report_left_open_warnings(
        run_id, artifact, post_fn=post_fn, project_key=project_key,
        agent_id=agent_id)
    _core.emit_axi(verb, False, {"help": _core.no_report_help(verb, artifact)},
             _core.axi_context(project_key, agent_id=agent_id),
             list(warnings) + closing
             + [_core.no_report_warning(subject or verb, artifact, exit_code, output)],
             f"[crucible] ERROR: the {verb} runner exited {exit_code} and its "
             f"{artifact} holds no results \u2014 nothing was filed")
    return exit_code or 1


class RunAbandoned(BaseException):
    """SIGINT/SIGTERM arrived while a WRAPPED run was in flight. Carries the
    signal number so the verb exits on the conventional 128+signum.

    A `BaseException`, as `KeyboardInterrupt` is: a best-effort `except
    Exception` on the way (a pre-flight lookup, a disk probe) must never
    swallow the signal and let the run carry on as if nothing had landed.

    When it escapes a gated-run bracket's body (`gated_run`), the bracket
    records what it closed on the way out: `agent_id` (the identity it opened
    and removed), `run_id` (the run `open_run` had opened inside it, already
    aborted \u2014 or filed, when the signal landed on its held ingest) and
    `warnings` (an abort's one warning; none for a filed run), so `run_verb`
    can report the exit without reaching back into the bracket."""

    def __init__(self, signum):
        super().__init__(f"run abandoned on {signal.Signals(signum).name}")
        self.signum = signum
        self.agent_id = None
        self.run_id = None
        self.warnings = []


class AbandonTrap:
    """The live state of one `abandon_trap`: its signal handler, and `held()`,
    the span a trapped signal must not cut in half.

    A step that creates something on the board and only
    learns it did from the board's ANSWER (the run identity's opening
    heartbeat) cannot be abandoned between the two: the board already holds
    the row, the client has no record of it, and the closing bracket removes
    nothing. A slow runner widens exactly that gap. Inside `held()` a signal
    is noted, not raised; it is raised as `RunAbandoned` the moment the span
    ends, once the step has recorded what it created. An untrapped run never
    installs the handler, so `held()` is then inert.

    `reported` turns True once a signal inside this trap's span has been
    turned into the exit's one `ok: false` envelope (or is on its way to
    it): a later signal then has nothing left to report."""

    def __init__(self):
        self._holding = 0
        self._pending = None
        self.reported = False

    def handle(self, signum, _frame):
        if self._holding:
            if self._pending is None:
                self._pending = signum
            return
        raise RunAbandoned(signum)

    @contextlib.contextmanager
    def held(self):
        self._holding += 1
        try:
            yield
        finally:
            self._holding -= 1
            if not self._holding and self._pending is not None:
                signum, self._pending = self._pending, None
                raise RunAbandoned(signum)


@contextlib.contextmanager
def abandon_trap(run_id):
    """Trap SIGINT/SIGTERM for as long as `run_id` names an OPEN run, turning
    the signal into a `RunAbandoned` the verb can report on. Outside a wrapped
    run (`run_id` None) this is inert and the default disposition stands \u2014
    there is nothing open to disclose. Yields the `AbandonTrap`, whose
    `held()` defers the signal across a step that must not be cut in half.

    The previous handlers are always restored, so the trap can never outlive
    the run it guards. A non-main thread cannot install handlers at all
    (`ValueError`); that is not a reason to fail a test run, so the wrap simply
    proceeds untrapped. The runner itself is reaped by `run_streamed`, which
    kills it before the exception propagates."""
    trap = AbandonTrap()
    if run_id is None:
        yield trap
        return

    previous = {}
    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, trap.handle)
    except ValueError:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        yield trap
        return
    try:
        yield trap
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def _emit_abandoned(verb, context, run_id, signum, warnings, closing):
    """The ONE ok:false envelope of an interrupted run: it names the signal and,
    when a run was open, the run and how it was settled (`closing`, its
    `abort_run` warning; None with a `run_id` when the run was filed).
    Returns the exit code, 128+signum."""
    if _core._gated_trap is not None:
        # Printed inside a gated bracket: its closing step must not print a
        # second one for a signal that lands after this.
        _core._gated_trap.reported = True
    signame = signal.Signals(signum).name
    warnings = list(warnings or [])
    if closing is None and run_id is None:
        fields = {"signal": signame}
        tail = "no run was open on the board"
    elif closing is None:
        fields = {"runId": run_id, "signal": signame}
        tail = f"run {run_id} was filed before the exit"
    else:
        settled = ("aborted" if closing["code"] == RUN_ABORTED_CODE
                   else "left open for the server's auto-abort")
        fields = {"runId": run_id, "signal": signame,
                  "help": run_left_open_help()}
        tail = f"run {run_id} {settled}"
        warnings.append(closing)
    _core.emit_axi(verb, False, fields, context, warnings,
             f"{verb}: ok=False \u2014 {signame} interrupted the run; {tail}")
    return 128 + signum


def emit_bracket_abandoned(verb, abandoned, context):
    """The exit of a signal that escaped a gated-run bracket: the bracket has
    already settled the run it opened (when it opened one) \u2014 filed by a held
    ingest, or aborted \u2014 and removed its identity, so all that is left is the
    one envelope. Returns 128+signum."""
    closing = abandoned.warnings[-1] if abandoned.warnings else None
    return _emit_abandoned(verb or "unknown", context, abandoned.run_id,
                           abandoned.signum, abandoned.warnings[:-1], closing)


def emit_run_abandoned(verb, project_key, agent_id, run_id, abandoned,
                       warnings=None, *, post_fn):
    """The signal path's ONLY output: the run it opened is closed through
    `abort_run` (reason naming the signal), then one ok:false envelope names
    the signal and the run, aborted or \u2014 when that abort failed \u2014 left to
    the server's auto-abort. Called from the verb's `except`, so the abort
    lands BEFORE a gated run's closing identity tombstone in its `finally`.
    Returns the exit code, 128+signum.

    CR-CRU-094 \u00a7S3 \u2014 `warnings` are the findings this run had ALREADY
    accumulated when the signal landed (the pre-flight `no-cycle` among them).
    The envelope here is built from a literal, so without them this one exit
    would print a warning on stderr and omit it from `warnings[]`; the
    two-channel guarantee holds on EVERY exit or on none.

    A run the board never opened (`run_id` None: the runner of a run whose
    `/runs/start` was refused or skipped, trapped by the gated bracket) has
    nothing to abort; the envelope then names the signal alone."""
    closing = None
    if run_id is not None:
        signame = signal.Signals(abandoned.signum).name
        closing = abort_run(post_fn, project_key, agent_id, run_id,
                            f"{signame} interrupted the wrapped run")
    return _emit_abandoned(verb, _core.axi_context(project_key, agent_id=agent_id),
                           run_id, abandoned.signum, warnings, closing)


def open_run(post_fn, project_key, agent_id, stack, tier=None, context=None,
             *, release=None):
    """Open the run BEFORE the suite is spawned. Returns `(run_id, warnings)`.

    A refusal degrades to single-shot with a warning naming the fallback. An
    `ok` answer that carries no runId is a server that simply did not open one
    (nothing failed, so there is nothing to report): the ingest is then the
    unchanged single-shot POST.

    \u00a7S1 \u2014 `release` rides the start body's TOP-LEVEL `release`, and a
    refused release run raises `ReleaseRunRefused` instead of degrading: its
    single-shot ingest would carry the same release and be refused in turn."""
    payload = {"projectKey": project_key, "agentId": agent_id, "stack": stack}
    if tier:
        payload["tier"] = tier
    if context:
        payload["context"] = context
    if release:
        payload["release"] = release
    # Inside a gated bracket the board creates the run before its answer is
    # read, so the POST is held: a signal landing on it is raised once the run
    # is recorded, and the bracket aborts it.
    with _core._gated_held():
        resp = post_fn(RUN_START_PATH, payload) or {}
        run_id = resp.get("runId")
        if run_id:
            _core._note_gated_run(post_fn, project_key, agent_id, run_id)
    if run_id:
        print(f"[crucible] run started: {run_id}", file=sys.stderr)
        return run_id, []
    if resp.get("ok"):
        return None, []
    error = resp.get("error") or "the server opened no run"
    if release:
        raise _core.ReleaseRunRefused(release, error)
    print(f"[crucible] WARN: run lifecycle unavailable ({error}) \u2014 "
          f"single-shot ingest", file=sys.stderr)
    return None, [run_lifecycle_unavailable_warning(error)]


# How long an interrupted runner's process group is given to exit on SIGTERM
# before what is left of it is sent SIGKILL.
RUNNER_GROUP_GRACE_SECONDS = 2.0
_RUNNER_GROUP_POLL_SECONDS = 0.05


def _signal_runner_group(pgid, signum):
    """Send `signum` to every process in the runner's group. Returns False when
    no process is left in it (the group is already down), True otherwise;
    signal 0 is therefore the liveness probe."""
    try:
        os.killpg(pgid, signum)
    except ProcessLookupError:
        return False
    return True


def _take_down_runner_group(proc):
    """Take an interrupted runner's whole tree down: SIGTERM to its process
    group (the runner leads it, in a session of its own), SIGKILL to whatever
    is still in it after `RUNNER_GROUP_GRACE_SECONDS`, and the runner reaped.

    SIGINT/SIGTERM are blocked for the span, so a second Ctrl-C cannot cut
    the takedown in half and leave part of the tree alive; a signal that
    arrives meanwhile is delivered once the group is down."""
    pgid = proc.pid
    blocked = signal.pthread_sigmask(signal.SIG_BLOCK,
                                     {signal.SIGINT, signal.SIGTERM})
    try:
        deadline = time.monotonic() + RUNNER_GROUP_GRACE_SECONDS
        _signal_runner_group(pgid, signal.SIGTERM)
        while time.monotonic() < deadline:
            # Reap the runner as soon as it exits, so only a LIVE member
            # keeps the group answering the probe.
            proc.poll()
            if not _signal_runner_group(pgid, 0):
                break
            time.sleep(_RUNNER_GROUP_POLL_SECONDS)
        else:
            _signal_runner_group(pgid, signal.SIGKILL)
        proc.wait()
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, blocked)


def run_streamed(cmd, cwd, env, log_path, narrator=None, capture=False):
    """Run `cmd`, streaming its combined stdout+stderr LIVE: every line goes to
    stderr and to `log_path` as the runner produces it, and to `narrator` for
    progress. Returns a `CompletedProcess` whose `stdout` is the whole capture,
    byte-identical to a capture-after-exit (the parsers read it unchanged).

    stdout stays the client's envelope channel, so the echo is on stderr. With
    neither a log nor a narrator there is nothing to tee, and the runner
    inherits stdio \u2014 unless the caller reads the capture anyway (`capture`: a
    no-report fallback that ingests the runner's own words), in which case the
    run is teed exactly as above.

    In both cases the runner starts in a session of its own, so its whole tree
    is one process group. An interruption while it is live (a signal trap
    raising, a `KeyboardInterrupt` with no trap installed, or any other
    exception) takes that group down before it propagates
    (`_take_down_runner_group`), so no descendant is left behind. A runner
    that exits on its own is never signalled. The group no longer receives a
    terminal's Ctrl-C directly; the client does, and takes it down."""
    if not log_path and narrator is None and not capture:
        with subprocess.Popen(cmd, cwd=cwd, env=env,
                              start_new_session=True) as proc:
            try:
                returncode = proc.wait()
            except BaseException:
                _take_down_runner_group(proc)
                raise
        return subprocess.CompletedProcess(cmd, returncode)
    lines = []
    with contextlib.ExitStack() as stack:
        log = None
        if log_path:
            try:
                log = stack.enter_context(open(log_path, "w"))
            except OSError as e:
                print(f"[crucible] WARN: could not write run log to {log_path}: {e}",
                      file=sys.stderr)
        proc = stack.enter_context(subprocess.Popen(
            cmd, cwd=cwd, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            bufsize=1, start_new_session=True,
        ))
        stream = proc.stdout
        assert stream is not None  # stdout=PIPE always yields a stream
        echo = True
        try:
            for line in stream:
                lines.append(line)
                # \u00a7S3 \u2014 a closed stderr ends the echo, never
                # the run: the capture and the log keep going.
                if echo:
                    echo = _core.write_to_pipe("stderr", line)
                if log is not None:
                    log.write(line)
                    log.flush()
                if narrator is not None:
                    narrator.observe(line)
            # The runner's output can end before the runner does: the wait
            # stays inside the guard, so a signal that lands before it is
            # reaped still takes its group down.
            returncode = proc.wait()
        except BaseException:
            _take_down_runner_group(proc)
            raise
    out = "".join(lines)
    if log is not None:
        print(f"[crucible] run log \u2192 {log_path} ({len(out)} bytes)",
              file=sys.stderr)
    return subprocess.CompletedProcess(cmd, returncode, stdout=out)
