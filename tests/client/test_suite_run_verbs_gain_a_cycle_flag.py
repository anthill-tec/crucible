"""Nine listed verbs that open a run but take no `--cycle`, reconciled against
`clients/*.py` at HEAD of this branch (every `add_gate_cycle_arg`/
`_add_gate_cycle_arg` call site read directly, never assumed from spec prose):

  python   `test` (plain, ungated) has no `--cycle`. `regression` (tier) and
           its five DECLARED cells (`unit`/`module`/`integration`/`e2e`/`bdd`
           via `_add_declared_tier_args`) already call the shared helper.
  mvn      `test`, and the FOUR named tier verbs it runs itself (`unit`,
           `module`, `integration`, `e2e`), have no `--cycle`. So does `bdd`,
           mvn's one DECLARED cell (`_add_declared_tier_args` for mvn never
           calls the shared helper either, and the spec prose names no
           declared cell for mvn at all — a gap the prose misses: `bdd` opens
           a real run once a project declares the profile, exactly like the
           four named tier verbs beside it, and today refuses one the same
           way `unit`/`module`/`integration`/`e2e` used to). `regression`
           (tier) and `pre-merge-gate` already call the shared helper.
  rust     `test`, `smoke-test`, `workspace-regression` and `pre-merge-gate`
           have no `--cycle`. `unit`/`integration`/`e2e` (tier verbs) and the
           two cells rust declares (`module`/`bdd`, via the SAME
           `_add_cargo_tier_run_args` the three named tiers share) already
           call it. So does `regression-ingest`.
  bun      every suite-running verb named in the spec's own worked example
           (`test`, `regression`, `pre-merge-gate`, and its five declared
           cells) already calls it — no discrepancy, used below as the field
           GUARD.
  arduino  `test`, `unit` (tier), `regression` (tier) and `pre-merge-gate` all
           already call it — not in this spec's scope, listed only for the
           census below.

So the reconciled worklist is ELEVEN verbs, not the prose's nine: python
`test`; mvn `test`/`unit`/`module`/`integration`/`e2e`/`bdd`; rust
`test`/`smoke-test`/`workspace-regression`/`pre-merge-gate`. `bdd` is added
because it opens a run and lacks the flag exactly like its sibling tier
verbs, which is the spec's own stated inclusion rule ("the same semantics as
every other verb").

RED phase. `argparse` rejects the unknown `--cycle` flag before any of the
downstream behaviour below can even be reached — every assertion fails for
that one reason, on every verb this file names.

── What each table-driven case asserts, and why a correct GREEN can pass it ──

(a) `CycleFlagHelpCensusTest` — `<verb> --help` must list `--cycle`. Cheap:
    no fixture, no board.

(b) `CycleBindsTheRunRoundTripTest` — `--agent A --cycle 7`, driven as a real
    OS subprocess against a `RecordingBoard` (`tests/client/live_run_harness.
    py`) whose register/heartbeat answer accepts the binding (the board's
    unscripted default: every POST not otherwise matched answers `ok:true,
    changed:true`). The verb's own register/heartbeat POST must carry
    `cycleId: 7` — the exact field `GatedRunIdentity.open_payload` rides on
    `/api/v2/agents/heartbeat` for every verb that already binds this way
    (`_open_gate_identity(project_dir, agent, cycle, …)`, read directly from
    `clients/bun-crucible.py`'s `cmd_test`/`cmd_regression`), proven below by
    one GUARD on bun `test` (already wired). The envelope must also carry NO
    `no-cycle` warning (`preflight_cycle_warnings(cycle_id=…)` short-circuits
    the moment a cycle is supplied). A GREEN that only adds the flag to
    argparse without wiring either half fails this case for a visible reason
    (missing heartbeat post, or a stray `no-cycle` warning) — never a no-op
    stub's free pass.

(c) `CycleWithReleaseIsRefusedTest` — `--release X --cycle 7` must still be
    refused exactly as it already is on a verb that takes both today (GUARD:
    bun `test`, CR-CRU-164 §S1's `ReleaseRunRefused` hard stop — the client
    raises it whenever the board declines to open a run filed under
    `release`, REGARDLESS of why; a release beside a cycle is one of its two
    named reasons, "the previous CR's rule"). Driven against a `RecordingBoard`
    scripted (via the new `refuse_next_start` below) to decline every
    `/api/v2/runs/start`, so the assertion is the same shape pre- and
    post-GREEN: a non-zero exit, an `ok:false` envelope, and NOT ONE ingest
    POST reaching the board — proven both on the bun GUARD (passes today) and
    on the eleven target verbs (fails today via argparse, for the right
    reason; passes once GREEN both adds `--cycle` and leaves the existing
    release-refusal path intact).

A small census (`AlreadyCycleCompliantVerbsHelpCensusTest`) pins the
twenty-six already-compliant verbs this reconciliation found, as a
regression guard against the gap silently reopening.

Invocation:
    python3 -m unittest tests.client.test_suite_run_verbs_gain_a_cycle_flag -v
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    install_project,
    load_toon,
    scrubbed_env,
    write_fake_cargo,
    write_fake_mvnw,
    write_fake_python,
)
from tests.client.test_cr017_client_lifecycle import MISSING_CYCLE_CODE

AGENT = "cycle-binding-fixture"
PROJECT_KEY = "test-key-cycle-binding"
CYCLE = 7
RELEASE = "0.4.0"

# A minimal declared-tier profile pom, reused from the shape
# `tests/client/test_client_tier_declaration_detection.py` already proves the
# client parses by SYMBOL (`<id>`), not by surrounding content.
_POM_WITH_TIER_PROFILE = """<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>cycle.probe</groupId>
  <artifactId>tier-probe</artifactId>
  <version>1.0.0</version>
  <profiles>
    <profile>
      <id>__PROFILE__</id>
    </profile>
  </profiles>
