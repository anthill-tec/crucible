"""CR-CRU-009 §S2 — the staged install orchestrator framework.

`run_install` sequences the server -> fleet -> manifest -> unit sub-installers
through an INJECTABLE stage-runner table (no real subprocess/network in this
cycle) and aggregates each stage's result into `(ok, stages, warnings)`. Stages
run in `STAGE_ORDER`; a stage exception is FAIL-FAST (remaining stages are
skipped and `ok` is False). Each returned stage path is `~`-abbreviated by
`run_install`.

`DEFAULT_STAGE_RUNNERS` is a module-level, in-place-mutable dict (tests patch it
via `mock.patch.dict`); `run_install` reads it by name at call time so a patch
is always observed.

CR-CRU-042 §S1 — the `[skills]` stage is retired: skill content is Model B's
scope now, so Crucible ships no `npx skills` invocation and the envelope
reports exactly the two surviving stages.

CR-CRU-066 §S2 — Bun is a GUARANTEED install dependency: the `[server]` stage
detects it, bootstraps it when absent (unless `--no-bun-bootstrap` /
`$CRUCIBLE_NO_BUN_BOOTSTRAP` opts out), RE-RESOLVES `$BUN_INSTALL/bin`, VERIFIES
that it runs, and otherwise fails the install with a named remedy. The provision
then runs that resolved ABSOLUTE Bun path, reported as the stage's `bun` output.

CR-CRU-090 §S1 — the `[fleet]` stage lays the eight packaged client files down
under `<target-dir>/clients/`, ordered strictly BEFORE `[manifest]`: the
manifest publishes six paths anchored on that directory, so it must be written
only after they exist. Before this, nothing materialised the directory and
every published path dangled.
"""

from __future__ import annotations

import inspect
import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

from crucible_axi import manifest

# The stage whose ADVANCE gates the upgrade restart (CR-CRU-071 AC9) -- named
# once, so the threading in `run_install` cannot drift from `STAGE_ORDER`.
SERVER_STAGE_NAME = "server"

# CR-CRU-090 §S1 -- `[fleet]` sits strictly BEFORE `[manifest]`: the manifest
# publishes six paths anchored on `<target-dir>/clients/`, so it may only be
# written once the files it names actually exist. Before this stage existed,
# nothing materialised that directory and every published path dangled.
# CR-CRU-070 §Design -- `[unit]` is LAST: it is the only stage that hands work
# to another supervisor, so the launcher its `ExecStart` names must already be
# provisioned (enabling it earlier would `enable --now` a unit that cannot
# start).
# CR-CRU-071 AC9 gives that ordering a second job: `[unit]` runs AFTER
# `[server]`, so by the time it decides whether to restart, the stage that
# re-provisioned has already reported that it did.
STAGE_ORDER = (SERVER_STAGE_NAME, "fleet", "manifest", "unit")

# The INVERSE sequence (CR-CRU-069 §S1) -- DESTRUCTIVE-LAST, deliberately not a
# naive reverse of `STAGE_ORDER`. Install has no destructive stage, so
# inverting its order says nothing about where a purge belongs; combined with
# fail-fast, destructive-last means data is destroyed only after every
# reversible step has already succeeded. `[config]` is the inverse of the
# `[manifest]` stage, named after the artifact it removes; `[store]` reverses
# what the SERVER creates at runtime and goes absolutely last -- it is the one
# irreplaceable artifact.
# CR-CRU-070 §Design extends the inversion with `[unit]` FIRST: removing the
# server package while an enabled unit still points at
# `~/.bun/bin/crucible-server` would leave systemd restarting a DELETED binary
# (`Restart=on-failure`, failing in a loop with no operator watching). Stopping
# the supervisor precedes removing what it supervises; destructive-last is
# untouched.
# `[fleet]` has NO inverse here yet: CR-CRU-090 §S1 defers the uninstall
# counterpart to a follow-up CR rather than widening this chain inside a
# hotfix.
UNINSTALL_STAGE_ORDER = ("unit", "server", "config", "store")

# External sources for the concrete sub-installers. `SERVER_NPM_PACKAGE` is the
# published npm package name and MUST stay equal to the repo package.json's
# `name` field (CR-CRU-041 §S1 — asserted by a test so the two artifacts cannot
# silently drift apart).
SERVER_NPM_PACKAGE = "@anthill-tec/crucible-server"

# Environment escape hatch for the version-pinned server fetch (CR-CRU-041 §S6)
# — for development and for recovering from a bad server publish. Unset means
# the orchestrator's own version, never `latest`.
SERVER_VERSION_ENV_VAR = "CRUCIBLE_SERVER_VERSION"

# The Bun curl-bootstrap the [server] stage runs when Bun is absent (CR-CRU-066
# §S2). It is a GUARANTEE step, not a best-effort one: when it cannot make Bun
# resolvable the stage fails definitively instead of limping into a cryptic
# provision error.
_BUN_INSTALL_COMMAND = "curl -fsSL https://bun.sh/install | bash"

# Bun's own executable name, resolved on PATH and inside `$BUN_INSTALL/bin`.
BUN_BIN_NAME = "bun"

# Operator opt-out of the automatic Bun bootstrap (CR-CRU-066 §S2 AC4) --
# equivalent to the `--no-bun-bootstrap` CLI flag. A missing Bun then fails the
# install immediately, with the same remedy, and no remote script is fetched.
BUN_NO_BOOTSTRAP_ENV_VAR = "CRUCIBLE_NO_BUN_BOOTSTRAP"

# Bun's global install prefix -- where `bun add -g` lays packages down and
# links their bins (CR-CRU-066 §S1). `$BUN_INSTALL` overrides it; the default
# is the user-scoped `~/.bun`, which is why the provision needs no system
# prefix (and no sudo) the way `npm -g` does.
BUN_INSTALL_ENV_VAR = "BUN_INSTALL"
_DEFAULT_BUN_INSTALL_PREFIX = "~/.bun"

# The console-script `SERVER_NPM_PACKAGE` links into Bun's global bin; its
# presence there is the server's REAL installed marker.
SERVER_BIN_NAME = "crucible-server"

# Where `bun add -g` lays a package's own tree down, relative to `$BUN_INSTALL`.
# The `package.json` under it carries the INSTALLED server version, which is
# what the pin is compared against so an UPGRADE never silently no-ops.
BUN_GLOBAL_NODE_MODULES = ("install", "global", "node_modules")

# The metadata key holding the installed version inside that `package.json`.
_PACKAGE_JSON_VERSION_KEY = "version"
_PACKAGE_JSON_NAME_KEY = "name"

# The server's own runtime configuration, forwarded to the child process by
# `crucible-axi serve` (CR-CRU-066 §S3). `serve` composes the child env
# EXPLICITLY, because the systemd `--user` unit the [unit] stage writes
# (CR-CRU-070) inherits neither the operator's PATH nor their exports.
SERVER_HOST_ENV_VAR = "CRUCIBLE_HOST"
SERVER_PORT_ENV_VAR = "CRUCIBLE_PORT"

# The server's STORE-PATH override (RUNBOOK "Database path" rule 2) -- the
# third `CRUCIBLE_*` knob the [unit] stage forwards explicitly, for the same
# reason `serve` composes the child env explicitly (CR-CRU-070 AC1).
SERVER_DB_ENV_VAR = "CRUCIBLE_DB"

