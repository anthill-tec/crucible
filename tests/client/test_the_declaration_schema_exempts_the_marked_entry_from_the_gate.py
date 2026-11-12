"""The declaration schema states that the bun gate exempts the marked entry
and names the verbs that read the marker.

In `clients/crucible-declaration.schema.json`, the bun `entry.key` states:
- its `gate` key rule exempts the entry marked `"test": true`
  (`"marked": "exempt"`), beside the rule's `template`, `exempt` and `in`,
  which are unchanged;
- its `marker` is read by `test`, `regression` and `pre-merge-gate`, in that
  order (`"read_by"`), beside the marker's existing fields, unchanged.

The schema's `version` is pinned with the schema's other content in
`test_the_declaration_schema_states_every_stacks_declaration`, and the
client's agreement with the gate rule in
`test_the_clients_agree_with_the_declaration_schema`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_the_declaration_schema_exempts_the_marked_entry_from_the_gate
"""

import unittest

from tests.client.declaration_schema_harness import load_schema


class TheBunKeyStatesTheMarkedEntrysGateExemptionTest(unittest.TestCase):

    def setUp(self):
        self.key = load_schema(self)["stacks"]["bun"]["entry"]["key"]

    def test_the_gate_rule_states_the_marked_entry_exempt(self):
        gate = self.key["gate"]
        self.assertEqual(gate.get("marked"), "exempt", f"gate={gate!r}")

    def test_the_gate_rule_keeps_its_template_exempt_frameworks_and_scope(self):
        gate = self.key["gate"]
        self.assertEqual(gate, {"template": "test:<tier>", "exempt": ["bun-test"],
                                "in": "scripts", "marked": "exempt"},
                         "the gate rule gains `marked` and changes nothing else")

    def test_the_marker_names_test_regression_and_the_gate_as_its_readers(self):
        marker = self.key["marker"]
        self.assertEqual(marker.get("read_by"), ["test", "regression", "pre-merge-gate"],
                         f"marker={marker!r}")

    def test_the_marker_keeps_its_other_fields(self):
        marker = self.key["marker"]
        self.assertEqual({k: v for k, v in marker.items() if k != "read_by"},
                         {"field": "test", "values": [True], "at_most": 1,
                          "script": "present-with-body", "entry_not_a_table": "skipped"},
                         f"marker={marker!r}")


if __name__ == "__main__":
    unittest.main()
