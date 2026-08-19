"""CR-CRU-042 C2 fix -- the WHEEL PACKAGING contract for `crucible-axi`.

Guards the CR-CRU-042 acceptance criterion that `python -m build` SUCCEEDS
and that the wheel it produces carries exactly the intended payload. The
defect this file exists to catch was live on the branch and invisible to
every other suite:

    ValueError: A second file is being added to the wheel archive at the
    same path: `crucible_axi/clients/STATUS-CONTRACT.md`

`pyproject.toml`'s `[tool.hatch.build.targets.wheel.force-include]` declared
BOTH the recursive `"clients" = "crucible_axi/clients"` mapping (which
already sweeps in STATUS-CONTRACT.md) AND a redundant single-file mapping
for STATUS-CONTRACT.md, so the same archive path was contributed twice.
Nothing in the repo exercised the PyPI half of the release -- `release.yml`'s
`build` job runs `python -m build`, but CI has never executed (the repo has
never been pushed), so the breakage sat undetected.

Contract pinned here:

    1. `python -m build --wheel` completes with returncode 0 and emits
       exactly one `.whl`.
    2. The wheel carries the full client fleet under `crucible_axi/clients/`:
       `_crucible_axi.py`, `toon.py`, `STATUS-CONTRACT.md`, and all five
       `{arduino,bun,mvn,python,rust}-crucible.py`.
    3. The wheel carries NO `skills/` entry -- CR-CRU-042 retired the
       `[skills]` installer stage and deleted `clients/skills/`; the
       packaging must not resurrect it.
    4. EVERY path in the archive appears EXACTLY ONCE. This is the
       assertion that would have caught the defect above, and it is
       deliberately stated over the whole namelist (not just the expected
       paths) so any future force-include/artifact overlap is caught too.
       It is also builder-version-independent: today hatchling happens to
       raise on a duplicate, but a builder that silently wrote both copies
       would still be caught here.

Why a real `python -m build` and not hatchling's in-process builder API:
the project's version is `dynamic` via hatch-vcs, and neither `hatchling`
nor `hatch_vcs` is importable from the project venv -- only `build`'s
isolated-environment path can resolve them. It is also the literal command
release.yml runs, so this test guards the actual release path rather than a
proxy for it. With a warm pip cache the build takes ~1s, so the whole class
shares ONE build via `setUpClass` and the suite cost is a single build.

The build writes into a `tempfile` directory and is asserted to leave no
`dist/` or `build/` artifact behind in the repo.

Invocation:
    python3 -m pytest tests/client/test_crucible_axi_wheel_packaging.py -q
Fallback:
    python3 tests/client/test_crucible_axi_wheel_packaging.py
"""

import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# The client fleet that MUST ship as package data inside the wheel, so the
# installed `crucible-axi` orchestrator carries the clients it lays down.
EXPECTED_CLIENT_PAYLOAD = (
    "crucible_axi/clients/_crucible_axi.py",
    "crucible_axi/clients/toon.py",
    "crucible_axi/clients/STATUS-CONTRACT.md",
    "crucible_axi/clients/arduino-crucible.py",
    "crucible_axi/clients/bun-crucible.py",
    "crucible_axi/clients/mvn-crucible.py",
    "crucible_axi/clients/python-crucible.py",
    "crucible_axi/clients/rust-crucible.py",
)

BUILD_TIMEOUT_SECONDS = 600


def _resolve_build_interpreter():
    """Return the first interpreter on this machine that can `import build`,
    or None. The project venv deliberately carries only the test/coverage
    toolchain, so the release tooling usually lives on the system
    interpreter -- resolve it rather than assuming `sys.executable`."""
    candidates = [sys.executable,
                  shutil.which("python3"),
                  shutil.which("python"),
                  str(Path(sys.base_prefix) / "bin" / "python3")]
    seen = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            probe = subprocess.run([candidate, "-c", "import build"],
                                   capture_output=True, timeout=60)
        except (OSError, subprocess.SubprocessError):
            continue
        if probe.returncode == 0:
            return candidate
    return None