</project>
"""

# ── per-verb fixtures: (extra argv, extra env) ──────────────────────────────

def _python_test_setup(project_dir, bin_dir):
    fake = write_fake_python(project_dir)
    return (["--python", fake, "--project-dir", project_dir, "--reports", "reports"],
           {"FAKE_TOTAL": "1"})

def _mvn_tier_setup(project_dir, bin_dir):
    write_fake_mvnw(project_dir)
    return (["--project-dir", project_dir, "--reports", "reports"],
           {"FAKE_TOTAL": "1"})

def _mvn_bdd_setup(project_dir, bin_dir):
    write_fake_mvnw(project_dir)
    (Path(project_dir) / "pom.xml").write_text(
        _POM_WITH_TIER_PROFILE.replace("__PROFILE__", "bdd"))
    return (["--project-dir", project_dir, "--reports", "reports"],
           {"FAKE_TOTAL": "1"})

def _rust_test_setup(project_dir, bin_dir):
    write_fake_cargo(bin_dir)
    return (["--crate", "fake-crate", "--project-dir", project_dir, "--reports", "reports"],
           {"FAKE_TOTAL": "1"})

def _rust_smoke_test_setup(project_dir, bin_dir):
    write_fake_cargo(bin_dir)
    return (["--project-dir", project_dir, "--reports", "reports"],
           {"FAKE_TOTAL": "1"})

def _rust_workspace_regression_setup(project_dir, bin_dir):
    write_fake_cargo(bin_dir)
    return (["--min-free-g", "0", "--keep-target", "--project-dir", project_dir,
             "--reports", "reports"],
           {"FAKE_TOTAL": "1"})

def _rust_pre_merge_gate_setup(project_dir, bin_dir):
    write_fake_cargo(bin_dir)
    return (["--skip-clippy", "--min-free-g", "0", "--keep-target",
             "--project-dir", project_dir, "--reports", "reports"],
           {"FAKE_TOTAL": "1"})

def _bun_test_setup(project_dir, bin_dir):
    # bun already takes --cycle today; used only by the GUARD cases below.
    from tests.client.live_run_harness import write_fake_bun
    fake = write_fake_bun(project_dir, 1)
    return (["--bun", fake, "--project-dir", project_dir,
             "--package-dir", project_dir, "--reports", "reports"],
           {"FAKE_TOTAL": "1"})

# ── the reconciled worklist: the ELEVEN verbs this CR must give --cycle ────

TARGET_VERBS = (
    ("python-crucible.py", "test", _python_test_setup),
    ("mvn-crucible.py", "test", _mvn_tier_setup),
    ("mvn-crucible.py", "unit", _mvn_tier_setup),
    ("mvn-crucible.py", "module", _mvn_tier_setup),
    ("mvn-crucible.py", "integration", _mvn_tier_setup),
    ("mvn-crucible.py", "e2e", _mvn_tier_setup),
    ("mvn-crucible.py", "bdd", _mvn_bdd_setup),
    ("rust-crucible.py", "test", _rust_test_setup),
    ("rust-crucible.py", "smoke-test", _rust_smoke_test_setup),
    ("rust-crucible.py", "workspace-regression", _rust_workspace_regression_setup),
    ("rust-crucible.py", "pre-merge-gate", _rust_pre_merge_gate_setup),
)

# The already-compliant census (GUARD, not RED) — every call site this
# reconciliation found that ALREADY wires `_add_gate_cycle_arg`/
# `add_gate_cycle_arg`, read directly from clients/*.py at HEAD.
ALREADY_COMPLIANT_VERBS = (
    [("bun-crucible.py", v) for v in
     ("test", "regression", "pre-merge-gate", "unit", "module", "integration", "e2e", "bdd")]
    + [("python-crucible.py", v) for v in
       ("regression", "unit", "module", "integration", "e2e", "bdd")]
    + [("mvn-crucible.py", v) for v in ("regression", "pre-merge-gate")]
    + [("rust-crucible.py", v) for v in
       ("unit", "integration", "e2e", "module", "bdd", "regression-ingest")]
    + [("arduino-crucible.py", v) for v in
       ("test", "unit", "regression", "pre-merge-gate")]
)

# ── shared drive helper ─────────────────────────────────────────────────────

def _drive(client, verb, setup_fn, tmpdir, *, cycle=None, release=None, board=None):
    slug = f"{client}-{verb}".replace(".py", "").replace("-", "_")
    project_dir = os.path.join(tmpdir, slug + "-proj")
    bin_dir = os.path.join(tmpdir, slug + "-bin")
    os.makedirs(project_dir, exist_ok=True)
    os.makedirs(bin_dir, exist_ok=True)
    own_board = board if board is not None else RecordingBoard()
    install_project(project_dir, own_board.url, PROJECT_KEY)
    extra_argv, env_extra = setup_fn(project_dir, bin_dir)
    argv = [verb]
    if release is not None:
        argv += ["--release", release]
    if cycle is not None:
        argv += ["--cycle", str(cycle)]
    argv += ["--agent", AGENT] + extra_argv
    env = scrubbed_env(path_prefix=bin_dir, **env_extra)
    cmd = [sys.executable, str(CLIENTS / client)] + argv
    result = subprocess.run(cmd, cwd=project_dir, env=env,
                            capture_output=True, text=True, timeout=90)
    return result, own_board

def _heartbeat_posts_carrying(posts, cycle):
    return [(p, b) for p, b in posts
            if p.endswith("/agents/heartbeat") and isinstance(b, dict)
            and b.get("cycleId") == cycle]

def _missing_cycle_warnings(axi):
    return [w for w in (axi.get("warnings") or [])
           if isinstance(w, dict) and w.get("code") == MISSING_CYCLE_CODE]

# ── (a) --help lists --cycle ────────────────────────────────────────────────

class CycleFlagHelpCensusTest(unittest.TestCase):
    """RED — each of the eleven reconciled verbs must document `--cycle` in
    its own `--help`."""

    def test_every_reconciled_verb_declares_cycle_in_its_own_help(self):
        for client, verb, _setup in TARGET_VERBS:
            with self.subTest(client=client, verb=verb):
                result = subprocess.run(
                    [sys.executable, str(CLIENTS / client), verb, "--help"],
                    capture_output=True, text=True, timeout=20)
                self.assertEqual(
                    result.returncode, 0,
                    f"{client} {verb} --help must exit 0; "
                    f"stdout={result.stdout!r} stderr={result.stderr!r}")
                self.assertIn(
                    "--cycle", result.stdout,
                    f"{client} {verb} --help must list --cycle; got "
                    f"stdout={result.stdout!r}")

class AlreadyCycleCompliantVerbsHelpCensusTest(unittest.TestCase):
    """GUARD, not RED — pins the twenty-six verbs this reconciliation found
    ALREADY wired to the shared `--cycle` helper, so a future change cannot
    silently drop one back out without a test noticing. Passes today."""

    def test_every_already_compliant_verb_still_declares_cycle(self):
        for client, verb in ALREADY_COMPLIANT_VERBS:
            with self.subTest(client=client, verb=verb):
                result = subprocess.run(
                    [sys.executable, str(CLIENTS / client), verb, "--help"],
                    capture_output=True, text=True, timeout=20)
                self.assertEqual(
                    result.returncode, 0,
                    f"{client} {verb} --help must exit 0; "
                    f"stdout={result.stdout!r} stderr={result.stderr!r}")
                self.assertIn(
                    "--cycle", result.stdout,
                    f"{client} {verb} --help must still list --cycle "
                    f"(reconciliation GUARD); got stdout={result.stdout!r}")

# ── (b) --cycle binds the run, no-cycle warning suppressed ────────────────

class CycleBindsTheRunRoundTripTest(unittest.TestCase):
    """RED — `--agent A --cycle 7` must post `cycleId: 7` on the SAME
    register/heartbeat path bun `test`/`regression` already use, and the
    envelope must carry no `no-cycle` warning."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="cycle-round-trip-")
        self.toon = load_toon()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _assert_cycle_binds(self, client, verb, setup_fn):
        result, board = _drive(client, verb, setup_fn, self.tmpdir, cycle=CYCLE)
        try:
            self.assertEqual(
                result.returncode, 0,
                f"{client} {verb} --cycle {CYCLE} must still be a green "
                f"wrapped run; stdout={result.stdout!r} stderr={result.stderr[-2000:]!r}")

            posts = board.posts()
            carrying = _heartbeat_posts_carrying(posts, CYCLE)
            self.assertEqual(
                len(carrying), 1,
                f"{client} {verb}: exactly ONE register/heartbeat POST must "
                f"carry cycleId={CYCLE} (the same field "
                f"`GatedRunIdentity.open_payload` rides for bun test/"
                f"regression); got posts={posts!r}")

            decoded = self.toon.decode(result.stdout)
            self.assertIn(
                "axi", decoded,
                f"{client} {verb}: stdout must decode to a TOON envelope; "
                f"got stdout={result.stdout!r}")
            axi = decoded["axi"]
            missing = _missing_cycle_warnings(axi)
            self.assertEqual(
                missing, [],
                f"{client} {verb}: a run filed with --cycle {CYCLE} must "
                f"carry NO {MISSING_CYCLE_CODE!r} warning; got "
                f"warnings={axi.get('warnings')!r}")
        finally:
            board.close()

    def test_cycle_binds_the_run_for_every_reconciled_verb(self):
        for client, verb, setup_fn in TARGET_VERBS:
            with self.subTest(client=client, verb=verb):
                self._assert_cycle_binds(client, verb, setup_fn)

