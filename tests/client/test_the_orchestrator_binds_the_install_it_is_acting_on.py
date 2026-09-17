"""CR-CRU-142 §S1/§S2 -- `crucible-axi install`/`uninstall` resolve the
configuration of the install they are ACTING ON, never one inside their own
package.

Reported from a real `crucible-axi==0.2.1` install: the envelope disclosed
`limit-configuration` naming
`.../uv/tools/crucible-axi/lib/python3.13/site-packages/crucible_axi/crucible.toml`
-- a directory `uv` owns and replaces on every upgrade -- while the same run
had just written the operator's real file at `~/.crucible/crucible.toml`.

Root cause: `cli._load_client_module("_crucible_axi")` vendors the shared
envelope module BY FILE PATH out of the orchestrator's own package
(`crucible_axi/clients/_crucible_axi.py` in the wheel), so that copy's
`_INSTALL_DIR` is `<site-packages>/crucible_axi` -- a THIRD execution shape
CR-CRU-138 §S1 never enumerated. Neither `cmd_install` nor `cmd_uninstall`
calls `bind_project_dir`, so `_PROJECT_DIR` stays None and the precedence
chain collapses to that one unusable candidate.

WHAT IS REPRODUCED HERE, AND WHY IT HAS TO BE. A checkout's
`clients/_crucible_axi.py` resolves `_INSTALL_DIR` to the REPO ROOT, which
carries a perfectly readable `crucible.toml` -- so a test run against the
checkout layout stays silent whether or not the bind is missing, and would pin
nothing at all. The fixture therefore lays the wheel's OWN layout down on the
real filesystem (`<tmp>/site-packages/crucible_axi/clients/`, a byte copy of
the packaged fleet) and points `manifest.source_clients_dir()` at it. The
resolution chain, the module load and the file reads are all REAL; only the
location of the package is a fixture -- which is precisely the variable under
test.

Four contracts, every one driven through the REAL entry point `cli.main([...])`:

    1. AC1 -- a fresh `install --target-dir <tmp>` into an EMPTY directory
       emits an envelope carrying NO `limit-configuration` disclosure: the
       `[manifest]` stage wrote `<tmp>/crucible.toml` moments earlier and the
       envelope resolves that very file. Pre-fix it carries the disclosure,
       naming the site-packages path.
    1b. AC1 (WHICH file) -- with a legal, NON-recommended `value` edited into
       `<tmp>/crucible.toml`, the envelope stays silent AND the module
       resolves that value: silence from a readable file, not silence from the
       shipped recommendations.
    2. AC2 -- when NOTHING wrote `<tmp>/crucible.toml` (the `[manifest]` stage
       stubbed out), the disclosure DOES fire, and names `<tmp>/crucible.toml`
       as its FIRST candidate -- the file an operator can create -- never the
       path under the running module's own location.
    3. AC3 -- `uninstall --target-dir <tmp> --purge`, which has just REMOVED
       that file, obeys the same rule.
    4. AC4 -- `_PROJECT_DIR` is bound to `args.target_dir` at the point each
       envelope is built, for BOTH verbs, observed by wrapping the vendored
       module's `emit_axi` -- never by calling `bind_project_dir` from the
       test.

HOW EACH FAILS IF §S1 IS NOT WIRED: `_PROJECT_DIR` is None, so
`_project_config_candidates()` is
`(<site-packages>/crucible_axi/crucible.toml,)` -- absent -- and every
envelope above carries the `no readable configuration` disclosure naming it.

§S2 is asserted by the diff rather than by a test: `clients/_crucible_axi.py`
is unchanged by this CR, and nothing here reaches it except through the
production load path.

Safety -- nothing here may touch the operator's real machine, which on a
development workstation carries a LIVE install at `~/.crucible` and a live
board writing `~/.local/share/crucible/crucible.db`. `$HOME`,
`$XDG_DATA_HOME`, `$XDG_CONFIG_HOME` and `$BUN_INSTALL` are all pinned inside
one tmp root for the duration of every test (CR-CRU-143 proved `store_dir()`
reads `$XDG_DATA_HOME` BEFORE `$HOME`, so pinning `$HOME` alone does NOT
sandbox the store a `--purge` deletes); `--target-dir` is always passed
explicitly, so the `~/.crucible` default is never used; `[server]` (which runs
`bun add -g`) and `[unit]` (which drives `systemctl --user`) are stubbed in
BOTH directions. An L2 escape detector re-reads the operator's two real
`crucible.toml` files after every test and FAILS on any change, so a sandbox
that ever regresses is reported here rather than on the operator's disk.

Invocation:
    python3 -m pytest tests/client/test_the_orchestrator_binds_the_install_it_is_acting_on.py -q
Fallback:
    python3 tests/client/test_the_orchestrator_binds_the_install_it_is_acting_on.py
"""

