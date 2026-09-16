"""CR-CRU-138 §S1/§S2/§S3 -- one suite that INSTALLS and then RESOLVES.

A production install of 0.2.0 resolves NO operator configuration at all. Three
paths exist and no two agree: the installer writes `<target-dir>/crucible.toml`,
the clients read `<project dir>/crucible.toml` falling back to `os.getcwd()`,
and the server reads `dirname(store)/crucible.toml` which nothing ever writes.
Each half was tested in isolation and the pair was never tested together, which
is why a two-line path mismatch survived a 4400-test suite and four CI runs.
That missing coverage IS the defect, so this file is written against the seam
the two halves meet on: the REAL installer runs into a sandbox, and then a
client loaded from the copy that installer laid down resolves a limit.

── What each class asserts ────────────────────────────────────────

`AnInstalledClientResolvesTheInstalledConfigurationTest` (§S1) -- the CHAIN, in
order: the bound project dir's file WINS; with nothing bound the INSTALL dir's
file is resolved, the install root being derived from the running module's own
location (`<install dir>/clients/_crucible_axi.py` -> `<install dir>`); with
neither, the shipped package data supplies every recommendation and a real verb
still succeeds. Two further contracts belong to the chain rather than to any one
step: the answer does not depend on the directory the process happens to stand
in (`os.getcwd()` leaves configuration-path resolution entirely), and the
unreadable-configuration warning names EVERY candidate in precedence order.

`TheInstallerLaysDownTheServersOperatorFileTest` (§S2) -- the server's operator
file, laid down beside the server's own database at `store_dir()/crucible.toml`:
it exists, parses, is commented, carries EXACTLY the three server limits and
none of the client three; `crucible-clients.json` declares it under its own key
distinct from the client `config` and both declared paths exist; an
operator-EDITED copy survives a reinstall and survives a purge while an
untouched byte-identical one is removed under purge and only under purge; and an
install that provisioned no server SKIPS the stage with a STATED REASON in the
install output -- a silent skip is how the first hole stayed invisible.

`TheSandboxHoldsTest` / `AFreshContainersEnvironmentTest` (§S3) -- the isolation
contract is part of the specification rather than a detail of how this file is
written, because the suite drives an installer that really writes files. Both
drive the whole lifecycle (install -> resolve -> purge) and carry the L2 escape
detector every case in this file inherits.

`TheKernelIsolationScriptIsDocumentedAndCannotDriftTest` (§S3 L3) -- the
opt-in third layer: a `bwrap` script an operator RUNS, documented in the RUNBOOK
beside the suite it wraps, with the documented command and the script's own
contents asserted to be ONE datum (CR-CRU-134's derivation rule) -- and NOT a
CI job, because bubblewrap is not guaranteed on `ubuntu-latest` and a gate that
cannot run everywhere is a gate that gets bypassed.

HOW EACH FAILS IF THE CODE DOES NOTHING:

  §S1  `project_config_path()` (clients/_crucible_axi.py:154-158) is ONE path,
        `<bound project dir or os.getcwd()>/crucible.toml`. With no project dir
        bound it answers with the process cwd, so:
         * the install-dir resolution tests fail resolving the shipped
           RECOMMENDATION instead of the value the laid-down file sets;
         * the two-cwd test fails because the two answers DIFFER -- which is
           the reported `/home/antonyj/crucible.toml` in one assertion;
         * the `os.getcwd()` test fails because resolution really does call it;
         * the warning test fails naming exactly ONE path.
        The no-configuration-anywhere pair fails differently and deliberately:
        an installed client's package-data candidates are
        `<install>/clients/crucible.toml` (which the fleet stage does not copy)
        and `<install>/crucible.toml` (the operator's own file), so deleting
        the operator's file leaves an installed client with NO declarations at
        all and `shipped_limits()` raises. CR-131's degradation rule -- every
        limit at its recommendation, the verb still succeeding -- is therefore
        not reachable from an installed deployment today, which is the same
        defect seen from its third side.
  §S2  nothing ever writes `store_dir()/crucible.toml`; every assertion in that
        class fails at `require_server_config`, naming the directory and what
        it actually holds. The skip-with-a-reason test fails because the
        `[manifest]` stage row carries no `server_config` report at all --
        neither a path nor a reason -- so an operator whose board lives on
        another host is told nothing about the file that was not written.
  §S3  both lifecycle tests fail on their §S1 resolution assertion; the escape
        detector is fixture-level and passes today (nothing escapes), which is
        what it is for. The L3 test fails because docs/RUNBOOK.md documents no
        sandboxing script for this suite and no such script exists.

The cross-runtime half of §S2 -- that the server READS `dirname(store)/
crucible.toml` -- is already asserted, on the server's own runtime, by
tests/server-limits-are-configuration.test.ts:848-852 (`serverConfigPath()` is
`path.join(dirname($CRUCIBLE_DB), "crucible.toml")`) and :887-888 (a value
written into that file is the value `resolveLimit` returns). This file therefore
asserts the WRITE side against the same rule -- `install.store_dir()` joined
with the config filename, which is `src/limits.ts:158-159` computed in python --
rather than spawning bun to re-prove what a bun suite already proves.

Safety -- the L1 sandbox and the L2 escape detector (§S3):

One `tempfile.mkdtemp` root per test, removed by `addCleanup`, holding the
scratch `$HOME`, `$XDG_DATA_HOME`, `$XDG_CONFIG_HOME`, `$BUN_INSTALL`,
`$CRUCIBLE_DB`, the `--target-dir` and every working directory a test stands in.
All of them are pinned through `mock.patch.dict` for the WHOLE test, so they
restore even when an assertion raises. `CRUCIBLE_NO_SERVICE=1` and
`CRUCIBLE_NO_BUN_BOOTSTRAP=1`; the `[server]` stage (which really runs `bun add
-g`) and `[unit]` (which really drives `systemctl --user enable --now`) are
stubbed in BOTH directions. `[fleet]`, `[manifest]`, `[config]` and `[store]`
run for REAL -- that is the point. No `uv tool install`, no `npm publish`, no
`pip install`, nothing written inside the repo, no board contacted.

Four hazards are specific to THIS suite and are handled here rather than
inherited: (1) cwd is process-global, so the saved directory is restored in
cleanup BEFORE the temp root is removed -- a process whose cwd is a deleted
inode makes every later `os.getcwd()` in the same worker raise; (2)
`_PROJECT_DIR` is a module global, so the client module is loaded FRESH per test
and `bind_project_dir(None)` runs in teardown; (3) the install root is derived
from the module's own location, so the client is loaded from the COPY the
installer laid down inside the sandbox -- loading the checkout's copy would
resolve the repo root and pass for exactly the wrong reason; (4) the checkout
must not be able to answer either, and `_assert_the_checkout_did_not_answer`
asserts that no path under this checkout -- least of all the repo root's own
`crucible.toml`, which is gitignored OPERATOR state that really does exist on a
developer's machine and is one of the four locations L2 watches -- is the file
the sandboxed client read.

L2, the escape detector: L1 protects the machine only from code that plays by
the rules, so every case snapshots the operator's REAL `~/.crucible`,
`~/.local/share/crucible`, `~/.config/systemd/user` and this checkout's own
`crucible.toml` from the AMBIENT environment BEFORE any patching, and asserts
them unchanged in teardown. It is fixture-level: no marker, no skip, and it runs
on a CI runner exactly as it runs on a workstation. The one documented
exclusion is the live board's own `crucible.db` and its WAL/backup companions in
the store directory: a development workstation writes them continuously, so
their size and mtime are evidence of nothing. Every other entry there --
including the `crucible.toml` §S2 lays down -- is watched exactly.

L4 is REFUSED: no `pyfakefs`, no monkeypatched `open`. The defect being fixed is
that the write path and the read path never met on a real filesystem, and a fake
one reintroduces precisely that blind spot.

Invocation:
    python3 -m unittest tests.client.test_an_installed_deployment_resolves_its_configuration -v
What CI runs (and what must list these ids):
    python3 -m unittest discover -s tests/client -t .
Fallback:
    python3 tests/client/test_an_installed_deployment_resolves_its_configuration.py
"""

import contextlib
import importlib
import importlib.util
import io
import itertools
import json
import os
import re
import shutil
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_NAME = "crucible.toml"

#: The distribution's own data, in the checkout: the bytes the installer lays
#: down and the table the fleet falls back to are ONE datum (CR-CRU-131 §S1c),
#: so every expectation below is READ BACK off it rather than written out.
SHIPPED_CLIENT_DATA = REPO_ROOT / "clients" / CONFIG_NAME
SHIPPED_SERVER_DATA = REPO_ROOT / "src" / CONFIG_NAME

#: §S4 -- the manifest key the fleet's OWN shipped data is declared under.
#: FLEET content, deliberately NOT the operator's `config`: one is package
#: data replaced on every upgrade, the other is an operator's file that
#: survives a purge once they have edited it, and automation that cannot tell
#: them apart will eventually edit the wrong one.
FLEET_CONFIG_MANIFEST_KEY = "shipped_config"

CLIENT_LIMITS = ("truncate_field_chars", "error_detail_chars", "roadmap_list_rows")
SERVER_LIMITS = ("run_abandon_ms", "project_inactive_ms", "retention")

