"""RED — CR-CRU-014 §S2: the `queue-file` client verb.

Spec (§S2, verbatim, docs/changes/CR-CRU-014-execution-roadmap.md):
  "`queue-file` parses the project's `docs/changes/README.md` queue table
  (CR, title, depends-on, wave columns) → POST; `--from-file` override."

Acceptance criterion pinned here (verbatim):
  "`queue-file` against this repo's `docs/changes/README.md` registers every
  row of the CR table with correct wave + dependsOn (spot-assert CR-CRU-009's
  five dependencies)."

Contract this file PINS (RED's prerogative, grounded in §S1 server code
src/v2.ts::handleQueuePost + src/store.ts::replaceQueue, already merged):
  * `queue-file` reads `<project>/docs/changes/README.md` by default, parses
    the CR queue Markdown table into `{cr, title, wave, dependsOn}` rows, and
    POSTs the WHOLE set to `/api/v2/projects/<key>/queue` — the §S1
    full-replace endpoint — in ONE request carrying an `entries` array.
  * `--from-file <path>` overrides the source file.
  * Each row's `cr` is the full id from the table link (`CR-CRU-009`); `title`
    is the Title cell; `wave` is the LEADING integer of the Wave cell (cells
    read like `4 (after 011)` / `5 (0.2.0)`); `dependsOn` is the comma list of
    the Depends-on cell normalized to full CR ids (`007` → `CR-CRU-007`), which
    is REQUIRED for the server's `unknownDependencies` join (it compares dep
    strings to the `cr` set — bare numbers would spuriously flag every dep;
    store.ts stores "the verbatim CR-id string list").
  * A malformed table row fails LOUDLY (non-zero exit, nothing POSTed) rather
    than silently mis-registering — the §S1 API is the contract, the parser is
    a convenience (CR Risk section).

ESCALATION (AC vs source-of-truth): the AC text says "CR-CRU-009's five
dependencies", but this repo's docs/changes/README.md line for CR-CRU-009 today
carries SIX depends-on entries (`007, 008, 011, 012, 013, 016`). Per the
dispatch ("read them from docs/changes/README.md so the fixture is real") the
spot-assert below pins the REAL six-entry value read from README, and flags the
count discrepancy for the orchestrator.

RED: `queue-file` is NOT a subcommand of clients/python-crucible.py today
(confirmed by grepping the source: no `queue-file` / `cmd_queue_file` / `queue`
parser), so argparse raises `SystemExit(2)` ("invalid choice: 'queue-file'")
for every test below — a valid RED (missing-SUT-verb), never a fixture bug.

Invocation:
    python3 -m pytest tests/client/test_queue_file_verb.py -q
"""

