"""The source package ships only what builds the wheel, and the wheel built
from it is the wheel.

Two offline builds run once for the class, with the suite's own interpreter,
in the checkout, each writing into a temporary directory the class owns:

- B1: `python -m build --no-isolation --outdir <D1>` -- the release
  workflow's own command: the sdist, then the wheel built from the unpacked
  sdist (no `.git`; the version comes from the sdist's `PKG-INFO`);
- B2: `python -m build --wheel --no-isolation --outdir <D2>` -- the wheel
  built from the checkout.

Pinned:

- The sdist is BOUNDED: each of its file members, top-level directory
  stripped and duplicates kept, is under `crucible_axi/` or `clients/`, or is
  one of `pyproject.toml`, `README.md`, `LICENSE`, `CHANGELOG.md`,
  `.gitignore` and `PKG-INFO`.
- The sdist is COMPLETE: every file `git ls-files crucible_axi clients`
  lists that exists on disk is a member exactly once. Untracked files under
  the two directories are within the bound and are not demanded, and a
  tracked file deleted on disk is not demanded, so both hold on a dirty tree.
- B1's wheel holds exactly the sdist's `crucible_axi/` files, its `clients/`
  files remapped by the wheel target's force-include
  (`"clients" = "crucible_axi/clients"`, so `clients/<p>` ships as
  `crucible_axi/clients/<p>`), and its `crucible_axi-<v>.dist-info/`
  (`METADATA`, `WHEEL`, `RECORD`, `entry_points.txt`, `licenses/LICENSE`).
  Its `dist-info` directory name equals B2's.
- B1's wheel `METADATA` declares `Description-Content-Type: text/markdown`,
  and its body -- everything after the blank line that ends the header
  block -- is `README.md` byte for byte.

A missing build module fails the class with `build_modules_gap()`'s answer,
as every other wheel builder does; a build that produces no artifact leaves
the class's archive fields empty, and each test then fails naming the build's
stderr.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_the_source_package_ships_only_what_builds_the_wheel
"""

import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from collections import Counter
from pathlib import Path

from tests.client.wheel_build_modules import build_modules_gap

REPO_ROOT = Path(__file__).resolve().parents[3]
README = REPO_ROOT / "README.md"

BUILD_TIMEOUT_SECONDS = 600
GIT_TIMEOUT_SECONDS = 60

#: The directories the sdist carries, each as its members' path prefix.
SDIST_DIRECTORIES = ("crucible_axi/", "clients/")
#: The root files the sdist carries besides the two directories.
SDIST_ROOT_FILES = ("pyproject.toml", "README.md", "LICENSE", "CHANGELOG.md",
                    ".gitignore", "PKG-INFO")
#: The wheel target's force-include: `clients` ships as `crucible_axi/clients`.
CLIENTS_SOURCE = "clients/"
CLIENTS_IN_WHEEL = "crucible_axi/clients/"
#: The files of the wheel's `dist-info` directory.
DIST_INFO_FILES = ("METADATA", "WHEEL", "RECORD", "entry_points.txt", "licenses/LICENSE")

MARKDOWN_CONTENT_TYPE = b"Description-Content-Type: text/markdown"

#: How many members a failure message lists before it summarises the rest.
SHOWN = 25


def _sdist_file_members(path):
    """The sdist's file members, top-level directory stripped, sorted, with
    any duplicate kept."""
    with tarfile.open(path, "r:gz") as archive:
        names = [member.name for member in archive.getmembers() if member.isfile()]
    return sorted(name.split("/", 1)[1] if "/" in name else name for name in names)


def _dist_info_dir(namelist):
    """The wheel's one `<name>-<version>.dist-info` directory, or None."""
    tops = {name.split("/", 1)[0] for name in namelist}
    found = sorted(top for top in tops if top.endswith(".dist-info"))
    return found[0] if len(found) == 1 else None


def _summarise(paths):
    shown = list(paths)[:SHOWN]
    rest = len(paths) - len(shown)
    tops = sorted({path.split("/", 1)[0] for path in paths})
    return (f"{len(paths)} path(s), under top-level entries {tops}; first {len(shown)}: {shown}"
            + (f" (and {rest} more)" if rest > 0 else ""))