# systemd's client. Resolved ABSOLUTELY and driven `--user` only: the unit is
# user-scoped exactly as `bun add -g` is, so nothing here needs privilege
# escalation (CR-CRU-070 §Scope).
SYSTEMCTL_BIN_NAME = "systemctl"
_USER_SCOPE_FLAG = "--user"

# The verb that re-execs an ALREADY-RUNNING service so the process becomes the
# code `bun add -g` just laid down (CR-CRU-071 AC9). `restart` and not
# `try-restart`: the stage has already PROBED the service active, so "restart
# it only if it happens to be up" would hide a genuine failure to come back.
_RESTART_VERB = "restart"

# The READ-ONLY verb that shows a failed unit's own last output -- where the
# server's store refusal / migration failure lands, since systemd captures a
# `--user` unit's stderr into the journal (CR-CRU-071 AC8). `--no-pager`
# because an install is not an interactive session. Fetched ONLY after a start
# has failed: a probe on every install is chatter the happy path does not need.
_UNIT_LOG_VERB = "status"
_NO_PAGER_FLAG = "--no-pager"

# The unit `systemctl --user` reads, and the directory it reads it from:
# `$XDG_CONFIG_HOME/systemd/user`, falling back to `<HOME>/.config` by the XDG
# base-directory rule the user manager itself follows.
UNIT_FILE_NAME = "crucible-server.service"
CONFIG_HOME_ENV_VAR = "XDG_CONFIG_HOME"
_DEFAULT_CONFIG_HOME_SUFFIX = (".config",)
_USER_UNIT_SUBDIR = ("systemd", "user")

# Operator opt-out of the whole systemd surface (CR-CRU-070 AC4) -- the
# `--no-service` flag's environment equivalent. An opt-out must not even PROBE:
# on a machine with a perfectly good user manager, it is the ONLY reason
# nothing happened, so the stage says so instead of staying silent.
NO_SERVICE_ENV_VAR = "CRUCIBLE_NO_SERVICE"

# How a user D-Bus session is detected WITHOUT spawning anything: the address
# the bus exports, else the socket the user manager lays down in the runtime
# dir.
DBUS_SESSION_ENV_VAR = "DBUS_SESSION_BUS_ADDRESS"
RUNTIME_DIR_ENV_VAR = "XDG_RUNTIME_DIR"
_USER_BUS_SOCKET_NAME = "bus"

# The read-only verb that asks the USER MANAGER whether it is there at all, and
# the failure it prints when it is not. This is the SECOND, independent bus
# check: the environment pair above can be inherited by a process whose bus has
# since gone away.
_MANAGER_PROBE_VERB = "is-system-running"
_BUS_FAILURE_NEEDLE = "failed to connect to bus"

# Why the [unit] stage did nothing, for each of the three ways it can decline
# (CR-CRU-070 AC4). A skip without a reason leaves the operator guessing
# whether their daemon exists.
_OPT_OUT_REASON = (
    f"skipped: systemd unit management was opted out of explicitly "
    f"(--no-service / ${NO_SERVICE_ENV_VAR})")
_NO_SYSTEMCTL_REASON = (
    f"skipped: no {SYSTEMCTL_BIN_NAME} is resolvable, so this machine has no "
    f"user service manager to hand the server to")
_NO_USER_BUS_REASON = (
    f"skipped: no user D-Bus session is reachable (${DBUS_SESSION_ENV_VAR} "
    f"unset and no ${RUNTIME_DIR_ENV_VAR} socket), so the user manager cannot "
    f"be addressed")

# The server's STORE, resolved by the server's own documented rule 4
# (CR-CRU-043 / RUNBOOK "Database path"): `$XDG_DATA_HOME/crucible`, falling
# back to `<HOME>/.local/share/crucible` when `$XDG_DATA_HOME` is unset or
# empty. `crucible-axi` never creates it -- the server does, on boot -- but
# `uninstall --purge` is what removes it, so the resolution must MATCH
# `resolveDbPath` in `src/server.ts` exactly or a purge would miss the store.
XDG_DATA_HOME_ENV_VAR = "XDG_DATA_HOME"
_DEFAULT_DATA_HOME_SUFFIX = (".local", "share")
STORE_DIR_NAME = "crucible"
# The packaged fleet, exactly (CR-CRU-090 §S1). The five stack clients plus:
# `_crucible_axi.py` (the shared AXI envelope) and `toon.py` (the codec) —
# which the five load BY FILE PATH from their OWN directory, so a clients-only
# copy lays down five UNRUNNABLE clients — plus `STATUS-CONTRACT.md`, the path
# `manifest.build_manifest` publishes as `status`.
FLEET_FILES = (
    "bun-crucible.py",
    "python-crucible.py",
    "rust-crucible.py",
    "mvn-crucible.py",
    "arduino-crucible.py",
    "_crucible_axi.py",
    "toon.py",
    "STATUS-CONTRACT.md",
)

# The directory the fleet lands in, under `--target-dir`. `manifest` anchors
# every path it publishes on this same name, so the two MUST agree.
FLEET_DIRNAME = "clients"


def _bun_install_prefix() -> str:
    """Bun's global install prefix -- `$BUN_INSTALL` when set, else `~/.bun`,
    expanded. Read at call time so both an operator's `$BUN_INSTALL` and a
    prefix that only exists after the curl bootstrap are observed."""
    prefix = os.environ.get(BUN_INSTALL_ENV_VAR) or _DEFAULT_BUN_INSTALL_PREFIX
    return os.path.expanduser(prefix)


def _bun_global_bin_dir() -> str:
    """Bun's global bin directory -- `<prefix>/bin`."""
    return os.path.join(_bun_install_prefix(), "bin")


def _provisioned_server_bin_path() -> str:
    """Absolute path of the `crucible-server` bin that `bun add -g` links."""
    return os.path.join(_bun_global_bin_dir(), SERVER_BIN_NAME)


def _provisioned_server_package_dir() -> str:
    """Absolute path of the package tree `bun add -g` unpacks the server into
    -- `$BUN_INSTALL/install/global/node_modules/<pkg>`. Together with the bin
    link it is what `bun remove -g` takes away, so it is also the PROBE an
    uninstall answers "is anything still provisioned?" from."""
    return os.path.join(_bun_install_prefix(), *BUN_GLOBAL_NODE_MODULES,
                        *SERVER_NPM_PACKAGE.split("/"))


def store_dir() -> str:
    """The server's store directory, by the server's own rule 4 (CR-CRU-043).

    Mirrors `resolveDbPath` in `src/server.ts`: `$XDG_DATA_HOME` when set and
    non-empty, else `<HOME>/.local/share`, plus `crucible`. Read at call time,
    so a test (or an operator) that redirects `$XDG_DATA_HOME`/`$HOME` is
    observed rather than a value captured at import.
    """
    xdg = os.environ.get(XDG_DATA_HOME_ENV_VAR, "")
    data_home = xdg if xdg else os.path.join(
        os.path.expanduser("~"), *_DEFAULT_DATA_HOME_SUFFIX)
    return os.path.join(os.path.expanduser(data_home), STORE_DIR_NAME)


def config_path(target_dir: str) -> str:
    """The client config/state artifact the [manifest] install stage writes --
    `<target-dir>/crucible-clients.json`. The one locus both the [config]
    uninstall stage and the interactive purge prompt derive it from."""
    return os.path.join(target_dir, manifest.MANIFEST_FILENAME)