class CrucibleAxiWheelPackagingTest(unittest.TestCase):
    """Builds the wheel ONCE for the whole class and asserts its payload."""

    tmp_dir = None
    build_result = None
    wheel_path = None
    namelist = None

    @classmethod
    def setUpClass(cls):
        interpreter = _resolve_build_interpreter()
        if interpreter is None:
            # Fail fast with a definitive, actionable error rather than
            # skipping -- a silent skip is exactly how the packaging defect
            # this suite guards stayed invisible. (Same fail-fast posture as
            # CR-CRU-039's `no-tests-discovered`.)
            raise RuntimeError(
                "no interpreter on this machine can `import build`; the "
                "wheel packaging contract cannot be verified. Remedy: "
                "`python3 -m pip install --upgrade build` (the same package "
                "release.yml's `build` job installs).")

        cls.tmp_dir = tempfile.mkdtemp(prefix="crucible-axi-wheel-packaging-")
        cls.build_result = subprocess.run(
            [interpreter, "-m", "build", "--wheel", "--outdir", cls.tmp_dir],
            cwd=str(REPO_ROOT), capture_output=True, text=True,
            timeout=BUILD_TIMEOUT_SECONDS)

        wheels = sorted(Path(cls.tmp_dir).glob("*.whl"))
        cls.wheel_path = wheels[0] if wheels else None
        if cls.wheel_path is not None:
            with zipfile.ZipFile(cls.wheel_path) as archive:
                cls.namelist = archive.namelist()

    @classmethod
    def tearDownClass(cls):
        if cls.tmp_dir:
            shutil.rmtree(cls.tmp_dir, ignore_errors=True)

    def _require_wheel(self):
        self.assertIsNotNone(
            self.namelist,
            f"no wheel was produced; build stderr:\n{self.build_result.stderr}")
        return self.namelist

    def test_python_m_build_wheel_succeeds(self):
        """The CR-CRU-042 AC itself -- the release build must not fail."""
        self.assertEqual(
            self.build_result.returncode, 0,
            f"`python -m build --wheel` failed (rc="
            f"{self.build_result.returncode}); stderr:\n"
            f"{self.build_result.stderr}")
        self.assertIsNotNone(
            self.wheel_path,
            f"build reported success but emitted no .whl into "
            f"{self.tmp_dir}; stdout:\n{self.build_result.stdout}")

    def test_wheel_carries_the_whole_client_fleet(self):
        namelist = self._require_wheel()
        missing = [path for path in EXPECTED_CLIENT_PAYLOAD
                   if path not in namelist]
        self.assertEqual(
            missing, [],
            f"client fleet entries missing from the wheel: {missing}; "
            f"archive contained: {sorted(namelist)}")

    def test_wheel_carries_no_skills_entry(self):
        """CR-CRU-042 retired the `[skills]` stage and deleted
        `clients/skills/` -- the packaging must never resurrect it."""
        namelist = self._require_wheel()
        skills_entries = [path for path in namelist
                          if "skills/" in path or path.endswith("/skills")]
        self.assertEqual(
            skills_entries, [],
            f"the wheel must carry no `skills/` entry (CR-CRU-042 deleted "
            f"clients/skills/), found: {skills_entries}")

    def test_every_archive_path_appears_exactly_once(self):
        """THE regression assertion for this fix round.

        `zipfile.namelist()` returns one element per archive MEMBER, so a
        path contributed twice (e.g. by overlapping force-include entries)
        shows up twice here. Asserted over the entire namelist so any future
        overlap is caught, not just the STATUS-CONTRACT.md one."""
        namelist = self._require_wheel()
        duplicates = {path: count
                      for path, count in Counter(namelist).items()
                      if count > 1}
        self.assertEqual(
            duplicates, {},
            f"every wheel archive path must appear exactly once; duplicated "
            f"paths (most likely overlapping "
            f"`[tool.hatch.build.targets.wheel.force-include]` entries in "
            f"pyproject.toml): {duplicates}")

    def test_each_expected_client_path_appears_exactly_once(self):
        """Narrower, explicitly-named form of the same guard, so a failure
        points straight at the client payload that regressed."""
        namelist = self._require_wheel()
        counts = Counter(namelist)
        not_exactly_once = {path: counts[path]
                            for path in EXPECTED_CLIENT_PAYLOAD
                            if counts[path] != 1}
        self.assertEqual(
            not_exactly_once, {},
            f"each client payload path must appear in the wheel exactly "
            f"once, got: {not_exactly_once}")

    def test_build_leaves_no_artifacts_in_the_repo(self):
        """Hygiene -- the build is directed at a tempdir, so the checkout
        must stay clean of dist/ and build/ droppings."""
        strays = [name for name in ("dist", "build")
                  if (REPO_ROOT / name).exists()]
        self.assertEqual(
            strays, [],
            f"the wheel build must leave no artifacts in the repo root, "
            f"found: {strays}")


if __name__ == "__main__":
    unittest.main()
