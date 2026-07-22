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

from crucible_axi import manifest

STAGE_ORDER = ("server", "skills", "manifest")


def _server_stage(target_dir: str, force: bool) -> dict:
    """C1 placeholder for the [server] sub-installer (real npx/uv delegation is
    C2). Reports the path the server would be laid down at."""
    return {"path": os.path.join(target_dir, "server"), "converged": False}


def _skills_stage(target_dir: str, force: bool) -> dict:
    """C1 placeholder for the [skills] sub-installer (real skills sync is C2)."""
    return {"path": os.path.join(target_dir, "skills"), "converged": False}


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
