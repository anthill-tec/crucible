"""`release-notes` refuses what it cannot draft, and says what to do — under
every `--format`, through `python-crucible.py` against a real, throwaway board.

Each refusal is the `release-notes` envelope on stdout (the TOON envelope
under the default format and under `markdown`, one JSON object under
`--format json`), with no section, its exit code, and a human line on stderr:

- no `--release`, an empty one, or a `--date` that is not a real `YYYY-MM-DD`
  date: exit 2, naming the usage form;
- a label the project does not hold: exit 1, `unknown release: <label>`, with
  the `history` verb's help;
- a label the project holds that has completed no CR and not shipped: exit 1,
  `release <label> is not in History yet`, with the queue help;
- a read that fails — the history, the closed plans, or the queue when a
  completed CR needs its queue title: exit 1, naming that read and its error,
  with the help the failing board gave. A failed read is driven by a proxy in
  front of the real board that answers that one read with an error; a failed
  queue read never falls back to bare ids.
"""

import unittest

from tests.client import release_notes_board as rn

SHIPPED = "8.0.0"
SHIPPED_AT = rn.utc_epoch(2026, 5, 20, 12, 0)
HELD = "6.6.6"
UNKNOWN = "7.7.7"
PLANNED_CR = "REFUSAL-PLANNED"
QUEUED_CR = "REFUSAL-QUEUED-ONLY"
HELD_CR = "REFUSAL-HELD"

#: Each format a refusal is checked under, its argv, and how its stdout is read.
FORMATS = (
    ("toon", (), rn.decode_toon_envelope),
    ("json", ("--format", "json"), rn.decode_json_envelope),
    ("markdown", ("--format", "markdown"), rn.decode_toon_envelope),
)

_BOARD = None
_PROJECT = None


def setUpModule():
    global _BOARD, _PROJECT
    _BOARD = rn.start_board("release-notes-refusals")
    if _BOARD is None:
        raise unittest.SkipTest(
            "the held and shipped labels are a property of the REAL store: "
            "without `bun` there is no board to hold them")
    try:
        project = rn.SeededProject(_BOARD, "release-notes-refusals")
        project.propose(SHIPPED)
        project.propose(HELD)
        project.declare(PLANNED_CR, "planned, as queued", SHIPPED)
        project.declare(QUEUED_CR, "Queued only, as queued", SHIPPED)
        project.declare(HELD_CR, "held, as queued", HELD)
        project.land(PLANNED_CR, "Planned and landed")
        project.ship(SHIPPED, SHIPPED_AT, [PLANNED_CR, QUEUED_CR])
        if sorted(project.history_crs(SHIPPED)) != sorted([PLANNED_CR,
                                                           QUEUED_CR]):
            raise RuntimeError(f"fixture: {SHIPPED} must complete both CRs: "
                               f"{project.history_row(SHIPPED)!r}")
        if project.history_row(HELD) is not None:
            raise RuntimeError(f"fixture: {HELD} must not be in the history")
        if project.history_row(UNKNOWN) is not None:
            raise RuntimeError(f"fixture: {UNKNOWN} must not be held at all")
        _PROJECT = project
    except BaseException:
        rn.close_quietly(_BOARD)
        raise


def tearDownModule():
    rn.close_quietly(_BOARD)


