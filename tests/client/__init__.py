"""The client suite runs with its project resolution pointed away from the repo.

Every client resolves its project as `--project-dir`, else its own
`<STACK>_CRUCIBLE_PROJECT_DIR`, else the working directory's repo -- and this
repo's root names the live project. On import, this package therefore points
all five variables at one fresh, empty directory outside the repo, overriding
any inherited value, and removes that directory when the process exits. A
client test that forgets to steer then finds no project and posts nothing.

The setup is idempotent within a process: an environment marker names the
directory, so a second import of the package (under another name) keeps it.

The isolation applies only when unittest imports this package, which it
does in three discovery shapes: `-s tests/client -t .` (the suite's declared
gate), dotted `tests.client.<module>` targets, and discovery from `-s tests`
(where the package loads as `client`). Discovered with `-s tests/client` and
no `-t .`, the top-level directory is `tests/client` itself, its modules load
as top-level `test_x`, and this package is NOT imported unless some module
imports `tests.client.*` -- in that shape the live-project guard finds the
variables unset and fails, naming the cause.

Scope: the isolation covers inherited resolution only. A test that removes
one of these variables from its environment takes responsibility for
steering, by `--project-dir` or by a working directory outside the repo.
"""

import atexit
import os
import shutil
import tempfile

#: The client-steering variables, one per stack.
PROJECT_DIR_VARIABLES = (
    "PY_CRUCIBLE_PROJECT_DIR",
    "BUN_CRUCIBLE_PROJECT_DIR",
    "MVN_CRUCIBLE_PROJECT_DIR",
    "RUST_CRUCIBLE_PROJECT_DIR",
    "ARDUINO_CRUCIBLE_PROJECT_DIR",
)

#: The marker naming this process's isolation directory.
ISOLATION_MARKER = "CRUCIBLE_CLIENT_SUITE_ISOLATION_DIR"


def _isolation_dir():
    """The isolation directory: the one the marker names when it still
    exists, else a fresh one removed at exit."""
    existing = os.environ.get(ISOLATION_MARKER)
    if existing and os.path.isdir(existing):
        return existing
    directory = tempfile.mkdtemp(prefix="crucible-client-suite-isolation-")
    atexit.register(shutil.rmtree, directory, ignore_errors=True)
    os.environ[ISOLATION_MARKER] = directory
    return directory


ISOLATION_DIR = _isolation_dir()
for _variable in PROJECT_DIR_VARIABLES:
    os.environ[_variable] = ISOLATION_DIR
