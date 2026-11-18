"""Fixtures for the `release-notes` suites: a fake board (`RecordingBoard`)
seeded scenario by scenario, one project per scenario, the six clients driven
as genuine subprocesses, and a capturing proxy that records every request a
client makes (and can answer one chosen read with an error).

Not a test module: it holds no `TestCase`.

The board is `tests/client/live_run_harness.py`'s `RecordingBoard`, a stand-in
on loopback. A scenario is SEEDED here the way an operator builds one on the
real board — a release is proposed, its CRs declared in the queue, each CR
landed by a closed plan (with or without a merge, with or without a title),
the release shipped with the CRs it names — and the seeder scripts, for each
project, the four reads `release-notes` makes in the server's own shapes:

- `GET …/history` — one row per past release, newest version first, as
  `projectHistory` (src/v2.ts) composes it from those records;
- `GET …/plans?status=closed` — the closed plans, each with its `closedAt`
  (epoch ms, strictly increasing in landing order), its title when it was
  filed with one, and `merge.commit` only when it was closed with a merge;
- `GET …/queue` — each declared CR with its queue title, wave and release;
- `GET …/release-proposals` — the live proposals.

What the server STORES for those writes, and the history it derives, is the
server's half and is held by the bun route tests (CR-CRU-262 route pass,
red970-report row 5): `history-by-release-read.test.ts`,
`plans-status-filter.test.ts`, `closed-plans-read-carries-merge-and-title-
verbatim.test.ts`, `plans.test.ts` and `queue-registration.test.ts`. These
suites keep the CLIENT's half: what it reads, in which order, and what it
drafts from the answers.

Every project directory declares its board in its own `crucible.toml` and is
checked by `declare_and_require_board`, so no drive can resolve another board.
"""

import contextlib
import datetime
import importlib.util
import itertools
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid
from pathlib import Path

from tests.client.live_run_harness import (  # noqa: F401 -- REPO_ROOT is re-exported to the release-notes modules
    REPO_ROOT, RecordingBoard, install_project, scrubbed_env)
from tests.client.client_fleet_envelope_census_helpers import declare_and_require_board
from tests.client import TEST_INSTALL_CLIENTS

CLIENTS_DIR = TEST_INSTALL_CLIENTS
TOON_PATH = CLIENTS_DIR / "toon.py"
RELEASE_MODULE = CLIENTS_DIR / "_crucible_release.py"
CORE_MODULE = CLIENTS_DIR / "_crucible_axi.py"

VERB = "release-notes"

#: The six clients that reach the verb, keyed as the fleet keys them.
CLIENT_FILES = {
    "bun": "bun-crucible.py",
    "python": "python-crucible.py",
    "rust": "rust-crucible.py",
    "mvn": "mvn-crucible.py",
    "arduino": "arduino-crucible.py",
    "go": "go-crucible.py",
}

ORCHESTRATOR = "release-notes-fixture-orchestrator"

#: A commit-shaped id for every merge and every ship the fixtures record.
FIXTURE_COMMIT = "0123456789abcdef0123456789abcdef01234567"

#: The usage form a usage refusal names.
USAGE_FORM = "release-notes --release <label>"

#: The help a held label's refusal carries, verbatim.
HELD_LABEL_HELP = "queue --fields release,seq,points,dependsOn"

#: What the stub answers a failed read with: its own error, and its own help.
STUB_ERROR = "stub-board-refused-this-read"
STUB_HELP = "stub-board-help: retry the read once the board answers"

#: Environment keys a drive must never inherit from the developer's shell.
_EXTRA_SCRUB = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_AGENT",
                "WORKFLOW_RELEASE")


# ── dates and the expected section ──────────────────────────────────────────

def utc_date(epoch_seconds):
    """The UTC calendar date of an epoch-seconds instant, `YYYY-MM-DD`."""
    return datetime.datetime.fromtimestamp(
        epoch_seconds, tz=datetime.timezone.utc).strftime("%Y-%m-%d")


