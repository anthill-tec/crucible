"""`project-create` against a real, throwaway board: creating is open, and the
token makes it idempotent.

The feature: a project is created by its token, at most once. No fake can
prove it: that a second create under the same token finds the stored project
rather than adding one is the board's own storage uniqueness, which a
scripted board would only answer as the test told it to.

- On a fresh board with no agent registered anywhere, the create is accepted:
  the project appears under the token's key, and its metadata holds the token.
- Two runs with the same token, under two names, leave exactly one project
  with that key; the second answers it with `created: false`.

The board is `tests/client/real_board.py`'s (`bun run src/server.ts` over a
temp store on a free port); the client runs as a subprocess from a scratch
copy of the fleet that declares that board (`project_create_harness`).
"""

import shutil
import unittest

from tests.client.project_create_harness import (
    ScratchFleet,
    drive,
    key_for_token,
    make_project_dir,
)
from tests.client.real_board import RealBoard

TOKEN = "real-board-proj"  # noqa: S105 -- a project token, not a secret


class ProjectCreateAgainstARealBoardTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        bun = shutil.which("bun")
        if bun is None:
            raise RuntimeError("bun is required to boot the real board")
        cls.board = RealBoard(bun, "pre-existing")
        try:
            cls.fleet = ScratchFleet(cls.board.base)
        except BaseException:
            cls.board.close()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.fleet.close()
        cls.board.close()

    def _run(self, name, token=TOKEN):
        root = make_project_dir(self.board.base)
        self.addCleanup(shutil.rmtree, root, True)
        return drive(self.fleet, root, name=name, token=token, agent="real-orch")

    def _projects_with_key(self, key):
        listed = self.board.http("/api/v2/projects")
        self.assertIs(listed.get("ok"), True, listed)
        return [p for p in listed.get("projects") or [] if p.get("key") == key]

    def test_a_fresh_board_with_no_agents_accepts_the_create(self):
        token = "open-create"  # noqa: S105
        key = key_for_token(token)
        agents = self.board.http("/api/v2/agents")
        self.assertEqual(agents.get("agents"), [], "no agent is registered anywhere")

        result, axi = self._run("Open Create", token=token)

        self.assertEqual(result.returncode, 0, f"stderr={result.stderr!r}")
        self.assertIs(axi.get("created"), True, axi)
        rows = self._projects_with_key(key)
        self.assertEqual([r.get("name") for r in rows], ["Open Create"])
        metadata = self.board.http(f"/api/v2/projects/{key}/metadata")
        self.assertEqual(metadata.get("metadata"), {"PROJECT_TOKEN": token})

    def test_two_runs_with_the_same_token_leave_exactly_one_project(self):
        key = key_for_token(TOKEN)
        first, first_axi = self._run("First Name")
        second, second_axi = self._run("Second Name")

        self.assertEqual(first.returncode, 0, f"stderr={first.stderr!r}")
        self.assertEqual(second.returncode, 0, f"stderr={second.stderr!r}")
        self.assertEqual(first_axi.get("projectKey"), key)
        self.assertIs(first_axi.get("created"), True)
        self.assertEqual(second_axi.get("projectKey"), key)
        self.assertIs(second_axi.get("created"), False)
        self.assertEqual(len(self._projects_with_key(key)), 1)


if __name__ == "__main__":
    unittest.main()
