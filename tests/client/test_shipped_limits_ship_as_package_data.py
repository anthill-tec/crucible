"""CR-CRU-131 §S1c -- the CLIENT's shipped defaults are PACKAGE DATA, and the
shipped declaration and the shipped documentation are ONE datum.

`_SHIPPED_LIMITS` (clients/_crucible_axi.py:120) is a Python literal today, so
the three client limit declarations exist in the source AND in a
`crucible.toml`. §S1c rules that out in as many words: "the last resort is a
DATA FILE in the distribution, not a number in a resolver. This is what makes
'no literal in source' achievable rather than aspirational."

The bun half of this contract -- the no-literal scan over `src/` and
`clients/`, and the same proof for the server's npm distribution -- lives in
tests/shipped-limits-ship-as-package-data.test.ts. This file owns the PyPI
half: `crucible-axi` is the package that carries the client fleet, so it is the
package that must carry the fleet's defaults.

What is asserted, and each from a BUILT ARTIFACT rather than the checkout
("the checkout is exactly where the file exists anyway" -- §S1c AC):

    1. TRAVEL -- `python -m build --wheel` produces a wheel carrying a
       `crucible.toml` that declares all three client limits with all four
       documented fields. Today the wheel's force-include is `"clients" =
       "crucible_axi/clients"` and nothing else, so there is no such file.
    2. ONE DATUM -- mutating that file INSIDE THE UNPACKED WHEEL moves what the
       resolver falls back to, with no operator file anywhere. If the shipped
       table were a second copy in source, the mutation would move one and not
       the other; that is the whole proof, and it is C1's widen/narrow shape
       one layer down.
    3. VERSION SKEW -- a client distribution whose data file declares a limit
       the CLIENT does not enforce (a server limit, or one from a release this
       package predates) still resolves all three it owns, and still refuses
       the foreign one. Client and server are separate packages on possibly
       different hosts at independently resolved versions; this is the property
       the ownership split exists to guarantee and the one a shared file would
       have destroyed.

HOW EACH FAILS IF THE CODE DOES NOTHING: (1) no `crucible.toml` anywhere in the
wheel; (2) and (3) unreachable -- there is no shipped data file to mutate or to
skew.

Safety. Nothing here runs `uv tool install`, `pip install`, `npm publish` or
any other command that touches the developer's installed tooling: the wheel is
BUILT into a tempfile directory (the same `python -m build --wheel` mechanism
tests/client/test_crucible_axi_wheel_packaging.py already drives, which is also
the literal command release.yml runs) and UNPACKED with `zipfile` into another
tempfile directory. Every mutation happens inside that unpacked copy. No
project directory inside the repo is ever bound, no `crucible.toml` in the
checkout is read or written, no board is contacted, and `data/crucible.db` is
never opened.

Invocation:
    python3 -m pytest tests/client/test_shipped_limits_ship_as_package_data.py -q
Fallback:
    python3 tests/client/test_shipped_limits_ship_as_package_data.py
"""

import importlib.util
import itertools
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENT_MODULE_NAME = "_crucible_axi.py"
DATA_FILE_NAME = "crucible.toml"

BUILD_TIMEOUT_SECONDS = 600

_COUNTER = itertools.count()

#: The four fields a limit is DOCUMENTED with. A declaration missing one is a
#: limit an operator cannot act on.
DOCUMENTED_FIELDS = ("description", "recommended", "min", "max")

#: The three limits the SERVER enforces. Here only so the skew case can name
#: one the client must keep refusing.
SERVER_LIMITS = ("run_abandon_ms", "project_inactive_ms", "retention")


def _resolve_build_interpreter():
    """The first interpreter on this machine that can `import build`, or None.

    LIFTED from tests/client/test_crucible_axi_wheel_packaging.py, which proved
    it: the project venv deliberately carries only the test/coverage toolchain,
    so the release tooling usually lives on the system interpreter."""
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