import contextlib
import importlib.util
import io
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "python-crucible.py"
TOON_PATH = REPO_ROOT / "clients" / "toon.py"
REAL_README = REPO_ROOT / "docs" / "changes" / "README.md"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Invoke module.main() with sys.argv patched → (code, stdout, stderr).
    Only SystemExit is caught; any other exception propagates so unittest
    reports it as an ERROR (still a valid RED signal)."""
    full_argv = ["python-crucible.py"] + argv
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", full_argv):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                if e.code is None:
                    code = 0
                elif isinstance(e.code, int):
                    code = e.code
                else:
                    code = 1
    return code, stdout.getvalue(), stderr.getvalue()


# ── Independent README-table parser (the test's own source of truth) ────────
# Deliberately re-derives the expected rows straight from the Markdown so the
# assertions are grounded in the REAL file, not a copy that could drift.

_ROW_RE = re.compile(r"^\|\s*\[(CR-CRU-\d+)\]\([^)]*\)\s*\|")


def _parse_readme_table(text):
    """Return {cr: {"title": str, "wave": str, "dependsOn": [cr…]}} for every
    CR row of the queue table."""
    rows = {}
    for line in text.splitlines():
        m = _ROW_RE.match(line)
        if not m:
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        # cr | title | type | status | depends on | wave  → 6 data cells
        assert len(cells) == 6, f"unexpected column count in row: {line!r}"
        cr = m.group(1)
        title = cells[1]
        depends_cell = cells[4]
        wave_cell = cells[5]
        wave = re.match(r"\s*(\d+)", wave_cell).group(1)
        deps = []
        if depends_cell and depends_cell != "—":
            for tok in depends_cell.split(","):
                tok = tok.strip()
                if not tok:
                    continue
                deps.append("CR-CRU-" + tok)
        rows[cr] = {"title": title, "wave": wave, "dependsOn": deps}
    return rows


class _QueueFileTestBase(unittest.TestCase):
    PROJECT_KEY = "test-key-queue-file"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")
    QUEUE_PATH = f"/api/v2/projects/{PROJECT_KEY}/queue"

    def setUp(self):
        self.module = _load_module(SCRIPT_PATH, "python_crucible_under_test_queuefile")
        self.toon = _load_module(TOON_PATH, "toon_under_test_for_queuefile")
        self.tmpdir = tempfile.mkdtemp(prefix="queue-file-verb-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _run_queue_file(self, extra_argv, post_return=None):
        post_return = post_return if post_return is not None else {
            "ok": True, "entries": [], "unknownDependencies": []}
        argv = ["queue-file", "--project-dir", self.tmpdir] + extra_argv
        with mock.patch.object(self.module, "_post", return_value=post_return,
                               create=True) as post_mock, \
             mock.patch.object(self.module, "_get", return_value=None,
                               create=True) as get_mock, \
             mock.patch.object(self.module, "_patch", return_value=None,
                               create=True) as patch_mock:
            code, out, err = _run_main(self.module, argv)
        return code, out, err, post_mock, get_mock, patch_mock

    def _queue_post(self, post_mock):
        for call in post_mock.call_args_list:
            args, kwargs = call
            path = args[0] if args else kwargs.get("path")
            if path == self.QUEUE_PATH:
                return call
        return None

    def _posted_entries(self, post_mock):
        call = self._queue_post(post_mock)
        self.assertIsNotNone(
            call, f"queue-file must POST to {self.QUEUE_PATH}; "
                  f"calls={post_mock.call_args_list!r}")
        payload = call[0][1]
        self.assertIn("entries", payload,
                      f"the queue POST body must carry an `entries` array; got {payload!r}")
        return payload["entries"]

    def _by_cr(self, entries):
        return {e["cr"]: e for e in entries}

    def _decode_axi(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIn("axi", decoded,
                      f"stdout must decode to a TOON-AXI envelope; got {stdout_text!r}")
        return decoded["axi"]


class QueueFileAgainstRealReadmeTest(_QueueFileTestBase):
    """Drives `queue-file --from-file <this repo's docs/changes/README.md>`."""

    def setUp(self):
        super().setUp()
        self.expected = _parse_readme_table(REAL_README.read_text())
        self.assertGreater(
            len(self.expected), 20,
            "sanity: the README queue table must have many CR rows")

    def _run_real(self):
        return self._run_queue_file(["--from-file", str(REAL_README)])

    def test_posts_full_entries_array_to_the_S1_queue_endpoint_once(self):
        code, out, _err, post_mock, _g, patch_mock = self._run_real()
        self.assertEqual(code, 0, f"queue-file must succeed; stdout={out!r}")
        entries = self._posted_entries(post_mock)
        self.assertEqual(
            len([c for c in post_mock.call_args_list
                 if (c[0][0] if c[0] else None) == self.QUEUE_PATH]), 1,
            "the queue is a FULL REPLACE — exactly one POST to the queue endpoint")
        patch_mock.assert_not_called()
        self.assertEqual(
            len(entries), len(self.expected),
            f"every CR row must be registered: posted {len(entries)} entries, "
            f"README table has {len(self.expected)} rows")
        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "queue-file")
        self.assertIs(axi.get("ok"), True)

    def test_every_row_carries_correct_wave_and_dependsOn(self):
        _code, _out, _err, post_mock, _g, _p = self._run_real()
        posted = self._by_cr(self._posted_entries(post_mock))
        self.assertEqual(
            set(posted), set(self.expected),
            "the posted CR set must equal the README table's CR set exactly")
        for cr, want in self.expected.items():
            got = posted[cr]
            self.assertEqual(
                str(got.get("wave")), want["wave"],
                f"{cr}: wave must be the leading integer of its Wave cell")
            self.assertEqual(
                list(got.get("dependsOn", [])), want["dependsOn"],
                f"{cr}: dependsOn must match the README (normalized to full CR ids)")

    def test_spot_assert_cr009_dependencies_title_and_wave(self):
        """AC spot-assert. NOTE (ESCALATION): the AC says "five dependencies";
        README today carries SIX for CR-CRU-009 — the fixture uses the real
        value read from README."""
        _c, _o, _e, post_mock, _g, _p = self._run_real()
        posted = self._by_cr(self._posted_entries(post_mock))
        self.assertIn("CR-CRU-009", posted)
        entry = posted["CR-CRU-009"]
        self.assertEqual(
            list(entry.get("dependsOn", [])),
            ["CR-CRU-007", "CR-CRU-008", "CR-CRU-011",
             "CR-CRU-012", "CR-CRU-013", "CR-CRU-016"],
            "CR-CRU-009's dependsOn must be its exact README depends-on list")
        self.assertEqual(
            entry.get("title"),
            "Release 0.1.0: distro-agnostic installer + multi-harness skill bundle")
        self.assertEqual(str(entry.get("wave")), "4")

    def test_wave_cell_with_parenthetical_yields_leading_integer(self):
        """CR-CRU-008's Wave cell is `4 (after 011)` → wave must be `4`."""
        _c, _o, _e, post_mock, _g, _p = self._run_real()
        posted = self._by_cr(self._posted_entries(post_mock))
        self.assertIn("CR-CRU-008", posted)
        self.assertEqual(str(posted["CR-CRU-008"].get("wave")), "4")
        # and its dependsOn is the normalized 3-id list
        self.assertEqual(
            list(posted["CR-CRU-008"].get("dependsOn", [])),
            ["CR-CRU-005", "CR-CRU-007", "CR-CRU-011"])