def today_utc():
    """Today's UTC date, `YYYY-MM-DD`."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


def utc_epoch(year, month, day, hour=0, minute=0):
    """Epoch seconds of a UTC wall-clock instant."""
    return int(datetime.datetime(year, month, day, hour, minute,
                                 tzinfo=datetime.timezone.utc).timestamp())


def expected_section(label, date, cr_lines):
    """The section exactly as the spec writes it, ending in one newline: the
    dated heading, then — only when there is a line — a blank line, the
    `### Changed` group, a blank line and one `- …` line per completed CR."""
    text = f"## [{label}] - {date}\n"
    if cr_lines:
        text += "\n### Changed\n\n" + "".join(f"{line}\n" for line in cr_lines)
    return text


# ── the board and its projects ──────────────────────────────────────────────

class FakeBoard:
    """A `RecordingBoard` and the scratch directory its projects live in."""

    def __init__(self, name):
        self.tmpdir = tempfile.mkdtemp(prefix=f"{name}-")
        self.recording = RecordingBoard()
        self.base = self.recording.url
        # Plan and cycle ids are per board, as the store numbers them.
        self._ids = itertools.count(1)

    def next_id(self):
        return next(self._ids)

    def close(self):
        try:
            self.recording.close()
        finally:
            shutil.rmtree(self.tmpdir, ignore_errors=True)


def start_board(name):
    """A fresh fake board for one module's scenarios."""
    return FakeBoard(name)


def _version_key(label):
    """A release label as `compareVersionLabels` orders it: numerically, part
    by part."""
    return tuple(int(part) if part.isdigit() else 0
                 for part in str(label).split("."))


def _history_row(entry, wave_of, completed):
    """One release's history row, as `historyRow` (src/v2.ts) shapes it:
    its completed CRs by wave (a wave with none is not listed), the rest
    counted pending, and its state."""
    crs = entry["crs"]
    shipped = "shippedAt" in entry
    done = [cr for cr in crs if cr in completed]
    waves = {}
    for cr in crs:
        if cr not in wave_of:
            continue
        held = waves.setdefault(wave_of[cr], {"crs": [], "pendingCount": 0})
        if cr in completed:
            held["crs"].append(cr)
        else:
            held["pendingCount"] += 1
    state = ("shipped" if shipped else
             "ship not recorded" if crs and len(done) == len(crs)
             else "in progress")
    row = {"labels": [entry["label"]], "state": state}
    if shipped:
        row.update({"shippedAt": entry["shippedAt"],
                    "tag": f"v{entry['label']}", "commit": FIXTURE_COMMIT})
    if "targetAt" in entry:
        row["targetAt"] = entry["targetAt"]
    row.update({
        "crCount": len(done), "pendingCount": len(crs) - len(done),
        "waves": [{"wave": wave, "crs": held["crs"],
                   "pendingCount": held["pendingCount"]}
                  for wave, held in sorted(
                      waves.items(), key=lambda kv: _version_key(kv[0]),
                      reverse=True) if held["crs"]],
        "workflows": [{"label": entry["label"], "gateRuns": [],
                       "verificationRuns": 0}]})
    return row