class _StagedWheelCase(unittest.TestCase):
    """Builds the `crucible-axi` wheel ONCE for the whole class and unpacks it
    into a scratch STAGE. Every test drives the stage, never the checkout."""

    tmp_dir = None
    build_result = None
    wheel_path = None
    namelist = None

    @classmethod
    def setUpClass(cls):
        interpreter = _resolve_build_interpreter()
        if interpreter is None:
            # Fail fast rather than skip -- a silent skip is how the packaging
            # defect CR-CRU-042 guards stayed invisible.
            raise RuntimeError(
                "no interpreter on this machine can `import build`; the "
                "packaging contract cannot be verified. Remedy: "
                "`python3 -m pip install --upgrade build`.")
        cls.tmp_dir = tempfile.mkdtemp(prefix="crucible-axi-limits-packaging-")
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

    def setUp(self):
        self.assertIsNotNone(
            self.wheel_path,
            "no wheel was produced; build stderr:\n%s"
            % (self.build_result.stderr,))
        self.stage = tempfile.mkdtemp(prefix="crucible-axi-stage-")
        self.addCleanup(shutil.rmtree, self.stage, ignore_errors=True)
        with zipfile.ZipFile(self.wheel_path) as archive:
            archive.extractall(self.stage)
        # A directory standing in for a project that configures NOTHING, so
        # what a resolver answers is the distribution's last resort and nothing
        # else. Outside the repo, always.
        self.bare_project = tempfile.mkdtemp(prefix="crucible-no-project-file-")
        self.addCleanup(shutil.rmtree, self.bare_project, ignore_errors=True)

    # -- the stage -------------------------------------------------------

    def assert_stage_is_a_distribution(self):
        """NON-VACUITY: prove the thing under assertion is a BUILT WHEEL and not
        a copy of this checkout. A test that read the checkout would pass on a
        packaging configuration that ships no defaults at all, which is exactly
        today's state."""
        self.assertFalse(
            str(Path(self.stage).resolve()).startswith(str(REPO_ROOT) + os.sep),
            "the stage must be outside the checkout; %s" % (self.stage,))
        dist_info = sorted(Path(self.stage).glob("crucible_axi-*.dist-info"))
        self.assertNotEqual(
            dist_info, [],
            "the stage carries no `crucible_axi-*.dist-info`, so it is not an "
            "unpacked wheel; entries=%r" % (sorted(os.listdir(self.stage)),))
        for intruder in ("tests", "src", "data", ".git", "docs", "public"):
            self.assertFalse(
                os.path.exists(os.path.join(self.stage, intruder)),
                "a distribution must not carry %s/ -- this stage is a copy of "
                "the repo, not a built artifact" % (intruder,))
        self.assertTrue(
            os.path.isfile(self.staged_client_module()),
            "fixture sanity: the shared client module must ship in the wheel")

    def staged_client_module(self):
        return os.path.join(self.stage, "crucible_axi", "clients",
                            CLIENT_MODULE_NAME)

    def staged_data_files(self):
        """Every `crucible.toml` anywhere in the unpacked wheel. Found by NAME
        rather than at a path this test dictates: where the defaults sit inside
        the distribution is the implementation's call, and the contract is that
        the resolver reads THEM."""
        return sorted(str(p) for p in Path(self.stage).rglob(DATA_FILE_NAME))

    def require_staged_data_files(self):
        found = self.staged_data_files()
        self.assertNotEqual(
            found, [],
            "§S1c: the shipped defaults must travel as PACKAGE DATA -- a "
            "`crucible.toml` force-included into `crucible_axi/` the way "
            "`clients/` already is. Without it an installed client resolves "
            "every limit from a file that does not exist, and the last resort "
            "is still a number in a resolver. Wheel entries: %r"
            % (sorted(self.namelist or []),))
        return found

    # -- driving the staged resolver -------------------------------------

    def staged_axi(self):
        """Load the STAGED `_crucible_axi.py` fresh, by file path -- the fleet's
        own loading discipline (every client loads its siblings this way). A
        fresh module per call is what makes a mutation between two calls
        observable rather than cached."""
        path = self.staged_client_module()
        name = "staged_crucible_axi_%d" % (next(_COUNTER),)
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        self.addCleanup(sys.modules.pop, name, None)
        spec.loader.exec_module(module)
        # No operator file anywhere: the project directory is empty, so every
        # number below comes from the distribution's own data.
        module.bind_project_dir(self.bare_project)
        self.assertFalse(
            os.path.exists(os.path.join(self.bare_project, DATA_FILE_NAME)),
            "fixture sanity: the project must configure nothing")
        return module

    def resolved(self, axi):
        return {name: axi.resolve_limit(name) for name in axi.CLIENT_LIMIT_NAMES}

    def set_recommended(self, path, limit, value):
        """Rewrite one `recommended =` line in a staged `[limits.<limit>]`."""
        text = Path(path).read_text(encoding="utf-8")
        pattern = re.compile(
            r"(\[limits\.%s\][\s\S]*?recommended\s*=\s*)-?\d[\d_]*" % (limit,))
        self.assertRegex(
            text, pattern,
            "the staged data file declares no `%s` to mutate: %s"
            % (limit, path))
        Path(path).write_text(pattern.sub(r"\g<1>%d" % (value,), text, count=1),
                              encoding="utf-8")