class BunTestCycleBindsTheHeartbeatFieldTest(unittest.TestCase):
    """GUARD, not RED — bun `test` already takes `--cycle`; this proves the
    EXACT field (`cycleId` on the register/heartbeat POST) the eleven
    verbs above are pinned against. Passes today."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="cycle-guard-bun-")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_bun_test_cycle_rides_the_heartbeat_as_cycle_id(self):
        result, board = _drive("bun-crucible.py", "test", _bun_test_setup,
                               self.tmpdir, cycle=CYCLE)
        try:
            self.assertEqual(
                result.returncode, 0,
                f"bun test --cycle {CYCLE} must be a green run; "
                f"stdout={result.stdout!r} stderr={result.stderr[-2000:]!r}")
            posts = board.posts()
            carrying = _heartbeat_posts_carrying(posts, CYCLE)
            self.assertEqual(
                len(carrying), 1,
                f"bun test: exactly ONE register/heartbeat POST must carry "
                f"cycleId={CYCLE}; got posts={posts!r}")
        finally:
            board.close()

# ── (c) --release beside --cycle is still refused ──────────────────────────

class CycleWithReleaseIsRefusedTest(unittest.TestCase):
    """(c) — `--release X --cycle 7` must be refused exactly as it already is
    on a verb that takes both today (the GUARD, bun `test`): the board
    declining `/api/v2/runs/start` must surface as a non-zero exit, an
    `ok:false` envelope, and NOT ONE ingest POST. RED on the eleven target
    verbs (argparse rejects --cycle before any of this is even reached);
    GUARD on bun `test` (passes today, proving the refusal mechanism the
    eleven must still honour once GREEN adds --cycle to them)."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="cycle-release-refused-")
        self.toon = load_toon()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _assert_refused(self, client, verb, setup_fn):
        board = RecordingBoard()
        board.refuse_next_start(
            times=99, error="a release run takes no --cycle and no "
                            "cycle-bound agent")
        result, _board = _drive(client, verb, setup_fn, self.tmpdir,
                                cycle=CYCLE, release=RELEASE, board=board)
        try:
            self.assertNotEqual(
                result.returncode, 0,
                f"{client} {verb} --release {RELEASE} --cycle {CYCLE} must "
                f"NOT exit 0 when the board declines to open the run; "
                f"stdout={result.stdout!r} stderr={result.stderr[-2000:]!r}")
            # The REFUSAL itself, not merely "some nonzero exit": --cycle must
            # have been ACCEPTED by argparse (an unrecognized-flag exit is a
            # DIFFERENT failure, never this one) and the client must have
            # reached the real hard stop, emitting a structured ok:false
            # envelope on stdout — an argparse usage error prints to stderr
            # and leaves stdout EMPTY, which decodes to `{}` (no `axi` key),
            # so this assertion fails for a DIFFERENT, correct reason today.
            decoded = self.toon.decode(result.stdout)
            self.assertIn(
                "axi", decoded,
                f"{client} {verb}: stdout must decode to a TOON envelope "
                f"carrying the refusal (not an argparse usage error on "
                f"stderr with nothing on stdout); got stdout={result.stdout!r} "
                f"stderr={result.stderr[-2000:]!r}")
            axi = decoded["axi"]
            self.assertIs(
                axi.get("ok"), False,
                f"{client} {verb}: a refused release-cycle run must reach "
                f"the envelope as ok:false; got axi={axi!r}")
            posts = board.posts()
            ingest_paths = [p for p, _b in posts
                           if p in ("/api/v2/runs", "/api/v2/runs/parsed",
                                    "/api/v2/runs/compile")]
            self.assertEqual(
                ingest_paths, [],
                f"{client} {verb}: a refused release-cycle run must ingest "
                f"NOTHING; got posts={posts!r}")
        finally:
            board.close()

    def test_release_beside_cycle_is_refused_for_every_reconciled_verb(self):
        for client, verb, setup_fn in TARGET_VERBS:
            with self.subTest(client=client, verb=verb):
                self._assert_refused(client, verb, setup_fn)

