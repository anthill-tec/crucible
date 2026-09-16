"""CR-CRU-138 -- the CLIENT-side ISOLATION GUARD: no python suite resolves its
configuration from THIS CHECKOUT.

── The hazard, measured ──────────────────────────────────────────────────

`<checkout>/crucible.toml` is UNTRACKED operator state (.gitignore), exactly as
the server's `data/crucible.toml` is. It EXISTS on a developer's machine and
does NOT exist on a fresh clone or a CI runner. §S1 makes a client's install
dir a configuration candidate, derived from the RUNNING MODULE's own location,
so a fixture that loads `<checkout>/clients/_crucible_axi.py` hands that module
the checkout as its install dir -- and the developer's own file then decides
what the suite resolves. Same code, same command, two different answers: green
here, red there, surfacing at gate time wearing an unrelated face.

That is not hypothetical. It was MEASURED in this cycle: with §S1's chain in
place, four cases in `test_client_limits_resolve_from_configuration.py` (the
two degradation cases and the two absent/unparsable disclosure cases) passed on
a fresh clone and failed on a workstation carrying that file, because the
unreadable-configuration warning they are owed was no longer owed -- a
readable file had been found, the developer's. The fixture now loads the fleet
from a COPY outside the checkout; this guard is what stops the next fixture
from re-opening the hole.

CR-CRU-131 §S1c made precisely this argument for the SERVER, and
`tests/no-suite-resolves-the-repo-configuration.test.ts` enforces it there. The
reasoning was never applied to the clients. This is that half.

── What this guard asserts, and why in this shape ────────────────────────

The claim is narrow ON PURPOSE: the configuration a client resolves under test
conditions must lie OUTSIDE this checkout. It is NOT "a suite may only resolve
something under its own temp root" -- `test_an_installed_deployment_resolves_
its_configuration.py` deliberately resolves an INSTALLED configuration inside
its sandbox, and that is the behaviour under test. The line is the checkout.

Three claims, all BEHAVIOURAL -- driven through the real chain on a real
filesystem, never asserted about source text:

  1. the containment check can SEE a path inside this checkout, so a green
     verdict below is the isolation's doing rather than a blind predicate;
  2. a client whose fleet lives outside the checkout resolves nothing inside
     it EVEN WHEN RUN FROM THE CHECKOUT ROOT -- the cwd is not a configuration
     source, which is §S1's own rule seen from the test harness's side;
  3. what decides a limit is the fixture's OWN file: a value written into the
     scratch install is the value that resolves, so nothing on the machine
     running the suite can outvote it.

Every failure names the OFFENDING PATH, because the next person to meet this
will be looking at a suite that passes for them and fails on the runner, and
the one fact they need is which file answered.

── HOW IT FAILS IF THE CODE DOES NOTHING ────────────────────────────────

`project_config_path()` (clients/_crucible_axi.py) is
`<bound project dir or os.getcwd()>/crucible.toml`, so claim 2 fails naming
`<checkout>/crucible.toml`: with nothing bound, a client run from the checkout
root reads the developer's own file, which is the whole defect. Claim 3 fails
resolving the build's recommendation instead of the scratch install's value,
because the install dir is not a candidate yet.

── Safety ───────────────────────────────────────────────────────────────

Nothing here writes inside the checkout. `<checkout>/crucible.toml` is READ
never, WRITTEN never, and its existence is never required -- the guard is
deterministic on a machine that has one and on a machine that does not. The
fleet is copied into a `tempfile.mkdtemp` root removed in cleanup, and the cwd
is restored BEFORE that removal (a process whose cwd is a deleted inode makes
every later `os.getcwd()` in the same worker raise).

Invocation:
    python3 -m unittest tests.client.test_no_suite_resolves_the_checkout_configuration -v
What CI runs (and what must list these ids):
    python3 -m unittest discover -s tests/client -t .
"""

import importlib.util
import itertools
import os
import re
import shutil
import tempfile
import tomllib
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
CONFIG_NAME = "crucible.toml"

#: The developer's own operator file -- the one that must never decide a
#: suite's outcome. Named so a failure can say so; never read, never written.
CHECKOUT_CONFIG = REPO_ROOT / CONFIG_NAME

#: The scratch fleet: the module under test plus the package data it reads.
#: A module copied without its declarations can resolve nothing at all.
_SCRATCH_FLEET = (CLIENTS_DIR / "_crucible_axi.py", CLIENTS_DIR / CONFIG_NAME)

CLIENT_LIMITS = ("truncate_field_chars", "error_detail_chars", "roadmap_list_rows")

_COUNTER = itertools.count()


def _load_module_by_path(path, cache_key):
    """The fleet's own `_axi()`/`_toon()` loader idiom, as every sibling test in
    this directory uses it."""
    spec = importlib.util.spec_from_file_location(cache_key, str(path))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _inside_checkout(candidate):
    """Is `candidate` inside THIS checkout? The one containment rule, shared by
    the control and every assertion so they cannot disagree.

    `os.path.realpath` on both sides, because a temp root on this machine is
    reached through `/tmp` -> `/private/tmp`-style links on some platforms and
    a suite must not be isolated merely because two spellings of one path
    happen to differ.
    """
    root = os.path.realpath(REPO_ROOT)
    resolved = os.path.realpath(str(candidate))
    return resolved == root or resolved.startswith(root + os.sep)