class ShippedClientDefaultsTravelTest(_StagedWheelCase):

    def test_the_built_wheel_carries_a_crucible_toml_declaring_every_client_limit(self):
        """§S1c -- asserted from a BUILT artifact, never from the checkout."""
        self.assertEqual(
            self.build_result.returncode, 0,
            "`python -m build --wheel` failed (rc=%s); stderr:\n%s"
            % (self.build_result.returncode, self.build_result.stderr))
        self.assert_stage_is_a_distribution()

        axi = self.staged_axi()
        declared = {}
        for path in self.require_staged_data_files():
            text = Path(path).read_text(encoding="utf-8")
            for name in axi.CLIENT_LIMIT_NAMES:
                table = re.search(
                    r"\[limits\.%s\]([\s\S]*?)(?=\n\[|\Z)" % (name,), text)
                if table is not None:
                    declared.setdefault(name, set()).update(
                        field for field in DOCUMENTED_FIELDS
                        if re.search(r"(?m)^\s*%s\s*=" % (field,), table.group(1)))

        missing = [name for name in axi.CLIENT_LIMIT_NAMES
                   if name not in declared]
        self.assertEqual(
            missing, [],
            "the shipped defaults must declare every limit this side ENFORCES; "
            "missing %r from %r" % (missing, self.staged_data_files()))
        undocumented = {name: sorted(set(DOCUMENTED_FIELDS) - fields)
                        for name, fields in declared.items()
                        if set(DOCUMENTED_FIELDS) - fields}
        self.assertEqual(
            undocumented, {},
            "each shipped limit carries FOUR fields of documentation -- a "
            "description, a recommendation and a supportable range -- because "
            "the range is enforced from the data that documents it; "
            "incomplete: %r" % (undocumented,))

    def test_the_wheel_carries_no_server_limit_the_client_could_never_enforce(self):
        """OWNERSHIP, from the artifact: the client package's own defaults are
        the client's. A server limit shipped as the CLIENT's last resort would
        document a knob that provably does nothing where it sits -- and C1
        asserts in tests that setting one there has no effect, so documentation
        must not teach against the tests."""
        self.assert_stage_is_a_distribution()
        for path in self.require_staged_data_files():
            text = Path(path).read_text(encoding="utf-8")
            present = [name for name in SERVER_LIMITS
                       if re.search(r"(?m)^\s*\[limits\.%s\]" % (name,), text)]
            self.assertEqual(
                present, [],
                "%s declares SERVER limit table(s) %r as the client's shipped "
                "defaults; a client never reads the server's file and the "
                "server never reads the client's" % (path, present))