def _installed_server_metadata_candidates() -> list[str]:
    """Every `package.json` path the PROVISIONED server's own metadata may sit
    at, most canonical first.

    `bun add -g` unpacks the package under
    `$BUN_INSTALL/install/global/node_modules/<pkg>` and links its bin into
    `$BUN_INSTALL/bin`, so the canonical location is derived directly. The bin
    link is then resolved and its directory walked upwards as a fallback, for a
    Bun layout that differs -- the walk stays INSIDE the Bun prefix, so a bin
    resolving elsewhere yields no candidate rather than reading arbitrary
    `package.json` files off the operator's disk.
    """
    prefix = _bun_install_prefix()
    candidates = [os.path.join(_provisioned_server_package_dir(),
                               "package.json")]

    real_prefix = os.path.realpath(prefix)
    directory = os.path.dirname(
        os.path.realpath(_provisioned_server_bin_path()))
    while directory == real_prefix or \
            directory.startswith(real_prefix + os.sep):
        candidate = os.path.join(directory, "package.json")
        if candidate not in candidates:
            candidates.append(candidate)
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    return candidates


def _read_installed_server_version(package_json_path: str) -> str | None:
    """The `version` from a provisioned-server `package.json`, or None when the
    file is absent, unreadable, malformed, or belongs to another package.

    Reading METADATA is deliberate: asking the server binary for its version
    would RUN the server during the install, which is the exact defect
    CR-CRU-066 exists to fix (that bin IS the server -- it `listen`s).
    """
    try:
        with open(package_json_path, encoding="utf-8") as handle:
            metadata = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(metadata, dict):
        return None
    if metadata.get(_PACKAGE_JSON_NAME_KEY) != SERVER_NPM_PACKAGE:
        return None
    version = metadata.get(_PACKAGE_JSON_VERSION_KEY)
    return version if isinstance(version, str) and version else None


def _installed_server_version() -> str | None:
    """The version of the server `bun add -g` actually laid down, or None when
    it cannot be determined. None is the FAIL-SAFE answer: the caller treats it
    as a mismatch and re-provisions rather than skipping silently."""
    for candidate in _installed_server_metadata_candidates():
        version = _read_installed_server_version(candidate)
        if version is not None:
            return version
    return None


def _server_already_installed(target_dir: str,
                              expected_version: str | None = None) -> bool:
    """REAL idempotency probe for the [server] sub-installer (CR-CRU-066 §S1) --
    True iff the `crucible-server` bin exists under Bun's global bin AND, when
    `expected_version` is given, the INSTALLED server is that exact version.

    Bun owns where the server lands, so `target_dir` (the install/manifest
    root) never holds a server payload: the retired `<target_dir>/server`
    marker-directory probe could never converge because nothing ever created
    it. `target_dir` is kept for the stage-runner signature.

    The version comparison is what makes an UPGRADE converge honestly: a bin
    left behind by an older `crucible-axi` (or by a hand-run `bun add -g`) is
    NOT the server this release is pinned to, and reporting it converged would
    silently skip the pin the lockstep release exists to enforce. An
    undeterminable installed version counts as a mismatch, so the stage
    re-provisions -- never a silent skip. `expected_version=None` asks the bare
    presence question, which is what `crucible-axi serve` needs.

    Tests patch this seam directly."""
    if not os.path.isfile(_provisioned_server_bin_path()):
        return False
    if expected_version is None:
        return True
    return _installed_server_version() == expected_version


def _resolve_server_version() -> str:
    """Return the npm server version the [server] stage fetches (CR-CRU-041 §S6).

    `CRUCIBLE_SERVER_VERSION` wins when set; otherwise the orchestrator's own
    `crucible_axi.__version__`, so a pinned `crucible-axi X.Y.Z` always
    provisions the server it was released with — never `latest`. Read at call
    time so the environment override is observed without re-importing.
    """
    override = os.environ.get(SERVER_VERSION_ENV_VAR)
    if override:
        return override
    # Deferred import: reads the package's CURRENT `__version__` at call time.
    # A module-level `from crucible_axi import __version__` would bind a COPY of
    # the value at import time, so neither a later reassignment nor a test's
    # `mock.patch.object(crucible_axi, "__version__", ...)` would ever be seen
    # here.
    from crucible_axi import __version__ as axi_version
    return axi_version


def _resolved_server_version_or_fail() -> str:
    """Return the server version to pin, or FAIL FAST when it is unusable
    (CR-CRU-041 §S6).

    The one unusable case is the source-checkout fallback: when crucible-axi is
    not installed as a package, `crucible_axi.__version__` is the
    `_SOURCE_CHECKOUT_VERSION` sentinel, which is not a valid npm version — a
    pin built from it makes the provision fail with an opaque error deep inside
    the install. With `CRUCIBLE_SERVER_VERSION` set the operator has named the
    version explicitly, so there is nothing to guard.
    """
    override = os.environ.get(SERVER_VERSION_ENV_VAR)
    version = _resolve_server_version()
    if override:
        return version

    # Deferred import for the same reasons as in `_resolve_server_version`.
    from crucible_axi import _SOURCE_CHECKOUT_VERSION
    if version == _SOURCE_CHECKOUT_VERSION:
        raise RuntimeError(
            "server stage failed: the Crucible server version could not be "
            "resolved. crucible-axi is running from a source checkout, so it "
            f"has no installed package version (it reports the placeholder "
            f"{version!r}, which is not a valid npm version) and there is "
            "nothing to pin the server fetch to. Remedy: set "
            f"{SERVER_VERSION_ENV_VAR} to the server version to install "
            f"(e.g. {SERVER_VERSION_ENV_VAR}=1.2.3), or run the installer "
            "from an installed crucible-axi release.")
    return version


def _bun_on_path() -> str | None:
    """Bun as the INHERITED PATH resolves it, absolute, or None when absent."""
    found = shutil.which(BUN_BIN_NAME)
    return os.path.abspath(found) if found else None


def _bun_in_global_prefix() -> str | None:
    """Bun where its own installer lays it down -- `$BUN_INSTALL/bin/bun`
    (default `~/.bun/bin/bun`), or None when it is not an executable file.

    PATH alone cannot be the only probe (CR-CRU-066 §S2): a Bun the curl
    bootstrap just installed is NOT on the PATH this process inherited, because
    that PATH was captured before the installer edited the shell profile.
    """
    candidate = os.path.join(_bun_global_bin_dir(), BUN_BIN_NAME)
    if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
        return candidate
    return None


def _resolve_bun_path() -> str | None:
    """The absolute Bun executable this install should run, or None.

    Read at call time (PATH first, then `$BUN_INSTALL/bin`) so a re-resolve
    after the bootstrap observes what the installer just laid down.
    """
    return _bun_on_path() or _bun_in_global_prefix()


def _bun_bootstrap_disabled(no_bun_bootstrap: bool = False) -> bool:
    """Whether the automatic curl bootstrap is opted out of -- by the
    `--no-bun-bootstrap` flag threaded in as `no_bun_bootstrap`, or by
    `$CRUCIBLE_NO_BUN_BOOTSTRAP` (CR-CRU-066 §S2 AC4). The two are equivalent.
    """
    if no_bun_bootstrap:
        return True
    raw = os.environ.get(BUN_NO_BOOTSTRAP_ENV_VAR, "").strip().lower()
    return raw not in ("", "0", "false", "no", "off")


def _bun_remedy(problem: str) -> str:
    """A definitive, actionable Bun failure message -- what went wrong plus the
    remedy, so the operator is never left with a cryptic downstream error."""
    return (
        f"Bun is REQUIRED to provision the Crucible server, but {problem}. "
        f"Remedy: install Bun from https://bun.sh and re-run the install, or "
        f"set {BUN_INSTALL_ENV_VAR} to a prefix that already contains "
        f"bin/{BUN_BIN_NAME}.")


