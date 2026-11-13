"""`project-create` registers `--agent` as the project's ORCHESTRATOR and
seeds the metadata map in the same call.

After the create the verb sends `POST /api/v2/agents/register` with its own
payload -- `{agentId, projectKey, status: "online", message: "Registering the
project", role: "ORCHESTRATOR", identity: {displayName, source: "claude-md",
repoPath}}` -- then ONE `PATCH …/metadata` whose `set` holds `PROJECT_TOKEN`,
`PROJECT_ACRONYM` (only with `--acronym`) and each `--set` pair. The
envelope's `metadata` is the board's map. On a project that already exists the
same register and PATCH run when the agent is absent from it, or is an unbound
ORCHESTRATOR there; under another role, or bound to a cycle, the verb refuses
with `agent-role-conflict`, registering, patching and writing nothing. It never
unregisters.

Driven as a real subprocess against the recording board double
(`tests/client/project_create_harness.py`).

Fails today: no client has a `project-create` subcommand.
"""

import os
import unittest

from tests.client.project_create_harness import (
    BoardDoubleMixin,
    key_for_token,
    names_code,
)

TOKEN = "seeded-proj"  # noqa: S105 -- a project token, not a secret
AGENT = "orch-seed"


class ProjectCreateRegistersAndSeedsANewProjectTest(BoardDoubleMixin, unittest.TestCase):

    def test_the_register_payload_is_exactly_the_modules_own_orchestrator_payload(self):
        root = self.project_root()
        result, _axi = self.run_verb(root, token=TOKEN, agent=AGENT)

        self.assertEqual(result.returncode, 0, result.stderr)
        registers = self.board.registers()
        self.assertEqual(len(registers), 1, self.board.requests)
        self.assertEqual(registers[0][2], {
            "agentId": AGENT,
            "projectKey": key_for_token(TOKEN),
            "status": "online",
            "message": "Registering the project",
            "role": "ORCHESTRATOR",
            "identity": {"displayName": AGENT, "source": "claude-md",
                         "repoPath": os.path.abspath(root)},
        })

    def test_one_patch_sets_only_the_token_when_no_acronym_or_set_is_given(self):
        root = self.project_root()
        result, axi = self.run_verb(root, token=TOKEN, agent=AGENT)

        self.assertEqual(result.returncode, 0, result.stderr)
        patches = self.board.patches()
        self.assertEqual(len(patches), 1, self.board.requests)
        method, path, body = patches[0]
        self.assertEqual(path, f"/api/v2/projects/{key_for_token(TOKEN)}/metadata")
        self.assertEqual(body.get("agentId"), AGENT)
        self.assertEqual(body.get("set"), {"PROJECT_TOKEN": TOKEN})
        self.assertEqual(axi.get("metadata"), {"PROJECT_TOKEN": TOKEN})

    def test_the_patch_set_holds_the_token_the_acronym_and_each_set_pair(self):
        root = self.project_root()
        result, axi = self.run_verb(
            root, "--acronym", "SDP", "--set", "PROJECT_STACKS=bun,python",
            "--set", "OWNER_NOTE=a=b", token=TOKEN, agent=AGENT)

        self.assertEqual(result.returncode, 0, result.stderr)
        patches = self.board.patches()
        self.assertEqual(len(patches), 1, self.board.requests)
        expected = {"PROJECT_TOKEN": TOKEN, "PROJECT_ACRONYM": "SDP",
                    "PROJECT_STACKS": "bun,python", "OWNER_NOTE": "a=b"}
        self.assertEqual(patches[0][2].get("set"), expected)
        self.assertEqual(axi.get("metadata"), expected)

    def test_register_runs_before_the_patch_and_no_unregister_is_ever_sent(self):
        root = self.project_root()
        result, _axi = self.run_verb(root, token=TOKEN, agent=AGENT)

        self.assertEqual(result.returncode, 0, result.stderr)
        order = [(m, p) for m, p, _b in self.board.requests]
        register_at = order.index(("POST", "/api/v2/agents/register"))
        patch_at = order.index(("PATCH", f"/api/v2/projects/{key_for_token(TOKEN)}/metadata"))
        self.assertLess(register_at, patch_at)
        self.assertEqual(self.board.unregisters(), [])
        self.assertEqual(
            [a["role"] for a in self.board.agents if a["agentId"] == AGENT],
            ["ORCHESTRATOR"])


