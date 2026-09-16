"""CR-CRU-131 §S1c -- the installer LAYS DOWN an operator-editable
`crucible.toml`, the manifest DECLARES it, and `uninstall` RESPECTS AN EDIT.

§S1c: "An install that only ships defaults gives the operator nothing to edit;
a checkout-only file gives an installed deployment nothing to read." Shipping
the defaults (tests/client/test_shipped_limits_ship_as_package_data.py) is only
half of it -- the other half is the file at the path an operator will actually
open.

Four contracts, all driven through the REAL `crucible_axi.install` entry points
against a TEMPORARY target directory:

    1. LAYDOWN -- `run_install` leaves a commented, operator-editable
       `crucible.toml` at `<target-dir>`, carrying each limit's description,
       recommendation and range. It carries ONLY the three limits this side
       ENFORCES: a laid-down file that shows an operator a knob which provably
       does nothing where it sits contradicts, in documentation, the ownership
       negatives C1 asserts in tests -- and the tests are the behaviour.
       The `[fleet]`/`[manifest]` stage ordering is unchanged.
       `<target-dir>` is the INSTALL ROOT, which CR-CRU-138 §S1 makes the
       second step of the client's own resolution chain: an installed client
       lives at `<install dir>/clients/_crucible_axi.py` and derives that root
       from its own location, so the path asserted here is the path an
       installed deployment READS. This file still asserts only the WRITE
       side; the pair is asserted together, by installing and then resolving,
       in tests/client/test_an_installed_deployment_resolves_its_configuration.py.
    2. MANIFEST -- the laid-down file is declared in `crucible-clients.json`
       like everything else the installer writes, and the declared path exists.
    3. UNINSTALL RESPECTS AN EDIT -- an artifact is replaceable; an operator's
       configuration is DATA. `uninstall --purge` may remove an untouched file
       and must NOT remove a modified one, and the survivor's content is the
       operator's rather than a restored default.
    4. RE-INSTALL -- a second install over an edited file does not overwrite
       the operator's values.

HOW EACH FAILS IF THE CODE DOES NOTHING: (1) `<target-dir>/crucible.toml` is
never created -- `run_install`'s stages are `server`/`fleet`/`manifest`/`unit`
and the only file written at `<target-dir>` itself is `crucible-clients.json`;
(2)-(4) unreachable, since there is no laid-down file to declare, to edit or to
preserve.

Safety -- nothing here touches the developer's environment. `[server]` (which
really runs `bun add -g`) and `[unit]` (which really drives `systemctl --user
enable --now`) are stubbed in BOTH directions via `mock.patch.dict`, exactly as
tests/client/test_cr090_cli_install_integration.py and
tests/client/test_cr069_uninstall.py do. `$HOME`, `$XDG_DATA_HOME` and
`$BUN_INSTALL` are pinned to scratch directories for the duration of every
test, so `store_dir()` and the default `~/.crucible` target resolve inside the
fixture and the operator's real ones are never reached. No `uv tool install`,
no `npm publish`, no `pip install`. Nothing is written inside the repo and no
board is contacted.

Invocation:
    python3 -m pytest tests/client/test_installer_lays_down_the_editable_limits_file.py -q
Fallback:
    python3 tests/client/test_installer_lays_down_the_editable_limits_file.py
"""

import contextlib
import importlib
import json
import os
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

CONFIG_NAME = "crucible.toml"
DOCUMENTED_FIELDS = ("description", "recommended", "min", "max")

#: The three limits the SERVER enforces -- read from a `crucible.toml` beside
#: its own DATABASE, never from one in a project directory. Named here so the
#: ownership NEGATIVE can be asserted on the laid-down file.
SERVER_LIMITS = ("run_abandon_ms", "project_inactive_ms", "retention")


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