class NoSuiteResolvesTheCheckoutConfigurationTest(unittest.TestCase):
    """A scratch fleet outside the checkout, driven from inside it."""

    LIMIT = "truncate_field_chars"

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="checkout-isolation-guard-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        # Registered AFTER the removal so it runs BEFORE it.
        self.addCleanup(os.chdir, os.getcwd())

        self.install_dir = os.path.join(self.root, "install")
        self.fleet_dir = os.path.join(self.install_dir, "clients")
        os.makedirs(self.fleet_dir, exist_ok=True)
        for source in _SCRATCH_FLEET:
            shutil.copyfile(source, os.path.join(self.fleet_dir, source.name))
        self.install_config = os.path.join(self.install_dir, CONFIG_NAME)
        self.axi_path = os.path.join(self.fleet_dir, "_crucible_axi.py")

    def axi(self):
        module = _load_module_by_path(
            self.axi_path, "checkout_guard_axi_%d" % next(_COUNTER))
        self.assertFalse(
            _inside_checkout(module.__file__),
            "the module under test must be the COPY outside the checkout: %r"
            % (module.__file__,))
        module.bind_project_dir(None)
        self.addCleanup(module.bind_project_dir, None)
        return module

    def shipped_declaration(self, name):
        with open(CLIENTS_DIR / CONFIG_NAME, "rb") as handle:
            return tomllib.load(handle)["limits"][name]

    def test_the_containment_check_can_see_a_path_inside_this_checkout(self):
        """THE CONTROL. A containment predicate that cannot see the hazard makes
        every verdict below an empty walk rather than the isolation's doing.

        Stated over PATHS rather than over what exists: this guard must reach
        the same verdict on a workstation carrying `<checkout>/crucible.toml`
        and on a fresh clone that does not, or it is exactly the
        machine-dependent thing it exists to forbid.
        """
        self.assertTrue(
            _inside_checkout(CHECKOUT_CONFIG),
            "%s must read as INSIDE the checkout" % (CHECKOUT_CONFIG,))
        self.assertTrue(_inside_checkout(CLIENTS_DIR / "_crucible_axi.py"))
        self.assertFalse(
            _inside_checkout(self.install_config),
            "a scratch install under %s must read as OUTSIDE it" % (self.root,))
        self.assertFalse(_inside_checkout("/tmp/elsewhere/" + CONFIG_NAME))

    def test_a_client_run_from_the_checkout_root_resolves_no_configuration_from_it(self):
        """The property itself. A suite's cwd is wherever the runner happened to
        start -- for `python3 -m unittest discover -s tests/client -t .` that is
        the CHECKOUT ROOT -- and configuration must not be a function of it.

        No project dir is bound and the scratch install carries no operator
        file, so this is the barest possible run: whatever answers, answers
        because the code went looking for it.
        """
        os.chdir(REPO_ROOT)
        axi = self.axi()

        resolved = axi.project_config_path()
        self.assertFalse(
            _inside_checkout(resolved),
            "a client resolved its configuration at %r, INSIDE this "
            "checkout. That file is untracked operator state: it exists here "
            "and not on a fresh clone or a runner, so every limit it sets "
            "decides this suite's outcome on one machine and nothing on the "
            "other. Configuration is a function of the INSTALL, never of the "
            "directory the runner started in" % (resolved,))

        shipped = axi.shipped_data_path()
        self.assertFalse(
            _inside_checkout(shipped),
            "the distribution's own data resolved to %r, inside the checkout: "
            "a client's package data must travel with the client" % (shipped,))

        for line in axi.limit_disclosures():
            for token in re.findall(r"(/[^\s,]+%s)" % (re.escape(CONFIG_NAME),),
                                    line):
                self.assertFalse(
                    _inside_checkout(token),
                    "a disclosure named %r, inside this checkout: the client "
                    "went looking in a developer's working copy. Line: %r"
                    % (token, line))

    def test_the_fixtures_own_file_is_what_decides_a_limit(self):
        """…and the positive half, without which the one above could be
        satisfied by a client that reads nothing anywhere: a value written into
        the scratch install is the value that RESOLVES, from a process standing
        in the checkout root. What decides a limit under test is the fixture's
        own file, and nothing on the machine running it can outvote that.
        """
        declaration = self.shipped_declaration(self.LIMIT)
        configured = declaration["max"]
        self.assertNotEqual(
            configured, declaration["recommended"],
            "fixture sanity: the configured value must be distinguishable from "
            "the recommendation, or 'the file decided' is unobservable")
        Path(self.install_config).write_text(
            "[limits.%s]\ndescription = %r\nrecommended = %d\nmin = %d\n"
            "max = %d\nvalue = %d\n"
            % (self.LIMIT, declaration["description"],
               declaration["recommended"], declaration["min"],
               declaration["max"], configured),
            encoding="utf-8")

        os.chdir(REPO_ROOT)
        axi = self.axi()
        self.assertEqual(
            configured, axi.resolve_limit(self.LIMIT),
            "the scratch install at %s sets `%s` to %d and the client resolved "
            "%d. A suite whose fixture cannot decide its own limits is a suite "
            "deciding them from the machine it runs on"
            % (self.install_config, self.LIMIT, configured,
               axi.resolve_limit(self.LIMIT)))

        # NEGATIVE -- the other two limits, which the fixture's file does NOT
        # set, fall to the SHIPPED recommendation rather than to anything the
        # checkout happens to declare.
        for name in CLIENT_LIMITS:
            if name == self.LIMIT:
                continue
            self.assertEqual(
                self.shipped_declaration(name)["recommended"],
                axi.resolve_limit(name),
                "`%s` is unset in the fixture's own file, so it must run at "
                "the build's recommendation -- not at whatever %s declares"
                % (name, CHECKOUT_CONFIG))


if __name__ == "__main__":
    unittest.main()