class ShippedDeclarationAndDocumentationAreOneDatumTest(_StagedWheelCase):

    def test_mutating_the_distributions_crucible_toml_moves_what_the_client_falls_back_to(self):
        """§S1c -- the shipped file and the shipped documentation are ONE datum.

        Two copies cannot pass this: a mutation moves the file and leaves the
        source table exactly where it was, so the resolver keeps answering the
        pre-mutation number."""
        self.assert_stage_is_a_distribution()
        files = self.require_staged_data_files()

        before_axi = self.staged_axi()
        before = self.resolved(before_axi)
        shipped_before = before_axi.shipped_limits()
        for name in before_axi.CLIENT_LIMIT_NAMES:
            self.assertEqual(
                before[name], shipped_before[name]["recommended"],
                "with nothing configured, `%s` must resolve to what the "
                "distribution recommends" % (name,))

        moved = {name: 37 + index * 11
                 for index, name in enumerate(before_axi.CLIENT_LIMIT_NAMES)}
        for name, value in moved.items():
            self.assertNotEqual(
                before[name], value,
                "the mutation must be distinguishable from the shipped value")
            for path in files:
                if re.search(r"(?m)^\s*\[limits\.%s\]" % (name,),
                             Path(path).read_text(encoding="utf-8")):
                    self.set_recommended(path, name, value)

        after_axi = self.staged_axi()
        after = self.resolved(after_axi)
        shipped_after = after_axi.shipped_limits()
        for name, value in moved.items():
            self.assertEqual(
                after[name], value,
                "`%s` still resolves to %r, the number compiled into the "
                "resolver, so the shipped declaration and the shipped "
                "documentation are TWO copies rather than one datum"
                % (name, after[name]))
            self.assertEqual(shipped_after[name]["recommended"], value)
            # NEGATIVE -- the pre-mutation number is GONE, not merely joined.
            self.assertNotEqual(after[name], before[name])

    def test_the_documentation_a_reader_meets_is_the_same_datum_the_code_falls_back_to(self):
        """The `description` an operator reads in the file is the one
        `shipped_limits()` reports -- one datum, read once, not a sentence in
        source and another in a file."""
        self.assert_stage_is_a_distribution()
        files = self.require_staged_data_files()
        axi = self.staged_axi()

        corpus = "\n".join(Path(p).read_text(encoding="utf-8") for p in files)
        for name, declaration in axi.shipped_limits().items():
            description = declaration["description"]
            self.assertGreater(
                len(description), 40,
                "`%s` must be described in a sentence an operator can act on"
                % (name,))
            self.assertIn(
                description, corpus,
                "`%s`'s description is not the one in the distribution's own "
                "data file, so the file a reader reads and the table the code "
                "falls back to are two different things" % (name,))


class ClientAndServerPackagesSkewIndependentlyTest(_StagedWheelCase):

    def test_a_data_file_naming_a_foreign_limit_still_resolves_every_limit_this_side_owns(self):
        """§S1c VERSION SKEW, asserted rather than asserted-about.

        Client and server are separate packages, installable on different hosts
        at independently resolved versions. Because each side's limits live in
        its own package's data, a client never needs a file the server's
        version wrote and neither side can be broken by the other's upgrade."""
        self.assert_stage_is_a_distribution()
        files = self.require_staged_data_files()

        baseline = self.resolved(self.staged_axi())

        for path in files:
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(
                    "\n[limits.retention]\n"
                    'description = "A SERVER limit, from a server package at '
                    'another version."\n'
                    "recommended = 5000\nmin = 10\nmax = 1000000\nvalue = 99\n"
                    "\n[limits.future_client_knob]\n"
                    'description = "A limit from a release this package '
                    'predates."\n'
                    "recommended = 9\nmin = 1\nmax = 99\nvalue = 7\n")

        axi = self.staged_axi()
        self.assertEqual(
            self.resolved(axi), baseline,
            "a limit set this package does not have must not disturb the "
            "limits it does -- that is the whole cross-machine "
            "independent-upgrade claim")
        self.assertEqual(
            sorted(axi.shipped_limits()), sorted(axi.CLIENT_LIMIT_NAMES),
            "a foreign limit must not be ADOPTED by having been written down")
        # NEGATIVE -- writing a server limit into the client's data file does
        # not make it resolvable here.
        with self.assertRaises(ValueError):
            axi.resolve_limit("retention")
        with self.assertRaises(ValueError):
            axi.resolve_limit("future_client_knob")


if __name__ == "__main__":
    unittest.main()
