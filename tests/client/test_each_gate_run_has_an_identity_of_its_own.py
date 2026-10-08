"""Each driven gate run has an identity of its own: `gate-run` and
`gate-respond` (`drive_axi_run`, shared by all five clients) post a run's
snapshots under `<caller>·gate·<run>`, where `<run>` is the first 8
characters of the no-mistakes run id named by the run's first snapshot. The
identity is opened before that snapshot is posted, heartbeated while the run
is driven and removed on every exit — so two concurrent drives by ONE caller
on two runs never share an identity, and the first to finish never removes
the other's. A drive that gets no run id at all (refused before any
snapshot) opens no identity.

(a) two concurrent drives by one caller, as REAL subprocesses against one
    `RecordingBoard`: each run's snapshots carry that run's own identity, and
    the first drive's exit leaves the second's identity online (heartbeated
    after the first's removal, removed only by its own exit);
(b) the identity's name: exactly the first 8 characters of the run id;
    a refused drive with no run id opens none.

Invocation:
    python3 -m pytest tests/client/test_each_gate_run_has_an_identity_of_its_own.py -q
"""

import os
import shutil
import stat
import subprocess
import sys
import unittest

from tests.client.test_cr054_fleet_inventory import CLIENT_FILES
from tests.client.test_a_gate_posted_by_the_fleet_carries_its_run_and_release import (
    _FAKE_NO_MISTAKES_BODY,
)
from tests.client.test_a_gate_is_running_only_while_its_run_is_driven_or_held import (
    GATE_DECISIONS_PATH,
    GATES_PATH,
    HEARTBEAT_PATH,
    UNREGISTER_PATH,
    _drive_all,
    _fixture,
)
from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    install_project,
    new_scratch,
    scrubbed_env,
)

CALLER = "one-caller-two-runs"
PROJECT_KEY = "one-caller-two-runs-key"
PROJECT_NAME = "one-caller-two-runs"

# Two runs whose ids differ within their first 8 characters, so each names
# an identity of its own.
SHORT_RUN_ID = "a1b2c3d4-short-run"
LONG_RUN_ID = "e5f6a7b8-long-run"
# The short drive ends well before the long one; the long one keeps being
# driven across several poll cadences after the short one's exit.
SHORT_RUN_SECONDS = "1.0"
LONG_RUN_SECONDS = "6.0"


def _identity(caller, run_id):
    return f"{caller}\u00b7gate\u00b7{run_id[:8]}"


def _index_of(posts, predicate):
    for i, (path, body) in enumerate(posts):
        if predicate(path, body):
            return i
    return None


def _is(path_wanted, agent_id):
    return lambda p, b: (p == path_wanted and isinstance(b, dict)
                         and b.get("agentId") == agent_id)


def _gate_run_id(body):
    run = (body.get("gate") or {}).get("run") if isinstance(body, dict) else None
    return run.get("id") if isinstance(run, dict) else None


# ═══════════════════════════════════════════════════════════════════════════
# (a) two concurrent drives by one caller on two runs
# ═══════════════════════════════════════════════════════════════════════════