#: `$HOME`, `$XDG_DATA_HOME`, `$XDG_CONFIG_HOME` and `$BUN_INSTALL` -- the four
#: the sandbox pins, and the four a fresh container has NONE of.
SANDBOXED_ENV = ("HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "BUN_INSTALL")

#: Written by the LIVE board on a development workstation, continuously. See
#: the Safety paragraph: excluded by NAME rather than by widening the window.
_LIVE_STORE_ARTIFACT = re.compile(r"^crucible(\.db|-pre-)")

_COUNTER = itertools.count()


def _load_module_by_path(path, cache_key):
    """The fleet's own `_axi()`/`_toon()` loader idiom, as every sibling test in
    this directory uses it. A FRESH module object per call, which is what keeps
    one test's `bind_project_dir` out of the next one's state."""
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Drive a client's REAL entry point and capture both streams (the sibling
    convention, tests/client/test_client_limits_resolve_from_configuration.py:195)."""
    stdout = io.StringIO()
    stderr = io.StringIO()
    with mock.patch.object(sys, "argv", ["bun-crucible.py"] + argv):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as exc:
                code = 0 if exc.code is None else (
                    exc.code if isinstance(exc.code, int) else 1)
    return code, stdout.getvalue(), stderr.getvalue()


def _stub_stage(name):
    """A stage runner that does nothing and reports a converged row -- the
    shape `run_install`/`run_uninstall` expect from a real one."""

    def _runner(target_dir, _switch=False, **_kwargs):
        return {"path": os.path.join(target_dir, name), "converged": True}

    return _runner


def _limits_in(path):
    """The `[limits.*]` tables of a real file on disk, parsed with stdlib
    `tomllib` -- a fact about the FILE rather than about a string a test just
    wrote."""
    with open(path, "rb") as handle:
        parsed = tomllib.load(handle)
    tables = parsed.get("limits")
    return tables if isinstance(tables, dict) else {}


def _legal_values(table, count):
    """`count` DISTINCT legal settings for a limit, none of them its
    `recommended` -- so 'the file decided this' is distinguishable from 'the
    build recommended it', and one file's answer from another's.

    Derived from the declaration's own `min`/`max`/`recommended`; nothing here
    spells a limit's number, which is the rule the whole CR-CRU-131 suite is
    written under (PRD §4.13).
    """
    low, high, recommended = table["min"], table["max"], table["recommended"]
    candidates = []
    for value in (recommended + 1, recommended - 1, recommended + 2,
                  recommended - 2, low, high):
        if low <= value <= high and value != recommended and value not in candidates:
            candidates.append(value)
    assert len(candidates) >= count, (
        "the declaration %r admits fewer than %d legal non-recommended values"
        % (table, count))
    return candidates[:count]


def _set_value(path, name, value):
    """Make an operator's edit -- a `value = …` beside the four documented
    fields, which is the ONE way the shipped file tells its reader to configure
    a limit -- and PROVE it landed by parsing the file back off disk.

    An existing `value` is REPLACED rather than doubled, so a file copied from
    one already carrying a setting stays valid TOML: a copy is how a project's
    file and the install's are made to disagree below.
    """
    text = Path(path).read_text(encoding="utf-8")
    table = re.search(r"(?ms)^\[limits\.%s\].*?(?=^\[|\Z)" % (re.escape(name),),
                      text)
    assert table is not None, "no `[limits.%s]` table to edit in %s" % (name, path)
    block = table.group(0)
    if re.search(r"(?m)^\s*value\s*=", block):
        edited_block = re.sub(r"(?m)^\s*value\s*=.*$", "value = %d" % (value,),
                              block, count=1)
    else:
        edited_block = re.sub(r"(max\s*=\s*\d[\d_]*)",
                              "\\g<1>\nvalue = %d" % (value,), block, count=1)
    assert edited_block != block, "nothing to edit in `[limits.%s]`" % (name,)
    Path(path).write_text(
        text[:table.start()] + edited_block + text[table.end():],
        encoding="utf-8")
    assert _limits_in(path)[name]["value"] == value, (
        "the edit did not land in %s" % (path,))
    return value


def _overwrite_field(path, name, field, value):
    """Overwrite one of the DOCUMENTED fields of a limit's table IN PLACE --
    the edit the shipped file's own header tells an operator never to make
    ("Do NOT edit `description`, `recommended`, `min` or `max`").

    It is written here precisely because §S4 is about a file that today is
    BOTH the operator's and the distribution's: an operator who makes this
    edit is rewriting the build's package data, and the only way to assert
    they cannot is to have one make it. As with `_set_value`, the result is
    proved by parsing the file back off disk.
    """
    text = Path(path).read_text(encoding="utf-8")
    table = re.search(r"(?ms)^\[limits\.%s\].*?(?=^\[|\Z)" % (re.escape(name),),
                      text)
    assert table is not None, "no `[limits.%s]` table to edit in %s" % (name, path)
    block = table.group(0)
    edited_block = re.sub(r"(?m)^(\s*%s\s*=).*$" % (re.escape(field),),
                          "\\g<1> %d" % (value,), block, count=1)
    assert edited_block != block, (
        "no `%s = …` to overwrite in `[limits.%s]` of %s" % (field, name, path))
    Path(path).write_text(
        text[:table.start()] + edited_block + text[table.end():],
        encoding="utf-8")
    assert _limits_in(path)[name][field] == value, (
        "the overwrite did not land in %s" % (path,))
    return value


# ===========================================================================
# L2 -- the escape detector (§S3)
# ===========================================================================

def _stat_tuple(path):
    """`(exists, size, mtime)` for one path, the triple §S3 names."""
    try:
        stat = os.stat(path)
    except OSError:
        return (False, None, None)
    return (True, stat.st_size, stat.st_mtime_ns)


def _watch_tree(path):
    """Every file under `path`, by `(exists, size, mtime)`. A recursive probe,
    because the escape that matters most -- OVERWRITING an operator's
    `~/.crucible/crucible.toml` -- changes no directory's own mtime."""
    snapshot = {"": _stat_tuple(path)}
    for directory, _dirnames, filenames in os.walk(path):
        for name in filenames:
            member = os.path.join(directory, name)
            snapshot[os.path.relpath(member, path)] = _stat_tuple(member)
    return snapshot


def _watch_store(path):
    """The store directory, minus the live board's own database. Its entry NAMES
    are watched (an escape that creates a file is caught) and so is every entry
    that is not `crucible.db*`/`crucible-pre-*` -- which is exactly the
    `crucible.toml` §S2 lays down."""
    snapshot = {"": _stat_tuple(path)}
    if not os.path.isdir(path):
        return snapshot
    names = sorted(os.listdir(path))
    snapshot["<entries>"] = names
    for name in names:
        if not _LIVE_STORE_ARTIFACT.match(name):
            snapshot[name] = _stat_tuple(os.path.join(path, name))
    return snapshot


def _watch_units(path):
    """The user's systemd unit directory: its entry names, plus the state of
    every unit whose name is ours."""
    snapshot = {"": _stat_tuple(path)}
    if not os.path.isdir(path):
        return snapshot
    names = sorted(os.listdir(path))
    snapshot["<entries>"] = names
    for name in names:
        if "crucible" in name:
            snapshot[name] = _stat_tuple(os.path.join(path, name))
    return snapshot


def _watch_file(path):
    return {"": _stat_tuple(path)}


def _real_locations():
    """The four REAL locations §S3 names, resolved from the AMBIENT environment
    -- called before any patching, so a hardcoded path or an `expanduser`
    evaluated too early is measured against where the operator's files actually
    are rather than against the sandbox."""
    home = os.environ.get("HOME") or os.path.expanduser("~")
    return (
        ("~/.crucible", os.path.join(home, ".crucible"), _watch_tree),
        ("~/.local/share/crucible",
         os.path.join(home, ".local", "share", "crucible"), _watch_store),
        ("~/.config/systemd/user",
         os.path.join(home, ".config", "systemd", "user"), _watch_units),
        ("<checkout>/" + CONFIG_NAME, str(REPO_ROOT / CONFIG_NAME), _watch_file),
    )


def _escape_snapshot(locations):
    return {label: probe(path) for label, path, probe in locations}


def _watch_verdict(before, now):
    """What one watched location actually WITNESSED -- `CHANGED`, `unchanged`,
    or `absent throughout`.

    The third is not the second, and a failure report that renders them the
    same way invites a reader to credit a watch that never had anything to
    watch. On this workstation `~/.local/share/crucible` does not exist at all
    (the board runs from `<repo>/data/crucible.db`), so that probe is a stable
    non-existence here and proves nothing LOCALLY -- while proving a real
    negative on a machine where the store does exist. Saying which is which
    costs one comparison and stops the detector from being read as stronger
    evidence than it is.
    """
    if before != now:
        return "CHANGED"
    if not before[""][0]:
        return "absent throughout (nothing to watch on this machine)"
    return "unchanged"


# ===========================================================================
# L1 -- the process-scoped sandbox (§S3), inherited by every case below
# ===========================================================================

