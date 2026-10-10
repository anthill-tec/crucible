"""CR-CRU-164 §S1 (client half) + AC1 — a release's verification runs declare
their release: `--release X.Y.Z` on the client's TEST-RUNNING verbs, beside
`--cycle` wherever a client already declares it (the shared
`add_gate_cycle_arg` sites in `clients/_crucible_axi.py`).

RED phase, C2 (cycle 601). Server half (C1, 6057c8d) already accepts a
top-level `release` on `/api/v2/runs/start` and the three ingest routes, and
already refuses an undeclared release or `release` beside a cycle with 400
(`src/v2.ts`'s `resolveReleaseAttach`) — read directly from source, not
measured through these tests. `GET /api/v2/events?project=…&release=X` (§S2)
is ALSO already server-side (`handleEventsList`'s by-release branch) — this
cycle's gap is the CLIENT side only: no client parses `--release`, no client
stamps it on the run-start/ingest payload, and no client emits the §S1
`release-run` note. This file is RED for exactly that reason everywhere
below: `argparse` rejects the unknown `--release` flag before any of the
downstream behaviour this file pins can even be reached.

── §S1 verb inventory, RECONCILED against `clients/*.py` at HEAD of this
   branch (every `add_gate_cycle_arg`/`_add_gate_cycle_arg` call site read
   directly, not assumed from the CR prose) ──

The CR's own sentence — "`--release` sits beside `--cycle` ... the shared
`add_gate_cycle_arg` sites" — does NOT hold uniformly for the verbs §S1 also
NAMES. Measured 2026-10 on this branch:

  bun      test, regression (tier), pre-merge-gate, and its 5 DECLARED tier
           cells (unit/module/integration/e2e/bdd via `_add_declared_tier_args`)
           ALL already call `_add_gate_cycle_arg` — no discrepancy.
  python   `regression` (tier) and its 5 declared cells already call it;
           the plain `test` verb (named in §S1's prose) does NOT — it has no
           `--cycle` at all today.
  mvn      `regression` (tier) and `pre-merge-gate` already call it; the
           plain `test` verb and the FOUR tier verbs it runs itself
           (unit/module/integration/e2e) do NOT — none has `--cycle` today.
           (`bdd`, mvn's one declared cell, is excluded from this file's scope
           entirely: `_add_declared_tier_args` for mvn never calls
           `_add_gate_cycle_arg` either, and §S1's prose does not name it.)
  rust     ONLY `regression-ingest` already calls it. `test`, `smoke-test`,
           `workspace-regression` and `pre-merge-gate` — all four of the
           OTHER verbs §S1's prose names for rust — have NO `--cycle` at all
           today.
  arduino  `test`, `unit` (tier), `regression` (tier) and `pre-merge-gate`
           all already call it — no discrepancy.

So for python/mvn/rust in particular, GREEN's job is bigger than "add
`--release` next to an existing `--cycle`": several of §S1's own named verbs
have no `--cycle` surface to sit beside yet. This file still asserts the ACs
literally (AC1 names the verb; the AC is the source of truth per the RED
dispatch's own precedence rule), and `--release`'s absence from argparse is
still a legitimate RED either way.

── Scope decisions this file makes, stated up front ──

* The full payload/envelope round trip (`ReleaseFlagRidesRunStartAndIngestTest`)
  is asserted on ONE pinned verb per client — the dispatch explicitly sanctions
  this ("pin one verb per client") for the "unchanged without --release" half,
  and the same pragmatism is extended here: every pinned verb already HAS
  `--cycle` today (so the round trip exercises the real mechanism `--release`
  extends, not a verb GREEN must also wire `--cycle` onto from scratch).
* `--help` lists `--release` is asserted for EVERY verb §S1 names per client
  (32 combinations) — cheap (no fixture, no board), so full coverage is kept.
* The "`--release` suppresses the `no-cycle` warning" half is proven
  in-process against bun only (`BunReleaseRunSuppressesNoCycleWarningTest`,
  reusing the already-proven CR-CRU-094 preflight harness in
  `test_cr017_client_lifecycle.py`): `RecordingBoard` (`live_run_harness.py`),
  used for the cross-client round trip below, answers EVERY `GET
  /api/v2/agents` with an empty `agents: []`, so `_bound_cycle_id` never
  "knows" the agent and `preflight_cycle_warnings` already returns no warning
  regardless of `--release` — it cannot discriminate this half. The in-process
  harness can script the agent as PRESENT and UNBOUND (`_agents_ok(bound_cycle_id=None)`),
  which DOES provoke the `no-cycle` warning on an unreleased run, so it is the
  one that can prove `--release` suppresses it.
* (b) the undeclared-release refusal is also proven in-process against bun,
  reusing `_FakeCrucible(start_response=...)` to answer `/api/v2/runs/start`
  the way the real server's `resolveReleaseAttach` 400s an undeclared label
  (`src/v2.ts`, read directly: `release ${release} is not declared on this
  project's roadmap (declared: ...)`).

Invocation:
    python3 -m unittest tests.client.test_verification_runs_declare_their_release -v
"""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    INGEST_PATHS,
    START,
    RecordingBoard,
    first_index,
    install_project,
    load_toon,
    scrubbed_env,
    write_fake_bun,
    write_fake_cargo,
    write_fake_mvnw,
    write_fake_native,
    write_fake_python,
)
from tests.client.test_cr017_client_lifecycle import (
    MISSING_CYCLE_CODE,
    _Cr094PreflightBase,
    _FakeCrucible,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS = REPO_ROOT / "clients"

RELEASE = "0.4.0"
UNDECLARED_RELEASE = "0.9.9"
RELEASE_NOTE_CODE = "release-run"
AGENT = "release-run-fixture"
PROJECT_KEY = "test-key-release-run"


# ── §S1's verb inventory, exactly as measured above ─────────────────────────

HELP_VERBS = (
    [("bun-crucible.py", v) for v in
     ("test", "regression", "pre-merge-gate", "unit", "module", "integration", "e2e", "bdd")]
    + [("python-crucible.py", v) for v in
       ("test", "regression", "pre-merge-gate", "unit", "module", "integration", "e2e", "bdd")]
    + [("mvn-crucible.py", v) for v in
       ("test", "unit", "module", "integration", "e2e", "regression", "pre-merge-gate")]
    + [("rust-crucible.py", v) for v in
       ("test", "regression-ingest", "smoke-test", "workspace-regression", "pre-merge-gate")]
    + [("arduino-crucible.py", v) for v in
       ("test", "unit", "regression", "pre-merge-gate")]
)


class ReleaseFlagHelpCensusTest(unittest.TestCase):
    """RED — every verb §S1 names, in all five clients, must document
    `--release` in its own `--help` (32 combinations, one assertion helper,
    table-driven per the fleet inventory above)."""

    def test_every_S1_verb_declares_release_in_its_own_help(self):
        for client, verb in HELP_VERBS:
            with self.subTest(client=client, verb=verb):
                result = subprocess.run(
                    [sys.executable, str(CLIENTS / client), verb, "--help"],
                    capture_output=True, text=True, timeout=20)
                self.assertEqual(
                    result.returncode, 0,
                    f"{client} {verb} --help must exit 0; "
                    f"stdout={result.stdout!r} stderr={result.stderr!r}")
                self.assertIn(
                    "--release", result.stdout,
                    f"{client} {verb} --help must list --release beside "
                    f"--cycle (§S1); got stdout={result.stdout!r}")


# ── (a) the full payload/envelope round trip — one pinned verb per client ──

def _bun_test_setup(project_dir, bin_dir):
    fake = write_fake_bun(project_dir, 1)
    argv = ["--bun", fake, "--project-dir", project_dir,
            "--package-dir", project_dir, "--reports", "reports"]
    return argv, {"FAKE_TOTAL": "1"}


def _python_regression_setup(project_dir, bin_dir):
    fake = write_fake_python(project_dir)
    argv = ["--python", fake, "--project-dir", project_dir]
    return argv, {"FAKE_TOTAL": "1"}


def _mvn_regression_setup(project_dir, bin_dir):
    write_fake_mvnw(project_dir)
    argv = ["--project-dir", project_dir]
    return argv, {"FAKE_TOTAL": "1"}


def _rust_regression_ingest_setup(project_dir, bin_dir):
    write_fake_cargo(bin_dir)
    argv = ["--crates", "fake-crate", "--project-dir", project_dir, "--reports", "reports"]
    return argv, {"FAKE_TOTAL": "1"}


def _arduino_unit_setup(project_dir, bin_dir):
    write_fake_native(project_dir)
    argv = ["--dir", "tests/native", "--project-dir", project_dir, "--reports", "reports"]
    return argv, {"FAKE_TOTAL": "1"}


# (client script, verb, setup fn) — every one of these verbs ALREADY has
# `--cycle` today (see the module docstring's inventory), so the round trip
# below exercises the real `--release`-beside-`--cycle` mechanism §S1 asks
# for, not a verb GREEN must also build `--cycle` onto from nothing.
ROUND_TRIP_CASES = (
    ("bun-crucible.py", "test", _bun_test_setup),
    ("python-crucible.py", "regression", _python_regression_setup),
    ("mvn-crucible.py", "regression", _mvn_regression_setup),
    ("rust-crucible.py", "regression-ingest", _rust_regression_ingest_setup),
    ("arduino-crucible.py", "unit", _arduino_unit_setup),
)


class ReleaseFlagRidesRunStartAndIngestTest(unittest.TestCase):
    """RED — `--release 0.4.0` (with `--agent`, unbound, no `--cycle`) must
    land on BOTH the run-start POST and the closing ingest POST at the TOP
    LEVEL (`release: "0.4.0"`), and the final envelope must carry a
    `release-run` note naming it. One assertion helper
    (`_assert_release_round_trip`), one table (`ROUND_TRIP_CASES`), one
    `subTest` per (client, verb) — never a hand-written test per verb."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="release-run-")
        self.toon = load_toon()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _drive(self, client, verb, setup_fn, release):
        import os
        slug = f"{client}-{verb}".replace(".py", "").replace("-", "_")
        project_dir = os.path.join(self.tmpdir, slug + "-proj")
        bin_dir = os.path.join(self.tmpdir, slug + "-bin")
        os.makedirs(project_dir, exist_ok=True)
        os.makedirs(bin_dir, exist_ok=True)
        board = RecordingBoard()
        # arduino uniquely requires CRUCIBLE_PROJECT_NAME in the subproject
        # .env (DN §3) — install_project only writes it when given, and the
        # other four clients ignore the extra line, so it is supplied
        # unconditionally rather than special-cased per client.
        install_project(project_dir, board.url, PROJECT_KEY, "release-run-fixture-project")
        extra_argv, env_extra = setup_fn(project_dir, bin_dir)
        argv = [verb]
        if release:
            argv += ["--release", release]
        argv += ["--agent", AGENT] + extra_argv
        env = scrubbed_env(path_prefix=bin_dir, **env_extra)
        cmd = [sys.executable, str(CLIENTS / client)] + argv
        result = subprocess.run(cmd, cwd=project_dir, env=env,
                                capture_output=True, text=True, timeout=90)
        return result, board

    def _assert_release_round_trip(self, client, verb, setup_fn):
        result, board = self._drive(client, verb, setup_fn, RELEASE)
        try:
            self.assertEqual(
                result.returncode, 0,
                f"{client} {verb} --release {RELEASE} must still be a green "
                f"wrapped run; stdout={result.stdout!r} stderr={result.stderr!r}")

            posts = board.posts()
            paths = [p for p, _ in posts]
            start_idx = first_index(posts, lambda p, b: p == START)
            self.assertIsNotNone(
                start_idx, f"{client} {verb}: must POST {START}; got paths={paths!r}")
            start_body = posts[start_idx][1] or {}
            self.assertEqual(
                start_body.get("release"), RELEASE,
                f"{client} {verb}: the run-start body must carry TOP-LEVEL "
                f"release={RELEASE!r}; got body={start_body!r}")

            ingest_idx = first_index(posts, lambda p, b: p in INGEST_PATHS)
            self.assertIsNotNone(
                ingest_idx, f"{client} {verb}: the run must still ingest; "
                f"got paths={paths!r}")
            ingest_body = posts[ingest_idx][1] or {}
            self.assertEqual(
                ingest_body.get("release"), RELEASE,
                f"{client} {verb}: the closing ingest body must carry "
                f"TOP-LEVEL release={RELEASE!r}; got body={ingest_body!r}")

            decoded = self.toon.decode(result.stdout)
            self.assertIn(
                "axi", decoded,
                f"{client} {verb}: stdout must decode to a TOON envelope; "
                f"got stdout={result.stdout!r}")
            axi = decoded["axi"]
            warnings = axi.get("warnings") or []
            release_notes = [w for w in warnings
                             if isinstance(w, dict) and w.get("code") == RELEASE_NOTE_CODE]
            self.assertEqual(
                len(release_notes), 1,
                f"{client} {verb}: the envelope must carry exactly ONE "
                f"{RELEASE_NOTE_CODE!r} note; got warnings={warnings!r}")
            self.assertIn(
                RELEASE, release_notes[0].get("detail") or "",
                f"{client} {verb}: the {RELEASE_NOTE_CODE!r} note must NAME "
                f"the release; got {release_notes[0]!r}")
        finally:
            board.close()

    def test_release_rides_run_start_and_ingest_for_one_verb_per_client(self):
        for client, verb, setup_fn in ROUND_TRIP_CASES:
            with self.subTest(client=client, verb=verb):
                self._assert_release_round_trip(client, verb, setup_fn)

    def test_omitting_release_changes_nothing_for_one_verb_per_client(self):
        """GUARD, not RED — pins that `--release` is ADDITIVE: the exact same
        pinned verbs, run with no `--release` at all, must post no `release`
        key anywhere and carry no `release-run` note. This already holds
        today (nothing reads a flag that does not exist yet) and must keep
        holding once GREEN lands `--release` — it is the regression pin that
        would catch a GREEN that defaults `release` onto every run."""
        for client, verb, setup_fn in ROUND_TRIP_CASES:
            with self.subTest(client=client, verb=verb):
                result, board = self._drive(client, verb, setup_fn, release=None)
                try:
                    self.assertEqual(
                        result.returncode, 0,
                        f"{client} {verb} without --release must still be a "
                        f"green run; stdout={result.stdout!r} stderr={result.stderr!r}")
                    posts = board.posts()
                    for path, body in posts:
                        self.assertNotIn(
                            "release", body or {},
                            f"{client} {verb}: no request may carry a "
                            f"`release` key when --release was never given; "
                            f"path={path!r} body={body!r}")
                    decoded = self.toon.decode(result.stdout)
                    axi = decoded.get("axi") or {}
                    warnings = axi.get("warnings") or []
                    codes = [w.get("code") for w in warnings if isinstance(w, dict)]
                    self.assertNotIn(
                        RELEASE_NOTE_CODE, codes,
                        f"{client} {verb}: no {RELEASE_NOTE_CODE!r} note "
                        f"without --release; got warnings={warnings!r}")
                finally:
                    board.close()


# ── bun-only: --release suppresses the no-cycle warning (in-process) ───────

class BunReleaseRunSuppressesNoCycleWarningTest(_Cr094PreflightBase):
    """RED — reuses the CR-CRU-094 preflight harness (the only one that can
    script the agent as PRESENT and UNBOUND, which is what provokes the
    `no-cycle` warning `RecordingBoard`'s always-empty `agents: []` cannot).

    `--release 0.4.0` on a run whose agent is bound to nothing must NOT carry
    the `no-cycle` warning, must carry the `release-run` note instead, and
    must print no `no-cycle` line on stderr — even though the SAME agent,
    run WITHOUT `--release`, already does all three the other way
    (`UnboundRunIsWarnedOnBothChannelsTest` in `test_cr017_client_lifecycle.py`,
    unmodified by this CR)."""

    def test_release_run_carries_no_no_cycle_warning_and_prints_no_no_cycle_line(self):
        server = _FakeCrucible()

        code, out, err, gets = self._drive(
            server, "test", self._agents_ok(bound_cycle_id=None),
            extra_argv=["--release", RELEASE])

        self.assertTrue(
            self._binding_reads(gets),
            f"pre-flight must still read the binding via GET /api/v2/agents "
            f"even on a release run; got gets={gets!r}")

        axi = self._assert_toon_axi_shaped(out, "test", "release-run preflight")
        self.assertEqual(
            self._missing_cycle_warnings(axi), [],
            f"a run filed under --release {RELEASE} must carry NO "
            f"{MISSING_CYCLE_CODE!r} warning even though its agent is "
            f"unbound; got warnings={axi.get('warnings')!r}")
        release_notes = [w for w in (axi.get("warnings") or [])
                         if isinstance(w, dict) and w.get("code") == RELEASE_NOTE_CODE]
        self.assertEqual(
            len(release_notes), 1,
            f"exactly one {RELEASE_NOTE_CODE!r} note must ride the envelope "
            f"instead; got warnings={axi.get('warnings')!r}")
        self.assertIn(RELEASE, release_notes[0].get("detail") or "",
                     f"the note must name the release; got {release_notes[0]!r}")
        self.assertNotIn(
            MISSING_CYCLE_CODE, err,
            f"stderr must carry no {MISSING_CYCLE_CODE!r} line on a "
            f"release run; got stderr={err!r}")

        start_body = server.payload_for("/api/v2/runs/start") or {}
        self.assertEqual(
            start_body.get("release"), RELEASE,
            f"the run-start body must carry top-level release={RELEASE!r}; "
            f"got {start_body!r}")
        ingest_body = server.payload_for("/api/v2/runs/parsed") or {}
        self.assertEqual(
            ingest_body.get("release"), RELEASE,
            f"the closing ingest body must carry top-level release={RELEASE!r}; "
            f"got {ingest_body!r}")


# ── (b) the server's 400 refusal reaches the envelope as ok:false ──────────

class BunUndeclaredReleaseRefusalTest(_Cr094PreflightBase):
    """RED — `src/v2.ts`'s `resolveReleaseAttach` refuses an undeclared
    release with 400 naming the declared ones, BEFORE any write
    ("... → {}, the route is unchanged" ... "otherwise the label, for the
    route to stamp"). Scripted here via `_FakeCrucible(start_response=...)`
    with the real refusal wording read from source, so the client's handling
    of a REAL shape is pinned, not an invented one.

    This refusal fires at RUN-START, before any runId exists — a different
    code path from CR-CRU-170's "the board refused the ingest that carried
    the runId" abort (that one needs an OPEN run to abort; this one never
    opens one). This test does not touch, retest or contradict that
    behaviour — it is simply orthogonal to it."""

    REFUSAL = (f"release {UNDECLARED_RELEASE} is not declared on this "
              f"project's roadmap (declared: 0.2.0, 0.3.0, 0.4.0)")

    def test_undeclared_release_reaches_the_envelope_as_ok_false_naming_the_refusal(self):
        server = _FakeCrucible(start_response={"ok": False, "error": self.REFUSAL})

        code, out, err, gets = self._drive(
            server, "test", self._agents_ok(bound_cycle_id=None),
            extra_argv=["--release", UNDECLARED_RELEASE])

        axi = self._assert_toon_axi_shaped(out, "test", "undeclared release refusal")
        self.assertFalse(
            axi.get("ok"), f"an undeclared release must reach the envelope "
            f"as ok:false; got axi={axi!r}")
        rendered = repr(axi)
        self.assertIn(
            UNDECLARED_RELEASE, rendered,
            f"the envelope must name the refused release; got axi={axi!r}")
        self.assertIn(
            "declared", rendered.lower(),
            f"the envelope must name the refusal (an undeclared label, "
            f"the declared ones) — got axi={axi!r}")

        stored_paths = [p for p in server.paths()
                        if p in ("/api/v2/runs", "/api/v2/runs/parsed",
                                 "/api/v2/runs/compile")]
        self.assertEqual(
            stored_paths, [],
            f"§S1: 'nothing is stored' on a refused release — no ingest "
            f"POST may have been made; got paths={server.paths()!r}")


if __name__ == "__main__":
    unittest.main()