class ProjectCreateSeedsAnExistingProjectTest(BoardDoubleMixin, unittest.TestCase):
    """The token's project already on the board, under each agent state."""

    def setUp(self):
        super().setUp()
        self.key = key_for_token(TOKEN)
        self.board.add_project(self.key, name="already here",
                               metadata={"KEPT": "yes"})

    def test_an_agent_absent_from_the_project_is_registered_and_the_metadata_patched(self):
        # Another agent, bound and of another role, is no conflict for ours.
        self.board.add_agent(self.key, "someone-else", "RED", bound_cycle_id=7)
        root = self.project_root()
        result, axi = self.run_verb(root, token=TOKEN, agent=AGENT)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIs(axi.get("created"), False)
        self.assertEqual(len(self.board.registers()), 1, self.board.requests)
        self.assertEqual(len(self.board.patches()), 1, self.board.requests)
        self.assertEqual(axi.get("metadata"), {"KEPT": "yes", "PROJECT_TOKEN": TOKEN},
                         "the envelope's map is the board's whole map after the PATCH")
        self.assertEqual(self.board.unregisters(), [])

    def test_an_unbound_orchestrator_already_there_is_registered_and_patched_again(self):
        self.board.add_agent(self.key, AGENT, "ORCHESTRATOR")
        root = self.project_root()
        result, axi = self.run_verb(root, token=TOKEN, agent=AGENT)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(len(self.board.registers()), 1, self.board.requests)
        self.assertEqual(len(self.board.patches()), 1, self.board.requests)
        self.assertEqual(self.board.unregisters(), [])


class ProjectCreateRefusesAnAgentRoleConflictTest(BoardDoubleMixin, unittest.TestCase):
    """The agent already on the project under another role, or bound."""

    ENV = b"A=1\nCRUCIBLE_PROJECT_KEY=\n"

    def setUp(self):
        super().setUp()
        self.key = key_for_token(TOKEN)
        self.board.add_project(self.key, name="already here")

    def _assert_refused_and_untouched(self, root, result, axi, row_before, row):
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertTrue(axi, f"no envelope: {result.stdout!r} {result.stderr!r}")
        self.assertIs(axi.get("ok"), False)
        self.assertTrue(names_code(axi, "agent-role-conflict"), axi)
        self.assertTrue(axi.get("help"), "a refusal carries a help")
        self.assertEqual(self.board.registers(), [], "nothing is registered")
        self.assertEqual(self.board.patches(), [], "no PATCH is sent")
        self.assertEqual(self.board.unregisters(), [], "no unregister is ever sent")
        self.assertEqual(row, row_before, "the agent's row is unchanged")
        self.assertEqual((root / ".env").read_bytes(), self.ENV, ".env is not written")

    def error_without_key(self, axi):
        """The refusal's text with the project key cut out, so a role or cycle
        is never found inside the key's own digits."""
        return str(axi.get("error")).replace(self.key, "")

    def test_the_agent_under_another_role_is_refused_naming_the_role(self):
        row = self.board.add_agent(self.key, AGENT, "report")
        row_before = dict(row)
        root = self.project_root(self.ENV)
        result, axi = self.run_verb(root, "--write-env", token=TOKEN, agent=AGENT)

        self._assert_refused_and_untouched(root, result, axi, row_before, row)
        self.assertIn("report", self.error_without_key(axi))

    def test_the_agent_bound_to_a_cycle_is_refused_naming_its_role_and_cycle(self):
        row = self.board.add_agent(self.key, AGENT, "ORCHESTRATOR", bound_cycle_id=4242)
        row_before = dict(row)
        root = self.project_root(self.ENV)
        result, axi = self.run_verb(root, "--write-env", token=TOKEN, agent=AGENT)

        self._assert_refused_and_untouched(root, result, axi, row_before, row)
        self.assertIn("ORCHESTRATOR", self.error_without_key(axi))
        self.assertIn("4242", self.error_without_key(axi))

    def test_a_tdd_role_bound_to_a_cycle_is_refused_naming_both(self):
        row = self.board.add_agent(self.key, AGENT, "GREEN", bound_cycle_id=9173)
        row_before = dict(row)
        root = self.project_root(self.ENV)
        result, axi = self.run_verb(root, "--write-env", token=TOKEN, agent=AGENT)

        self._assert_refused_and_untouched(root, result, axi, row_before, row)
        self.assertIn("GREEN", self.error_without_key(axi))
        self.assertIn("9173", self.error_without_key(axi))


if __name__ == "__main__":
    unittest.main()
