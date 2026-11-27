"""RED — the first paragraph of the run-attribution step: while a project has
an ACTIVE cycle, every client's `test` and `pre-merge-gate` refuse a run that
would carry no cycle (the agent bound to no cycle, neither `--cycle` nor
`--release` given), exiting non-zero BEFORE the runner starts, with `help[]`
naming the active cycle (`--cycle <id>`). With `--cycle <id>` the run still
proceeds and is stored under that cycle. With NO active cycle, today's soft
`no-cycle` warning stands unchanged. A `--release` run is never refused by
this check, active cycle or not.

Driven against a recording board (`cycle_board`, a `RecordingBoard`) that
answers the pre-flight reads in the server's shapes: the project's agent list
holding the agent bound to no cycle, and its open plans carrying one ACTIVE
cycle (or no plan at all, for the sibling project). What the client sent is
read off the board's request log. The server's half — `boundCycleId` on the
agent list (`agent-cycle-binding.test.ts`), `?status=open` answering exactly
the open plan (`plans-status-filter.test.ts`), a run stored under the cycle
its context or binding names (`ingest-binding-attach.test.ts`) and a release
run stored under its release (`events-by-release.test.ts`) — is held in bun.
Each of the five
clients' `test`/`pre-merge-gate` verbs is driven as a genuine OS subprocess,
argv built from each client's OWN real argparse
(`test_client_fleet_envelope_census.py`'s `enumerate_verbs`/`build_argv`),
toolchains stubbed by that module's own proven `_build_fake_bin_dir` (so
`pre-merge-gate`'s docker-up/down, clippy, tsc and `arduino-cli compile`
steps all run for real against fakes, never skipped).

RED phase — today's code only WARNS (`no-cycle`) and lets the run proceed
regardless of an active cycle: `preflight_cycle_warnings`
(`clients/_crucible_axi.py`) never reads whether the project has an active
cycle at all, so every refusal case below fails on its very first assertion
(`returncode != 0`) because today's run actually succeeds. The three GUARD
cases (`--cycle` still binds, no active cycle still warns, `--release` is
never refused) are expected to PASS today — they pin behaviour this fix must
not disturb — and are filed here rather than skipped because they are the
asserted OTHER HALF of the very same acceptance criterion.

Invocation:
    python3 -m unittest tests.client.integration.test_an_unattributed_run_is_refused_while_a_cycle_is_active -v
"""

import shutil
import unittest
from pathlib import Path

from tests.client.an_unattributed_run_is_refused_while_a_cycle_is_active_helpers import (
    cycle_board,
    filed,
    unattributed_to,
)
from tests.client.client_fleet_envelope_census_helpers import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_toon_module,
    _make_project_dir,
    build_argv,
    classify_envelope,
    drive_verb,
    enumerate_verbs,
    seed_eda_run,
)

REPO_ROOT = Path(__file__).resolve().parents[3]

NO_CYCLE_CODE = "no-cycle"
RELEASE_RUN_CODE = "release-run"

# Every (client, verb) pair this acceptance criterion names — the fleet's run
# verbs, never the gate-milestone/cr-close verbs (a later cycle's scope).
CLIENT_VERB_PAIRS = sorted(
    (client_key, verb) for client_key in CLIENT_FILES for verb in ("test", "pre-merge-gate")
)