def _guarantee_bun(no_bun_bootstrap: bool = False) -> str:
    """GUARANTEE Bun, or fail definitively (CR-CRU-066 §S2 AC3/AC4).

    Detect at BOTH locations first (`_resolve_bun_path`: PATH **and** the
    explicit `$BUN_INSTALL/bin/bun`) -> bootstrap only when BOTH miss (unless
    opted out) -> RE-RESOLVE including `$BUN_INSTALL/bin` -> VERIFY the resolved
    binary actually runs (`<abs-bun> --version` exits 0) -> return its ABSOLUTE
    path. Anything else raises `RuntimeError` carrying the remedy: an
    unguaranteed Bun must never reach the provision, and the failure is never
    swallowed.

    A PATH-ONLY first probe is wrong (caught at VERIFY): this CR's own install
    puts Bun under `~/.bun`, so an operator who has not re-sourced their shell
    has a perfectly usable Bun that PATH cannot see -- and the PATH-only probe
    then re-pipes the remote installer into a shell on every `--force` /
    re-provision, which is exactly the pipe-to-shell the opt-out exists to
    avoid.
    """
    bun = _resolve_bun_path()
    if bun is None:
        opted_out = _bun_bootstrap_disabled(no_bun_bootstrap)
        if not opted_out:
            subprocess.run(_BUN_INSTALL_COMMAND, shell=True, check=False)
        bun = _resolve_bun_path()
        if bun is None:
            why = ("and the automatic bootstrap is disabled "
                   f"({BUN_NO_BOOTSTRAP_ENV_VAR} / --no-bun-bootstrap)"
                   if opted_out else "even after running the Bun installer")
            raise RuntimeError(_bun_remedy(
                f"no {BUN_BIN_NAME} executable could be resolved on PATH or at "
                f"{os.path.join(_bun_global_bin_dir(), BUN_BIN_NAME)} {why}"))

    probe = subprocess.run([bun, "--version"], check=False,
                           capture_output=True, text=True)
    if probe.returncode != 0:
        raise RuntimeError(_bun_remedy(
            f"the Bun at {bun} is not usable: {BUN_BIN_NAME} --version exited "
            f"with returncode {probe.returncode}"))
    return bun


def _server_stage(target_dir: str, force: bool,
                  no_bun_bootstrap: bool = False) -> dict:
    """[server] sub-installer -- PROVISIONS the server user-scoped via
    `bun add -g <SERVER_NPM_PACKAGE>@<version>`, then RETURNS (CR-CRU-066 §S1).

    It never runs the server: that npm package's bin IS the server (it
    `listen`s), so the retired run-the-published-bin delegation blocked forever
    and the install never reached the [manifest] stage. `bun add -g` installs
    the package and links its `crucible-server` bin into Bun's user-scoped
    global prefix (`~/.bun`), so there is no system-prefix permission problem
    either. Running the server is a separate step.

    Bun is GUARANTEED first (`_guarantee_bun`): detected, bootstrapped when
    absent unless opted out, re-resolved, verified, or the stage fails
    definitively. The provision then runs that RESOLVED ABSOLUTE Bun path --
    never the bare `bun` token, which depends on an inherited PATH a fresh
    bootstrap has not touched -- and reports it as the `bun` stage output. The
    provision is VERSION-PINNED (see `_resolve_server_version`).

    Idempotent AND version-aware: an already-provisioned server bin AT THE
    RESOLVED PIN (and not `force`) short-circuits to converged=True without
    shelling out. A bin at any other version -- or one whose version cannot be
    read -- is NOT converged, so an upgrade re-provisions through the same
    absolute-Bun `bun add -g <pkg>@<pin>` path instead of silently leaving the
    older server in place.

    A re-provision reports `advanced: True` (CR-CRU-071 AC9). This stage is the
    ONLY one that can know an upgrade happened -- the `[unit]` stage compares
    unit TEXT, and `ExecStart` is a version-INDEPENDENT
    `$BUN_INSTALL/bin/crucible-server`, so its text is byte-identical across an
    upgrade. Without this signal `bun add -g` replaces the package on disk
    while the running service keeps serving the old code from memory.
    """
    server_path = _provisioned_server_bin_path()

    # The non-failing resolver: an unusable pin must surface through
    # `_resolved_server_version_or_fail` below (with its remedy), not as a
    # convergence answer.
    if not force and _server_already_installed(target_dir,
                                               _resolve_server_version()):
        return {"path": server_path, "converged": True}

    # Resolve (and validate) the pin BEFORE any side effect -- an unusable
    # version must fail definitively, not after bootstrapping Bun.
    server_version = _resolved_server_version_or_fail()

    bun = _guarantee_bun(no_bun_bootstrap=no_bun_bootstrap)

    provision_argv = [bun, "add", "-g",
                      f"{SERVER_NPM_PACKAGE}@{server_version}"]
    completed = subprocess.run(provision_argv, check=False)
    if completed.returncode != 0:
        raise RuntimeError(
            f"server stage failed: `{' '.join(provision_argv)}` exited with "
            f"returncode {completed.returncode}")

    return {"path": server_path, "converged": False, "advanced": True,
            "bun": bun}


def server_launch_argv() -> list[str]:
    """The ABSOLUTE argv that RUNS the provisioned server (CR-CRU-066 §S3).

    `$BUN_INSTALL/bin/crucible-server` when the [server] install stage has
    provisioned it, else the version-pinned package through the resolved
    ABSOLUTE Bun (`<bun> x <pkg>@<pinned>` — what `bunx` is). Never a bare
    `crucible-server`/`bun`/`bunx` token: the systemd `--user` unit that
    renders this argv into its `ExecStart` (CR-CRU-070 AC1) gets a minimal PATH
    that resolves none of them.

    This RUNS the server, it never provisions one — `bun add -g` is the
    [server] stage's job (§S1). So Bun is resolved and verified with the curl
    bootstrap OPTED OUT: a missing Bun fails with the same named remedy rather
    than piping a remote installer to a shell from a run command.
    """
    server_bin = _provisioned_server_bin_path()
    if os.path.isfile(server_bin):
        return [server_bin]
    bun = _guarantee_bun(no_bun_bootstrap=True)
    server_version = _resolved_server_version_or_fail()
    return [bun, "x", f"{SERVER_NPM_PACKAGE}@{server_version}"]


def user_unit_dir() -> str:
    """The directory `systemctl --user` reads units from --
    `$XDG_CONFIG_HOME/systemd/user`, else `<HOME>/.config/systemd/user`
    (CR-CRU-070 §Scope).

    The same XDG rule the user manager itself applies, so the unit lands where
    it is actually read. Never a system-scope directory: that needs root, which
    this install never has.
    """
    config_home = os.environ.get(CONFIG_HOME_ENV_VAR, "").strip()
    if not config_home:
        config_home = os.path.join(os.path.expanduser("~"),
                                   *_DEFAULT_CONFIG_HOME_SUFFIX)
    return os.path.join(os.path.expanduser(config_home), *_USER_UNIT_SUBDIR)


def user_unit_path() -> str:
    """Absolute path of the `--user` unit the [unit] stage owns."""
    return os.path.join(user_unit_dir(), UNIT_FILE_NAME)