import contextlib
import hashlib
import importlib
import io
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
TOON_PATH = REPO_ROOT / "clients" / "toon.py"
SOURCE_CLIENTS_DIR = REPO_ROOT / "clients"

CONFIG_NAME = "crucible.toml"
FLEET_DIRNAME = "clients"

#: The envelope `warnings[]` code every limit disclosure carries
#: (`_crucible_axi.LIMIT_CONFIGURATION_CODE`). Matched on the CODE, never on
#: the sentence: the disclosure's wording is not this CR's contract.
LIMIT_CONFIGURATION_CODE = "limit-configuration"

#: The fragment `_limits_unreadable` puts immediately before the candidate
#: chain, in precedence order. The FIRST name after it is the file the
#: disclosure tells an operator to create -- which is the whole of AC2/AC3.
PRECEDENCE_PREFIX = "precedence order: "

#: A limit whose `value` an operator may legally set to something that is NOT
#: the recommendation (`recommended` 200, range [20, 4000] in the shipped
#: declarations). 40 is inside the range, so it is OBEYED and discloses
#: nothing -- silence here means "the file read", never "the value refused".
EDITED_LIMIT_NAME = "truncate_field_chars"
EDITED_LIMIT_VALUE = 40

#: The operator's REAL files, resolved at IMPORT time -- before any test pins
#: `$HOME` -- so the escape detector below addresses the actual machine.
#: `crucible.db` is deliberately NOT watched: a development workstation's live
#: board writes it continuously (CR-CRU-143's own suite excludes it by name).
REAL_INSTALL_CONFIG = Path(os.path.expanduser("~/.crucible")) / CONFIG_NAME
REAL_STORE_CONFIG = (Path(os.path.expanduser("~/.local/share/crucible"))
                     / CONFIG_NAME)
REAL_WATCHED_PATHS = (REAL_INSTALL_CONFIG, REAL_STORE_CONFIG)


