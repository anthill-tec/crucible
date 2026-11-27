"""Every verb that files a run, or a compile or lint result, refuses an
unattributed run while the project has an active cycle — before anything is
run or filed.

The sibling suite (`test_an_unattributed_run_is_refused_while_a_cycle_is_active.py`)
proves the refusal for `test` and `pre-merge-gate`. This one proves it for the
rest of the fleet's filing verbs: `regression`, the tier verbs, `check`,
`compile`, `auto-ingest`, rust's `smoke-test`, `docker-e2e-gate`, `clippy`,
`workspace-clippy`, `workspace-regression` and `regression-ingest`, and each
`pre-merge-gate`'s own first step (the compile, typecheck or clippy step a
gate runs before its suites).

Each case drives the real client as an OS subprocess against its own
recording board (`cycle_board`, a `RecordingBoard`) answering the pre-flight
reads in the server's shapes: the agent held bound to no cycle, and one open
plan carrying an active cycle (or none). What the client sent is read off
the board's request log; the server's half — the binding read, the open-plans
filter and a result stored under the cycle its context or binding names — is
held in bun (`agent-cycle-binding.test.ts`, `plans-status-filter.test.ts`,
`ingest-binding-attach.test.ts`). Every
fake toolchain records each invocation in its bin directory, and every
compile, typecheck and lint step is made to FAIL, so a step that ran would
file a compile or lint result. Three properties are read back:

  * refused: non-zero exit, an `ok:false` envelope whose `help[]` names
    `--cycle <the active id>`, NO toolchain invocation, and NOTHING posted to
    a run route by the agent;
  * the control: the same failing drives on a project with NO active cycle
    DO file, so the fixture is one that would file;
  * `--cycle <id>`: every verb the refusal covers accepts the flag (a census
    over each client's own argparse), and a verb given it files its result
    carrying that cycle.
"""

import shutil
import unittest

from tests.client.an_unattributed_run_is_refused_while_a_cycle_is_active_helpers import (
    cycle_board,
    filed,
    runs_touched,
    unattributed_to,
)
from tests.client.client_fleet_envelope_census_helpers import (
    CLIENT_FILES,
    _load_toon_module,
    _make_project_dir,
    build_argv,
    classify_envelope,
    drive_verb,
)
from tests.client.every_verb_that_files_a_run_is_refused_while_a_cycle_is_active_helpers import (
    _PYTHON_WRAPPER,
    TIERS,
    _build_recording_bin_dir,
    _filing_verbs,
    _invocations,
    _seed,
)

REFUSED_CODE = "unattributed-run-refused"


# The verbs whose run files a compile or lint result, or files a run, in the
# fixture below: the "would FAIL and file" proof. Tier and regression verbs are
# proved refused by the refusal itself (its code and help naming the active
# cycle), which only the pre-flight raises.
STEP_VERBS = {
    "python": ("check", "auto-ingest", "pre-merge-gate"),
    "bun": ("check", "auto-ingest", "pre-merge-gate"),
    "mvn": ("check", "compile", "auto-ingest", "pre-merge-gate"),
    "rust": ("check", "auto-ingest", "clippy", "workspace-clippy",
             "pre-merge-gate", "smoke-test", "docker-e2e-gate", "regression"),
    "arduino": ("check", "compile", "auto-ingest", "pre-merge-gate"),
    # go files a streamed run from each of its three running verbs; it has no
    # compile step of its own, and its `lint` is proved refused by the
    # refusal itself, as every client's is.
    "go": ("test", "regression", "pre-merge-gate"),
    # eda files a pytest run from each of its three running verbs, and
    # ingests the reports it finds; it has no compile or lint step.
    "eda": ("test", "regression", "pre-merge-gate", "auto-ingest"),
}


def _accepts(subparser, flag):
    return any(flag in action.option_strings for action in subparser._actions)