class _InstalledDeploymentCase(unittest.TestCase):
    """One tmp root holding the scratch `$HOME`, `$XDG_DATA_HOME`,
    `$XDG_CONFIG_HOME`, `$BUN_INSTALL`, `$CRUCIBLE_DB`, the `--target-dir`, a
    project directory and two unrelated working directories. `[server]` and
    `[unit]` are ALWAYS stubbed, in both directions; `[fleet]`, `[manifest]`,
    `[config]` and `[store]` are REAL."""

    PROJECT_KEY = "019f6228-63a7-7000-b3d4-000000000138"

    #: A fresh container's shape: the four sandboxed variables are ABSENT from
    #: the ambient environment rather than merely carrying a developer's values.
    AMBIENT_UNSET = False

    def setUp(self):
        # L2 FIRST, from the ambient environment, and its assertion registered
        # FIRST so `addCleanup`'s LIFO order runs it LAST.
        self.real_locations = _real_locations()
        self.escape_before = _escape_snapshot(self.real_locations)
        self.addCleanup(self.assert_nothing_escaped)

        environment = mock.patch.dict(os.environ, {}, clear=False)
        environment.start()
        self.addCleanup(environment.stop)
        if self.AMBIENT_UNSET:
            for name in SANDBOXED_ENV:
                os.environ.pop(name, None)

        self.root = tempfile.mkdtemp(prefix="installed-deployment-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        # HAZARD 1 -- registered AFTER the removal so it runs BEFORE it: a
        # process whose cwd is a deleted inode makes every later `os.getcwd()`
        # in this worker raise.
        self.addCleanup(os.chdir, os.getcwd())

        self.fake_home = os.path.join(self.root, "home")
        self.xdg_data = os.path.join(self.root, "xdg-data")
        self.xdg_config = os.path.join(self.root, "xdg-config")
        self.bun_root = os.path.join(self.root, "bun")
        self.target_dir = os.path.join(self.root, "target")
        self.project_dir = os.path.join(self.root, "project")
        self.elsewhere = os.path.join(self.root, "elsewhere")
        self.elsewhere_too = os.path.join(self.root, "elsewhere-too")
        for directory in (self.fake_home, self.xdg_data, self.xdg_config,
                          self.bun_root, self.project_dir, self.elsewhere,
                          self.elsewhere_too):
            os.makedirs(directory, exist_ok=True)
        Path(self.project_dir, ".env").write_text(
            "CRUCIBLE_PROJECT_KEY=%s\n" % (self.PROJECT_KEY,), encoding="utf-8")

        os.environ.update({
            "HOME": self.fake_home,
            "XDG_DATA_HOME": self.xdg_data,
            "XDG_CONFIG_HOME": self.xdg_config,
            "BUN_INSTALL": self.bun_root,
            "CRUCIBLE_NO_SERVICE": "1",
            "CRUCIBLE_NO_BUN_BOOTSTRAP": "1",
        })
        os.environ.pop("BUN_CRUCIBLE_PROJECT_DIR", None)

        self.install = importlib.import_module("crucible_axi.install")
        self.manifest = importlib.import_module("crucible_axi.manifest")

        # `$CRUCIBLE_DB` beside the store the installer computes, which is the
        # SAME rule `src/limits.ts` resolves the server's config path by.
        self.store_dir = self.install.store_dir()
        os.environ["CRUCIBLE_DB"] = os.path.join(self.store_dir, "crucible.db")

        self.install_config = os.path.join(self.target_dir, CONFIG_NAME)
        self.project_config = os.path.join(self.project_dir, CONFIG_NAME)
        self.server_config = os.path.join(self.store_dir, CONFIG_NAME)
        self.manifest_file = os.path.join(
            self.target_dir, self.manifest.MANIFEST_FILENAME)
        self.fleet_dir = os.path.join(self.target_dir, self.install.FLEET_DIRNAME)
        self.installed_axi = os.path.join(self.fleet_dir, "_crucible_axi.py")
        self.installed_client = os.path.join(self.fleet_dir, "bun-crucible.py")
        # §S4 -- the distribution's OWN data, beside the module that reads it:
        # the first of `_SHIPPED_DATA_CANDIDATES`, which no install lays down
        # today, which is why the second (the operator's file) answers.
        self.fleet_config = os.path.join(self.fleet_dir, CONFIG_NAME)

    # -- L2 ----------------------------------------------------------------

    def assert_nothing_escaped(self):
        after = _escape_snapshot(self.real_locations)
        # Every watch's own verdict, reported alongside the failure: a location
        # that was ABSENT THROUGHOUT witnessed nothing and must not be read as
        # a location that was watched and stayed put.
        verdicts = {label: _watch_verdict(self.escape_before[label], after[label])
                    for label, _path, _probe in self.real_locations}
        for label, _path, _probe in self.real_locations:
            before, now = self.escape_before[label], after[label]
            if before == now:
                continue
            moved = sorted(
                set(before) ^ set(now)
                | {key for key in set(before) & set(now)
                   if before[key] != now[key]})
            self.fail(
                "L2 escape detector: %s CHANGED while this test ran. The"
                " sandbox pins $HOME, $XDG_DATA_HOME, $XDG_CONFIG_HOME,"
                " $BUN_INSTALL and $CRUCIBLE_DB inside %s, so a write that"
                " landed here came from a hardcoded path, an `expanduser`"
                " evaluated before the patch, or a subprocess handed a stale"
                " environment -- and it landed on the OPERATOR's machine."
                " Changed: %r. Every watch this run: %r"
                % (label, self.root, moved, verdicts))

    # -- driving the REAL entry points --------------------------------------

    def _stubs(self, table):
        return {name: _stub_stage(name)
                for name in ("server", "unit") if name in table}

    def install_once(self, force=False):
        with mock.patch.dict(self.install.DEFAULT_STAGE_RUNNERS,
                             self._stubs(self.install.DEFAULT_STAGE_RUNNERS)):
            ok, stages, warnings = self.install.run_install(
                self.target_dir, force=force, no_service=True,
                no_bun_bootstrap=True)
        self.assertTrue(
            ok, "the install must succeed before anything it wrote can be "
                "asserted; warnings=%r stages=%r" % (warnings, stages))
        return stages

    def uninstall_once(self, purge=True):
        with mock.patch.dict(
                self.install.DEFAULT_UNINSTALL_STAGE_RUNNERS,
                self._stubs(self.install.DEFAULT_UNINSTALL_STAGE_RUNNERS)):
            ok, stages, warnings = self.install.run_uninstall(
                self.target_dir, purge=purge)
        self.assertTrue(
            ok, "the uninstall must run to completion; warnings=%r stages=%r"
               % (warnings, stages))
        return stages

    def provision_server(self):
        """Make the server PROVISIONED LOCALLY, as the installer's own probe
        answers that question (`_provisioned_server_package_dir` and
        `_provisioned_server_bin_path`, the pair `_server_uninstall_stage`
        already probes with) -- both resolved from the sandboxed `$BUN_INSTALL`.

        The package carries `src/crucible.toml`, which is where
        `@anthill-tec/crucible-server` ships its limit declarations
        (package.json `files`) and the source §S2 lays the operator's copy down
        from. `bun add -g` is never run: the stage that would run it is stubbed,
        and what §S2 turns on is whether the package IS there.
        """
        package = self.install._provisioned_server_package_dir()
        os.makedirs(os.path.join(package, "src"), exist_ok=True)
        shutil.copyfile(SHIPPED_SERVER_DATA,
                        os.path.join(package, "src", CONFIG_NAME))
        Path(package, "package.json").write_text(
            json.dumps({"name": self.install.SERVER_NPM_PACKAGE,
                        "version": "0.0.0-sandbox"}) + "\n", encoding="utf-8")
        binary = self.install._provisioned_server_bin_path()
        os.makedirs(os.path.dirname(binary), exist_ok=True)
        Path(binary).write_text("#!/usr/bin/env node\n", encoding="utf-8")
        os.chmod(binary, 0o755)
        self.assertTrue(
            os.path.isdir(package) and os.path.lexists(binary),
            "fixture sanity: the installer's own provisioning probe must see a "
            "server at %s" % (package,))
        return package

    # -- observations -------------------------------------------------------

    def require_install_config(self):
        self.assertTrue(
            os.path.isfile(self.install_config),
            "fixture sanity: the [manifest] stage lays the operator-editable "
            "`%s` down at the target dir; `%s` holds %r"
            % (CONFIG_NAME, self.target_dir,
               sorted(os.listdir(self.target_dir))
               if os.path.isdir(self.target_dir) else None))
        return self.install_config

    def require_server_config(self):
        self.assertTrue(
            os.path.isfile(self.server_config),
            "§S2: an install that provisioned the server must lay "
            "the server's operator-editable `%s` down BESIDE ITS DATABASE, at "
            "%s -- the path `src/limits.ts:158-159` computes and the only file "
            "the server will ever read. `install.store_dir()` already knows "
            "that directory; nothing writes into it. It holds %r"
            % (CONFIG_NAME, self.server_config,
               sorted(os.listdir(self.store_dir))
               if os.path.isdir(self.store_dir) else None))
        return self.server_config

    def axi_from_the_install(self):
        """The client the installer LAID DOWN, loaded from inside the sandbox.

        HAZARD 3: §S1 derives the install root from the running module's own
        location, so a module loaded out of the checkout would resolve the
        checkout's root and this suite would pass for the wrong reason -- the
        exact failure mode that let the defect ship. HAZARD 2: a fresh module
        object per call, with `bind_project_dir(None)` registered for teardown,
        because `_PROJECT_DIR` is a module global.
        """
        self.assertTrue(
            os.path.isfile(self.installed_axi),
            "fixture sanity: the [fleet] stage must have laid the shared module "
            "down at %s" % (self.installed_axi,))
        module = _load_module_by_path(
            self.installed_axi, "installed_axi_%d" % next(_COUNTER))
        self.assertTrue(
            os.path.realpath(module.__file__).startswith(
                os.path.realpath(self.root) + os.sep),
            "the module under test must be the INSTALLED copy inside the "
            "sandbox, not the checkout's: %r" % (module.__file__,))
        module.bind_project_dir(None)
        self.addCleanup(module.bind_project_dir, None)
        return module

    def bun_client_from_the_install(self):
        self.assertTrue(
            os.path.isfile(self.installed_client),
            "fixture sanity: the [fleet] stage must have laid the client down "
            "at %s" % (self.installed_client,))
        return _load_module_by_path(
            self.installed_client, "installed_bun_client_%d" % next(_COUNTER))

    def assert_the_checkout_did_not_answer(self, module):
        """HAZARD 4 -- the checkout must not be reachable from the sandboxed
        client either.

        Stated as 'no path under this checkout is one the client read' rather
        than 'the checkout carries no root `crucible.toml`': that file is
        gitignored OPERATOR state which really does exist on a developer's
        machine, and §S3's own L2 layer watches it as one of the four REAL
        locations -- it is not this suite's to delete. What matters is the
        property both readings are after: the answer came from the sandbox.
        """
        checkout = os.path.realpath(REPO_ROOT) + os.sep
        for line in module.limit_disclosures():
            for token in re.findall(r"(/[^\s,]+%s)" % (re.escape(CONFIG_NAME),),
                                    line):
                self.assertFalse(
                    os.path.realpath(token).startswith(checkout),
                    "the installed client named a path inside this CHECKOUT "
                    "(%s) -- an installed deployment must resolve its "
                    "configuration from the install, never from a developer's "
                    "working copy: %r" % (token, line))


# ===========================================================================
# §S1 -- a client resolves the INSTALLED configuration when it is not inside
#        a project, and the chain decides in order
# ===========================================================================

class AnInstalledClientResolvesTheInstalledConfigurationTest(_InstalledDeploymentCase):

    LIMIT = "truncate_field_chars"

    def test_a_client_outside_any_project_resolves_the_install_dirs_own_configuration(self):
        """The reported defect, end to end: an operator edits the file the
        installer laid down and nothing changes, because no reader consults it."""
        self.install_once()
        declaration = _limits_in(self.require_install_config())[self.LIMIT]
        (configured,) = _legal_values(declaration, 1)
        _set_value(self.install_config, self.LIMIT, configured)

        os.chdir(self.elsewhere)
        axi = self.axi_from_the_install()

        self.assertEqual(
            configured, axi.resolve_limit(self.LIMIT),
            "§S1: with NO project dir bound and the cwd outside the "
            "install, a client must resolve `<install dir>/%s` -- the file the "
            "installer laid down at %s and the manifest already declares. It "
            "resolved the build's recommendation (%d) instead, which is an "
            "operator editing a knob that does nothing."
            % (CONFIG_NAME, self.install_config, declaration["recommended"]))
        self.assert_the_checkout_did_not_answer(axi)

    def test_a_projects_own_configuration_wins_and_the_install_is_what_it_falls_through_to(self):
        """The chain is an ORDER over READABLE files, and both halves of that
        are asserted here: a project's own file WINS over the installed one
        (what §S1b chose, kept FIRST because a multi-project machine needs the
        project it is working in to decide), and a bound project that declares
        NOTHING falls through to the install rather than to the build's
        recommendation."""
        self.install_once()
        declaration = _limits_in(self.require_install_config())[self.LIMIT]
        installed, project = _legal_values(declaration, 2)
        _set_value(self.install_config, self.LIMIT, installed)
        shutil.copyfile(self.install_config, self.project_config)
        _set_value(self.project_config, self.LIMIT, project)
        self.assertNotEqual(installed, project)

        os.chdir(self.elsewhere)
        axi = self.axi_from_the_install()
        axi.bind_project_dir(self.project_dir)

        self.assertEqual(
            project, axi.resolve_limit(self.LIMIT),
            "the PROJECT's own file must win over the installed one when both "
            "set the same limit: a machine carrying several projects needs the "
            "one it is working in to decide")
        # NEGATIVE -- the installed file really did set a different legal value,
        # so 'the project won' is not 'the installed file was never read'.
        self.assertEqual(installed,
                         _limits_in(self.install_config)[self.LIMIT]["value"])

        # …and the SECOND step of the chain, on the SAME still-bound client:
        # with the project's file gone, the install's file answers. That is
        # what makes this an ORDER rather than a single candidate that happened
        # to exist -- and the file is read at the POINT OF USE, so no reload is
        # needed for the client to see the removal.
        os.remove(self.project_config)
        self.assertEqual(
            installed, axi.resolve_limit(self.LIMIT),
            "a project that declares nothing must fall through to the "
            "INSTALLED configuration (%s), not past it to the build's "
            "recommendation (%d)"
            % (self.install_config, declaration["recommended"]))

    def test_with_no_configuration_file_anywhere_every_limit_runs_at_its_recommendation(self):
        """CR-131's degradation rule, preserved exactly -- and reachable from an
        INSTALLED deployment, which today it is not.

        An installed client's package-data candidates are
        `<install>/clients/crucible.toml` (which [fleet] does not copy) and
        `<install>/crucible.toml` (the operator's OWN file), so removing the
        operator's file leaves an installed client with no declarations at all
        and `shipped_limits()` raises. The recommendations expected here are
        read off the distribution's own data in the checkout -- the same bytes
        the installer lays down -- so nothing is written out.
        """
        self.install_once()
        self.require_install_config()
        os.remove(self.install_config)
        self.assertFalse(os.path.exists(self.project_config))

        os.chdir(self.elsewhere)
        axi = self.axi_from_the_install()

        shipped = _limits_in(SHIPPED_CLIENT_DATA)
        for name in CLIENT_LIMITS:
            self.assertEqual(
                shipped[name]["recommended"], axi.resolve_limit(name),
                "with no `%s` anywhere, `%s` must run at the value the build "
                "RECOMMENDS: the shipped package data is the last resort and "
                "an installed deployment must carry it, or a missing operator "
                "file takes every client verb down with it" % (CONFIG_NAME, name))

    def test_a_real_verb_still_succeeds_and_discloses_every_candidate_it_tried(self):
        """Driven through the REAL entry point -- `bun-crucible.py status` with
        only the wire mocked -- because a limit that resolved in isolation but
        took a verb down on the client's own boot path would be green here and
        broken in production, and because a warning composed by a function with
        no callers would satisfy the unit assertion above just as happily.

        This is the reported bootstrap, reproduced: the envelope really did
        carry `limit-configuration, "no readable configuration at
        /home/antonyj/crucible.toml"`, naming a directory the operator merely
        happened to be standing in and no other.
        """
        self.install_once()
        self.require_install_config()
        os.remove(self.install_config)

        os.chdir(self.elsewhere)
        client = self.bun_client_from_the_install()
        plans = {"ok": True, "plans": [
            {"planId": "plan-1", "cr": "CR-SHIPPED-001", "wave": "6",
             "status": "open", "cycles": []},
        ]}
        with mock.patch.object(client, "_get", return_value=plans):
            code, out, err = _run_main(
                client, ["status", "--project-dir", self.project_dir])

        self.assertEqual(
            0, code,
            "a client must still format its output on a machine that has no "
            "`%s` anywhere; stdout=%r stderr=%r" % (CONFIG_NAME, out, err))
        self.assertIn("verb: status", out)

        toon = _load_module_by_path(
            os.path.join(self.target_dir, self.install.FLEET_DIRNAME, "toon.py"),
            "installed_toon_%d" % next(_COUNTER))
        envelope = toon.decode(out)
        self.assertIn("axi", envelope, "the verb emitted no envelope: %r" % (out,))
        axi = self.axi_from_the_install()
        reported = [warning["detail"]
                    for warning in (envelope["axi"].get("warnings") or [])
                    if warning.get("code") == axi.LIMIT_CONFIGURATION_CODE]
        self.assertEqual(
            1, len(reported),
            "a run with no readable configuration owes exactly one "
            "unreadable-configuration disclosure on its envelope: %r"
            % (envelope["axi"].get("warnings"),))
        for candidate in (self.project_config, self.install_config):
            self.assertIn(
                candidate, reported[0],
                "the envelope of a REAL run must name every candidate the "
                "client tried, so the operator of the reported bootstrap "
                "learns that `%s` is the file to create: %r"
                % (self.install_config, reported[0]))

    def test_two_different_working_directories_resolve_the_same_configuration(self):
        """The regression for the reported `/home/antonyj/crucible.toml`: the
        bootstrap ran from `$HOME`, so the client looked for its configuration
        in `$HOME`. With no project dir bound, configuration is a function of
        the INSTALL and never of the directory an operator happened to stand in.

        A decoy file is planted in ONE of the two directories, so 'the answers
        agree' cannot be satisfied by a resolver that reads nothing at all.
        """
        self.install_once()
        declaration = _limits_in(self.require_install_config())[self.LIMIT]
        installed, decoy = _legal_values(declaration, 2)
        _set_value(self.install_config, self.LIMIT, installed)
        shutil.copyfile(self.install_config,
                        os.path.join(self.elsewhere, CONFIG_NAME))
        _set_value(os.path.join(self.elsewhere, CONFIG_NAME), self.LIMIT, decoy)

        os.chdir(self.elsewhere)
        here = self.axi_from_the_install().resolve_limit(self.LIMIT)
        os.chdir(self.elsewhere_too)
        there = self.axi_from_the_install().resolve_limit(self.LIMIT)

        self.assertEqual(
            here, there,
            "the same install resolved `%s` as %d from %s and %d from %s. A "
            "client's configuration must not depend on the directory it was "
            "RUN from" % (self.LIMIT, here, self.elsewhere, there,
                          self.elsewhere_too))
        self.assertEqual(
            installed, here,
            "both answers must be the INSTALL's, not the cwd's decoy (%d)"
            % (decoy,))

    def test_configuration_path_resolution_never_calls_os_getcwd(self):
        """§S1 removes the `os.getcwd()` fallback, and the assertion is made on
        the CALL rather than on the source text: `os.getcwd` is replaced by one
        that raises for the duration of a resolution, so a resolver that still
        consults the process working directory cannot answer at all."""
        self.install_once()
        declaration = _limits_in(self.require_install_config())[self.LIMIT]
        (configured,) = _legal_values(declaration, 1)
        _set_value(self.install_config, self.LIMIT, configured)

        os.chdir(self.elsewhere)
        axi = self.axi_from_the_install()

        def _refuse():
            raise AssertionError(
                "§S1: `os.getcwd()` must no longer appear in "
                "configuration-path resolution -- it is the whole reason the "
                "reported path read `$HOME/crucible.toml`")

        with mock.patch.object(os, "getcwd", side_effect=_refuse):
            resolved = axi.resolve_limit(self.LIMIT)
            disclosures = axi.limit_disclosures()

        self.assertEqual(configured, resolved)
        self.assertEqual(
            [], disclosures,
            "the installed file is readable and sets a legal value, so nothing "
            "is owed: %r" % (disclosures,))

    def test_the_unreadable_configuration_warning_names_every_candidate_in_order(self):
        """'no readable configuration at X', on a machine carrying three
        candidate locations, tells an operator almost nothing -- and the X it
        named was the directory they happened to be standing in."""
        self.install_once()
        self.require_install_config()
        os.remove(self.install_config)
        self.assertFalse(os.path.exists(self.project_config))

        os.chdir(self.elsewhere)
        axi = self.axi_from_the_install()
        axi.bind_project_dir(self.project_dir)

        disclosures = axi.limit_disclosures()
        self.assertEqual(
            1, len(disclosures),
            "exactly one unreadable-configuration warning was owed: %r"
            % (disclosures,))
        detail = disclosures[0]
        self.assertIn(
            self.project_config, detail,
            "the warning must name the PROJECT candidate: %r" % (detail,))
        self.assertIn(
            self.install_config, detail,
            "the warning must name the INSTALL candidate too -- every path "
            "tried, or an operator cannot tell which file to create: %r"
            % (detail,))
        self.assertLess(
            detail.index(self.project_config), detail.index(self.install_config),
            "the candidates must be listed in PRECEDENCE order, project dir "
            "first: %r" % (detail,))
        # …and it stays a WARNING: a client with no file anywhere still runs.
        self.assertIn("WARNING", detail)


# ===========================================================================
# §S2 -- the installer lays the SERVER's operator file beside its database
# ===========================================================================

class TheInstallerLaysDownTheServersOperatorFileTest(_InstalledDeploymentCase):
    """`install.store_dir()` already computes the server's store directory by
    the server's own rule; nothing writes the operator's file into it, so the
    server runs its three limits on shipped recommendations with no file to
    edit.

    'Provisioned locally' is answered by the installer's OWN probe -- the
    package tree and bin link `_server_uninstall_stage` already probes for --
    rather than by `--no-service`: §S3 requires `CRUCIBLE_NO_SERVICE=1`
    throughout this sandbox, and §S2 requires the file to be laid down from the
    PROVISIONED npm package, so the presence of that package is the only
    reading under which both paragraphs of the spec hold at once.
    """

    EDIT_MARKER = "# edited by the operator, cycle 472\n"

    def install_provisioned(self):
        self.provision_server()
        return self.install_once()

    def edit_server_config(self):
        before = Path(self.server_config).read_bytes()
        declaration = _limits_in(self.server_config)[SERVER_LIMITS[0]]
        (chosen,) = _legal_values(declaration, 1)
        Path(self.server_config).write_text(
            self.EDIT_MARKER + Path(self.server_config).read_text(
                encoding="utf-8"), encoding="utf-8")
        _set_value(self.server_config, SERVER_LIMITS[0], chosen)
        self.assertNotEqual(
            Path(self.server_config).read_bytes(), before,
            "fixture sanity: the operator's edit must actually change the "
            "file, or 'it survived' proves nothing")
        return chosen

    def test_an_install_that_provisioned_the_server_leaves_a_parsable_config_beside_the_store(self):
        self.install_provisioned()
        path = self.require_server_config()

        tables = _limits_in(path)
        self.assertNotEqual(
            {}, tables,
            "the laid-down server file declares no `[limits.*]` table at all")
        text = Path(path).read_text(encoding="utf-8")
        comments = [line for line in text.splitlines()
                    if line.lstrip().startswith("#")]
        self.assertGreater(
            len(comments), 4,
            "the server's file must arrive COMMENTED, like the client's: the "
            "operator meets the documentation at the path they will edit. It "
            "carried %d comment line(s)" % (len(comments),))
        self.assertIn(
            "value", text,
            "the file must tell its reader HOW to configure a limit -- a "
            "`value = …` beside the four documented fields, never by "
            "overwriting `recommended` in place")

    def test_the_server_file_carries_exactly_the_three_server_limits(self):
        """OWNERSHIP, in the documentation as well as in the code: the two
        shipped templates are disjoint BY DESIGN (version skew across two
        independently installable packages), and a client limit in the server's
        file is a knob that provably does nothing where it sits."""
        self.install_provisioned()
        tables = _limits_in(self.require_server_config())

        self.assertEqual(
            sorted(SERVER_LIMITS), sorted(tables),
            "the file laid down beside the server's database must carry "
            "EXACTLY the three limits the SERVER enforces; it carries %r"
            % (sorted(tables),))
        for name in CLIENT_LIMITS:
            self.assertNotIn(
                name, tables,
                "`%s` is enforced by a CLIENT, which never reads this file"
                % (name,))

    def test_the_laid_down_path_is_the_one_the_server_computes_from_its_own_store_rule(self):
        """The cross-runtime claim, asserted on the WRITE side: the installer
        must write where `src/limits.ts:158-159` reads --
        `join(dirname(store), "crucible.toml")`, which `install.store_dir()`
        already mirrors (`resolveDbPath`, CR-CRU-043 rule 4).

        The READ side is already asserted on the server's own runtime by
        tests/server-limits-are-configuration.test.ts:848-852 (the path) and
        :887-888 (a value written into that file is the value `resolveLimit`
        returns), so bun is not spawned here to re-prove it.
        """
        self.install_provisioned()
        path = self.require_server_config()

        self.assertEqual(
            os.path.join(self.install.store_dir(), CONFIG_NAME), path)
        self.assertEqual(
            os.path.join(os.path.dirname(os.environ["CRUCIBLE_DB"]), CONFIG_NAME),
            path,
            "the server finds its configuration beside the DATABASE it "
            "resolves; a file written anywhere else is a file it will never "
            "read")

    def test_the_manifest_declares_both_configuration_files_and_both_paths_exist(self):
        self.install_provisioned()
        self.require_install_config()
        self.require_server_config()
        self.assertTrue(os.path.isfile(self.manifest_file))

        document = json.loads(
            Path(self.manifest_file).read_text(encoding="utf-8"))
        self.assertEqual(
            self.install_config, document.get("config"),
            "the CLIENT's configuration keeps its own key, unchanged: %r"
            % (document,))

        declaring = sorted(key for key, value in document.items()
                           if isinstance(value, str)
                           and value == self.server_config)
        self.assertEqual(
            1, len(declaring),
            "§S2: `%s` must declare the SERVER's configuration under its OWN "
            "key, distinct from the client `config` -- automation cannot edit "
            "a file it cannot discover. The manifest declares %r"
            % (self.manifest.MANIFEST_FILENAME, document))
        self.assertNotEqual("config", declaring[0])
        for key in ("config", declaring[0]):
            self.assertTrue(
                os.path.isfile(document[key]),
                "the manifest declares `%s` at %s and nothing is there -- the "
                "dangling-path defect the manifest contract closed"
                % (key, document[key]))

    def test_an_operator_edited_server_config_survives_a_reinstall(self):
        self.install_provisioned()
        self.require_server_config()
        chosen = self.edit_server_config()
        edited = Path(self.server_config).read_bytes()

        self.install_once()

        self.assertEqual(
            edited, Path(self.server_config).read_bytes(),
            "§S2: a re-install must not overwrite the operator's server "
            "configuration -- an upgrade that resets configuration is the "
            "defect this section exists to prevent")
        self.assertEqual(chosen,
                         _limits_in(self.server_config)[SERVER_LIMITS[0]]["value"])

    def test_an_operator_edited_server_config_survives_a_purge(self):
        self.install_provisioned()
        self.require_server_config()
        chosen = self.edit_server_config()

        self.uninstall_once(purge=True)

        self.assertTrue(
            os.path.isfile(self.server_config),
            "§S2: `uninstall --purge` must NOT delete an operator-EDITED server "
            "configuration. An artifact is replaceable; an operator's "
            "configuration is DATA -- and this one sits inside the store "
            "directory the [store] stage removes, so the protection has to be "
            "real rather than incidental")
        survivor = Path(self.server_config).read_text(encoding="utf-8")
        self.assertIn(
            self.EDIT_MARKER.strip(), survivor,
            "the file that survived is not the operator's -- their edit is "
            "gone, which is a silent overwrite wearing a survival's clothes")
        self.assertEqual(chosen,
                         _limits_in(self.server_config)[SERVER_LIMITS[0]]["value"])

    def test_an_untouched_server_config_is_removed_by_a_purge_and_only_by_a_purge(self):
        """The easy half, and it is the half that makes the hard one mean
        something: removal is not blanket-disabled, it is conditioned on the
        file being UNMODIFIED -- the existing `_operator_config_is_untouched`
        rule, reused rather than reimplemented."""
        self.install_provisioned()
        self.require_server_config()

        self.uninstall_once(purge=False)
        self.assertTrue(
            os.path.isfile(self.server_config),
            "a plain uninstall destroys nothing and stays reversible by "
            "reinstalling")

        self.uninstall_once(purge=True)
        self.assertFalse(
            os.path.isfile(self.server_config),
            "an UNMODIFIED laid-down config is an artifact like any other and "
            "`--purge` removes it; leaving it makes the modified-file "
            "protection unobservable")

    def manifest_stage(self, stages):
        rows = [stage for stage in stages if stage.get("name") == "manifest"]
        self.assertEqual(
            1, len(rows),
            "the install must report exactly one `[manifest]` stage row -- the "
            "stage the configuration lay-down lives in: %r" % (stages,))
        return rows[0]

    def test_without_a_provisioned_server_the_laydown_reports_it_did_not_happen_and_why(self):
        """A silent skip is how the first hole stayed invisible: the operator of
        a machine whose board lives on another host must be TOLD that no server
        configuration was written, and why.

        The lay-down lives in `[manifest]` -- the stage that publishes the
        paths, which really did do its own work -- so the report is that
        stage's own `server_config` field rather than a stage declaring itself
        skipped: `{"path": <written file> | None, "reason": <sentence> | None}`,
        the shape `[server]` already uses for its resolved bun path. What is
        REQUIRED is unchanged: a machine that wrote no server configuration
        must say so, naming the server it did not find provisioned.
        """
        stages = self.install_once()

        self.assertFalse(
            os.path.exists(self.server_config),
            "nothing provisioned a server here, so no server configuration is "
            "owed at %s" % (self.server_config,))
        reported = self.manifest_stage(stages).get("server_config")
        self.assertIsInstance(
            reported, dict,
            "§S2: the `[manifest]` stage must report the server-configuration "
            "lay-down as `{'path': …, 'reason': …}` whether or not it "
            "happened -- a lay-down nobody reports is a lay-down nobody can "
            "tell from a failure. The install reported %r" % (stages,))
        self.assertIsNone(
            reported.get("path"),
            "no server is provisioned on this machine, so no path may be "
            "claimed: %r" % (reported,))
        reason = reported.get("reason") or ""
        self.assertTrue(
            re.search(r"server|provision", reason, re.IGNORECASE),
            "the skipped lay-down must STATE ITS REASON, naming the server it "
            "did not find provisioned: reason=%r" % (reason,))


# ===========================================================================
# §S3 -- the isolation contract, asserted rather than assumed
# ===========================================================================

class TheSandboxHoldsTest(_InstalledDeploymentCase):

    def test_a_whole_install_resolve_purge_lifecycle_stays_inside_the_sandbox(self):
        """The suite's own contract, driven end to end: install for real,
        resolve through the laid-down client, then purge for real. The L2
        escape detector asserts in teardown as well, so this test states the
        same claim where a reader will look for it."""
        self.provision_server()
        self.install_once()
        declaration = _limits_in(self.require_install_config())["roadmap_list_rows"]
        (configured,) = _legal_values(declaration, 1)
        _set_value(self.install_config, "roadmap_list_rows", configured)

        os.chdir(self.elsewhere)
        axi = self.axi_from_the_install()
        self.assertEqual(
            configured, axi.resolve_limit("roadmap_list_rows"),
            "the install-then-resolve seam is what this whole suite exists to "
            "exercise, and it is exercised here on the SECOND client limit so "
            "the chain is not wired for one name")
        self.require_server_config()

        os.chdir(self.elsewhere_too)
        self.uninstall_once(purge=True)

        self.assert_nothing_escaped()
        self.assertTrue(
            os.path.isdir(self.root),
            "fixture sanity: everything this test wrote lives under %s"
            % (self.root,))


class AFreshContainersEnvironmentTest(_InstalledDeploymentCase):
    """The L1 sandbox must hold on a RUNNER as well as on a workstation: the
    four variables it pins are ABSENT from a fresh container's environment
    rather than merely carrying a developer's values, and a fixture that read
    one before pinning it would fail there and only there."""

    AMBIENT_UNSET = True

    def test_an_install_resolves_its_configuration_with_no_ambient_environment(self):
        for name in SANDBOXED_ENV:
            self.assertEqual(
                os.environ[name],
                getattr(self, {"HOME": "fake_home",
                               "XDG_DATA_HOME": "xdg_data",
                               "XDG_CONFIG_HOME": "xdg_config",
                               "BUN_INSTALL": "bun_root"}[name]),
                "the sandbox must PIN `%s` itself, never inherit it" % (name,))

        self.install_once()
        declaration = _limits_in(self.require_install_config())["error_detail_chars"]
        (configured,) = _legal_values(declaration, 1)
        _set_value(self.install_config, "error_detail_chars", configured)

        os.chdir(self.elsewhere)
        axi = self.axi_from_the_install()
        self.assertEqual(
            configured, axi.resolve_limit("error_detail_chars"),
            "an installed client resolves the install's own configuration on a "
            "machine that has no $HOME, $XDG_DATA_HOME, $XDG_CONFIG_HOME or "
            "$BUN_INSTALL of its own")


class TheKernelIsolationScriptIsDocumentedAndCannotDriftTest(_InstalledDeploymentCase):
    """L3 -- OPT-IN, and a script an operator RUNS rather than a CI job.

    `bwrap` is not guaranteed on `ubuntu-latest`, and a gate that cannot run
    everywhere is a gate that gets bypassed; on a disposable container it
    defends nothing L1+L2 do not. So the third layer is offered rather than
    wired in -- and an offered layer that nobody can find is not offered at
    all, which is why it is documented in the RUNBOOK beside the suite it
    wraps.

    Documentation and script are asserted to be ONE datum (CR-CRU-134's
    derivation rule): the command the RUNBOOK shows an operator is read out of
    the RUNBOOK, the script is found BY THE PATH THE RUNBOOK NAMES, and every
    isolation flag the one carries must appear in the other. A RUNBOOK that
    documents a `--tmpfs "$HOME"` the script does not pass is a reader who
    believes their `$HOME` is on memory while a real write lands on it.
    """

    #: The flags that MAKE it isolation rather than a shell wrapper: a user
    #: namespace, a tmpfs over `$HOME` (where `~/.crucible` and the XDG data
    #: dir live) and one over the runtime dir. Dropping any of them silently
    #: turns the script into a no-op that reads as protection.
    BWRAP_FLAGS = ("--unshare-user", "--unshare-pid", "--dev-bind",
                   "--tmpfs", "$HOME", "/run/user/")

    SUITE = os.path.basename(__file__)
    RUNBOOK = REPO_ROOT / "docs" / "RUNBOOK.md"

    def runbook_section(self):
        text = self.RUNBOOK.read_text(encoding="utf-8")
        self.assertIn(
            self.SUITE, text,
            "§S3 L3: `%s` must document the sandboxing script BESIDE the suite "
            "it wraps, naming that suite -- an operator cannot run a layer "
            "they cannot find, and an undocumented script is L3 not existing"
            % (self.RUNBOOK,))
        start = text.index(self.SUITE)
        return text[max(0, start - 2000):start + 2000]

    def test_the_runbook_and_the_bwrap_script_carry_the_same_command(self):
        section = self.runbook_section()
        self.assertIn(
            "bwrap", section,
            "the documented layer is a `bwrap` user namespace with a tmpfs "
            "over $HOME; the RUNBOOK section naming %s shows no `bwrap` "
            "command" % (self.SUITE,))

        scripts = re.findall(r"((?:scripts|bin|tools)/[\w.\-/]+\.sh)", section)
        self.assertTrue(
            scripts,
            "the RUNBOOK must name the SCRIPT an operator runs, not only the "
            "command they could retype: a command typed by hand is a command "
            "that drifts. Section: %r" % (section[-800:],))
        script = REPO_ROOT / scripts[0]
        self.assertTrue(
            script.is_file(),
            "the RUNBOOK documents `%s` and nothing is there -- the "
            "dangling-path defect, one artifact wider" % (scripts[0],))
        self.assertTrue(
            os.access(script, os.X_OK),
            "`%s` is documented as a script an operator RUNS; it is not "
            "executable" % (scripts[0],))

        contents = script.read_text(encoding="utf-8")
        for flag in self.BWRAP_FLAGS:
            self.assertIn(
                flag, contents,
                "`%s` does not pass `%s`, so it is not the isolation it is "
                "documented as" % (scripts[0], flag))
            self.assertIn(
                flag, section,
                "the RUNBOOK's own command omits `%s` while `%s` passes it: "
                "the documentation and the script must be ONE datum, or a "
                "reader trusts an isolation they are not getting"
                % (flag, scripts[0]))
        self.assertIn(
            self.SUITE, contents,
            "`%s` must wrap THIS suite -- a sandboxing script that runs "
            "something else defends nothing here" % (scripts[0],))

        # …and the OTHER half of the same rule: L3 is NOT a gate. A workflow
        # that shelled out to `bwrap` would fail on a runner that has none.
        workflows = REPO_ROOT / ".github" / "workflows"
        for workflow in sorted(workflows.glob("*.yml")):
            body = workflow.read_text(encoding="utf-8")
            self.assertNotIn(
                "bwrap", body,
                "%s invokes `bwrap`: L3 is opt-in precisely because "
                "bubblewrap is not guaranteed on `ubuntu-latest`, and a gate "
                "that cannot run everywhere is a gate that gets bypassed"
                % (workflow.name,))
            self.assertNotIn(
                scripts[0], body,
                "%s runs %s: the portable layers are L1+L2, which gate every "
                "push; L3 stays an operator's own paranoia"
                % (workflow.name, scripts[0]))


# ===========================================================================
# §S4 -- the installed fleet carries its OWN shipped defaults, and the
#        operator's file is never them
# ===========================================================================

class TheInstalledFleetCarriesItsOwnShippedDefaultsTest(_InstalledDeploymentCase):
    """`_SHIPPED_DATA_CANDIDATES` (clients/_crucible_axi.py:130-136) is
    `(<install>/clients/crucible.toml, <install>/crucible.toml)`, and on an
    installed fleet the FIRST never exists -- `[fleet]` copies eight files
    (install.py:212-221) and the distribution's data is not one of them. So
    `shipped_data_path()` resolves the SECOND: the OPERATOR's editable file.

    One file was therefore doing two incompatible jobs, and both consequences
    were observed on a healthy 0.2.0 install before it was removed:

      * delete it -- an ordinary `uninstall --purge` -- and every client verb
        raises `RuntimeError: no shipped limit defaults found at …`. Not a
        degraded default: a crash, on a machine that still has a whole fleet
        installed;
      * keep it, and an operator editing "their" file is editing what the code
        treats as the BUILD's recommendations, so `recommended` itself becomes
        operator-mutable -- which
        `test_a_shipped_declaration_carries_no_value_of_its_own`
        (tests/client/test_client_limits_resolve_from_configuration.py:434)
        exists to forbid and cannot see, because it runs against a CHECKOUT
        where the two files are genuinely different files.

    So the fleet carries the distribution's own `crucible.toml` at
    `<install>/clients/crucible.toml`, beside the module that reads it, as
    PACKAGE DATA: replaced wholesale on upgrade like every other file that
    stage copies, declared in the manifest as FLEET content under
    `shipped_config` rather than as configuration, and never left absent while
    the module that cannot work without it is still installed.
    """

    LIMIT = "truncate_field_chars"

    #: Package data a hand has been laid on -- the state a re-install must
    #: erase rather than preserve, which is the whole difference between this
    #: file and the operator's.
    MODIFIED_MARKER = "# hand-modified package data, cycle 472\n"

    def require_fleet_config(self):
        self.assertTrue(
            os.path.isfile(self.fleet_config),
            "§S4: the `[fleet]` stage must lay the distribution's "
            "own `%s` down at %s -- beside `_crucible_axi.py`, the module that "
            "reads it, and the FIRST of `_SHIPPED_DATA_CANDIDATES`. Without it "
            "an installed client's only package data is the OPERATOR's file, "
            "which is not the distribution's to read. `%s` holds %r"
            % (CONFIG_NAME, self.fleet_config, self.fleet_dir,
               sorted(os.listdir(self.fleet_dir))
               if os.path.isdir(self.fleet_dir) else None))
        return self.fleet_config

    def test_the_install_lays_the_distributions_own_data_down_beside_the_module_that_reads_it(self):
        """The laid-down copy is BYTE-IDENTICAL to the distribution's own data
        (`manifest.shipped_config_path()`), and `shipped_data_path()` answers
        with THAT path.

        Asserted on WHICH path it resolved rather than on it not raising:
        today it does not raise either -- it answers with the operator's file,
        and a test satisfied by 'something came back' would have passed
        throughout the defect.
        """
        self.install_once()
        source = self.manifest.shipped_config_path()
        self.require_fleet_config()
        self.assertEqual(
            Path(source).read_bytes(), Path(self.fleet_config).read_bytes(),
            "the laid-down package data must be the distribution's OWN bytes "
            "(%s): the file an operator edits and the declarations the fleet "
            "falls back to are two different data, and only a byte copy of the "
            "source keeps the second one the BUILD's" % (source,))

        # The operator's file is made to DIFFER, so neither assertion below
        # can be satisfied by the candidate that answers today.
        declaration = _limits_in(self.require_install_config())[self.LIMIT]
        (configured,) = _legal_values(declaration, 1)
        _set_value(self.install_config, self.LIMIT, configured)
        self.assertNotEqual(
            Path(source).read_bytes(), Path(self.install_config).read_bytes(),
            "fixture sanity: the operator's file must now differ from the "
            "shipped source, or the two candidates are indistinguishable")

        os.chdir(self.elsewhere)
        axi = self.axi_from_the_install()
        resolved = axi.shipped_data_path()
        self.assertEqual(
            os.path.realpath(self.fleet_config), os.path.realpath(resolved),
            "§S4: an installed client's PACKAGE DATA is the copy beside its own "
            "module. `shipped_data_path()` answered %r -- the operator's "
            "editable file, doing a second job it cannot do: the aliasing this "
            "section exists to end" % (resolved,))
        self.assertNotEqual(
            os.path.realpath(self.install_config), os.path.realpath(resolved),
            "the operator's file must never be what the distribution reads as "
            "its own declarations")

    def test_with_the_operator_file_purged_every_limit_still_runs_at_its_shipped_recommendation(self):
        """The exact state `uninstall --purge` leaves -- the operator's file
        gone, the fleet still installed -- driven on a REAL install rather than
        described. Today the first limit touched raises `RuntimeError: no
        shipped limit defaults found at …`, which is why CR-CRU-131's
        degradation rule (every limit at its recommendation, the verb still
        succeeding) is not reachable from an installed deployment at all.
        """
        self.install_once()
        self.require_install_config()
        os.remove(self.install_config)
        self.assertFalse(os.path.exists(self.project_config))

        os.chdir(self.elsewhere)
        axi = self.axi_from_the_install()
        shipped = _limits_in(SHIPPED_CLIENT_DATA)
        for name in CLIENT_LIMITS:
            try:
                resolved = axi.resolve_limit(name)
            except Exception as exc:  # the CRASH is the defect under test
                self.fail(
                    "§S4: with the operator's `%s` purged from %s, resolving "
                    "`%s` raised %s: %s. A distribution carries its own "
                    "defaults; an operator's file is not them, and removing "
                    "one must DEGRADE to the build's recommendations rather "
                    "than take every client verb down with it"
                    % (CONFIG_NAME, self.target_dir, name,
                       type(exc).__name__, exc))
            self.assertEqual(
                shipped[name]["recommended"], resolved,
                "`%s` must run at the recommendation the distribution's own "
                "data declares" % (name,))

        self.assertEqual(
            os.path.realpath(self.fleet_config),
            os.path.realpath(axi.shipped_data_path()),
            "…and the path those recommendations were read from is the fleet's "
            "package data, which is present whether or not any operator file "
            "is -- which is what `shipped_data_path()`'s own docstring already "
            "promises")

        # …and through a REAL verb, because a limit that resolves in isolation
        # while the client's boot path raises is a crash an operator meets and
        # a unit assertion never sees.
        plans = {"ok": True, "plans": [
            {"planId": "plan-1", "cr": "CR-SHIPPED-001", "wave": "6",
             "status": "open", "cycles": []},
        ]}
        try:
            client = self.bun_client_from_the_install()
            with mock.patch.object(client, "_get", return_value=plans):
                code, out, err = _run_main(
                    client, ["status", "--project-dir", self.project_dir])
        except Exception as exc:  # noqa: BLE001 -- see above
            self.fail(
                "§S4: `status` raised %s: %s on an install whose operator file "
                "was purged. `uninstall --purge` must not leave a fleet whose "
                "every verb crashes" % (type(exc).__name__, exc))
        self.assertEqual(
            0, code, "stdout=%r stderr=%r" % (out, err))
        self.assertIn("verb: status", out)

    def test_an_operator_edit_moves_the_resolved_value_but_never_the_builds_recommendation(self):
        """An operator's file decides what a limit RUNS at and nothing else.
        `recommended`, `min` and `max` keep reading as the build's own
        declarations, and the shipped table still carries no `value`.

        That rule is already pinned by
        `test_a_shipped_declaration_carries_no_value_of_its_own`
        (tests/client/test_client_limits_resolve_from_configuration.py:434) and
        by `test_setting_a_value_leaves_recommended_reading_as_the_shipped_recommendation`
        (:446) -- but both run against a CHECKOUT, where the shipped data and
        the operator's file are genuinely different files. On an INSTALLED
        deployment they are ONE file, so an operator's `value` lands inside the
        shipped table and an operator's `recommended` overwrites the build's.
        The rule is therefore re-asserted here, where it is actually violated.
        """
        self.install_once()
        self.require_install_config()
        shipped = _limits_in(SHIPPED_CLIENT_DATA)
        chosen = {}
        for name in CLIENT_LIMITS:
            configured, redefined = _legal_values(shipped[name], 2)
            chosen[name] = _set_value(self.install_config, name, configured)
            self.assertNotEqual(
                redefined, shipped[name]["recommended"],
                "fixture sanity: the operator's redefinition must differ from "
                "the build's own recommendation")
            # The edit the shipped header forbids, made anyway -- and today it
            # rewrites the distribution's package data, because that is the
            # file the code reads as its own.
            _overwrite_field(self.install_config, name, "recommended", redefined)
            _overwrite_field(self.install_config, name, "min",
                             shipped[name]["min"] - 1)
            _overwrite_field(self.install_config, name, "max",
                             shipped[name]["max"] + 1)

        os.chdir(self.elsewhere)
        axi = self.axi_from_the_install()
        table = axi.shipped_limits()
        for name in CLIENT_LIMITS:
            self.assertEqual(
                chosen[name], axi.resolve_limit(name),
                "the operator's `value` must MOVE the number `%s` runs at: "
                "that is the one job their file has" % (name,))
            for field in ("recommended", "min", "max"):
                self.assertEqual(
                    shipped[name][field], table[name][field],
                    "§S4: `%s`'s `%s` must keep reading as the BUILD's own "
                    "declaration (%r). The operator's file redefined it and "
                    "the change was believed, because that file IS what this "
                    "deployment reads as its package data -- one upgrade from "
                    "an operator no longer able to tell our number from theirs"
                    % (name, field, shipped[name][field]))
            self.assertIsNone(
                table[name].get("value"),
                "a shipped declaration carries no `value` of its own "
                "(tests/client/test_client_limits_resolve_from_configuration"
                ".py:434); `%s` picked one up out of the operator's file"
                % (name,))

    def test_the_manifest_declares_the_fleet_copy_as_shipped_data_under_its_own_key(self):
        """Automation cannot discover what the manifest does not declare, and
        the two files are not the same KIND of thing: `config` is the
        operator's, survives a purge once edited, and is theirs to change;
        `shipped_config` is the build's, replaced on every upgrade, and editing
        it is editing a file the next install will overwrite. One key each, or
        automation eventually edits the wrong one."""
        self.install_once()
        self.require_install_config()
        self.assertTrue(os.path.isfile(self.manifest_file))
        document = json.loads(
            Path(self.manifest_file).read_text(encoding="utf-8"))
        # The DECLARATION is asserted before the file is required to exist, so
        # this test's failure names the key the manifest is missing rather
        # than repeating the laydown failure its siblings already report.

        self.assertEqual(
            self.install_config, document.get("config"),
            "the OPERATOR's configuration keeps the `config` key, unchanged: %r"
            % (document,))
        declaring = sorted(key for key, value in document.items()
                           if isinstance(value, str) and value == self.fleet_config)
        self.assertEqual(
            [FLEET_CONFIG_MANIFEST_KEY], declaring,
            "§S4: `%s` must declare the fleet's shipped `%s` (%s) under "
            "EXACTLY the key `%s` -- FLEET content, distinct from the "
            "operator's `config`. It declares %r"
            % (self.manifest.MANIFEST_FILENAME, CONFIG_NAME, self.fleet_config,
               FLEET_CONFIG_MANIFEST_KEY, document))
        self.assertNotEqual(
            "config", declaring[0],
            "package data and an operator's configuration must not share a key")
        self.assertTrue(
            os.path.isfile(document[FLEET_CONFIG_MANIFEST_KEY]),
            "the manifest declares `%s` at %s and nothing is there -- the "
            "dangling-path defect the manifest contract closed"
            % (FLEET_CONFIG_MANIFEST_KEY,
               document.get(FLEET_CONFIG_MANIFEST_KEY)))

    def test_no_uninstall_leaves_the_installed_module_without_the_shipped_data_beside_it(self):
        """The INVARIANT, asserted rather than a lifecycle invented for it.

        `_crucible_axi.py` cannot resolve a single limit without the package
        data beside it, so any path that removes one while leaving the other
        manufactures precisely the `RuntimeError: no shipped limit defaults
        found at …` state this section exists to end -- the state the operator
        of the reported 0.2.0 install actually met. `[fleet]` has no uninstall
        inverse today (install.py:75-77), so the rule costs nothing now and
        fails the day one is added that forgets this file.

        Asserted after a PLAIN uninstall and after a PURGE, because the two
        run different stages over the same directory.
        """
        self.install_once()
        self.require_fleet_config()

        asserted = 0
        for purge in (False, True):
            self.uninstall_once(purge=purge)
            if not os.path.isfile(self.installed_axi):
                continue
            asserted += 1
            self.assertTrue(
                os.path.isfile(self.fleet_config),
                "§S4: `uninstall%s` left %s installed with no `%s` beside it. A "
                "module that cannot say what this distribution enforces is "
                "worse than an absent one: every client verb RAISES instead of "
                "degrading, which is the reported defect exactly"
                % (" --purge" if purge else "", self.installed_axi, CONFIG_NAME))

        # The loop's `continue` is the only way its assertion can be skipped, so
        # the COUNT is asserted too: there is no `[fleet]` uninstall inverse
        # today, so the module survives BOTH passes and the invariant is checked
        # twice. If a later CR builds one, this fails loudly and is re-decided --
        # rather than passing vacuously with nothing checked, which is how a
        # guard quietly becomes decoration.
        self.assertEqual(
            2, asserted,
            "the invariant must have been CHECKED on both the plain uninstall "
            "and the purge; it ran %d time(s), so an uninstall removed %s and "
            "this guard stopped guarding anything"
            % (asserted, self.installed_axi))

        # …and the purge really ran, so the loop above was not vacuous: an
        # UNTOUCHED operator file is an artifact like any other and `--purge`
        # removes it (the existing CR-CRU-131 §S1c rule, unchanged).
        self.assertFalse(
            os.path.exists(self.install_config),
            "fixture sanity: `--purge` must have removed the untouched "
            "operator file at %s, or nothing destructive ran here at all"
            % (self.install_config,))

    def test_a_reinstall_replaces_the_fleet_copy_wholesale_while_the_operators_edit_survives(self):
        """Two files, two opposite rules, in ONE run -- because the defect was
        that one file carried both. Package data is REPLACED, like every other
        file `[fleet]` copies; the operator's configuration SURVIVES
        (the existing `_operator_config_is_untouched` rule,
        crucible_axi/install.py:1170-1186, unchanged)."""
        self.install_once()
        self.require_fleet_config()
        Path(self.fleet_config).write_text(
            self.MODIFIED_MARKER + Path(self.fleet_config).read_text(
                encoding="utf-8"), encoding="utf-8")

        declaration = _limits_in(self.require_install_config())[self.LIMIT]
        (configured,) = _legal_values(declaration, 1)
        _set_value(self.install_config, self.LIMIT, configured)
        edited = Path(self.install_config).read_bytes()

        self.install_once()

        source = self.manifest.shipped_config_path()
        self.assertEqual(
            Path(source).read_bytes(), Path(self.fleet_config).read_bytes(),
            "§S4: a re-install must replace the fleet's `%s` WHOLESALE -- it is "
            "package DATA, not operator state, and a modified copy is a "
            "distribution lying about what it enforces" % (CONFIG_NAME,))
        self.assertNotIn(
            self.MODIFIED_MARKER.strip(),
            Path(self.fleet_config).read_text(encoding="utf-8"),
            "the hand modification survived the upgrade: package data that "
            "accumulates local state is no longer the build's")
        self.assertEqual(
            edited, Path(self.install_config).read_bytes(),
            "…and in the SAME run the OPERATOR's file is untouched: an upgrade "
            "that resets configuration is the defect the installer split exists to "
            "prevent, and the two rules must hold at once or the files are "
            "still one file wearing two names")
        self.assertEqual(
            configured, _limits_in(self.install_config)[self.LIMIT]["value"],
            "the operator's own value must still be the one their file sets")


if __name__ == "__main__":
    unittest.main()
