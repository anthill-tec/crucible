"""The run module's late-bound `_core` is a live view of the core.

Once the core loads, the run module's `_core` slot reads the core's namespace
at call time: a core name read through it is the core's own, a patch of the
core is seen through it and undone with it, and a name the core gains after
loading is reached.
"""

import unittest
from unittest import mock

from tests.client.live_run_harness import load_client

CORE_SLOT = "_core"


class TheRunModulesCoreIsALiveViewOfTheCoreTest(unittest.TestCase):

    def test_once_the_core_loads_the_slot_is_a_live_view_of_the_cores_namespace(self):
        core = load_client("_crucible_axi.py")
        namespace = core.ingest_reports.__globals__
        self.assertEqual(namespace.get("__name__"), f"{core.__name__}_run",
                         "the core's `ingest_reports` runs in its run module")
        view = namespace.get(CORE_SLOT)
        self.assertIsNotNone(view, "the core binds the run module's `_core`")
        self.assertIs(view.post_ingest, core.post_ingest,
                      "a core name read through `_core` is the core's own")

        replacement = mock.Mock(name="patched_post_ingest")
        with mock.patch.object(core, "post_ingest", replacement):
            self.assertIs(
                view.post_ingest, replacement,
                "`_core` reads the core's namespace at call time, so a patch "
                "of the core is seen through it")
        self.assertIs(view.post_ingest, core.post_ingest,
                      "the patch is undone through the view as well")

        added = object()
        with mock.patch.object(core, "late_added_core_name", added, create=True):
            self.assertIs(view.late_added_core_name, added,
                          "a name the core gains after loading is reached")
        with self.assertRaises(AttributeError):
            _ = view.late_added_core_name


if __name__ == "__main__":
    unittest.main()