def _service_disabled(no_service: bool = False) -> bool:
    """Whether the operator opted OUT of the systemd surface -- the
    `--no-service` flag or `$CRUCIBLE_NO_SERVICE` (CR-CRU-070 AC4), read
    exactly as `_bun_bootstrap_disabled` reads its own opt-out."""
    if no_service:
        return True
    raw = os.environ.get(NO_SERVICE_ENV_VAR, "").strip().lower()
    return raw not in ("", "0", "false", "no", "off")


def _user_bus_available() -> bool:
    """Whether a user D-Bus session looks reachable, WITHOUT spawning anything.

    `systemctl --user` is useless without one (an ssh session with no
    `systemd --user`, a CI container), and asking the environment first is what
    keeps the opt-out-free absent-systemd path from shelling out at all.
    """
    if os.environ.get(DBUS_SESSION_ENV_VAR, "").strip():
        return True
    runtime_dir = os.environ.get(RUNTIME_DIR_ENV_VAR, "").strip()
    return bool(runtime_dir) and os.path.exists(
        os.path.join(runtime_dir, _USER_BUS_SOCKET_NAME))


def _run_systemctl(systemctl: str, *arguments: str):
    """Run `systemctl --user <arguments>`; the `CompletedProcess`, or None when
    the user manager is UNREACHABLE (the binary vanished mid-run, or no bus
    answered).

    `--user` is not optional: the system manager would need root, which this
    install never has. Output is CAPTURED -- stdout belongs to the ONE TOON-AXI
    envelope the verb emits, so systemctl's chatter must never land in it.
    """
    argv = [systemctl, _USER_SCOPE_FLAG, *arguments]
    try:
        completed = subprocess.run(argv, check=False, capture_output=True,
                                   text=True)
    except OSError:  # the resolved systemctl is gone / not executable
        return None
    stderr = getattr(completed, "stderr", None) or ""
    if completed.returncode != 0 and \
            _BUS_FAILURE_NEEDLE in str(stderr).lower():
        return None
    return completed


def _unit_log(systemctl: str) -> str:
    """The failed unit's OWN last output, as `systemctl --user status` shows it.

    systemd captures a `--user` unit's stdout/stderr into the journal, so this
    is where the server's store refusal (`REFUSING TO OPEN ...`) or migration
    failure (`MIGRATION FAILED on ...`) lands -- including the
    `<store>.pre-upgrade-<epoch>` backup to restore from. Read-only, and only
    ever called once a start has already failed.
    """
    completed = _run_systemctl(systemctl, _UNIT_LOG_VERB, _NO_PAGER_FLAG,
                               UNIT_FILE_NAME)
    if completed is None:
        return ""
    return str(getattr(completed, "stdout", None) or "")


def _start_service_or_fail(systemctl: str, *arguments: str) -> None:
    """Run a systemctl verb that STARTS the service, and FAIL when it could not
    (CR-CRU-071 AC8).

    Starting is where the new build opens the store and runs the migration
    chain, so the start's outcome IS the upgrade's migration gate: a store this
    build refuses to open (AC5 -- a newer Crucible wrote it) or a migration step
    that threw (AC7) leaves the service dead, and swallowing the returncode is
    what would leave a new binary pointed at a store it cannot open while the
    install reported `ok: true`. The failure carries the server's own message,
    fetched from the unit's log, so the operator reads the refusal and its
    backup path instead of going digging in the journal.

    An UNREACHABLE manager still DEGRADES (CR-CRU-070 AC4): `_run_systemctl`
    answers None for a machine whose user bus went away, which is not a failed
    start and must not fail the install.
    """
    completed = _run_systemctl(systemctl, *arguments)
    if completed is None or completed.returncode == 0:
        return
    reported = "\n".join(
        text.strip() for text in (
            str(getattr(completed, "stdout", None) or ""),
            str(getattr(completed, "stderr", None) or ""),
            _unit_log(systemctl))
        if text.strip())
    raise RuntimeError(
        f"`{SYSTEMCTL_BIN_NAME} {_USER_SCOPE_FLAG} {' '.join(arguments)}` "
        f"exited with returncode {completed.returncode}, so the server never "
        f"started and this upgrade is NOT complete (CR-CRU-071 AC8). The store "
        f"is under {store_dir()}; a store this build REFUSES to open, or a "
        f"migration that threw and rolled back, is reported below and names "
        f"the pre-upgrade backup to restore from. "
        f"{SYSTEMCTL_BIN_NAME} reported:\n{reported}")


def _unit_manager(no_service: bool = False) -> tuple[str | None, str]:
    """The absolute `systemctl` the [unit] stage may drive, or `(None, reason)`
    naming why it may not -- decided WITHOUT spawning anything (CR-CRU-070
    AC4).

    Opt-out first, so an explicit `--no-service` never probes a machine whose
    user manager is perfectly healthy.
    """
    if _service_disabled(no_service):
        return None, _OPT_OUT_REASON
    systemctl = shutil.which(SYSTEMCTL_BIN_NAME)
    if not systemctl:
        return None, _NO_SYSTEMCTL_REASON
    if not _user_bus_available():
        return None, _NO_USER_BUS_REASON
    return os.path.abspath(systemctl), ""


def _manager_probe_reason(systemctl: str) -> str:
    """`""` when the user manager answers a READ-ONLY probe, else the reason it
    does not -- the second bus check, through the subprocess seam rather than
    the environment (an inherited `$DBUS_SESSION_BUS_ADDRESS` outlives the bus
    it names)."""
    if _run_systemctl(systemctl, _MANAGER_PROBE_VERB) is None:
        return _NO_USER_BUS_REASON
    return ""


def _unit_state(systemctl: str, probe: str) -> bool:
    """Whether a read-only unit probe (`is-enabled`, `is-active`) answers yes."""
    completed = _run_systemctl(systemctl, probe, UNIT_FILE_NAME)
    return completed is not None and completed.returncode == 0


def _unit_path_value() -> str | None:
    """`PATH` for the unit, or None when Bun cannot be resolved.

    An absolute `ExecStart` is NOT sufficient. The published
    `crucible-server` bin is a SHIM that spawns bare `bun` ITSELF, so under a
    unit -- which inherits no shell `PATH` -- that spawn resolves to nothing
    and the service dies `status=127` in a `Restart=on-failure` loop. Observed
    exactly that on a real `--user` unit before this was added:

        crucible-server: failed to launch bun on .../src/server.ts:
          spawn bun ENOENT

    CR-CRU-066 made OUR argv absolute; it cannot reach inside the npm
    package's own launcher. So the unit puts the RESOLVED Bun's directory
    first, then a minimal system PATH for anything else the server shells out
    to. The curl bootstrap is OPTED OUT: rendering a unit must never pipe a
    remote installer to a shell.
    """
    bun = _resolve_bun_path()
    if bun is None:
        return None
    return os.pathsep.join([os.path.dirname(bun), "/usr/local/bin",
                            "/usr/bin", "/bin"])


def _unit_environment() -> list[tuple[str, str]]:
    """The `PATH` the shim needs, plus the `CRUCIBLE_*` knobs to forward, as
    `(name, value)`.

    Only the `CRUCIBLE_*` ones actually SET: `Environment=CRUCIBLE_PORT=` would
    override the server's own default with nothing, which is worse than not
    forwarding it.
    """
    forwarded = []
    path_value = _unit_path_value()
    if path_value is not None:
        forwarded.append(("PATH", path_value))
    for name in (SERVER_HOST_ENV_VAR, SERVER_PORT_ENV_VAR, SERVER_DB_ENV_VAR):
        value = os.environ.get(name, "")
        if value.strip():
            forwarded.append((name, value))
    return forwarded


