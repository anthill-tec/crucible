"""`project-create` is stated where the project's documentation and the
fleet's help steps say how a project is registered.

- The PRD's bullet that opens "`POST /api/projects/add` with an existing key
  → HTTP 400." still opens with that sentence, and names `project-create` and
  `--write-env`.
- The client-fleet inventory's `_project_key` row names `project-create`.
- One release's `### Added` in the changelog holds exactly one bullet naming
  `project-create`, and it names its token, `--write-env` and
  `--project-dir`. Every release's `### Added` is searched, so a later
  release's never hides the one that records the verb.
- The README names `project-create`.
- The shared core's `HELP_STEPS` has a `project-create` entry.

Pinned by containment, never by whole sentences. Fails today: none of these
documents names the verb, and `HELP_STEPS` has no entry for it.
"""

import re
import unittest

from tests.client.changelog_section import changelog_entries
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


def _added_subsections():
    """Every `### Added` subsection of the changelog's release sections,
    newest first, each up to the next `### ` heading: one release's own."""
    entries = changelog_entries(CHANGELOG.read_text(encoding="utf-8"))
    return re.findall(r"(?ms)^### Added\n.*?(?=^### |\Z)", entries)


def _top_level_bullets(added):
    """The top-level bullets of one `### Added`, each with its nested
    lines."""
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
        naming = [[b for b in _top_level_bullets(added) if "project-create" in b]
                  for added in _added_subsections()]
        once = [bullets[0] for bullets in naming if len(bullets) == 1]
        self.assertTrue(once,
                        "one release's Added in the changelog names project-create in "
                        f"exactly one bullet; bullets naming it, Added by Added: "
                        f"{[len(bullets) for bullets in naming]}")
        # The oldest release recording the verb in one bullet is the one
        # that added it.
        bullet = once[-1]
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