class BunTestReleaseBesideCycleIsRefusedGuardTest(unittest.TestCase):
    """GUARD, not RED — bun `test` already takes both flags; proves the
    refusal mechanism itself works TODAY, so the eleven RED cases above are
    pinned against a real, already-working contract rather than an invented
    one."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="cycle-release-guard-bun-")
        self.toon = load_toon()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_bun_test_release_beside_cycle_is_refused(self):
        board = RecordingBoard()
        board.refuse_next_start(
            times=99, error="a release run takes no --cycle and no "
                            "cycle-bound agent")
        result, _board = _drive("bun-crucible.py", "test", _bun_test_setup,
                                self.tmpdir, cycle=CYCLE, release=RELEASE,
                                board=board)
        try:
            self.assertNotEqual(
                result.returncode, 0,
                f"bun test --release {RELEASE} --cycle {CYCLE} must NOT "
                f"exit 0 when the board declines to open the run; "
                f"stdout={result.stdout!r} stderr={result.stderr[-2000:]!r}")
            decoded = self.toon.decode(result.stdout)
            axi = decoded.get("axi") or {}
            self.assertIs(
                axi.get("ok"), False,
                f"bun test: a refused release-cycle run must reach the "
                f"envelope as ok:false; got axi={axi!r}")
            posts = board.posts()
            ingest_paths = [p for p, _b in posts
                           if p in ("/api/v2/runs", "/api/v2/runs/parsed",
                                    "/api/v2/runs/compile")]
            self.assertEqual(
                ingest_paths, [],
                f"bun test: a refused release-cycle run must ingest "
                f"NOTHING; got posts={posts!r}")
        finally:
            board.close()

if __name__ == "__main__":
    unittest.main()