def _load_toon_module():
    spec = importlib.util.spec_from_file_location(
        "toon_under_test_for_cr142", TOON_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _stub_stage(name):
    """A stage runner that does nothing and reports a converged row -- the
    shape `run_install`/`run_uninstall` expect from a real one."""

    def _runner(target_dir, _switch=False, **_kwargs):
        return {"path": os.path.join(target_dir, name), "converged": True}

    return _runner


@contextlib.contextmanager
def _patched_env(**overrides):
    with mock.patch.dict(os.environ, {}, clear=False):
        for key, value in overrides.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        yield


def _fingerprint(path):
    """`(exists, size, mtime_ns, sha256)` for one real file -- enough to catch
    a rewrite that restored the same length, and cheap enough to take around
    every test."""
    try:
        stat = os.stat(path)
        digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except FileNotFoundError:
        return (False, None, None, None)
    return (True, stat.st_size, stat.st_mtime_ns, digest)


class _OrchestratorInstallCase(unittest.TestCase):
    """One tmp root holding the scratch `$HOME`, `$XDG_DATA_HOME`,
    `$XDG_CONFIG_HOME`, `$BUN_INSTALL`, the `--target-dir`, and a
    `site-packages/crucible_axi/clients/` tree carrying a byte copy of the
    packaged fleet -- the WHEEL's layout, which is the shape the defect lives
    in. `[server]` and `[unit]` are ALWAYS stubbed, in both directions;
    `[fleet]` and `[manifest]` are REAL, which is the point."""

    def setUp(self):
        self.cli = importlib.import_module("crucible_axi.cli")
        self.install = importlib.import_module("crucible_axi.install")
        self.manifest = importlib.import_module("crucible_axi.manifest")
        self.toon = _load_toon_module()

        self.root = tempfile.mkdtemp(prefix="cr142-orchestrator-bind-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.target_dir = os.path.join(self.root, "target")
        self.fake_home = os.path.join(self.root, "home")
        self.xdg_data = os.path.join(self.root, "xdg-data")
        self.xdg_config = os.path.join(self.root, "xdg-config")
        self.bun_root = os.path.join(self.root, "bun")
        for directory in (self.fake_home, self.xdg_data, self.xdg_config,
                          self.bun_root):
            os.makedirs(directory, exist_ok=True)

        # The wheel's own layout: `crucible_axi/clients/` as package data,
        # under a directory named exactly as the report names it.
        self.vendored_package_dir = os.path.join(
            self.root, "site-packages", "crucible_axi")
        self.vendored_clients_dir = os.path.join(
            self.vendored_package_dir, FLEET_DIRNAME)
        shutil.copytree(SOURCE_CLIENTS_DIR, self.vendored_clients_dir,
                        ignore=shutil.ignore_patterns("__pycache__"))
        self.vendored_install_config = os.path.join(
            self.vendored_package_dir, CONFIG_NAME)
        self.assertFalse(
            os.path.exists(self.vendored_install_config),
            "fixture: the vendored package dir must carry NO `crucible.toml` "
            "-- that absence is what the reported defect resolves to")

        self.config_file = os.path.join(self.target_dir, CONFIG_NAME)
        self.emissions = []
        self._real_before = {str(p): _fingerprint(p)
                             for p in REAL_WATCHED_PATHS}
        self.addCleanup(self._assert_operator_install_untouched)

    # -- isolation ---------------------------------------------------------

    def _assert_operator_install_untouched(self):
        after = {str(p): _fingerprint(p) for p in REAL_WATCHED_PATHS}
        self.assertEqual(
            after, self._real_before,
            "L2 escape detector: the operator's REAL configuration changed "
            "while this test ran. The sandbox pins $HOME, $XDG_DATA_HOME, "
            "$XDG_CONFIG_HOME and $BUN_INSTALL inside %s and always passes "
            "--target-dir explicitly, so a write that landed here came from a "
            "hardcoded path or an `expanduser` evaluated before the patch -- "
            "and it landed on the OPERATOR's machine." % (self.root,))

    def _env(self):
        return {
            "HOME": self.fake_home,
            "XDG_DATA_HOME": self.xdg_data,
            "XDG_CONFIG_HOME": self.xdg_config,
            "BUN_INSTALL": self.bun_root,
            "CRUCIBLE_NO_SERVICE": "1",
            "CRUCIBLE_NO_BUN_BOOTSTRAP": "1",
        }

    def _stubs(self, table, extra=()):
        names = {"server", "unit"} | set(extra)
        return {name: _stub_stage(name) for name in names if name in table}

    # -- driving the real entry point --------------------------------------

    def _recording_loader(self, real_loader):
        """`cli._load_client_module` with the vendored module's `emit_axi`
        wrapped, so what the module RESOLVED at the moment the envelope was
        built is observable without the test ever binding anything itself."""

        def _loader(name):
            module = real_loader(name)
            if name != "_crucible_axi":
                return module
            real_emit = module.emit_axi

            def _emit(*args, **kwargs):
                self.emissions.append({
                    "project_dir": module._PROJECT_DIR,
                    "install_dir": module._INSTALL_DIR,
                    "candidates": tuple(module._project_config_candidates()),
                    "config_path": module.project_config_path(),
                    "limit": module.resolve_limit(EDITED_LIMIT_NAME),
                })
                return real_emit(*args, **kwargs)

            module.emit_axi = _emit
            return module

        return _loader

    def run_cli(self, argv, extra_stubs=()):
        """`cli.main(argv)` under the sandbox, with stdout captured. Returns
        `(code, stdout)`; an argparse `SystemExit` is reported as its code so a
        contract failure never surfaces as an opaque test error."""
        buffer = io.StringIO()
        with _patched_env(**self._env()), \
                mock.patch.object(self.manifest, "source_clients_dir",
                                  return_value=self.vendored_clients_dir), \
                mock.patch.object(
                    self.cli, "_load_client_module",
                    side_effect=self._recording_loader(
                        self.cli._load_client_module)), \
                mock.patch.dict(
                    self.install.DEFAULT_STAGE_RUNNERS,
                    self._stubs(self.install.DEFAULT_STAGE_RUNNERS,
                                extra_stubs)), \
                mock.patch.dict(
                    self.install.DEFAULT_UNINSTALL_STAGE_RUNNERS,
                    self._stubs(self.install.DEFAULT_UNINSTALL_STAGE_RUNNERS,
                                extra_stubs)), \
                contextlib.redirect_stdout(buffer):
            try:
                code = self.cli.main(argv)
            except SystemExit as exc:
                code = 0 if exc.code is None else exc.code
        return code, buffer.getvalue()

    def install_via_cli(self, *extra_argv, **kwargs):
        code, stdout = self.run_cli(
            ["install", "--target-dir", self.target_dir, "--no-service",
             "--no-bun-bootstrap", *extra_argv], **kwargs)
        self.assertEqual(
            code, 0,
            "the install must succeed before its envelope can be read; "
            "envelope:\n%s" % (stdout,))
        return stdout

    def uninstall_via_cli(self, *extra_argv, **kwargs):
        code, stdout = self.run_cli(
            ["uninstall", "--target-dir", self.target_dir, *extra_argv],
            **kwargs)
        self.assertEqual(
            code, 0,
            "the uninstall must run to completion before its envelope can be "
            "read; envelope:\n%s" % (stdout,))
        return stdout

    # -- observations ------------------------------------------------------

    def envelope(self, stdout):
        return self.toon.decode(stdout)["axi"]

    def limit_warnings(self, stdout):
        return [w for w in self.envelope(stdout).get("warnings", [])
                if w.get("code") == LIMIT_CONFIGURATION_CODE]

    def sole_limit_warning(self, stdout, verb):
        found = self.limit_warnings(stdout)
        self.assertEqual(
            len(found), 1,
            "%s: exactly ONE `%s` disclosure is expected here (no readable "
            "configuration exists at either candidate), got %d; envelope:\n%s"
            % (verb, LIMIT_CONFIGURATION_CODE, len(found), stdout))
        return found[0]["detail"]

    def assertNamesTargetDirFirst(self, detail, verb):
        self.assertIn(
            PRECEDENCE_PREFIX, detail,
            "%s: the disclosure must state its candidate chain in precedence "
            "order; detail=%r" % (verb, detail))
        chain = detail.split(PRECEDENCE_PREFIX, 1)[1]
        first = chain.split(",")[0].split(" — ")[0].strip()
        self.assertEqual(
            first, self.config_file,
            "§S1/%s: the FIRST candidate -- the file the disclosure tells an "
            "operator to create -- must be the `--target-dir` this verb is "
            "acting on, never a path under the orchestrator's own package "
            "(%s). `cmd_%s` loads the vendored `_crucible_axi` and must call "
            "`axi.bind_project_dir(args.target_dir)` before anything can "
            "emit. detail=%r"
            % (verb, self.vendored_install_config, verb, detail))

    def last_emission(self, verb):
        self.assertTrue(
            self.emissions,
            "%s: the vendored `_crucible_axi` module was never loaded, so no "
            "envelope was built through it -- the fixture cannot observe what "
            "this CR is about" % (verb,))
        return self.emissions[-1]


class AFreshInstallResolvesTheConfigurationItJustWroteTest(
        _OrchestratorInstallCase):
    """AC1 -- the reported defect, end to end."""

    def test_install_into_an_empty_dir_discloses_no_limit_configuration(self):
        stdout = self.install_via_cli()
        self.assertTrue(
            os.path.isfile(self.config_file),
            "fixture: the [manifest] stage must have laid `%s` down -- AC1 is "
            "about the envelope resolving the file the install just wrote; "
            "envelope:\n%s" % (self.config_file, stdout))
        self.assertEqual(
            self.limit_warnings(stdout), [],
            "§S1/AC1: an install that has just WRITTEN `%s` owes its operator "
            "no `%s` disclosure -- the file is right there and it reads. "
            "Pre-fix the vendored module's `_PROJECT_DIR` is unbound, so the "
            "chain collapses to `%s` (inside the orchestrator's own package, "
            "which no operator can edit) and the envelope claims no "
            "configuration exists. envelope:\n%s"
            % (self.config_file, LIMIT_CONFIGURATION_CODE,
               self.vendored_install_config, stdout))

    def test_install_resolves_a_legal_non_recommended_value_from_the_target_dir(self):
        """AC1 (WHICH file) -- silence must come from the operator's file, not
        from the shipped recommendations. A legal, non-recommended `value` is
        obeyed and disclosed nowhere, so the value the module resolves names
        the file it read."""
        self.install_via_cli()
        text = Path(self.config_file).read_text(encoding="utf-8")
        header = "[limits.%s]\n" % (EDITED_LIMIT_NAME,)
        self.assertIn(
            header, text,
            "fixture: the laid-down config must declare `%s`"
            % (EDITED_LIMIT_NAME,))
        Path(self.config_file).write_text(
            text.replace(header,
                         "%svalue = %d\n" % (header, EDITED_LIMIT_VALUE), 1),
            encoding="utf-8")

        stdout = self.install_via_cli("--force")

        self.assertEqual(
            self.limit_warnings(stdout), [],
            "§S1/AC1: `value = %d` is inside the range declared beside it, so "
            "it is OBEYED and nothing is disclosed; envelope:\n%s"
            % (EDITED_LIMIT_VALUE, stdout))
        emission = self.last_emission("install")
        self.assertEqual(
            emission["config_path"], self.config_file,
            "§S1/AC1: the envelope must have resolved the operator's file at "
            "the `--target-dir`, got %r" % (emission["config_path"],))
        self.assertEqual(
            emission["limit"], EDITED_LIMIT_VALUE,
            "§S1/AC1: `%s` must run at the operator's %d -- resolving the "
            "shipped recommendation instead means the envelope read some "
            "other file than `%s`"
            % (EDITED_LIMIT_NAME, EDITED_LIMIT_VALUE, self.config_file))


class ADisclosureNamesTheInstallBeingActedOnTest(_OrchestratorInstallCase):
    """AC2/AC3 -- when a disclosure DOES fire, the path it tells an operator to
    create is one they own.

    AC2 keeps `<tmp>/crucible.toml` absent by stubbing the `[manifest]` stage
    (the stage that lays it down): a `--force` re-run would simply rewrite the
    file and the disclosure would not fire at all, which pins nothing. AC3 gets
    the same state from the production path -- `uninstall --purge` REMOVES that
    file before the envelope is built.
    """

    def test_install_that_wrote_no_config_names_the_target_dir_first(self):
        stdout = self.install_via_cli(extra_stubs=("manifest",))
        self.assertFalse(
            os.path.exists(self.config_file),
            "fixture: `%s` must be ABSENT for this contract -- AC2 is about "
            "the disclosure that fires when nothing wrote it"
            % (self.config_file,))
        self.assertNamesTargetDirFirst(
            self.sole_limit_warning(stdout, "install"), "install")

    def test_uninstall_after_a_purge_names_the_target_dir_first(self):
        self.install_via_cli()
        self.assertTrue(os.path.isfile(self.config_file))

        stdout = self.uninstall_via_cli("--purge")

        self.assertFalse(
            os.path.exists(self.config_file),
            "fixture: `--purge` must have removed the untouched `%s`, which is "
            "the state AC3 is about; envelope:\n%s"
            % (self.config_file, stdout))
        self.assertNamesTargetDirFirst(
            self.sole_limit_warning(stdout, "uninstall"), "uninstall")


class BothVerbsBindTheTargetDirBeforeEmittingTest(_OrchestratorInstallCase):
    """AC4 -- `_PROJECT_DIR` is bound to `args.target_dir` at the point each
    envelope is built, for BOTH verbs, observed through the real CLI entry
    point rather than by calling `bind_project_dir` from the test."""

    def test_install_and_uninstall_bind_the_target_dir_at_emit_time(self):
        self.install_via_cli()
        self.uninstall_via_cli()

        self.assertEqual(
            len(self.emissions), 2,
            "fixture: one envelope per verb must have been built through the "
            "vendored module; got %r" % (self.emissions,))
        for verb, emission in zip(("install", "uninstall"), self.emissions):
            self.assertEqual(
                emission["install_dir"], self.vendored_package_dir,
                "fixture: the vendored module must be running in the WHEEL's "
                "shape, whose `_INSTALL_DIR` is the package dir `%s` -- "
                "otherwise this suite is not exercising the reported defect"
                % (self.vendored_package_dir,))
            self.assertEqual(
                emission["project_dir"], self.target_dir,
                "§S1/AC4: `cmd_%s` must call "
                "`axi.bind_project_dir(args.target_dir)` immediately after "
                "loading the vendored module and BEFORE `emit_axi`; at emit "
                "time `_PROJECT_DIR` was %r"
                % (verb, emission["project_dir"]))
            self.assertEqual(
                emission["candidates"][0],
                os.path.join(self.target_dir, CONFIG_NAME),
                "§S1/AC4: the bind must put `<target-dir>/%s` FIRST in the "
                "precedence chain `cmd_%s` resolves against; chain=%r"
                % (CONFIG_NAME, verb, emission["candidates"]))


if __name__ == "__main__":
    unittest.main()