def _render_user_unit() -> str:
    """The `--user` unit text (CR-CRU-070 AC1).

    `ExecStart` is `server_launch_argv()` -- the ABSOLUTE argv `serve` runs, the
    function CR-CRU-066 §S3 built for exactly this: a unit inherits no shell
    PATH, so a bare `crucible-server`/`bun`/`bunx` token would resolve to
    nothing. `Restart=on-failure` brings a CRASHED server back while leaving a
    clean `systemctl --user stop` alone (the 128+N contract CR-CRU-066 shipped),
    and `[Install] WantedBy=default.target` is what `enable` has to link.

    Deterministic byte-for-byte: the text carries no timestamp and no
    machine-specific ordering, which is what lets the install compare it
    against the unit on disk and decline to rewrite an unchanged one (AC2).
    """
    lines = [
        "# Managed by crucible-axi install (CR-CRU-070). Edits are OVERWRITTEN",
        "# by the next `crucible-axi install`; `crucible-axi uninstall`",
        f"# removes it. Opt out with --no-service / ${NO_SERVICE_ENV_VAR}.",
        "[Unit]",
        "Description=Crucible test-reporting server",
        "After=network.target",
        "",
        "[Service]",
        "Type=simple",
        f"ExecStart={shlex.join(server_launch_argv())}",
        "Restart=on-failure",
        "RestartSec=2",
    ]
    lines += [f"Environment={name}={value}"
              for name, value in _unit_environment()]
    lines += ["", "[Install]", "WantedBy=default.target", ""]
    return "\n".join(lines)


