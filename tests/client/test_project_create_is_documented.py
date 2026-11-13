"""`project-create` is stated where the project's documentation and the
fleet's help steps say how a project is registered.

- The PRD's bullet that opens "`POST /api/projects/add` with an existing key
  → HTTP 400." still opens with that sentence, and names `project-create` and
  `--write-env`.
- The client-fleet inventory's `_project_key` row names `project-create`.
- The CHANGELOG's `[Unreleased]` `### Added` holds a bullet naming
  `project-create`, its token, `--write-env` and `--project-dir`.
- The README names `project-create`.
- The shared core's `HELP_STEPS` has a `project-create` entry.

Pinned by containment, never by whole sentences. Fails today: none of these
documents names the verb, and `HELP_STEPS` has no entry for it.
"""

import re
import unittest

from tests.client.project_create_harness import CLIENTS_DIR, REPO_ROOT, load_module

PRD = REPO_ROOT / "docs" / "research" / "PRD-crucible-v2.md"
DN = REPO_ROOT / "docs" / "research" / "DN-client-fleet-inventory.md"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
README = REPO_ROOT / "README.md"

PRD_BULLET_OPENING = "- `POST /api/projects/add` with an existing key → HTTP 400."


def _prd_bullet():
    """The PRD bullet from its opening to the next top-level bullet."""
    text = PRD.read_text(encoding="utf-8")
    start = text.index("- `POST /api/projects/add` with an existing key")
    end = text.find("\n- ", start + 1)
    return text[start:] if end == -1 else text[start:end]


def _dn_project_key_row():
    for line in DN.read_text(encoding="utf-8").splitlines():
        if line.startswith("| `_project_key` |"):
            return line
    raise AssertionError("the inventory has no `_project_key` row")


def _unreleased_added_bullets():
    """The top-level bullets of `## [Unreleased]` → `### Added`, each with
    its nested lines."""
    text = CHANGELOG.read_text(encoding="utf-8")
    unreleased = text[text.index("## [Unreleased]"):]
    unreleased = unreleased[:unreleased.index("\n## [", 1)]
    added = unreleased[unreleased.index("### Added"):]
    following = added.find("\n### ", 1)
    added = added if following == -1 else added[:following]
    return [b for b in re.split(r"\n(?=- )", added) if b.startswith("- ")]


class ProjectCreateIsDocumentedTest(unittest.TestCase):

    def test_the_prd_bullet_keeps_its_opening_and_names_project_create_and_write_env(self):
        bullet = _prd_bullet()
        self.assertTrue(bullet.startswith(PRD_BULLET_OPENING), bullet[:120])
        self.assertIn("`project-create`", bullet)
        self.assertIn("--write-env", bullet)

    def test_the_inventory_project_key_row_names_project_create(self):
        self.assertIn("project-create", _dn_project_key_row())

    def test_the_unreleased_added_section_has_a_bullet_for_the_verb(self):
        bullets = [b for b in _unreleased_added_bullets() if "project-create" in b]
        self.assertEqual(len(bullets), 1,
                         f"one Added bullet names project-create; found {len(bullets)}")
        bullet = bullets[0]
        self.assertIn("token", bullet.lower())
        self.assertIn("--write-env", bullet)
        self.assertIn("--project-dir", bullet)

    def test_the_readme_names_the_verb(self):
        self.assertIn("project-create", README.read_text(encoding="utf-8"))

    def test_the_cores_help_steps_have_a_project_create_entry(self):
        core = load_module(CLIENTS_DIR / "_crucible_axi.py", "project_create_doc_core")
        steps = core.HELP_STEPS.get("project-create")
        self.assertIsInstance(steps, list, f"HELP_STEPS['project-create'] = {steps!r}")
        self.assertTrue(steps and all(isinstance(s, str) and s for s in steps), steps)


if __name__ == "__main__":
    unittest.main()