class TheSourcePackageShipsOnlyWhatBuildsTheWheelTest(unittest.TestCase):
    """Builds B1 and B2 once for the class and checks the sdist and the wheel
    built from it."""

    sdist_dir: str | None = None
    wheel_dir: str | None = None
    sdist_build: "subprocess.CompletedProcess[str]"
    wheel_build: "subprocess.CompletedProcess[str]"
    tracked: tuple[str, ...] = ()
    sdist_path: Path | None = None
    sdist_wheel_path: Path | None = None
    checkout_wheel_path: Path | None = None
    sdist_members: list[str] | None = None
    sdist_wheel_names: list[str] | None = None
    checkout_wheel_names: list[str] | None = None
    sdist_wheel_metadata: bytes | None = None

    @classmethod
    def setUpClass(cls):
        gap = build_modules_gap()
        if gap is not None:
            raise RuntimeError(f"the source package's contents cannot be verified: {gap}")

        # Each directory's cleanup is registered as it is made, so a build
        # that times out or fails in this method leaks neither.
        cls.sdist_dir = tempfile.mkdtemp(prefix="crucible-axi-sdist-build-")
        cls.addClassCleanup(shutil.rmtree, cls.sdist_dir, ignore_errors=True)
        cls.wheel_dir = tempfile.mkdtemp(prefix="crucible-axi-checkout-wheel-build-")
        cls.addClassCleanup(shutil.rmtree, cls.wheel_dir, ignore_errors=True)

        # What the checkout tracks under the two directories, read at the
        # moment the sdist is built from it.
        listed = subprocess.run(
            ["git", "ls-files", "-z", "--", "crucible_axi", "clients"],
            cwd=str(REPO_ROOT), capture_output=True, text=True,
            timeout=GIT_TIMEOUT_SECONDS)
        cls.tracked = tuple(sorted(path for path in (listed.stdout or "").split("\0")
                                   if path and (REPO_ROOT / path).is_file()))

        cls.sdist_build = subprocess.run(
            [sys.executable, "-m", "build", "--no-isolation", "--outdir", cls.sdist_dir],
            cwd=str(REPO_ROOT), capture_output=True, text=True,
            timeout=BUILD_TIMEOUT_SECONDS)
        cls.wheel_build = subprocess.run(
            [sys.executable, "-m", "build", "--wheel", "--no-isolation",
             "--outdir", cls.wheel_dir],
            cwd=str(REPO_ROOT), capture_output=True, text=True,
            timeout=BUILD_TIMEOUT_SECONDS)

        sdists = sorted(Path(cls.sdist_dir).glob("*.tar.gz"))
        sdist_wheels = sorted(Path(cls.sdist_dir).glob("*.whl"))
        checkout_wheels = sorted(Path(cls.wheel_dir).glob("*.whl"))
        cls.sdist_path = sdists[0] if len(sdists) == 1 else None
        cls.sdist_wheel_path = sdist_wheels[0] if len(sdist_wheels) == 1 else None
        cls.checkout_wheel_path = checkout_wheels[0] if len(checkout_wheels) == 1 else None

        if cls.sdist_path is not None:
            cls.sdist_members = _sdist_file_members(cls.sdist_path)
        if cls.sdist_wheel_path is not None:
            with zipfile.ZipFile(cls.sdist_wheel_path) as archive:
                cls.sdist_wheel_names = archive.namelist()
                dist_info = _dist_info_dir(cls.sdist_wheel_names)
                if dist_info is not None:
                    cls.sdist_wheel_metadata = archive.read(f"{dist_info}/METADATA")
        if cls.checkout_wheel_path is not None:
            with zipfile.ZipFile(cls.checkout_wheel_path) as archive:
                cls.checkout_wheel_names = archive.namelist()

    # -- what each test needs from the builds ------------------------------

    def _no_artifact(self, what, directory, build):
        return (f"{what} was not produced as one file in {directory} "
                f"(rc={build.returncode}); stderr:\n{build.stderr}")

    def _require_sdist(self):
        members, path = self.sdist_members, self.sdist_path
        if members is None or path is None:
            self.fail(self._no_artifact("B1's sdist", self.sdist_dir, self.sdist_build))
        return members, path

    def _require_sdist_wheel(self):
        names = self.sdist_wheel_names
        if names is None:
            self.fail(self._no_artifact("B1's wheel", self.sdist_dir, self.sdist_build))
        return names

    def _require_checkout_wheel(self):
        names = self.checkout_wheel_names
        if names is None:
            self.fail(self._no_artifact("B2's wheel", self.wheel_dir, self.wheel_build))
        return names

    def _require_metadata(self):
        names = self._require_sdist_wheel()
        metadata = self.sdist_wheel_metadata
        if metadata is None:
            self.fail(f"B1's wheel has no single dist-info METADATA: {sorted(names)}")
        return metadata

    # -- the sdist ----------------------------------------------------------

    def test_every_sdist_member_is_under_the_package_or_the_clients_or_a_fixed_root_file(self):
        members, _ = self._require_sdist()
        outside = [member for member in members
                   if not member.startswith(SDIST_DIRECTORIES)
                   and member not in SDIST_ROOT_FILES]
        self.assertEqual(
            outside, [],
            "the sdist carries only `crucible_axi/`, `clients/` and "
            f"{list(SDIST_ROOT_FILES)}; outside that bound: {_summarise(outside)}")

    def test_every_tracked_package_and_client_file_is_in_the_sdist_exactly_once(self):
        members, _ = self._require_sdist()
        self.assertTrue(
            any(path.startswith(CLIENTS_SOURCE) for path in self.tracked)
            and any(path.startswith("crucible_axi/") for path in self.tracked),
            "`git ls-files crucible_axi clients` listed both directories' files: "
            f"{list(self.tracked[:SHOWN])}")
        counts = Counter(members)
        not_once = {path: counts[path] for path in self.tracked if counts[path] != 1}
        self.assertEqual(
            not_once, {},
            "each file `git ls-files crucible_axi clients` lists that exists on disk "
            f"is an sdist member exactly once; path -> member count: {not_once}")

    # -- the wheel built from the sdist -------------------------------------

    def test_the_wheel_built_from_the_sdist_holds_exactly_its_package_clients_and_dist_info(self):
        members, sdist_path = self._require_sdist()
        names = self._require_sdist_wheel()
        version = sdist_path.name[len("crucible_axi-"):-len(".tar.gz")]
        dist_info = f"crucible_axi-{version}.dist-info"
        expected = sorted(
            [member for member in members if member.startswith("crucible_axi/")]
            + [CLIENTS_IN_WHEEL + member[len(CLIENTS_SOURCE):]
               for member in members if member.startswith(CLIENTS_SOURCE)]
            + [f"{dist_info}/{name}" for name in DIST_INFO_FILES])
        actual = sorted(names)
        missing = sorted((Counter(expected) - Counter(actual)).elements())
        extra = sorted((Counter(actual) - Counter(expected)).elements())
        self.assertEqual(
            (missing, extra), ([], []),
            f"B1's wheel holds exactly the sdist's package and clients and {dist_info}/; "
            f"missing from the wheel: {missing}; not expected in it: {extra}")

    def test_the_wheel_built_from_the_sdist_names_the_same_dist_info_as_the_checkout_wheel(self):
        from_sdist = _dist_info_dir(self._require_sdist_wheel())
        from_checkout = _dist_info_dir(self._require_checkout_wheel())
        self.assertIsNotNone(from_checkout, "B2's wheel has one dist-info directory")
        self.assertEqual(
            from_sdist, from_checkout,
            "the wheel built from the sdist carries the same name and version as the "
            "wheel built from the checkout")

    def test_the_wheel_built_from_the_sdist_declares_a_markdown_description(self):
        metadata = self._require_metadata()
        header = metadata.split(b"\n\n", 1)[0]
        declared = [line for line in header.split(b"\n")
                    if line.startswith(b"Description-Content-Type:")]
        self.assertEqual(
            declared, [MARKDOWN_CONTENT_TYPE],
            "METADATA's header declares exactly one markdown description; "
            f"header:\n{header.decode('utf-8', 'replace')}")

    def test_the_wheel_built_from_the_sdist_describes_itself_with_the_readme_byte_for_byte(self):
        metadata = self._require_metadata()
        readme = README.read_bytes()
        parts = metadata.split(b"\n\n", 1)
        if len(parts) != 2:
            self.fail("METADATA has a body after its header block; it has none "
                      f"(METADATA is {len(metadata)} bytes, README.md is {len(readme)})")
        body = parts[1]
        self.assertEqual(
            body, readme,
            f"METADATA's body ({len(body)} bytes) is README.md ({len(readme)} bytes) "
            f"byte for byte; body starts: {body[:200]!r}")

    # -- the checkout --------------------------------------------------------

    def test_the_builds_leave_no_dist_or_build_directory_in_the_checkout(self):
        strays = [name for name in ("dist", "build") if (REPO_ROOT / name).exists()]
        self.assertEqual(strays, [],
                         f"the builds write only into their own directories, found: {strays}")


if __name__ == "__main__":
    unittest.main()