class EveryRefusableVerbAcceptsCycleTest(unittest.TestCase):
    """The refusal's first lever is `re-run with --cycle <id>`, so every verb
    the refusal covers must accept `--cycle` — read off each client's own
    argparse, never a hand-kept list of flags."""

    def test_the_go_tier_verbs_join_the_census(self):
        """go declares its tiers by build tag, so each tier verb and
        `regression` is a go filing verb this census drives."""
        filing = set(_filing_verbs("go"))
        self.assertEqual(sorted(set(TIERS + ("regression",)) - filing), [],
                         f"go's filing verbs: {sorted(filing)!r}")

    def test_every_verb_the_refusal_covers_accepts_cycle(self):
        for client_key in sorted(CLIENT_FILES):
            for verb, subparser in sorted(_filing_verbs(client_key).items()):
                with self.subTest(client=client_key, verb=verb):
                    self.assertTrue(
                        _accepts(subparser, "--cycle"),
                        f"{client_key} {verb}: files a run or a compile/lint "
                        f"result, so the refusal can name `--cycle <id>` to "
                        f"it — and its parser does not accept --cycle")


class EveryVerbThatFilesARunIsRefusedTest(unittest.TestCase):
    """The AC "Every verb that files a run", for all five clients, against a
    board per drive: a project with one ACTIVE cycle, and a sibling with
    none."""

    ORCHESTRATOR = "every-verb-refusal-orchestrator"
    PLANTED_CR = "CR-T-EVERY-VERB-REFUSAL"
    active_key = "every-verb-refusal-active-key"
    no_active_key = "every-verb-refusal-no-active-key"
    active_cycle_id = 52

    @classmethod
    def setUpClass(cls):
        cls.toon = _load_toon_module()

    # ── drive + read helpers ────────────────────────────────────────────────

    def _drive(self, client_key, verb, agent_id, project_key, extra_argv=()):
        """Drive one verb against its own board, holding the agent registered
        bound to no cycle: `active_key`'s carries the ACTIVE cycle,
        `no_active_key`'s no plan at all. The board is kept as
        `self.board`."""
        self.board = cycle_board(
            project_key, agent_id,
            self.active_cycle_id if project_key == self.active_key else None,
            cr=self.PLANTED_CR, orchestrator=self.ORCHESTRATOR)
        self.addCleanup(self.board.close)
        bin_dir = _build_recording_bin_dir()
        self.addCleanup(shutil.rmtree, bin_dir, True)
        project_dir = _make_project_dir(client_key)
        self.addCleanup(shutil.rmtree, project_dir, True)
        env_lines = [f"CRUCIBLE_PROJECT_KEY={project_key}\n"]
        if client_key == "arduino":
            env_lines.append("CRUCIBLE_PROJECT_NAME=every-verb-refusal-project\n")
        (project_dir / ".env").write_text("".join(env_lines))
        seeded = _seed(client_key, verb, project_dir)
        subparser = _filing_verbs(client_key)[verb]
        # The census argv without its trailing positionals (bun's tier
        # passthrough, which takes nothing here), and with this agent in place
        # of its placeholder.
        census = build_argv(verb, subparser, project_dir)[1:]
        positionals = sum(1 for a in subparser._actions if not a.option_strings)
        census = census[:len(census) - positionals]
        census[census.index("--agent") + 1] = agent_id
        argv = [verb] + seeded + list(extra_argv) + census
        result = drive_verb(
            CLIENT_FILES[client_key], argv, project_dir, bin_dir, timeout=120,
            board=self.board.url,
            extra_env={"PY_CRUCIBLE_PYTHON": str(bin_dir / _PYTHON_WRAPPER),
                       "EDA_CRUCIBLE_PYTHON": str(bin_dir / _PYTHON_WRAPPER)})
        emits, axi = classify_envelope(result.stdout, self.toon)
        return result, emits, axi or {}, _invocations(bin_dir), subparser

    def _filed_by(self, project_key, agent_id):
        """Every run, compile and lint result the agent filed on the drive's
        board — never its identity's own registration touches: what a
        refusal must prevent."""
        del project_key  # one board per drive, one project per board
        return [b for _p, b in filed(self.board)
                if isinstance(b, dict) and b.get("agentId") == agent_id]

    @staticmethod
    def _agent_id(prefix, client_key, verb):
        return f"{prefix}-{client_key}-{verb}"

    @staticmethod
    def _transcript(result):
        return (f"exit={result.returncode} stdout={result.stdout.strip()[:800]!r} "
                f"stderr={result.stderr.strip()[-1500:]!r}")

    # ── the refusal ─────────────────────────────────────────────────────────

    def test_every_filing_verb_is_refused_before_anything_runs_or_files(self):
        for client_key in sorted(CLIENT_FILES):
            for verb in sorted(_filing_verbs(client_key)):
                with self.subTest(client=client_key, verb=verb):
                    agent_id = self._agent_id("refused", client_key, verb)
                    result, emits, axi, ran, subparser = self._drive(
                        client_key, verb, agent_id, self.active_key)
                    self.assertNotEqual(
                        result.returncode, 0,
                        f"{client_key} {verb}: an unbound run with no --cycle "
                        f"while cycle {self.active_cycle_id} is active must "
                        f"exit non-zero; {self._transcript(result)}")
                    self.assertIn(
                        REFUSED_CODE, result.stderr,
                        f"{client_key} {verb}: the exit must be the "
                        f"{REFUSED_CODE} refusal, not some other failure; "
                        f"{self._transcript(result)}")
                    self.assertTrue(emits, f"{client_key} {verb}: no envelope; "
                                           f"{self._transcript(result)}")
                    self.assertIs(axi.get("ok"), False, f"{client_key} {verb}: {axi!r}")
                    help_text = " ".join(str(h) for h in (axi.get("help") or []))
                    self.assertIn(
                        f"--cycle {self.active_cycle_id}", help_text,
                        f"{client_key} {verb}: help[] must name --cycle "
                        f"{self.active_cycle_id}; got {axi.get('help')!r}")
                    if "--release" in help_text:
                        self.assertTrue(
                            _accepts(subparser, "--release"),
                            f"{client_key} {verb}: help[] names --release, "
                            f"which this verb does not accept; got "
                            f"{axi.get('help')!r}")
                    self.assertEqual(
                        ran, [],
                        f"{client_key} {verb}: refused before anything is run "
                        f"— yet the toolchain was invoked: {ran!r}")
                    touched = runs_touched(self.board)
                    self.assertEqual(
                        touched, [],
                        f"{client_key} {verb}: a refused run files nothing "
                        f"and opens no run; got {touched!r}")

    # ── the control: the same failing steps DO file with no active cycle ──

    def test_each_failing_step_files_when_no_cycle_is_active(self):
        for client_key in sorted(CLIENT_FILES):
            for verb in STEP_VERBS[client_key]:
                with self.subTest(client=client_key, verb=verb):
                    agent_id = self._agent_id("control", client_key, verb)
                    result, _emits, _axi, ran, _sub = self._drive(
                        client_key, verb, agent_id, self.no_active_key)
                    self.assertNotIn(REFUSED_CODE, result.stderr,
                                     self._transcript(result))
                    if verb != "auto-ingest":  # ingests reports it finds
                        self.assertTrue(
                            ran, f"{client_key} {verb}: with no active cycle "
                                 f"the toolchain must run; "
                                 f"{self._transcript(result)}")
                    self.assertTrue(
                        self._filed_by(self.no_active_key, agent_id),
                        f"{client_key} {verb}: with no active cycle this drive "
                        f"must FILE a result — otherwise the refusal case "
                        f"proves nothing; {self._transcript(result)}")

    # ── --cycle files the result under that cycle ───────────────────────────

    def test_cycle_flag_files_the_result_under_that_cycle(self):
        for client_key in sorted(CLIENT_FILES):
            for verb in STEP_VERBS[client_key]:
                if verb == "pre-merge-gate":
                    continue  # proven by the sibling suite's --cycle guard
                with self.subTest(client=client_key, verb=verb):
                    agent_id = self._agent_id("bound", client_key, verb)
                    result, _emits, _axi, _ran, _sub = self._drive(
                        client_key, verb, agent_id, self.active_key,
                        extra_argv=["--cycle", str(self.active_cycle_id)])
                    self.assertNotIn(REFUSED_CODE, result.stderr,
                                     self._transcript(result))
                    results = self._filed_by(self.active_key, agent_id)
                    self.assertTrue(
                        results, f"{client_key} {verb}: --cycle must still file; "
                                 f"{self._transcript(result)}")
                    self.assertEqual(
                        unattributed_to(self.board, self.active_cycle_id), [],
                        f"{client_key} {verb}: filed with --cycle "
                        f"{self.active_cycle_id}, so every result carries it "
                        f"— by its context or its agent's binding; "
                        f"posts={self.board.posts()!r}")


if __name__ == "__main__":
    unittest.main()
