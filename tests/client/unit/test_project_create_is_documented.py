"""The shared core's `HELP_STEPS` has a `project-create` entry, so the
fleet's help steps say how a project is registered.
"""

import unittest

from tests.client.project_create_harness import CLIENTS_DIR, load_module


class ProjectCreateIsDocumentedTest(unittest.TestCase):

    def test_the_cores_help_steps_have_a_project_create_entry(self):
        core = load_module(CLIENTS_DIR / "_crucible_axi.py", "project_create_doc_core")
        steps = core.HELP_STEPS.get("project-create")
        self.assertIsInstance(steps, list, f"HELP_STEPS['project-create'] = {steps!r}")
        self.assertTrue(steps and all(isinstance(s, str) and s for s in steps), steps)

if __name__ == "__main__":
    unittest.main()