class SeededProject:
    """One project on a fake board, and a project directory whose own
    configuration resolves that board. Every seeding call re-scripts the
    project's four reads in the server's shapes."""

    def __init__(self, board, name):
        self.board = board
        self.base = board.base
        self.name = name
        self.key = str(uuid.uuid4())
        self._proposals = []      # [{label, targetAt}]
        self._queue = []          # [{cr, title, wave, release}]
        self._plans = []          # closed plans, in closing order
        self._ships = {}          # label -> {releasedAt, crs}
        # `closedAt` in epoch ms, strictly increasing close after close, as
        # the server stamps it on each close.
        self._clock_ms = int(time.time() * 1000) - 60_000
        self.project_dir = self.dir_through(self.base)
        self._publish()

    def dir_through(self, base):
        """A fresh project directory for this project whose configuration
        resolves `base` (the board itself, or a proxy in front of it)."""
        project_dir = tempfile.mkdtemp(prefix="release-notes-project-",
                                       dir=self.board.tmpdir)
        install_project(project_dir, base, self.key, self.name)
        declare_and_require_board(project_dir, base, "the release-notes fixture")
        return project_dir

    # -- the roadmap --------------------------------------------------------

    def propose(self, label):
        self._proposals.append({"label": label,
                                "targetAt": utc_epoch(2027, 6, 1)})
        self._publish()

    def declare(self, cr, title, release, wave="1"):
        """Declare `cr` in `release` with its queue title."""
        self._queue.append({"cr": cr, "title": title, "wave": wave,
                            "release": release})
        self._publish()

    # -- landing ------------------------------------------------------------

    def land(self, cr, title=None, wave="1", merged=True):
        """A plan for `cr` (titled when `title` is given), its one cycle
        done, closed now — with a merge commit, so the CR lands, or with
        `merged=False` without one, so it does not land by it."""
        self._clock_ms += 1000
        plan_id = self.board.next_id()
        plan = {"planId": plan_id, "projectKey": self.key, "cr": cr,
                "wave": wave, "status": "closed",
                "cycles": [{"id": self.board.next_id(), "label": "solo",
                            "kind": "red-green", "status": "done",
                            "activatedAt": self._clock_ms - 500,
                            "doneAt": self._clock_ms - 100}],
                "closedAt": self._clock_ms}
        if title is not None:
            plan["title"] = title
        if merged:
            plan["merge"] = {"commit": FIXTURE_COMMIT}
        self._plans.append(plan)
        self._publish()
        return plan_id

    # -- shipping -----------------------------------------------------------

    def ship(self, label, released_at, crs=()):
        """The release record a ship writes: `released_at` (epoch seconds)
        and the CRs it names (none named when `crs` is empty)."""
        self._ships[label] = {"releasedAt": released_at,
                              "crs": list(crs) if crs else None}
        self._publish()

    # -- the answers --------------------------------------------------------

    def closed_plans(self):
        """The closed plans, as `GET …/plans?status=closed` lists them."""
        return json.loads(json.dumps(self._plans))

    def queue_entries(self):
        """The queue, as `GET …/queue` lists it."""
        entries = []
        for seq, entry in enumerate(self._queue, start=1):
            mine = [p for p in self._plans if p["cr"] == entry["cr"]]
            merged = [p for p in mine if p.get("merge")]
            row = {"cr": entry["cr"], "title": entry["title"],
                   "wave": entry["wave"], "dependsOn": [],
                   "status": "COMPLETED" if merged else "PENDING",
                   "seq": seq, "release": entry["release"]}
            if mine:
                row["planId"] = mine[-1]["planId"]
            entries.append(row)
        return entries

    def history(self):
        """The history rows, as `projectHistory` (src/v2.ts) composes them
        from this project's records: a shipped release's CRs are those its
        record names (else the queue's), an unshipped one's are the queue's,
        and a CR no release holds falls in the release that succeeds its
        close. Only a past release — shipped, or with a completed CR — is a
        row; newest version first."""
        labels = self._release_labels()
        completed = {p["cr"] for p in self._plans if p.get("merge")}
        for ship in self._ships.values():
            completed.update(ship["crs"] or [])
        self._place_unheld_crs(labels)
        wave_of = {p["cr"]: p.get("wave", "") for p in self._plans}
        wave_of.update({e["cr"]: e["wave"] for e in self._queue})
        return [_history_row(entry, wave_of, completed)
                for entry in sorted(labels.values(),
                                    key=lambda e: _version_key(e["label"]),
                                    reverse=True)
                if "shippedAt" in entry
                or any(cr in completed for cr in entry["crs"])]

    def _release_labels(self):
        """Each release label and the CRs it holds: a ship record first,
        then a proposal, then a label only the queue names."""
        queued_under = {}
        for entry in self._queue:
            queued_under.setdefault(entry["release"], []).append(entry["cr"])
        labels = {}
        for label, ship in self._ships.items():
            crs = ship["crs"] if ship["crs"] is not None else queued_under.get(label)
            labels[label] = {"label": label, "shippedAt": ship["releasedAt"],
                             "crs": list(dict.fromkeys(crs or []))}
        for proposal in self._proposals:
            labels.setdefault(proposal["label"], {
                "label": proposal["label"], "targetAt": proposal["targetAt"],
                "crs": list(dict.fromkeys(queued_under.get(proposal["label"]) or []))})
        for label, crs in queued_under.items():
            labels.setdefault(label, {"label": label,
                                      "crs": list(dict.fromkeys(crs))})
        return labels

    def _place_unheld_crs(self, labels):
        """A CR no release holds falls in the first release shipped at or
        after its latest close, else the lowest unshipped one."""
        held = {cr for entry in labels.values() for cr in entry["crs"]}
        timeline = sorted(labels.values(), key=lambda e: (
            (0, e["shippedAt"], ()) if "shippedAt" in e
            else (1, 0, _version_key(e["label"]))))
        unplaced = dict.fromkeys(
            [e["cr"] for e in self._queue] + [p["cr"] for p in self._plans])
        for cr in unplaced:
            if cr in held:
                continue
            closes = [p["closedAt"] for p in self._plans if p["cr"] == cr]
            at = max(closes) if closes else None
            entry = next((e for e in timeline if "shippedAt" not in e or (
                at is not None and e["shippedAt"] * 1000 >= at)), None)
            if entry is not None:
                entry["crs"].append(cr)

    def _publish(self):
        """Script the project's four reads with the answers as they stand."""
        prefix = f"/api/v2/projects/{self.key}"
        recording = self.board.recording
        last_closed = self._plans[-1]["cr"] if self._plans else None
        recording.answer("GET", f"{prefix}/history",
                         {"ok": True, "releases": self.history(),
                          "acceptedFailingGates": []})
        recording.answer("GET", f"{prefix}/plans?status=closed",
                         {"ok": True, "plans": self.closed_plans(),
                          "lastClosedCr": last_closed,
                          "filed": len(self._plans)})
        recording.answer("GET", f"{prefix}/queue",
                         {"ok": True, "entries": self.queue_entries(),
                          "tracks": []})
        proposals = [{"label": p["label"], "targetAt": p["targetAt"],
                      "waves": sorted({e["wave"] for e in self._queue
                                       if e["release"] == p["label"]})}
                     for p in self._proposals if p["label"] not in self._ships]
        recording.answer("GET", f"{prefix}/release-proposals",
                         {"ok": True, "proposals": proposals,
                          "totalCount": len(proposals)})

    # -- the answers, as the fixtures check them ------------------------------

    def history_row(self, label):
        """The history row for `label`, or None."""
        for row in self.history():
            if label in (row.get("labels") or []):
                return row
        return None

    def history_crs(self, label):
        """The CRs the history row for `label` counts completed, in the
        order the row lists them."""
        row = self.history_row(label) or {}
        return [cr for wave in row.get("waves") or []
                for cr in wave.get("crs") or []]

    def closed_at(self):
        """Every closed plan's `(cr, closedAt)`."""
        return [(plan.get("cr"), plan.get("closedAt")) for plan in self._plans]


