"""CR-CRU-009 §S2 — the staged install orchestrator framework.

`run_install` sequences the server -> fleet -> manifest sub-installers through
an INJECTABLE stage-runner table (no real subprocess/network in this cycle) and
aggregates each stage's result into `(ok, stages, warnings)`. Stages run in
`STAGE_ORDER`; a stage exception is FAIL-FAST (remaining stages are skipped and
`ok` is False). Each returned stage path is `~`-abbreviated by `run_install`.

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
import shutil
import subprocess
from pathlib import Path

from crucible_axi import manifest

STAGE_ORDER = ("server", "fleet", "manifest")

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
# EXPLICITLY: a systemd `--user` unit (the follow-up CR) inherits neither the
# operator's PATH nor their exports.
SERVER_HOST_ENV_VAR = "CRUCIBLE_HOST"
SERVER_PORT_ENV_VAR = "CRUCIBLE_PORT"

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
    candidates = [os.path.join(prefix, *BUN_GLOBAL_NODE_MODULES,
                               *SERVER_NPM_PACKAGE.split("/"), "package.json")]

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

    return {"path": server_path, "converged": False, "bun": bun}


def server_launch_argv() -> list[str]:
    """The ABSOLUTE argv that RUNS the provisioned server (CR-CRU-066 §S3).

    `$BUN_INSTALL/bin/crucible-server` when the [server] install stage has
    provisioned it, else the version-pinned package through the resolved
    ABSOLUTE Bun (`<bun> x <pkg>@<pinned>` — what `bunx` is). Never a bare
    `crucible-server`/`bun`/`bunx` token: the follow-up systemd `--user` unit
    gets a minimal PATH that resolves none of them.

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
}


def _abbreviate_home(path: str) -> str:
    """Abbreviate a $HOME-rooted path to `~/...` (identity otherwise)."""
    home = os.path.expanduser("~")
    if path == home:
        return "~"
    if path.startswith(home + os.sep):
        return "~" + path[len(home):]
    return path


def _stage_options(runner, no_bun_bootstrap: bool) -> dict:
    """The extra keyword options a stage runner OPTS INTO by declaring them.

    Keeps the `(target_dir, force)` runner protocol intact -- injected doubles
    that take exactly those two arguments are called exactly as before -- while
    letting the real `[server]` stage receive `no_bun_bootstrap` (CR-CRU-066
    §S2 AC4) instead of reaching for global state.
    """
    try:
        parameters = inspect.signature(runner).parameters
    except (TypeError, ValueError):  # builtins/C callables expose no signature
        return {}
    if "no_bun_bootstrap" in parameters:
        return {"no_bun_bootstrap": no_bun_bootstrap}
    return {}


def run_install(target_dir, stage_runners=None, force=False,
                no_bun_bootstrap=False):
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

    `no_bun_bootstrap` is the `--no-bun-bootstrap` opt-out, threaded down to
    the stages that accept it.
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

    for name in STAGE_ORDER:
        runner = runners[name]
        try:
            result = runner(target_dir, force,
                            **_stage_options(runner, no_bun_bootstrap))
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
        # The resolved Bun path is reported verbatim (never ~-abbreviated): it
        # is the executable the install ran, so it must stay runnable as-is.
        bun = result.get("bun")
        if bun:
            stage["bun"] = str(bun)
        stages.append(stage)

    return ok, stages, warnings
