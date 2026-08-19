"""CR-CRU-009 §S2 — the staged install orchestrator framework.

`run_install` sequences the server -> manifest sub-installers through
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
"""

from __future__ import annotations

import os
import shutil
import subprocess

from crucible_axi import manifest

STAGE_ORDER = ("server", "manifest")

# External sources for the concrete sub-installers. `SERVER_NPM_PACKAGE` is the
# published npm package name and MUST stay equal to the repo package.json's
# `name` field (CR-CRU-041 §S1 — asserted by a test so the two artifacts cannot
# silently drift apart).
SERVER_NPM_PACKAGE = "@anthill-tec/crucible-server"

# Environment escape hatch for the version-pinned server fetch (CR-CRU-041 §S6)
# — for development and for recovering from a bad server publish. Unset means
# the orchestrator's own version, never `latest`.
SERVER_VERSION_ENV_VAR = "CRUCIBLE_SERVER_VERSION"

# The Bun curl-bootstrap the [server] stage runs when Bun is absent from PATH.
_BUN_INSTALL_COMMAND = "curl -fsSL https://bun.sh/install | bash"

# Bun's global install prefix -- where `bun add -g` lays packages down and
# links their bins (CR-CRU-066 §S1). `$BUN_INSTALL` overrides it; the default
# is the user-scoped `~/.bun`, which is why the provision needs no system
# prefix (and no sudo) the way `npm -g` does.
BUN_INSTALL_ENV_VAR = "BUN_INSTALL"
_DEFAULT_BUN_INSTALL_PREFIX = "~/.bun"

# The console-script `SERVER_NPM_PACKAGE` links into Bun's global bin; its
# presence there is the server's REAL installed marker.
SERVER_BIN_NAME = "crucible-server"


def _bun_global_bin_dir() -> str:
    """Bun's global bin directory -- `$BUN_INSTALL/bin` when set, else
    `~/.bun/bin`. Read at call time so both an operator's `$BUN_INSTALL` and a
    prefix that only exists after the curl bootstrap are observed."""
    prefix = os.environ.get(BUN_INSTALL_ENV_VAR) or _DEFAULT_BUN_INSTALL_PREFIX
    return os.path.join(os.path.expanduser(prefix), "bin")


def _provisioned_server_bin_path() -> str:
    """Absolute path of the `crucible-server` bin that `bun add -g` links."""
    return os.path.join(_bun_global_bin_dir(), SERVER_BIN_NAME)


def _server_already_installed(target_dir: str) -> bool:
    """REAL idempotency probe for the [server] sub-installer (CR-CRU-066 §S1) --
    True iff the `crucible-server` bin exists under Bun's global bin.

    Bun owns where the server lands, so `target_dir` (the install/manifest
    root) never holds a server payload: the retired `<target_dir>/server`
    marker-directory probe could never converge because nothing ever created
    it. `target_dir` is kept for the stage-runner signature.

    Tests patch this seam directly."""
    return os.path.isfile(_provisioned_server_bin_path())


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


def _server_stage(target_dir: str, force: bool) -> dict:
    """[server] sub-installer -- PROVISIONS the server user-scoped via
    `bun add -g <SERVER_NPM_PACKAGE>@<version>`, then RETURNS (CR-CRU-066 §S1).

    It never runs the server: that npm package's bin IS the server (it
    `listen`s), so the retired run-the-published-bin delegation blocked forever
    and the install never reached the [manifest] stage. `bun add -g` installs
    the package and links its `crucible-server` bin into Bun's user-scoped
    global prefix (`~/.bun`), so there is no system-prefix permission problem
    either. Running the server is a separate step.

    Bun is bootstrapped via the curl installer FIRST when absent from PATH. The
    provision is VERSION-PINNED (see `_resolve_server_version`).

    Idempotent: an already-provisioned server bin (and not `force`)
    short-circuits to converged=True without shelling out.
    """
    server_path = _provisioned_server_bin_path()

    if not force and _server_already_installed(target_dir):
        return {"path": server_path, "converged": True}

    # Resolve (and validate) the pin BEFORE any side effect -- an unusable
    # version must fail definitively, not after bootstrapping Bun.
    server_version = _resolved_server_version_or_fail()

    if shutil.which("bun") is None:
        subprocess.run(_BUN_INSTALL_COMMAND, shell=True, check=False)

    provision_argv = ["bun", "add", "-g",
                      f"{SERVER_NPM_PACKAGE}@{server_version}"]
    completed = subprocess.run(provision_argv, check=False)
    if completed.returncode != 0:
        raise RuntimeError(
            f"server stage failed: `{' '.join(provision_argv)}` exited with "
            f"returncode {completed.returncode}")

    return {"path": server_path, "converged": False}


# Module-level, in-place-mutable stage table (patched by tests via
# mock.patch.dict). `run_install` reads this name at call time.
DEFAULT_STAGE_RUNNERS: dict = {
    "server": _server_stage,
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


def run_install(target_dir, stage_runners=None, force=False):
    """Run the staged install; return `(ok, stages, warnings)`.

    `stages` is a list of `{"name", "path" (~-abbreviated), "converged"}` in
    `STAGE_ORDER` up to (and excluding) the first failing stage. A stage
    exception halts the sequence and surfaces as `ok=False` plus a warning —
    the failure is recorded visibly, never swallowed.
    """
    runners = stage_runners if stage_runners is not None else DEFAULT_STAGE_RUNNERS
    stages: list[dict] = []
    warnings: list[dict] = []
    ok = True

    for name in STAGE_ORDER:
        runner = runners[name]
        try:
            result = runner(target_dir, force)
        except Exception as exc:  # noqa: BLE001 — fail-fast: record + halt
            ok = False
            warnings.append({
                "code": "stage-failed",
                "detail": f"{name} stage failed: {exc}",
            })
            break
        stages.append({
            "name": name,
            "path": _abbreviate_home(str(result.get("path", ""))),
            "converged": bool(result.get("converged", False)),
        })

    return ok, stages, warnings