def require_strictly_later(project, earlier_cr, later_cr):
    """Fixture sanity: `later_cr`'s latest close is strictly after
    `earlier_cr`'s latest close."""
    latest = {}
    for cr, at in project.closed_at():
        if at is not None:
            latest[cr] = max(at, latest.get(cr, at))
    if not latest.get(earlier_cr) or not latest.get(later_cr) \
            or latest[earlier_cr] >= latest[later_cr]:
        raise RuntimeError(
            f"fixture: {later_cr} must close strictly after {earlier_cr}; "
            f"the seeding recorded {latest!r}")


# ── driving a client ────────────────────────────────────────────────────────

def drive_env():
    env = scrubbed_env()
    for key in _EXTRA_SCRUB:
        env.pop(key, None)
    return env


def run_client(client, project_dir, *argv, verb=VERB):
    """Run `<client> <verb> <argv…> --project-dir <dir>` as the operator
    does: a genuine subprocess, from the project directory."""
    return subprocess.run(
        [sys.executable, str(CLIENTS_DIR / CLIENT_FILES[client]), verb,
         *argv, "--project-dir", project_dir],
        cwd=project_dir, env=drive_env(), capture_output=True, text=True,
        timeout=120, check=False)


def describe(run):
    return (f"exit={run.returncode}\n  stdout={run.stdout[:1500]!r}\n"
            f"  stderr={run.stderr[:1500]!r}")