class UnattributedRunRefusedWhileACycleIsActiveTest(unittest.TestCase):
    """AC — "An unattributed run is refused", read for all five clients
    against a board per drive: a project carrying an ACTIVE cycle, and a
    sibling project carrying none."""

    ORCHESTRATOR = "cycle-refusal-fixture-orchestrator"
    RELEASE_LABEL = "4.4.4-cycle-refusal-fixture"
    PLANTED_CR = "CR-T-CYCLE-REFUSAL-ACTIVE"
    active_key = "cycle-refusal-active-key"
    no_active_key = "cycle-refusal-no-active-key"
    active_cycle_id = 41

    @classmethod
    def setUpClass(cls):
        cls.toon = _load_toon_module()

    # ── drive + read helpers ────────────────────────────────────────────────

    def _project_dir(self, client_key, project_key):
        d = _make_project_dir(client_key)
        env_lines = [f"CRUCIBLE_PROJECT_KEY={project_key}\n"]
        if client_key == "arduino":
            env_lines.append("CRUCIBLE_PROJECT_NAME=cycle-refusal-fixture-project\n")
        (d / ".env").write_text("".join(env_lines))
        self.addCleanup(shutil.rmtree, d, True)
        return d

    def _drive(self, client_key, verb_name, agent_id, project_key, extra_argv=()):
        """Drive one verb against its own board: `active_key`'s carries the
        ACTIVE cycle, `no_active_key`'s no plan at all; both hold the agent
        bound to no cycle. The board is kept as `self.board`."""
        self.board = cycle_board(
            project_key, agent_id,
            self.active_cycle_id if project_key == self.active_key else None,
            cr=self.PLANTED_CR, orchestrator=self.ORCHESTRATOR)
        self.addCleanup(self.board.close)
        fake_bin_dir = _build_fake_bin_dir()
        self.addCleanup(shutil.rmtree, fake_bin_dir, True)
        project_dir = self._project_dir(client_key, project_key)
        script_path = CLIENT_FILES[client_key]
        verbs = enumerate_verbs(client_key, script_path)
        assert verb_name in verbs, (
            f"{client_key}: verb {verb_name!r} not found in its real argparse "
            f"— {sorted(verbs)!r}")
        argv = build_argv(verb_name, verbs[verb_name], project_dir)
        argv = argv + ["--agent", agent_id] + list(extra_argv)
        if client_key == "eda":
            # eda's gate runs the entries the project declares, and its
            # `test` only the paths it is named.
            argv += seed_eda_run(project_dir, verb_name)
        result = drive_verb(script_path, argv, project_dir, fake_bin_dir,
                            timeout=90, board=self.board.url)
        emits, axi = classify_envelope(result.stdout, self.toon)
        # `axi` is None on a decode failure; every caller asserts `emits`
        # first (which fails loudly and stops the test right there), so an
        # empty-dict fallback here only keeps the subsequent `.get(...)`
        # calls type-safe, it never masks a real decode failure.
        return result, emits, axi or {}

    def _events_for(self, project_key, agent_id):
        """The RUN RESULTS (`/api/v2/runs`, `/api/v2/runs/parsed`: the
        server's `kind: "test"` events) this agent filed on the drive's
        board — never the opening heartbeat's own registration, which is
        identity management, not the runner's evidence (a refusal that opens
        the identity bracket before declining to spawn the runner must still
        file NO run result)."""
        del project_key  # one board per drive, one project per board
        return [b for p, b in filed(self.board)
                if p in ("/api/v2/runs", "/api/v2/runs/parsed")
                and isinstance(b, dict) and b.get("agentId") == agent_id]

    def _warnings_of(self, axi, code):
        return [w for w in (axi.get("warnings") or [])
               if isinstance(w, dict) and w.get("code") == code]

    # ── the refusal itself ──────────────────────────────────────────────────

    def test_refused_before_the_runner_starts_for_every_client_and_verb(self):
        """The core case: an agent bound to no cycle, no `--cycle`, no
        `--release`, against a project that HAS an active cycle — every
        client's `test`/`pre-merge-gate` must exit non-zero before spawning
        its runner, naming the active cycle id in `help[]`, and leave NO
        trace on the board (the runner's own evidence never reaches it)."""
        for client_key, verb_name in CLIENT_VERB_PAIRS:
            with self.subTest(client=client_key, verb=verb_name):
                agent_id = f"cycle-refusal-{client_key}-{verb_name}".replace(" ", "-")
                result, emits, axi = self._drive(
                    client_key, verb_name, agent_id, self.active_key)

                self.assertNotEqual(
                    result.returncode, 0,
                    f"{client_key} {verb_name}: a run with NO --cycle and NO "
                    f"--release, filed by an agent bound to no cycle while "
                    f"project {self.active_key} has an ACTIVE cycle "
                    f"({self.active_cycle_id}), must exit NON-ZERO before "
                    f"the runner starts; "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                self.assertTrue(
                    emits,
                    f"{client_key} {verb_name}: the refusal must still "
                    f"decode as one TOON axi: envelope; got "
                    f"stdout={result.stdout!r}")
                self.assertFalse(
                    axi.get("ok"),
                    f"{client_key} {verb_name}: the refusal envelope must "
                    f"carry ok:false; got {axi!r}")
                help_text = " ".join(str(h) for h in (axi.get("help") or []))
                self.assertIn(
                    "--cycle", help_text,
                    f"{client_key} {verb_name}: the refusal's help[] must "
                    f"name the lever (--cycle <id>); got "
                    f"help={axi.get('help')!r}")
                self.assertIn(
                    str(self.active_cycle_id), help_text,
                    f"{client_key} {verb_name}: the refusal's help[] must "
                    f"name the project's ACTUAL active cycle id "
                    f"({self.active_cycle_id}), not a placeholder; got "
                    f"help={axi.get('help')!r}")

                events = self._events_for(self.active_key, agent_id)
                self.assertEqual(
                    events, [],
                    f"{client_key} {verb_name}: a refused run must leave NO "
                    f"ingested evidence on the board — the runner's own "
                    f"proof it never started; got events={events!r}")

    # ── GUARD 1 — --cycle still binds the run, even with an active cycle ───

    def test_cycle_flag_still_binds_the_run_despite_the_active_cycle(self):
        """GUARD — expected to PASS today and after the fix: `--cycle
        <active id>` must still open and store the run under that cycle,
        proved by the ingested event's own echoed `context.cycleId` (which
        survives this run's own anti-ghost identity cleanup, unlike the
        agent row)."""
        for client_key, verb_name in CLIENT_VERB_PAIRS:
            with self.subTest(client=client_key, verb=verb_name):
                agent_id = f"cycle-refusal-bound-{client_key}-{verb_name}".replace(" ", "-")
                result, emits, axi = self._drive(
                    client_key, verb_name, agent_id, self.active_key,
                    extra_argv=["--cycle", str(self.active_cycle_id)])

                self.assertEqual(
                    result.returncode, 0,
                    f"{client_key} {verb_name}: `--cycle "
                    f"{self.active_cycle_id}` must still be a green wrapped "
                    f"run even while the project has an active cycle; "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                self.assertTrue(
                    emits,
                    f"{client_key} {verb_name}: must decode as one TOON "
                    f"axi: envelope; got stdout={result.stdout!r}")
                self.assertTrue(
                    axi.get("ok"),
                    f"{client_key} {verb_name}: a bound run must carry "
                    f"ok:true; got {axi!r}")
                self.assertEqual(
                    self._warnings_of(axi, NO_CYCLE_CODE), [],
                    f"{client_key} {verb_name}: a run filed with --cycle "
                    f"{self.active_cycle_id} must carry NO {NO_CYCLE_CODE!r} "
                    f"warning; got warnings={axi.get('warnings')!r}")

                events = self._events_for(self.active_key, agent_id)
                self.assertEqual(
                    len(events), 1,
                    f"{client_key} {verb_name}: --cycle "
                    f"{self.active_cycle_id} must file exactly one event "
                    f"for this agent; got events={events!r}")
                self.assertEqual(
                    unattributed_to(self.board, self.active_cycle_id), [],
                    f"{client_key} {verb_name}: the run must be filed "
                    f"carrying EXACTLY the cycle it was bound to "
                    f"({self.active_cycle_id}) — by its context or its "
                    f"agent's binding; posts={self.board.posts()!r}")

    # ── GUARD 2 — no active cycle: today's soft warning stands ─────────────

    # rust `pre-merge-gate` dispatches to `cmd_workspace_regression`, whose
    # own run body (`_workspace_regression_run`, clients/rust-crucible.py)
    # never calls `preflight_cycle_warnings` at all — read directly: its
    # only cycle-adjacent warning is the `release_run_note` it builds
    # in-line when `--release` is given, with NO `no_cycle_warning` branch
    # for any other case. A PRE-EXISTING asymmetry confirmed by reading the
    # source, outside this acceptance criterion's own scope (it is not a
    # refusal-mechanism gap) — carried here as a documented exception
    # rather than silently assumed uniform across the fleet.
    NO_CYCLE_WARNING_NOT_WIRED_TODAY = {("rust", "pre-merge-gate")}

    def test_no_active_cycle_still_only_warns_as_today(self):
        """GUARD — expected to PASS today and after the fix: with NO active
        cycle on the project, an unattributed run is project-scoped on
        purpose (§S2's own exemption) and proceeds, carrying the SAME
        `no-cycle` warning it carries today."""
        for client_key, verb_name in CLIENT_VERB_PAIRS:
            if (client_key, verb_name) in self.NO_CYCLE_WARNING_NOT_WIRED_TODAY:
                continue
            with self.subTest(client=client_key, verb=verb_name):
                agent_id = f"cycle-refusal-noactive-{client_key}-{verb_name}".replace(" ", "-")
                result, emits, axi = self._drive(
                    client_key, verb_name, agent_id, self.no_active_key)

                self.assertEqual(
                    result.returncode, 0,
                    f"{client_key} {verb_name}: with NO active cycle on the "
                    f"project, an unattributed run must still proceed; "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                self.assertTrue(
                    emits,
                    f"{client_key} {verb_name}: must decode as one TOON "
                    f"axi: envelope; got stdout={result.stdout!r}")
                missing = self._warnings_of(axi, NO_CYCLE_CODE)
                self.assertEqual(
                    len(missing), 1,
                    f"{client_key} {verb_name}: with no active cycle the run "
                    f"must carry exactly one {NO_CYCLE_CODE!r} warning, "
                    f"unchanged from today; got "
                    f"warnings={axi.get('warnings')!r}")

    # ── GUARD 3 — a --release run is never refused ──────────────────────────

    def test_release_run_is_never_refused_despite_the_active_cycle(self):
        """GUARD — expected to PASS today and after the fix: `--release
        <declared label>` is unattributed to a cycle BY DESIGN, so it must
        proceed even on a project that HAS an active cycle, carrying the
        `release-run` note instead of `no-cycle`."""
        for client_key, verb_name in CLIENT_VERB_PAIRS:
            with self.subTest(client=client_key, verb=verb_name):
                agent_id = f"cycle-refusal-release-{client_key}-{verb_name}".replace(" ", "-")
                result, emits, axi = self._drive(
                    client_key, verb_name, agent_id, self.active_key,
                    extra_argv=["--release", self.RELEASE_LABEL])

                self.assertEqual(
                    result.returncode, 0,
                    f"{client_key} {verb_name}: a --release "
                    f"{self.RELEASE_LABEL} run must never be refused, even "
                    f"while project {self.active_key} has an active cycle "
                    f"({self.active_cycle_id}); "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                self.assertTrue(
                    emits,
                    f"{client_key} {verb_name}: must decode as one TOON "
                    f"axi: envelope; got stdout={result.stdout!r}")
                self.assertEqual(
                    self._warnings_of(axi, NO_CYCLE_CODE), [],
                    f"{client_key} {verb_name}: a release run must NEVER "
                    f"carry the {NO_CYCLE_CODE!r} warning; got "
                    f"warnings={axi.get('warnings')!r}")
                release_notes = self._warnings_of(axi, RELEASE_RUN_CODE)
                self.assertEqual(
                    len(release_notes), 1,
                    f"{client_key} {verb_name}: a release run must carry "
                    f"exactly one {RELEASE_RUN_CODE!r} note instead; got "
                    f"warnings={axi.get('warnings')!r}")


if __name__ == "__main__":
    unittest.main()
