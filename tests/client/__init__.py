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

The test install (CR-CRU-260 AC6, AC10)
---------------------------------------
A client derives its install dir from its own location, so a client loaded
or spawned from the checkout takes the REPO ROOT as its install and reads the
operator's git-ignored root `crucible.toml`. On import this package therefore
also lays down a TEST INSTALL it owns, outside the repo: a directory named
`<TEST_INSTALL_PREFIX><pid>-...` holding a `clients` symlink to the
checkout's client source and a `crucible.toml` that declares no board, no
`[lint]` or `[run]` table and no limits. The suite reaches its clients only
through this package:

- LOAD or SPAWN a client: `client_script(name)`, `load_client(name)`,
  `TEST_INSTALL_CLIENTS`;
- READ client source or COPY it into a test's own install:
  `CLIENT_SOURCE_DIR`.

Ownership: the process that CREATES the install removes it at exit; a child
that finds it through `TEST_INSTALL_MARKER` reuses it and never removes it.
A run killed before its exit leaves an install the NEXT creation sweeps
(any prefixed install whose creator PID is dead).
"""

import atexit
import importlib.util
import itertools
import os
import shutil
import tempfile
from pathlib import Path

#: The client-steering variables, one per stack.
PROJECT_DIR_VARIABLES = (
    "PY_CRUCIBLE_PROJECT_DIR",
    "BUN_CRUCIBLE_PROJECT_DIR",
    "MVN_CRUCIBLE_PROJECT_DIR",
    "RUST_CRUCIBLE_PROJECT_DIR",
    "ARDUINO_CRUCIBLE_PROJECT_DIR",
    "GO_CRUCIBLE_PROJECT_DIR",
    "EDA_CRUCIBLE_PROJECT_DIR",
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

#: The root `.env`'s registry variables (CR-CRU-260 AC9). direnv exports the
#: root `.env` into the operator's shell, so they arrive by inheritance; the
#: suite drops them at import. Kept in step with the bun preload
#: (`tests/helpers/isolated-store-preload.ts`).
ENV_REGISTRY_VARIABLES = (
    "CRUCIBLE_PROJECT_KEY",
    "CRUCIBLE_PROJECT_NAME",
    "WORKFLOW_ORCHESTRATOR",
    "SANDESH_PROJECT",
    "SANDESH_ADDRESS",
    "PROJECT_TOKEN",
    "PROJECT_STACKS",
    "KNOWLEDGE_CATEGORY",
)
for _variable in ENV_REGISTRY_VARIABLES:
    os.environ.pop(_variable, None)

#: The checkout's client source: for READING client source or COPYING it into
#: a test's own install -- never for loading or spawning a client.
CLIENT_SOURCE_DIR = Path(__file__).resolve().parents[2] / "clients"

#: The fixed name prefix of a test install; the creator's PID follows it.
TEST_INSTALL_PREFIX = "crucible-client-suite-install-"

#: The environment variable naming this run's test install for child processes.
TEST_INSTALL_MARKER = "CRUCIBLE_CLIENT_SUITE_TEST_INSTALL"

#: The test install's own `crucible.toml`: it declares nothing, so a client
#: that resolves past its project refuses naming this file, never the
#: operator's root configuration.
_TEST_INSTALL_CONFIG_TEXT = (
    "# The client suite's test install (tests/client/__init__.py).\n"
    "# It declares no board, no [lint] or [run] table and no limits: a test\n"
    "# declares what it needs in a project directory it owns.\n"
)


def pid_alive(pid):
    """True when a process with `pid` exists (signal 0 probes, never signals)."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def install_owner_pid(name_or_path):
    """The creator PID a test install's name carries, or None when the name
    has no prefix or no numeric PID."""
    name = os.path.basename(os.path.normpath(str(name_or_path)))
    if not name.startswith(TEST_INSTALL_PREFIX):
        return None
    pid_text = name[len(TEST_INSTALL_PREFIX):].split("-", 1)[0]
    return int(pid_text) if pid_text.isdigit() else None


def _remove_install(path):
    """Remove a test install without following its `clients` link."""
    link = os.path.join(path, "clients")
    if os.path.islink(link):
        os.unlink(link)
    shutil.rmtree(path, ignore_errors=True)


def sweep_dead_installs(directory, pid_alive):
    """Remove every prefixed test install in `directory` whose creator PID is
    dead; keep live, unattributable and foreign entries. Answers the removed
    paths, sorted."""
    removed = []
    for name in sorted(os.listdir(directory)):
        owner = install_owner_pid(name)
        if owner is None or pid_alive(owner):
            continue
        path = os.path.join(directory, name)
        if os.path.islink(path) or not os.path.isdir(path):
            continue
        _remove_install(path)
        removed.append(path)
    return sorted(removed)


def establish_test_install(environ, *, pid, pid_alive, at_exit):
    """The test install `environ`'s marker names, when it exists (nothing is
    created or registered); else a new one under `tempfile.gettempdir()`,
    created after sweeping that directory, with its removal registered once
    through `at_exit` and the marker set in `environ` (only)."""
    existing = environ.get(TEST_INSTALL_MARKER)
    if existing and os.path.isdir(existing):
        return existing
    parent = tempfile.gettempdir()
    sweep_dead_installs(parent, pid_alive)
    install = tempfile.mkdtemp(prefix=f"{TEST_INSTALL_PREFIX}{pid}-", dir=parent)
    os.symlink(CLIENT_SOURCE_DIR, os.path.join(install, "clients"),
               target_is_directory=True)
    with open(os.path.join(install, "crucible.toml"), "w", encoding="utf-8") as handle:
        handle.write(_TEST_INSTALL_CONFIG_TEXT)
    at_exit(_remove_install, install)
    environ[TEST_INSTALL_MARKER] = install
    return install


TEST_INSTALL_DIR = Path(establish_test_install(
    os.environ, pid=os.getpid(), pid_alive=pid_alive, at_exit=atexit.register))
TEST_INSTALL_CLIENTS = TEST_INSTALL_DIR / "clients"
TEST_INSTALL_CONFIG = TEST_INSTALL_DIR / "crucible.toml"

_LOAD_COUNTER = itertools.count()


def client_script(name):
    """`<test install>/clients/<name>`: the path to SPAWN a client by."""
    return TEST_INSTALL_CLIENTS / name


def install_clients_candidates(manifest):
    """`manifest._CLIENTS_CANDIDATES` with the checkout's `clients/` replaced
    by the test install's: patched in, the core `crucible_axi.cli` vendors
    takes the test install, never the repo root."""
    return (str(TEST_INSTALL_CLIENTS),) + tuple(manifest._CLIENTS_CANDIDATES[1:])


def load_client(name, module_name=None):
    """A FRESH module loaded from `<test install>/clients/<name>` on every
    call, so no binding leaks from one test's module into another's."""
    if module_name is None:
        stem = Path(name).stem.replace("-", "_")
        module_name = f"tests_client_install_{stem}_{next(_LOAD_COUNTER)}"
    path = client_script(name)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load the client {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