class QueueFileSourceSelectionTest(_QueueFileTestBase):
    """Default source path + `--from-file` override behaviour."""

    _FIXTURE = (
        "# Q\n\n"
        "| CR | Title | Type | Status | Depends on | Wave |\n"
        "|---|---|---|---|---|---|\n"
        "| [CR-CRU-501](CR-CRU-501-a.md) | Alpha | feature | PENDING | — | 5 (0.2.0) |\n"
        "| [CR-CRU-502](CR-CRU-502-b.md) | Beta | feature | PENDING | 501 | 6 |\n"
    )

    def test_defaults_to_project_docs_changes_readme(self):
        docs = os.path.join(self.tmpdir, "docs", "changes")
        os.makedirs(docs, exist_ok=True)
        with open(os.path.join(docs, "README.md"), "w") as f:
            f.write(self._FIXTURE)
        code, out, _err, post_mock, _g, _p = self._run_queue_file([])
        self.assertEqual(code, 0, f"stdout={out!r}")
        posted = self._by_cr(self._posted_entries(post_mock))
        self.assertEqual(set(posted), {"CR-CRU-501", "CR-CRU-502"})
        self.assertEqual(str(posted["CR-CRU-501"].get("wave")), "5")
        self.assertEqual(posted["CR-CRU-501"].get("title"), "Alpha")
        self.assertEqual(list(posted["CR-CRU-502"].get("dependsOn", [])),
                         ["CR-CRU-501"])

    def test_from_file_overrides_the_default_source(self):
        # a DIFFERENT (empty-table) default in place, proving --from-file wins
        docs = os.path.join(self.tmpdir, "docs", "changes")
        os.makedirs(docs, exist_ok=True)
        with open(os.path.join(docs, "README.md"), "w") as f:
            f.write("# empty\n\n| CR | Title | Type | Status | Depends on | Wave |\n"
                    "|---|---|---|---|---|---|\n")
        override = os.path.join(self.tmpdir, "custom-queue.md")
        with open(override, "w") as f:
            f.write(self._FIXTURE)
        code, _out, _err, post_mock, _g, _p = self._run_queue_file(
            ["--from-file", override])
        self.assertEqual(code, 0)
        posted = self._by_cr(self._posted_entries(post_mock))
        self.assertEqual(set(posted), {"CR-CRU-501", "CR-CRU-502"},
                         "--from-file must be parsed instead of the default README")


class QueueFileMalformedRowTest(_QueueFileTestBase):
    """A malformed table row must fail loudly, never silently mis-register."""

    _MALFORMED = (
        "# Q\n\n"
        "| CR | Title | Type | Status | Depends on | Wave |\n"
        "|---|---|---|---|---|---|\n"
        "| [CR-CRU-601](CR-CRU-601-a.md) | Good | feature | PENDING | — | 5 |\n"
        # next row is missing the Wave column entirely (5 cells, not 6)
        "| [CR-CRU-602](CR-CRU-602-b.md) | Bad | feature | PENDING | 601 |\n"
    )

    def test_malformed_row_fails_loudly_without_posting(self):
        override = os.path.join(self.tmpdir, "broken.md")
        with open(override, "w") as f:
            f.write(self._MALFORMED)
        code, out, err, post_mock, _g, _p = self._run_queue_file(
            ["--from-file", override])
        self.assertNotEqual(
            code, 0, "a malformed queue row must produce a non-zero exit")
        self.assertIsNone(
            self._queue_post(post_mock),
            "nothing may be POSTed when a row is malformed (no silent "
            "mis-registration)")
        combined = (out + err).lower()
        self.assertNotIn(
            "invalid choice", combined,
            "the failure must name the malformed row, NOT be argparse rejecting "
            "an unknown subcommand")
        self.assertIn(
            "602", combined,
            "the loud failure must identify the offending row (CR-CRU-602)")


if __name__ == "__main__":
    unittest.main()