class ReleaseNotesRefusalTest(unittest.TestCase):

    def project(self):
        assert _PROJECT is not None
        return _PROJECT

    def refuse(self, fmt, argv, decode, exit_code, project_dir=None):
        """Drive one refusal and check what every refusal shares; return
        the envelope."""
        run = rn.run_client("python", project_dir or self.project().project_dir,
                            *argv, *fmt)
        self.assertEqual(
            run.returncode, exit_code,
            f"the refusal exits {exit_code}:\n{rn.describe(run)}")
        axi = decode(run.stdout)
        self.assertIsInstance(
            axi, dict,
            f"a refusal is the release-notes envelope on stdout, never a "
            f"bare usage error (today the verb does not exist):\n"
            f"{rn.describe(run)}")
        assert axi is not None
        self.assertEqual(axi.get("verb"), "release-notes")
        self.assertIs(axi.get("ok"), False, f"got {axi!r}")
        self.assertNotIn("### Changed", run.stdout, "no section on stdout")
        self.assertFalse(
            [line for line in run.stdout.splitlines() if line.startswith("## [")],
            f"no section heading on stdout; got {run.stdout!r}")
        self.assertIn(axi.get("lines"), (None, []),
                      f"a refusal carries no section lines; got {axi!r}")
        lines = rn.stderr_lines(run)
        self.assertTrue(
            any(line.startswith("release-notes:") for line in lines),
            f"a refusal has its own stderr line; got {run.stderr!r}")
        return axi, run

    def help_of(self, axi):
        steps = axi.get("help")
        self.assertIsInstance(steps, list, f"a refusal carries help; {axi!r}")
        self.assertTrue(steps, f"a refusal's help is non-empty; {axi!r}")
        return [str(step) for step in steps]

    # -- usage refusals -----------------------------------------------------

    def assert_usage_refusal(self, argv):
        for name, fmt, decode in FORMATS:
            with self.subTest(format=name):
                axi, _ = self.refuse(fmt, argv, decode, 2)
                self.assertIn(rn.USAGE_FORM, rn.envelope_text(axi),
                              f"a usage refusal names the usage form; {axi!r}")

    def test_no_release_flag_is_a_usage_refusal_naming_the_form(self):
        self.assert_usage_refusal(())

    def test_an_empty_release_is_a_usage_refusal_naming_the_form(self):
        self.assert_usage_refusal(("--release", ""))

    def test_a_date_that_is_no_calendar_day_is_a_usage_refusal(self):
        self.assert_usage_refusal(("--release", SHIPPED, "--date", "2026-02-30"))

    def test_a_date_not_written_yyyy_mm_dd_is_a_usage_refusal(self):
        self.assert_usage_refusal(("--release", SHIPPED, "--date", "next-tuesday"))

    # -- label refusals -----------------------------------------------------

    def test_a_label_the_project_does_not_hold_is_an_unknown_release(self):
        for name, fmt, decode in FORMATS:
            with self.subTest(format=name):
                axi, _ = self.refuse(fmt, ("--release", UNKNOWN), decode, 1)
                self.assertIn(f"unknown release: {UNKNOWN}",
                              rn.envelope_text(axi, ("context", "verb", "help")))
                self.assertTrue(
                    any(step.startswith("history") for step in self.help_of(axi)),
                    f"the help is the `history` verb's; got {axi.get('help')!r}")

    def test_a_held_label_with_nothing_completed_is_not_in_history_yet(self):
        for name, fmt, decode in FORMATS:
            with self.subTest(format=name):
                axi, _ = self.refuse(fmt, ("--release", HELD), decode, 1)
                self.assertIn(f"release {HELD} is not in History yet",
                              rn.envelope_text(axi, ("context", "verb", "help")))
                self.assertIn(rn.HELD_LABEL_HELP, self.help_of(axi))

    # -- failed reads -------------------------------------------------------

    def assert_failed_read(self, read):
        project = self.project()
        proxy = rn.CapturingProxy(project.base,
                                  fail_on=rn.fail_read(project.key, read))
        try:
            project_dir = project.dir_through(proxy.base)
            for name, fmt, decode in FORMATS:
                with self.subTest(format=name):
                    axi, run = self.refuse(fmt, ("--release", SHIPPED), decode, 1,
                                           project_dir=project_dir)
                    reads = [rn.read_name(project.key, method, path)
                             for method, path in proxy.taken()]
                    self.assertIn(read, reads,
                                  f"the {read} read was made (and failed); "
                                  f"recorded {reads!r}")
                    said = rn.envelope_text(axi, ("context", "verb", "help"))
                    self.assertIn(read, said,
                                  f"the refusal names the {read} read; {axi!r}")
                    self.assertIn(rn.STUB_ERROR, said,
                                  f"the refusal carries the read's error; {axi!r}")
                    self.assertIn(rn.STUB_HELP, self.help_of(axi),
                                  "the help is the failing board's own")
                    self.assertNotIn(f"- {QUEUED_CR}", run.stdout)
                    self.assertNotIn(f"- {PLANNED_CR}", run.stdout)
        finally:
            proxy.close()

    def test_a_failed_history_read_is_a_refusal_naming_the_history(self):
        self.assert_failed_read("history")

    def test_a_failed_closed_plans_read_is_a_refusal_naming_the_closed_plans(self):
        self.assert_failed_read("closed plans")

    def test_a_failed_queue_read_is_a_refusal_and_never_falls_back_to_bare_ids(self):
        self.assert_failed_read("queue")


if __name__ == "__main__":
    unittest.main()
