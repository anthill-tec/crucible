"""The python floor is 3.14 wherever the project declares it.

Python 3.14 is the adopted baseline, so the package metadata states it:
`pyproject.toml`'s `[project]` table declares `requires-python = ">=3.14"`
and carries exactly two python classifiers -- `Programming Language ::
Python :: 3` and `Programming Language :: Python :: 3.14`.
"""

# pi-lens-ignore: I001 — pi-lens lints with its own ruff configuration, which sets no target version, so ruff files `tomllib` as third-party whatever the declared floor
import tomllib  # noqa: I001
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PYPROJECT_PATH = REPO_ROOT / "pyproject.toml"

EXPECTED_REQUIRES_PYTHON = ">=3.14"
EXPECTED_PYTHON_CLASSIFIERS = [
    "Programming Language :: Python :: 3",
    "Programming Language :: Python :: 3.14",
]


def _load_pyproject():
    with open(PYPROJECT_PATH, "rb") as handle:
        return tomllib.load(handle)


class PyprojectDeclaresThePython314FloorTest(unittest.TestCase):
    """The package metadata names 3.14 as the floor and as the only
    supported python minor."""

    def test_requires_python_is_at_least_3_14(self):
        project = _load_pyproject()["project"]
        self.assertEqual(
            project.get("requires-python"), EXPECTED_REQUIRES_PYTHON,
            f"pyproject.toml [project] requires-python: expected "
            f"{EXPECTED_REQUIRES_PYTHON!r}, got "
            f"{project.get('requires-python')!r}")

    def test_python_classifiers_are_exactly_python_3_and_3_14(self):
        classifiers = _load_pyproject()["project"].get("classifiers", [])
        python_classifiers = [
            c for c in classifiers
            if c.startswith("Programming Language :: Python")
        ]
        self.assertEqual(
            sorted(python_classifiers), sorted(EXPECTED_PYTHON_CLASSIFIERS),
            f"pyproject.toml python classifiers: expected exactly "
            f"{EXPECTED_PYTHON_CLASSIFIERS!r}, got {python_classifiers!r}")

    def test_the_non_python_classifiers_are_kept(self):
        classifiers = _load_pyproject()["project"].get("classifiers", [])
        self.assertIn(
            "License :: OSI Approved :: GNU General Public License v3 (GPLv3)",
            classifiers)
        self.assertIn("Operating System :: POSIX", classifiers)


if __name__ == "__main__":
    unittest.main()