class _InstallerFixtureCase(unittest.TestCase):
    """One tmp root holding a scratch `$HOME`, `$XDG_DATA_HOME`, `$BUN_INSTALL`
    and `--target-dir`. The `[server]` and `[unit]` stages are ALWAYS stubbed,
    in both directions; `[fleet]`, `[manifest]`, `[config]` and `[store]` are
    REAL, which is the point."""

    def setUp(self):
        self.install = importlib.import_module("crucible_axi.install")
        self.manifest = importlib.import_module("crucible_axi.manifest")

        self.root = tempfile.mkdtemp(prefix="limits-installer-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.target_dir = os.path.join(self.root, "target")
        self.fake_home = os.path.join(self.root, "home")
        self.xdg_home = os.path.join(self.root, "xdg")
        self.bun_root = os.path.join(self.root, "bun")
        for directory in (self.fake_home, self.xdg_home, self.bun_root):
            os.makedirs(directory, exist_ok=True)

        self.config_file = os.path.join(self.target_dir, CONFIG_NAME)
        self.manifest_file = os.path.join(
            self.target_dir, self.manifest.MANIFEST_FILENAME)

    # -- driving the real entry points ------------------------------------

    def _env(self):
        return {
            "HOME": self.fake_home,
            "XDG_DATA_HOME": self.xdg_home,
            "BUN_INSTALL": self.bun_root,
            "CRUCIBLE_NO_SERVICE": "1",
            "CRUCIBLE_NO_BUN_BOOTSTRAP": "1",
        }

    def _stubs(self, table):
        return {name: _stub_stage(name)
                for name in ("server", "unit") if name in table}

    def install_once(self, force=False):
        with _patched_env(**self._env()), mock.patch.dict(
                self.install.DEFAULT_STAGE_RUNNERS,
                self._stubs(self.install.DEFAULT_STAGE_RUNNERS)):
            ok, stages, warnings = self.install.run_install(
                self.target_dir, force=force, no_service=True,
                no_bun_bootstrap=True)
        self.assertTrue(
            ok, "the install must succeed before anything it wrote can be "
                "asserted; warnings=%r stages=%r" % (warnings, stages))
        return stages

    def uninstall_once(self, purge=True):
        with _patched_env(**self._env()), mock.patch.dict(
                self.install.DEFAULT_UNINSTALL_STAGE_RUNNERS,
                self._stubs(self.install.DEFAULT_UNINSTALL_STAGE_RUNNERS)):
            ok, stages, warnings = self.install.run_uninstall(
                self.target_dir, purge=purge)
        self.assertTrue(
            ok, "the uninstall must run to completion; warnings=%r stages=%r"
               % (warnings, stages))
        return stages

    # -- observations ------------------------------------------------------

    def require_config(self):
        self.assertTrue(
            os.path.isfile(self.config_file),
            "§S1c: the installer must LAY DOWN an operator-editable "
            "`crucible.toml` at the target directory -- it already has a "
            "[config] stage and already writes one file there. Without it an "
            "installed deployment ships defaults the operator has no way to "
            "override at the path they would look -- and, since the chain "
            "landed, at the path an installed client RESOLVES: the install root "
            "it derives from its own location. `%s` holds: %r"
            % (self.target_dir,
               sorted(os.listdir(self.target_dir))
               if os.path.isdir(self.target_dir) else None))
        return Path(self.config_file).read_text(encoding="utf-8")

    def client_limit_names(self):
        """The limits a CLIENT enforces, read from the fleet's own declaration
        rather than restated here -- a seventh limit is then covered on the day
        it is added."""
        source = Path(self.manifest.source_clients_dir()) / "_crucible_axi.py"
        match = re.search(r"CLIENT_LIMIT_NAMES\s*=\s*\(([^)]*)\)",
                          source.read_text(encoding="utf-8"))
        self.assertIsNotNone(
            match,
            "%s no longer declares CLIENT_LIMIT_NAMES; it is the single list "
            "of the limits a client enforces" % (source,))
        return tuple(re.findall(r'"([^"]+)"', match.group(1)))

    def table_of(self, text, name):
        match = re.search(r"\[limits\.%s\]([\s\S]*?)(?=\n\[|\Z)" % (name,), text)
        return match.group(1) if match else None


class TheInstallerLaysDownAnEditableConfigTest(_InstallerFixtureCase):

    def test_install_leaves_a_commented_crucible_toml_carrying_every_client_limit(self):
        self.install_once()
        text = self.require_config()

        # COMMENTED -- the operator meets the documentation at the path they
        # will edit, and is told HOW to set a value (`value = …` beside the
        # four immutable fields, never by overwriting `recommended`).
        comments = [line for line in text.splitlines()
                    if line.lstrip().startswith("#")]
        self.assertGreater(
            len(comments), 4,
            "the laid-down file must arrive COMMENTED; it carried %d comment "
            "line(s)" % (len(comments),))
        self.assertIn(
            "value", text,
            "the file must tell its reader how to configure a limit -- an "
            "operator who edits `recommended` in place destroys, in the very "
            "file they read, the record of what we recommend")

        # …and each limit's description, recommendation and RANGE.
        for name in self.client_limit_names():
            table = self.table_of(text, name)
            self.assertIsNotNone(
                table,
                "the laid-down file declares no `[limits.%s]` table; the file "
                "must carry every limit this side enforces" % (name,))
            missing = [field for field in DOCUMENTED_FIELDS
                       if not re.search(r"(?m)^\s*%s\s*=" % (field,), table)]
            self.assertEqual(
                missing, [],
                "`[limits.%s]` is missing %r -- the range is enforced from the "
                "data that documents it, so a table without its bounds is a "
                "bound nothing can check" % (name, missing))

    def test_the_laid_down_file_carries_no_limit_this_side_does_not_enforce(self):
        """OWNERSHIP, in the documentation as well as in the code: a SERVER
        limit in the file laid down at the install root is inert, and C1
        asserts exactly that in tests. Documentation must not teach against the
        tests.

        The server's own three are not unreachable, they are laid down
        ELSEWHERE -- beside the server's database, by CR-CRU-138 §S2, from the
        server's own package data. The two templates stay disjoint by design
        (version skew across two independently installable packages), which is
        exactly what this test keeps true from the client side.
        """
        self.install_once()
        text = self.require_config()

        declared = [name for name in SERVER_LIMITS
                    if re.search(r"(?m)^\s*\[limits\.%s\]" % (name,), text)]
        self.assertEqual(
            declared, [],
            "the file laid down at the install root declares SERVER limit "
            "table(s) %r. No client reads them and the server reads its OWN "
            "file beside its database, never this one, so an operator who set "
            "one would be editing a knob that provably does nothing where it "
            "sits" % (declared,))


class TheManifestDeclaresTheLaidDownFileTest(_InstallerFixtureCase):

    def test_crucible_clients_json_declares_the_config_it_wrote_and_the_path_exists(self):
        self.install_once()
        config_text = self.require_config()
        self.assertTrue(
            os.path.isfile(self.manifest_file),
            "fixture sanity: the [manifest] stage must have written %s"
            % (self.manifest_file,))

        document = json.loads(
            Path(self.manifest_file).read_text(encoding="utf-8"))

        def paths(node):
            if isinstance(node, str):
                yield node
            elif isinstance(node, dict):
                for value in node.values():
                    yield from paths(value)
            elif isinstance(node, list):
                for value in node:
                    yield from paths(value)

        published = list(paths(document))
        self.assertIn(
            self.config_file, published,
            "§S1c: a file the installer WRITES belongs in `%s` like everything "
            "else it lays down -- otherwise automation cannot discover the "
            "config it is meant to edit. published=%r"
            % (self.manifest.MANIFEST_FILENAME, published))
        # NON-VACUITY: the manifest names a file that is really there, with
        # content -- the dangling-path defect CR-CRU-090 closed, one artifact
        # wider.
        self.assertNotEqual(config_text.strip(), "")

        # …and the ORDERING that makes such a declaration honest is unchanged
        # (§S1c AC: "the `[config]`/`[manifest]` stage ordering is unchanged").
        # A manifest may only publish paths that already exist, so whatever
        # stage writes the config must precede [manifest] exactly as [fleet]
        # does; and a purge may only destroy after every reversible step has
        # succeeded.
        # (The dangling-path defect that ordering closed is narrated at
        # crucible_axi/install.py's STAGE_ORDER; the assertion states the rule,
        # not the history, so no project id rides in its message.)
        order = tuple(self.install.STAGE_ORDER)
        self.assertLess(
            order.index("fleet"), order.index("manifest"),
            "[manifest] publishes paths anchored on what earlier stages "
            "materialise; inverting them republishes the dangling-path defect "
            "that ordering closed. STAGE_ORDER=%r" % (order,))
        self.assertEqual(
            order[-1], "unit",
            "[unit] hands work to another supervisor and must stay LAST; "
            "STAGE_ORDER=%r" % (order,))
        inverse = tuple(self.install.UNINSTALL_STAGE_ORDER)
        self.assertEqual(
            inverse[0], "unit",
            "[unit] is removed FIRST so systemd never restarts a deleted "
            "binary; UNINSTALL_STAGE_ORDER=%r" % (inverse,))
        self.assertEqual(
            inverse[-1], "store",
            "destructive-LAST: the store is the one irreplaceable artifact; "
            "UNINSTALL_STAGE_ORDER=%r" % (inverse,))


class UninstallRespectsAnOperatorsEditTest(_InstallerFixtureCase):

    EDIT_MARKER = "# edited by the operator, cycle 457\n"

    def _edit_config(self):
        """Make an operator's edit and PROVE it landed -- the bytes must differ
        from what the installer wrote, or the survival assertion below would be
        asserting nothing."""
        before = Path(self.config_file).read_bytes()
        name = self.client_limit_names()[0]
        text = Path(self.config_file).read_text(encoding="utf-8")
        table = self.table_of(text, name)
        self.assertIsNotNone(table, "nothing to edit in the laid-down file")
        floor = int(re.search(r"(?m)^\s*min\s*=\s*(\d[\d_]*)",
                              table).group(1).replace("_", ""))
        ceiling = int(re.search(r"(?m)^\s*max\s*=\s*(\d[\d_]*)",
                                table).group(1).replace("_", ""))
        chosen = floor + (ceiling - floor) // 3
        edited = text.replace(
            "[limits.%s]" % (name,),
            "%s[limits.%s]" % (self.EDIT_MARKER, name), 1)
        edited = edited.rstrip("\n") + "\n"
        edited = re.sub(
            r"(\[limits\.%s\][\s\S]*?max\s*=\s*\d[\d_]*)" % (name,),
            r"\g<1>\nvalue = %d" % (chosen,), edited, count=1)
        Path(self.config_file).write_text(edited, encoding="utf-8")

        self.assertNotEqual(
            Path(self.config_file).read_bytes(), before,
            "fixture sanity: the operator's edit must actually change the "
            "file, or 'it survived' proves nothing")
        return name, chosen

    def test_purge_does_not_delete_a_crucible_toml_the_operator_modified(self):
        self.install_once()
        self.require_config()
        name, chosen = self._edit_config()

        self.uninstall_once(purge=True)

        self.assertTrue(
            os.path.isfile(self.config_file),
            "§S1c: `uninstall` must NOT silently delete an operator-EDITED "
            "`crucible.toml`. An artifact is replaceable; an operator's "
            "configuration is DATA, and the stage order is already "
            "fail-fast-first / destructive-last for exactly this class of "
            "reason")
        survivor = Path(self.config_file).read_text(encoding="utf-8")
        # The SURVIVOR is the operator's file, not a restored default.
        self.assertIn(
            self.EDIT_MARKER.strip(), survivor,
            "the file that survived is not the operator's -- their edit is "
            "gone, which is a silent overwrite wearing a survival's clothes")
        self.assertRegex(
            self.table_of(survivor, name) or "",
            r"(?m)^\s*value\s*=\s*%d\s*$" % (chosen,),
            "the operator's `value = %d` for `%s` did not survive the purge"
            % (chosen, name))

    def test_purge_may_remove_an_untouched_crucible_toml(self):
        """The easy half, and it is the half that makes the hard one mean
        something: removal is not blanket-disabled, it is conditioned on the
        file being UNMODIFIED. Without this, 'the edited file survived' would
        be indistinguishable from 'uninstall stopped removing anything'."""
        self.install_once()
        self.require_config()

        self.uninstall_once(purge=True)

        self.assertFalse(
            os.path.isfile(self.config_file),
            "an UNMODIFIED laid-down config is an artifact like any other and "
            "`--purge` removes it; leaving it makes the modified-file "
            "protection unobservable")
        self.assertFalse(
            os.path.isfile(self.manifest_file),
            "fixture sanity: `--purge` removes the manifest it wrote")

    def test_a_reinstall_over_an_edited_file_keeps_the_operators_values(self):
        self.install_once()
        self.require_config()
        name, chosen = self._edit_config()
        edited = Path(self.config_file).read_bytes()

        self.install_once()

        self.assertEqual(
            Path(self.config_file).read_bytes(), edited,
            "§S1c: a re-install over an existing edited file must not "
            "overwrite the operator's values -- an upgrade that resets "
            "configuration is the defect this whole section exists to "
            "prevent")
        self.assertRegex(
            self.table_of(
                Path(self.config_file).read_text(encoding="utf-8"), name) or "",
            r"(?m)^\s*value\s*=\s*%d\s*$" % (chosen,))


if __name__ == "__main__":
    unittest.main()