class TwoConcurrentDrivesByOneCallerTest(unittest.TestCase):

    def setUp(self):
        self.project = new_scratch("one-caller-two-runs-")
        self.bin_dir = new_scratch("one-caller-two-runs-bin-")
        self.state_dir = new_scratch("one-caller-two-runs-state-")
        fake_path = os.path.join(self.bin_dir, "no-mistakes")
        with open(fake_path, "w") as f:
            f.write(f"#!{sys.executable}\n")
            f.write(_FAKE_NO_MISTAKES_BODY)
        os.chmod(fake_path, os.stat(fake_path).st_mode | stat.S_IXUSR)
        self.files = {}
        for name, run_id in (("short", SHORT_RUN_ID), ("long", LONG_RUN_ID)):
            live, final = _fixture(run_id, f"feature/{name}", "cafe2001", "review")
            live_file = os.path.join(self.state_dir, f"{name}-live.toon")
            final_file = os.path.join(self.state_dir, f"{name}-final.toon")
            with open(live_file, "w") as f:
                f.write(live)
            with open(final_file, "w") as f:
                f.write(final)
            self.files[name] = (live_file, final_file)

    def tearDown(self):
        shutil.rmtree(self.project, ignore_errors=True)
        shutil.rmtree(self.bin_dir, ignore_errors=True)
        shutil.rmtree(self.state_dir, ignore_errors=True)

    def _env(self, name, run_seconds):
        live_file, final_file = self.files[name]
        return scrubbed_env(self.bin_dir, GATE_FLEET_FAKE_LIVE_FILE=live_file,
                            GATE_FLEET_FAKE_FINAL_FILE=final_file,
                            GATE_FLEET_FAKE_RUN_SECONDS=run_seconds)

    def _drive_both(self, client_name):
        board = RecordingBoard()
        try:
            install_project(self.project, board.url, PROJECT_KEY, PROJECT_NAME)
            procs = []
            for name, seconds in (("long", LONG_RUN_SECONDS),
                                  ("short", SHORT_RUN_SECONDS)):
                cmd = [sys.executable, str(CLIENTS / client_name), "gate-run",
                       "--intent", f"drive the {name} run", "--agent", CALLER,
                       "--project-dir", self.project]
                procs.append(subprocess.Popen(
                    cmd, cwd=self.project, env=self._env(name, seconds),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
            try:
                outputs = [p.communicate(timeout=60) for p in procs]
            finally:
                for p in procs:
                    if p.poll() is None:
                        p.kill()
                        p.wait()
            return [p.returncode for p in procs], outputs, board.posts()
        finally:
            board.close()

    def test_every_clients_runs_each_keep_an_identity_of_their_own(self):
        short_identity = _identity(CALLER, SHORT_RUN_ID)
        long_identity = _identity(CALLER, LONG_RUN_ID)
        for key, path in CLIENT_FILES.items():
            with self.subTest(client=key):
                codes, outputs, posts = self._drive_both(path.name)
                self.assertEqual(codes, [0, 0],
                                 f"{key}: both drives must seal; stderr="
                                 f"{[e for _o, e in outputs]!r}")

                # Each run's snapshots carry that run's OWN identity.
                for run_id, identity in ((SHORT_RUN_ID, short_identity),
                                         (LONG_RUN_ID, long_identity)):
                    gates = [b for p, b in posts if p == GATES_PATH
                             and _gate_run_id(b) == run_id]
                    self.assertGreaterEqual(
                        len(gates), 2,
                        f"{key}: expected an interim and a seal for {run_id}; "
                        f"posts={posts!r}")
                    self.assertEqual(
                        {g.get("agentId") for g in gates}, {identity},
                        f"{key}: every snapshot of {run_id} must post under "
                        f"{identity!r}")

                # The short drive's exit removes ITS identity only...
                short_removed = _index_of(posts, _is(UNREGISTER_PATH, short_identity))
                long_removed = _index_of(posts, _is(UNREGISTER_PATH, long_identity))
                self.assertIsNotNone(short_removed,
                                     f"{key}: the short run's identity was never "
                                     f"removed; posts={posts!r}")
                self.assertIsNotNone(long_removed,
                                     f"{key}: the long run's identity was never "
                                     f"removed; posts={posts!r}")
                assert short_removed is not None and long_removed is not None
                self.assertLess(short_removed, long_removed,
                                f"{key}: the long run's identity must outlive "
                                f"the short run's exit")
                # ...and the long run's identity stays online after it: it is
                # still heartbeated, and still posts its run, before its own
                # removal.
                after = posts[short_removed + 1:long_removed]
                self.assertTrue(
                    any(_is(HEARTBEAT_PATH, long_identity)(p, b) for p, b in after),
                    f"{key}: the long run's identity must stay online (heartbeated) "
                    f"after the short run's exit; posts={posts!r}")
                long_seal = _index_of(
                    posts, lambda p, b: p == GATES_PATH
                    and _gate_run_id(b) == LONG_RUN_ID
                    and "push" in (b.get("gate") or {}))
                self.assertIsNotNone(long_seal)
                assert long_seal is not None
                self.assertLess(long_seal, long_removed,
                                f"{key}: the long run seals under its identity "
                                f"before that identity is removed")
                self.assertEqual(
                    [b for p, b in posts if p == UNREGISTER_PATH
                     and b.get("agentId") == long_identity][0].get("silent"),
                    True)


# ═══════════════════════════════════════════════════════════════════════════
# (b) the identity's name per run, and no identity without a run id
# ═══════════════════════════════════════════════════════════════════════════

NAMED_RUN_ID = "0123456789abcdef"


class TheRunIdentityNamesItsRunTest(unittest.TestCase):

    CALLER = "names-its-run"

    @classmethod
    def setUpClass(cls):
        cls.drives = {}
        for key, path in CLIENT_FILES.items():
            live, final = _fixture(NAMED_RUN_ID, f"feature/named-{key}",
                                   "cafe2002", "review")
            cls.drives[key] = _drive_all(
                key, path,
                ["gate-run", "--intent", "name the run", "--agent", cls.CALLER],
                live, final, "1.0")

    def test_every_clients_identity_is_the_caller_gate_and_the_run_ids_first_8(self):
        want = f"{self.CALLER}\u00b7gate\u00b701234567"
        for key, drive in self.drives.items():
            with self.subTest(client=key):
                opened = {b.get("agentId") for p, b in drive.posts
                          if p == HEARTBEAT_PATH}
                self.assertEqual(opened, {want},
                                 f"{key}: posts={drive.posts!r}")
                self.assertEqual(
                    [b.get("identity", {}).get("displayName")
                     for p, b in drive.posts if p == HEARTBEAT_PATH][0], want)
                self.assertEqual(
                    {b.get("agentId") for p, b in drive.posts if p == GATES_PATH},
                    {want})
                self.assertEqual(
                    [b.get("agentId") for p, b in drive.posts
                     if p == UNREGISTER_PATH], [want])


_REFUSED_NO_RUN = "error: no run is awaiting a decision\n"


class ARefusedDriveWithNoRunIdOpensNoIdentityTest(unittest.TestCase):

    CALLER = "refused-before-any-snapshot"

    @classmethod
    def setUpClass(cls):
        cls.drives = {}
        for key, path in CLIENT_FILES.items():
            # No snapshot while the call runs, and a final answer naming no
            # run: the tool refused the respond before any run was touched.
            cls.drives[key] = _drive_all(
                key, path,
                ["gate-respond", "--action", "approve", "--agent", cls.CALLER],
                "", _REFUSED_NO_RUN, "0.5")

    def test_every_clients_refused_drive_opens_and_removes_no_identity(self):
        for key, drive in self.drives.items():
            with self.subTest(client=key):
                self.assertNotEqual(drive.code, 0, f"{key}: a refusal fails")
                lifecycle = [(p, b) for p, b in drive.posts
                             if p in (HEARTBEAT_PATH, UNREGISTER_PATH)]
                self.assertEqual(lifecycle, [],
                                 f"{key}: a drive with no run id opens no "
                                 f"identity; posts={drive.posts!r}")
                self.assertEqual(
                    [p for p, _b in drive.posts
                     if p in (GATES_PATH, GATE_DECISIONS_PATH)], [],
                    f"{key}: a refusal posts no gate and records no decision")


if __name__ == "__main__":
    unittest.main()
