"""A project's own verbs live in their own shared module, beside the core.

`clients/_crucible_project.py` holds the `project-meta` section, moved out of
the core with its behaviour unchanged, and the project key and `.env` reader
and writer beside it. The core, `clients/_crucible_axi.py`, loads it by file
path from its own directory, as it loads the release-notes module, binds its
`_core` to a live view of the core, and re-exports every name it defines, so a
client's `_axi().cmd_project_meta` is unchanged.

What is asserted here:

  * the core's own source defines none of the `project-meta` names;
  * the project module's source defines each of them once, and the key and
    the `.env` reader and writer once;
  * on a loaded core, each of those names is the very object the project
    module defines, and the module the core loaded was read from the core's
    own directory;
  * the project module's `_core` is a view of the core that loaded it;
  * the project module imports only the standard library.

The behaviour of `project-meta` itself is pinned, unchanged, by
`test_project_meta_reads_and_writes_the_map` and
`test_project_meta_verb_wires_write_read_and_refusal_end_to_end`.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_project_meta_lives_in_the_project_module
"""

import ast
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import load_client
from tests.client.test_the_run_pipeline_lives_in_its_own_shared_module import (
    CLIENTS,
    CORE_MODULE,
    is_core_view,
    top_level_definitions,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
PROJECT_MODULE = CLIENTS / "_crucible_project.py"

#: The `project-meta` section that moves out of the core.
PROJECT_META_NAMES = (
    "PROJECT_META_VERB",
    "project_metadata_path",
    "parse_meta_set",
    "add_project_meta_args",
    "project_meta_refusal_fields",
    "cmd_project_meta",
)

#: The project key and the one `.env` reader and writer, defined beside it.
PROJECT_KEY_NAMES = (
    "PROJECT_KEY_NAMESPACE",
    "project_key_for_token",
    "read_env_project_key",
    "write_env_project_key",
)

PROJECT_MODULE_NAMES = PROJECT_META_NAMES + PROJECT_KEY_NAMES


def _source(path):
    return Path(path).read_text(encoding="utf-8")


def _require_project_module(test):
    test.assertTrue(
        PROJECT_MODULE.is_file(),
        f"{PROJECT_MODULE.relative_to(REPO_ROOT)} does not exist: a project's "
        f"own verbs have not been moved out of the core")


def project_namespace(test, core):
    """The namespace of the project module `core` loaded, reached through the
    re-exported `cmd_project_meta`, after asserting it was read from the core's
    own directory and is not the core itself."""
    _require_project_module(test)
    command = getattr(core, "cmd_project_meta", None)
    if command is None:
        test.fail("the core carries no `cmd_project_meta`")
    namespace = getattr(command, "__globals__", {})
    test.assertEqual(
        Path(namespace.get("__file__") or "").resolve(), PROJECT_MODULE.resolve(),
        f"the core's `cmd_project_meta` runs in a module read from "
        f"{namespace.get('__file__')!r}, not in {PROJECT_MODULE.name} beside "
        f"the core")
    test.assertNotEqual(namespace.get("__name__"), core.__name__)
    return namespace


class TheProjectMetaSectionMovedOutOfTheCoreTest(unittest.TestCase):

    def test_the_core_defines_none_of_the_project_meta_names(self):
        core_defs = top_level_definitions(ast.parse(_source(CORE_MODULE)))
        still_there = [name for name in PROJECT_META_NAMES if name in core_defs]
        self.assertEqual(
            still_there, [],
            "clients/_crucible_axi.py defines none of the project-meta names: "
            "they are written in clients/_crucible_project.py and only "
            "re-exported by the core")

    def test_the_project_module_defines_each_project_meta_name_once(self):
        _require_project_module(self)
        defs = top_level_definitions(ast.parse(_source(PROJECT_MODULE)))
        counts = {name: defs.count(name) for name in PROJECT_META_NAMES}
        self.assertEqual(
            counts, dict.fromkeys(PROJECT_META_NAMES, 1),
            "clients/_crucible_project.py defines each project-meta name "
            "exactly once")

    def test_the_project_module_defines_the_key_and_the_env_reader_and_writer_once(self):
        _require_project_module(self)
        defs = top_level_definitions(ast.parse(_source(PROJECT_MODULE)))
        counts = {name: defs.count(name) for name in PROJECT_KEY_NAMES}
        self.assertEqual(
            counts, dict.fromkeys(PROJECT_KEY_NAMES, 1),
            "clients/_crucible_project.py defines the key namespace, the key "
            "function and the `.env` reader and writer exactly once")


class TheCoreReexportsTheProjectModuleTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.core = load_client("_crucible_axi.py")

    def test_each_project_name_on_the_core_is_the_project_modules_own_object(self):
        namespace = project_namespace(self, self.core)
        misses = []
        for name in PROJECT_MODULE_NAMES:
            if name not in namespace:
                misses.append((name, "not defined by the project module"))
            elif not hasattr(self.core, name):
                misses.append((name, "absent from the core"))
            elif getattr(self.core, name) is not namespace[name]:
                misses.append((name, "a different object on the core"))
        self.assertEqual(
            misses, [],
            "every project name is re-exported by the core as the very object "
            "the project module defines, so a client's `_axi().<name>` reaches it")

    def test_the_project_meta_verb_name_is_unchanged(self):
        project_namespace(self, self.core)
        self.assertEqual(self.core.PROJECT_META_VERB, "project-meta")
        self.assertEqual(self.core.project_metadata_path("k-1"),
                         "/api/v2/projects/k-1/metadata")

    def test_the_project_module_is_bound_to_a_view_of_the_core_that_loaded_it(self):
        namespace = project_namespace(self, self.core)
        self.assertIn("_core", namespace,
                      "the project module declares the `_core` its loader binds")
        self.assertTrue(
            is_core_view(namespace["_core"], self.core),
            "the project module's `_core` is a live view of the core that "
            "loaded it, so a core name it uses is read at call time")

    def test_two_cores_in_one_process_each_load_their_own_project_module(self):
        other = load_client("_crucible_axi.py")
        mine = project_namespace(self, self.core)
        theirs = project_namespace(self, other)
        self.assertIsNot(mine, theirs,
                         "each core loads a project module of its own")
        self.assertIsNot(self.core.cmd_project_meta, other.cmd_project_meta)


class TheProjectModuleIsCleanTest(unittest.TestCase):

    def test_the_project_module_imports_only_the_standard_library(self):
        _require_project_module(self)
        tree = ast.parse(_source(PROJECT_MODULE))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                imported.add("." if node.level else (node.module or "").split(".")[0])
        foreign = sorted(name for name in imported
                         if name not in sys.stdlib_module_names
                         and name != "__future__")
        self.assertEqual(foreign, [],
                         "clients/_crucible_project.py imports only the "
                         "standard library; it reaches the core through its "
                         "bound view")
        self.assertIn("uuid", imported,
                      "the project key is a uuid5, from the standard library")


if __name__ == "__main__":
    unittest.main()
