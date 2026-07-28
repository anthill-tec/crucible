"""CR-CRU-009 §S2 — the staged install orchestrator framework.

`run_install` sequences the server -> skills -> manifest sub-installers through
an INJECTABLE stage-runner table (no real subprocess/network in this cycle) and
aggregates each stage's result into `(ok, stages, warnings)`. Stages run in
`STAGE_ORDER`; a stage exception is FAIL-FAST (remaining stages are skipped and
`ok` is False). Each returned stage path is `~`-abbreviated by `run_install`.

`DEFAULT_STAGE_RUNNERS` is a module-level, in-place-mutable dict (tests patch it
via `mock.patch.dict`); `run_install` reads it by name at call time so a patch
is always observed. In C1 the server/skills default runners are minimal
placeholders — the real delegation is C2 — while the manifest runner already
drives the real manifest module.
"""

from __future__ import annotations

import os
import shutil
import subprocess

from crucible_axi import manifest

STAGE_ORDER = ("server", "skills", "manifest")

# External sources for the concrete sub-installers. `SERVER_NPM_PACKAGE` is the
# published npm package name and MUST stay equal to the repo package.json's
# `name` field (CR-CRU-041 §S1 — asserted by a test so the two artifacts cannot
# silently drift apart).
SERVER_NPM_PACKAGE = "@anthill-tec/crucible-server"
SKILLS_CLI_SOURCE = "crucible-dev/crucible"  # TODO(S6): real public owner/repo source

# Environment escape hatch for the version-pinned server fetch (CR-CRU-041 §S6)
# — for development and for recovering from a bad server publish. Unset means
# the orchestrator's own version, never `latest`.
SERVER_VERSION_ENV_VAR = "CRUCIBLE_SERVER_VERSION"

# The Bun curl-bootstrap the [server] stage runs when Bun is absent from PATH.
_BUN_INSTALL_COMMAND = "curl -fsSL https://bun.sh/install | bash"


def _server_already_installed(target_dir: str) -> bool:
    """Idempotency detection seam for the [server] sub-installer -- True when the
    server has already been laid down under `target_dir`. Tests patch this
    directly; the on-disk probe is a simple marker-directory check."""
    return os.path.isdir(os.path.join(target_dir, "server"))


def _skills_already_installed(target_dir: str) -> bool:
    """Idempotency detection seam for the [skills] sub-installer -- True when the
    Crucible skill set has already been synced. Tests patch this directly; the
    on-disk probe is a simple marker-directory check."""
    return os.path.isdir(os.path.join(target_dir, "skills"))


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
    # Deferred import: resolves the package's CURRENT `__version__` at call
    # time rather than binding the module object at import time (and keeps this
    # module free of a package-level circular import).
    from crucible_axi import __version__ as axi_version
    return axi_version


def _resolved_server_version_or_fail() -> str:
    """Return the server version to pin, or FAIL FAST when it is unusable
    (CR-CRU-041 §S6).

    The one unusable case is the source-checkout fallback: when crucible-axi is
    not installed as a package, `crucible_axi.__version__` is the
    `_SOURCE_CHECKOUT_VERSION` sentinel, which is not a valid npm version — a
    pin built from it makes `npx` fail with an opaque error deep inside the
    install. With `CRUCIBLE_SERVER_VERSION` set the operator has named the
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
    """[server] sub-installer -- `npx -y <SERVER_NPM_PACKAGE>@<version>` fetches +
    runs the bun/node server, bootstrapping Bun via the curl installer first if
    absent. The fetch is VERSION-PINNED (see `_resolve_server_version`).

    Idempotent: an already-installed server (and not `force`) short-circuits to
    converged=True without shelling out.
    """
    server_path = os.path.join(target_dir, "server")

    if not force and _server_already_installed(target_dir):
        return {"path": server_path, "converged": True}

    # Resolve (and validate) the pin BEFORE any side effect -- an unusable
    # version must fail definitively, not after bootstrapping Bun.
    server_version = _resolved_server_version_or_fail()

    if shutil.which("bun") is None:
        subprocess.run(_BUN_INSTALL_COMMAND, shell=True, check=False)

    pinned_package = f"{SERVER_NPM_PACKAGE}@{server_version}"
    completed = subprocess.run(
        ["npx", "-y", pinned_package], check=False)
    if completed.returncode != 0:
        raise RuntimeError(
            f"server stage failed: `npx -y {pinned_package}` exited with "
            f"returncode {completed.returncode}")

    return {"path": server_path, "converged": False}


def _skills_stage(target_dir: str, force: bool) -> dict:
    """[skills] sub-installer -- `npx skills add <SKILLS_CLI_SOURCE> --skill '*'
    --agent '*' -g -y` installs the Crucible skill set into every detected
    harness (global scope, non-interactive).

    Idempotent: an already-installed skill set (and not `force`) short-circuits
    to converged=True without shelling out.
    """
    skills_path = os.path.join(target_dir, "skills")

    if not force and _skills_already_installed(target_dir):
        return {"path": skills_path, "converged": True}

    completed = subprocess.run(
        ["npx", "skills", "add", SKILLS_CLI_SOURCE,
         "--skill", "*", "--agent", "*", "-g", "-y"],
        check=False)
    if completed.returncode != 0:
        raise RuntimeError(
            f"skills stage failed: `npx skills add {SKILLS_CLI_SOURCE}` exited "
            f"with returncode {completed.returncode}")

    return {"path": skills_path, "converged": False}


# Module-level, in-place-mutable stage table (patched by tests via
# mock.patch.dict). `run_install` reads this name at call time.
DEFAULT_STAGE_RUNNERS: dict = {
    "server": _server_stage,
    "skills": _skills_stage,
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