_TOON = None


def toon():
    global _TOON
    if _TOON is None:
        spec = importlib.util.spec_from_file_location("release_notes_toon",
                                                      TOON_PATH)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"could not load {TOON_PATH}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _TOON = module
    return _TOON


def decode_toon_envelope(stdout):
    """The `axi` object of a TOON envelope, or None when stdout holds none."""
    if not stdout.strip():
        return None
    try:
        decoded = toon().decode(stdout)
    except Exception:  # not an envelope at all: the caller reports stdout
        return None
    axi = decoded.get("axi") if isinstance(decoded, dict) else None
    return axi if isinstance(axi, dict) else None


def decode_json_envelope(stdout):
    """The one JSON object `--format json` writes, or None."""
    try:
        parsed = json.loads(stdout)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def envelope_text(axi, exclude=("context", "verb")):
    """Every string an envelope carries outside `exclude`, joined, so wording
    is checked wherever the envelope states it."""
    parts = []

    def walk(value):
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    for key, value in (axi or {}).items():
        if key not in exclude:
            walk(value)
    return "\n".join(parts)


def stderr_lines(run):
    return [line for line in run.stderr.splitlines() if line.strip()]


# ── the recorded reads ────────────────────────────────────────────────────────
#
# A scenario's client is driven through `real_board.RecordingProxy` in front
# of the fake board, which records every request `(method, path-with-query)`
# in arrival order (`taken()`); `fail_read` is its `intercept` hook for a read
# the stub answers instead of the board.

#: How long the proxy waits on the board's answer to one request.
PROXY_TIMEOUT = 20


def split_request(path):
    """`(route, query)` of a recorded request path."""
    parts = urllib.parse.urlsplit(path)
    return parts.path, urllib.parse.parse_qs(parts.query)


def read_name(project_key, method, path):
    """Which of the reads a recorded request is: `history`, `closed plans`,
    `queue`, `release proposals` — or None for any other request."""
    if method != "GET":
        return None
    route, query = split_request(path)
    prefix = f"/api/v2/projects/{project_key}"
    if route == f"{prefix}/history" and not query:
        return "history"
    if route == f"{prefix}/plans" and query == {"status": ["closed"]}:
        return "closed plans"
    if route == f"{prefix}/queue" and not query:
        return "queue"
    if route == f"{prefix}/release-proposals" and not query:
        return "release proposals"
    return None


def fail_read(project_key, name):
    """A `RecordingProxy` `intercept` hook that fails exactly the read called
    `name`: it answers 500 with the stub's own error and help instead of
    reaching the board, and lets every other request through."""
    def intercept(method, path, _body):
        if read_name(project_key, method, path) != name:
            return None
        return 500, json.dumps({"ok": False, "error": STUB_ERROR,
                                "help": [STUB_HELP]}).encode()
    return intercept


def write_refused_limit(project_dir):
    """Declare an illegal `value` (below the shipped minimum) for one client
    limit in the project's own `crucible.toml`, so every envelope driven from
    it owes a `limit-configuration` disclosure."""
    config = Path(project_dir) / "crucible.toml"
    text = config.read_text(encoding="utf-8")
    config.write_text("[limits.truncate_field_chars]\nvalue = 1\n\n" + text
                      if "[limits.truncate_field_chars]" not in text
                      else text.replace("[limits.truncate_field_chars]",
                                        "[limits.truncate_field_chars]\nvalue = 1",
                                        1),
                      encoding="utf-8")


def close_quietly(*things):
    for thing in things:
        if thing is not None:
            # Teardown: never mask the test's own failure.
            with contextlib.suppress(Exception):
                thing.close()


def scratch_dir(prefix):
    return tempfile.mkdtemp(prefix=prefix)


def remove_dir(path):
    shutil.rmtree(path, ignore_errors=True)