def _existing_unit_text(unit_path: str) -> str | None:
    """The unit already on disk, or None when there is none to compare."""
    try:
        with open(unit_path, encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return None


def _skipped_unit(unit_path: str, reason: str) -> dict:
    """A stage row saying the systemd surface was NOT touched, and WHY.

    `converged: True` is the honest answer: a skip leaves nothing half-done, and
    a systemd-less machine's `uninstall` must still report every stage converged
    (CR-CRU-069 AC3). The path is reported either way, so the operator can see
    WHERE the unit would have gone.
    """
    return {"path": unit_path, "converged": True, "skipped": True,
            "reason": reason}


def _unit_stage(target_dir: str, force: bool, no_service: bool = False,
                server_advanced: bool = False) -> dict:
    """[unit] sub-installer -- provisions the systemd `--user` unit that runs
    the server the way `serve` does (CR-CRU-070 AC1/AC2).

    WRITE -> `daemon-reload` -> `enable --now`, in that order: reloading before
    the file exists makes systemd re-read a directory that does not yet contain
    the unit, and enabling before the reload enables a definition the manager
    has not read.

    Idempotent in both halves. An UNCHANGED unit is not rewritten (a rewrite
    churns the mtime on every install) and an already-enabled, already-active
    service is not touched (a restart drops every live SSE subscriber for
    nothing). `force` re-asserts the manager state without rewriting identical
    bytes.

    `server_advanced` is the ONE exception, and CR-CRU-071 AC9: when the
    `[server]` stage re-provisioned IN THIS RUN, the live process is still
    serving the code `bun add -g` replaced, so an ACTIVE service is restarted.
    The signal comes from the stage sequence alone -- never from re-reading the
    installed version or re-resolving the pin, because two sources of truth for
    "did the server advance?" is exactly how the missing-restart bug appeared:
    the `[server]` stage compared VERSIONS, this stage compared unit TEXT, and
    `ExecStart` is version-independent so the text never changed. A converged
    server plus an unchanged unit therefore still writes nothing and restarts
    nothing. `force` restarts an active service too -- it is the "make it match
    whatever the state" escape hatch.

    Every START is GATED (AC8): starting is where the new build opens the store
    and runs the migration chain, so a store it refuses to open or a migration
    that threw makes the start fail, and that failure FAILS THE RUN with the
    server's own message rather than being swallowed into an `ok: true`
    install pointing a new binary at a store it cannot open.

    Absent systemd DEGRADES, never fails (AC4): no `systemctl`, no user bus, or
    an explicit opt-out reports skipped-with-reason, and the overall install
    stays ok -- the base install has no systemd dependency.

    `target_dir` is unused: a `--user` unit belongs where the user manager reads
    it, never under the client's target dir.
    """
    unit_path = user_unit_path()
    systemctl, reason = _unit_manager(no_service)
    if systemctl is None:
        return _skipped_unit(unit_path, reason)
    unreachable = _manager_probe_reason(systemctl)
    if unreachable:
        return _skipped_unit(unit_path, unreachable)

    desired = _render_user_unit()
    changed = _existing_unit_text(unit_path) != desired
    if changed:
        os.makedirs(os.path.dirname(unit_path), exist_ok=True)
        with open(unit_path, "w", encoding="utf-8") as handle:
            handle.write(desired)
    if changed or force:
        _run_systemctl(systemctl, "daemon-reload")

    # `is-active` FIRST: it is the probe the restart decision needs, and an
    # inactive service short-circuits the enablement check exactly as before.
    active = _unit_state(systemctl, "is-active")
    provisioned = active and _unit_state(systemctl, "is-enabled")
    if force or not provisioned:
        _start_service_or_fail(systemctl, "enable", "--now", UNIT_FILE_NAME)

    # AC9 -- an INACTIVE unit has no stale process to replace (`enable --now`
    # above just started the new code), so only a running one is re-exec'd.
    restarted = active and (server_advanced or force)
    if restarted:
        _start_service_or_fail(systemctl, _RESTART_VERB, UNIT_FILE_NAME)

    return {"path": unit_path,
            "converged": not changed and not force and provisioned,
            "restarted": restarted}
def run_fleet_stage(target_dir: str, force: bool = False) -> dict:
    """[fleet] sub-installer — lay the eight packaged fleet files down under
    `<target-dir>/clients/` (CR-CRU-090 §S1).

    This is the directory `manifest.build_manifest` anchors all six of its
    published paths on, which is why the stage is ordered strictly BEFORE
    [manifest]: the manifest is written only after the paths it names exist.

    The copy is confined to `<target-dir>/clients/` (created when absent) and
    is byte-for-byte, MODE INCLUDED: each landed file carries its source's
    permission bits, so the three executable clients arrive executable instead
    of 0o644 under the operator's umask (which would make
    `<target-dir>/clients/rust-crucible.py` unrunnable directly). Confinement
    is ENFORCED, not merely intended: a SYMLINK sitting at one of the eight
    destination names is REPLACED by a regular file and never followed, because
    both the read-compare and the write traverse a link and would otherwise
    land a client's bytes in a file the operator never pointed `--target-dir`
    at. Destination files that are not one of the eight are left
    untouched — the install never removes what it does not manage. A missing
    SOURCE file fails the stage definitively with that path named: `run_install`
    is fail-fast, so it surfaces as `ok=False` plus a `stage-failed` warning
    instead of a silent partial laydown, which is the exact defect class this
    CR exists to kill.

    `converged` mirrors `manifest.run_manifest_stage`'s contract — the in-repo
    precedent for this exact read-compare-then-write shape: a destination file
    whose bytes ALREADY match its source is left alone (not rewritten, so its
    mtime survives), and `converged` is True only when EVERY one of the eight
    already matched. Convergence is all-or-nothing: one stale or missing file
    makes the stage report `converged: False`, and only that file is rewritten.
    `--force` re-copies all eight unconditionally and reports
    `converged: False`. The verdict is decided over the eight SOURCE files
    only — an unmanaged destination file is never read for it, so it can
    neither be rewritten nor defeat convergence. Bytes are the only input:
    never a size or an mtime, either of which a truncated or touched copy
    would pass. A destination symlink is always replaced, so the run that
    replaces one reports `converged: False` and the next run — comparing a
    regular file — converges normally.
    """
    source_dir = manifest.source_clients_dir()
    clients_dir = os.path.join(target_dir, FLEET_DIRNAME)
    os.makedirs(clients_dir, exist_ok=True)
    converged = not force
    for name in FLEET_FILES:
        source = os.path.join(source_dir, name)
        if not os.path.isfile(source):
            raise FileNotFoundError(
                f"packaged fleet file missing at source: {source}")
        destination = os.path.join(clients_dir, name)
        # §S1's confinement rule, ENFORCED: the copy lands inside
        # `<target-dir>/clients/` and nowhere else. `os.path.isfile` and
        # `Path.write_bytes` BOTH traverse a symlink, so a link left at one of
        # the eight names would make the compare read — and the write
        # overwrite — a file outside the target dir, and would leave the link
        # in place for every later run to escape through again. Unlinking
        # BEFORE the compare also stops a link whose target happens to match
        # the source from masquerading as an already-converged destination.
        # `islink` is true for a DANGLING link too, which is the shape that
        # would otherwise CREATE the outside file.
        if os.path.islink(destination):
            os.unlink(destination)
        fresh = Path(source).read_bytes()
        if (not force
                and os.path.isfile(destination)
                and Path(destination).read_bytes() == fresh):
            continue
        Path(destination).write_bytes(fresh)
        # The mode is part of the payload: `write_bytes` creates with the
        # process umask, which strips the executable bit three of the eight
        # carry at source. `copymode` also NORMALISES an existing
        # destination's mode to the source's, so a `--force` re-copy repairs a
        # mode that drifted out of band.
        shutil.copymode(source, destination)
        converged = False
    return {"path": clients_dir, "converged": converged}


# Module-level, in-place-mutable stage table (patched by tests via
# mock.patch.dict). `run_install` reads this name at call time.
DEFAULT_STAGE_RUNNERS: dict = {
    "server": _server_stage,
    "fleet": run_fleet_stage,
    "manifest": manifest.run_manifest_stage,
    "unit": _unit_stage,
}


def _abbreviate_home(path: str) -> str:
    """Abbreviate a $HOME-rooted path to `~/...` (identity otherwise)."""
    home = os.path.expanduser("~")
    if path == home:
        return "~"
    if path.startswith(home + os.sep):
        return "~" + path[len(home):]
    return path


def _stage_options(runner, no_bun_bootstrap: bool, no_service: bool,
                   server_advanced: bool = False) -> dict:
    """The extra keyword options a stage runner OPTS INTO by declaring them.

    Keeps the `(target_dir, force)` runner protocol intact -- injected doubles
    that take exactly those two arguments are called exactly as before -- while
    letting the real `[server]` stage receive `no_bun_bootstrap` (CR-CRU-066
    §S2 AC4), the real `[unit]` stage `no_service` (CR-CRU-070 AC4) and, since
    CR-CRU-071 AC9, whatever the EARLIER stages of this very run reported:
    `server_advanced` says the `[server]` stage re-provisioned, which is the
    only thing that licenses restarting a live service. All three arrive as
    declared parameters instead of any stage reaching for global state.
    """
    try:
        parameters = inspect.signature(runner).parameters
    except (TypeError, ValueError):  # builtins/C callables expose no signature
        return {}
    options = {}
    if "no_bun_bootstrap" in parameters:
        options["no_bun_bootstrap"] = no_bun_bootstrap
    if "no_service" in parameters:
        options["no_service"] = no_service
    if "server_advanced" in parameters:
        options["server_advanced"] = server_advanced
    return options


def run_install(target_dir, stage_runners=None, force=False,
                no_bun_bootstrap=False, no_service=False):
    """Run the staged install; return `(ok, stages, warnings)`.

    `stages` is a list of `{"name", "path" (~-abbreviated), "converged"}` in
    `STAGE_ORDER` up to (and excluding) the first failing stage, plus any
    stage-specific output the runner reported (the `[server]` stage's resolved
    absolute `bun` path — CR-CRU-066 §S2). A stage exception halts the sequence
    and surfaces as `ok=False` plus a warning — the failure is recorded
    visibly, never swallowed.

    `target_dir` is CREATED first (`os.makedirs(..., exist_ok=True)` — §S1b):
    the stages write into it, so a fresh machine without `~/.crucible` would
    otherwise die on the [manifest] write. A target that cannot be created
    fails definitively with the path named.

    `no_bun_bootstrap` is the `--no-bun-bootstrap` opt-out and `no_service` the
    `--no-service` one (CR-CRU-070 AC4), each threaded down to the stages that
    accept it.

    The sequence also carries what an EARLIER stage reported into the later
    ones: an `advanced` `[server]` stage (it re-provisioned) becomes the
    `[unit]` stage's `server_advanced`, which is the ONLY thing that licenses
    restarting a live service (CR-CRU-071 AC9). Nothing re-derives it -- the
    stage that did the work is the single source of truth.
    """
    runners = stage_runners if stage_runners is not None else DEFAULT_STAGE_RUNNERS
    stages: list[dict] = []
    warnings: list[dict] = []
    ok = True

    # §S1b — create what the install installs INTO, before any stage runs.
    # Idempotent by `exist_ok`; an uncreatable target (permissions) fails
    # definitively, naming the path, instead of surfacing later as a cryptic
    # missing-manifest error.
    try:
        os.makedirs(target_dir, exist_ok=True)
    except OSError as exc:
        warnings.append({
            "code": "target-dir-failed",
            "detail": f"could not create target dir {target_dir}: {exc}",
        })
        return False, stages, warnings

    # CR-CRU-071 AC9 -- what the `[server]` stage reported, carried forward to
    # the `[unit]` stage. False until that stage has actually said otherwise,
    # so an injected double that provisions nothing never restarts anything.
    server_advanced = False

    for name in STAGE_ORDER:
        runner = runners[name]
        try:
            result = runner(target_dir, force,
                            **_stage_options(runner, no_bun_bootstrap,
                                             no_service, server_advanced))
        except Exception as exc:  # noqa: BLE001 — fail-fast: record + halt
            ok = False
            warnings.append({
                "code": "stage-failed",
                "detail": f"{name} stage failed: {exc}",
            })
            break
        if name == SERVER_STAGE_NAME:
            server_advanced = bool(result.get("advanced", False))
        stage = {
            "name": name,
            "path": _abbreviate_home(str(result.get("path", ""))),
            "converged": bool(result.get("converged", False)),
        }
        # A stage that DECLINED says so, and says why (CR-CRU-070 AC4): a
        # silent absence of a daemon is the bug the reason exists to prevent.
        if result.get("skipped"):
            stage["skipped"] = True
        reason = result.get("reason")
        if reason:
            stage["reason"] = str(reason)
        # The resolved Bun path is reported verbatim (never ~-abbreviated): it
        # is the executable the install ran, so it must stay runnable as-is.
        bun = result.get("bun")
        if bun:
            stage["bun"] = str(bun)
        # A RESTART is disclosed (CR-CRU-071 AC9): it drops every live SSE
        # subscriber, so an operator watching an upgrade must see that it
        # happened on purpose rather than infer it from a broken stream.
        if result.get("restarted"):
            stage["restarted"] = True
        stages.append(stage)

    return ok, stages, warnings


def _server_uninstall_stage(target_dir: str, purge: bool) -> dict:
    """[server] inverse -- DE-PROVISIONS the server with
    `<abs-bun> remove -g <SERVER_NPM_PACKAGE>` (CR-CRU-069 §S1).

    The exact inverse of `_server_stage`'s `bun add -g`, through the same
    absolute-Bun resolution: Bun links the `crucible-server` bin into its
    global prefix, so only Bun knows how to unlink it, and a bare `bun` token
    off an inherited PATH is as wrong here as it is on the install path.

    Idempotent, and the probe is answered from the FILESYSTEM before Bun is
    touched at all: an already-absent artifact converges without spawning any
    subprocess (not even `bun --version`), so a second uninstall -- or a
    machine that never installed -- is a no-op rather than a failure.

    Bun itself is NEVER removed (AC5): install only GUARANTEES Bun, it does not
    own it. For the same reason the curl bootstrap is OPTED OUT here -- an
    uninstall that pipes a remote installer to a shell to acquire the tool it
    is about to stop using would be absurd.

    `purge` is unused: the program artifacts are what a plain uninstall
    removes, and no `--purge` escalation applies to them.
    """
    server_path = _provisioned_server_bin_path()
    if not os.path.lexists(server_path) and \
            not os.path.isdir(_provisioned_server_package_dir()):
        return {"path": server_path, "converged": True}

    bun = _guarantee_bun(no_bun_bootstrap=True)
    removal_argv = [bun, "remove", "-g", SERVER_NPM_PACKAGE]
    completed = subprocess.run(removal_argv, check=False)
    if completed.returncode != 0:
        raise RuntimeError(
            f"server stage failed: `{' '.join(removal_argv)}` exited with "
            f"returncode {completed.returncode}")

    return {"path": server_path, "converged": False, "bun": bun}


def _config_uninstall_stage(target_dir: str, purge: bool) -> dict:
    """[config] inverse -- removes `<target-dir>/crucible-clients.json`, the
    artifact the [manifest] install stage wrote, but ONLY under `purge`.

    Without `purge` the stage is a NO-OP that reports the path it RETAINED: a
    plain uninstall destroys nothing and stays reversible by reinstalling, and
    automation must never be left guessing where the state it kept now lives.
    """
    path = config_path(target_dir)
    if not purge:
        return {"path": path, "converged": True, "retained": True}
    if not os.path.exists(path):
        return {"path": path, "converged": True}
    os.remove(path)
    return {"path": path, "converged": False}


def _store_uninstall_stage(target_dir: str, purge: bool) -> dict:
    """[store] inverse -- removes the server's store directory (every
    `crucible.db` and every `crucible-pre-*.db` backup in it), ONLY under
    `purge`, and LAST of all stages.

    The store is the one irreplaceable artifact, so retention is the default
    and the stage otherwise only reports where the data it kept lives.
    """
    store_path = store_dir()
    if not purge:
        return {"path": store_path, "converged": True, "retained": True}
    if not os.path.isdir(store_path):
        return {"path": store_path, "converged": True}
    shutil.rmtree(store_path)
    return {"path": store_path, "converged": False}


def _unit_uninstall_stage(target_dir: str, purge: bool) -> dict:
    """[unit] inverse -- `disable --now`, remove the unit file, `daemon-reload`,
    and FIRST of all uninstall stages (CR-CRU-070 AC2/AC3).

    Disabling LAST would leave the manager holding a unit whose file is already
    gone -- and `disable --now` is what STOPS the running service rather than
    merely de-linking it for the next login. The closing reload is what makes
    systemd forget the unit instead of keeping it loaded until logout.

    Idempotent, and the probe is answered from the FILESYSTEM before the
    manager is touched at all: an already-absent unit converges without
    spawning any systemctl, exactly as the [server] inverse converges without
    spawning Bun (CR-CRU-069 AC3).

    The unit is a program artifact, so a plain uninstall always removes it and
    `purge` is unused. An opt-out (`$CRUCIBLE_NO_SERVICE`) leaves it strictly
    alone: the operator asked crucible-axi not to manage their systemd.
    """
    unit_path = user_unit_path()
    systemctl, reason = _unit_manager()
    if systemctl is None:
        return _skipped_unit(unit_path, reason)
    if not os.path.lexists(unit_path):
        return {"path": unit_path, "converged": True}
    unreachable = _manager_probe_reason(systemctl)
    if unreachable:
        return _skipped_unit(unit_path, unreachable)

    _run_systemctl(systemctl, "disable", "--now", UNIT_FILE_NAME)
    os.remove(unit_path)
    _run_systemctl(systemctl, "daemon-reload")
    return {"path": unit_path, "converged": False}


# The uninstall counterpart of `DEFAULT_STAGE_RUNNERS` -- module-level and
# in-place-mutable, so a test injects doubles with `mock.patch.dict` exactly as
# it does for install. `run_uninstall` reads this name at call time.
DEFAULT_UNINSTALL_STAGE_RUNNERS: dict = {
    "unit": _unit_uninstall_stage,
    "server": _server_uninstall_stage,
    "config": _config_uninstall_stage,
    "store": _store_uninstall_stage,
}


def run_uninstall(target_dir, stage_runners=None, purge=False):
    """Run the staged uninstall; return `(ok, stages, warnings)` -- the same
    triple, the same fail-fast semantics and the same runner protocol as
    `run_install`, with `purge` where install has `force`.

    `stages` is a list of `{"name", "path" (~-abbreviated), "converged"}` in
    `UNINSTALL_STAGE_ORDER` up to (and excluding) the first failing stage, plus
    whatever the runner reported (`retained` on a stage that kept its artifact,
    the `[server]` stage's resolved absolute `bun`). A stage exception halts
    the sequence and surfaces as `ok=False` plus a warning.

    Unlike `run_install` this does NOT create `target_dir`: an uninstall that
    materialises the directory it is dismantling would be a contradiction, and
    an absent target simply means the config is already gone.
    """
    runners = (stage_runners if stage_runners is not None
               else DEFAULT_UNINSTALL_STAGE_RUNNERS)
    stages: list[dict] = []
    warnings: list[dict] = []
    ok = True

    for name in UNINSTALL_STAGE_ORDER:
        runner = runners[name]
        try:
            result = runner(target_dir, purge)
        except Exception as exc:  # noqa: BLE001 — fail-fast: record + halt
            ok = False
            warnings.append({
                "code": "stage-failed",
                "detail": f"{name} stage failed: {exc}",
            })
            break
        stage = {
            "name": name,
            "path": _abbreviate_home(str(result.get("path", ""))),
            "converged": bool(result.get("converged", False)),
        }
        if result.get("retained"):
            stage["retained"] = True
        # The same declined-with-a-reason row the install side reports
        # (CR-CRU-070 AC4) -- a teardown that skipped systemd must say so.
        if result.get("skipped"):
            stage["skipped"] = True
        reason = result.get("reason")
        if reason:
            stage["reason"] = str(reason)
        # Reported verbatim (never ~-abbreviated): it is the executable the
        # uninstall ran, so it must stay runnable as-is.
        bun = result.get("bun")
        if bun:
            stage["bun"] = str(bun)
        stages.append(stage)

    return ok, stages, warnings
