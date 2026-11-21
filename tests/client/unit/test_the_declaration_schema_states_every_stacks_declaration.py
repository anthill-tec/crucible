"""The declaration schema (`clients/crucible-declaration.schema.json`) states
every stack's declaration as the clients accept it, and the writer's rule.

The schema is a plain JSON descriptor: an integer `version`, a description
saying it is not a JSON Schema, and a `stacks` map naming bun, rust, arduino,
maven, python and go. For each stack it states where the declaration lives, how an
entry's key is formed, each field (allowed values in one of four forms,
default, whether it is required, cross-field rules), whether an entry is open,
the refused fields (entry level, and bun's package level), the stack's own
table (`[bun] package_dir`, `[python] runner`), the shape and parse rules and
the reserved frameworks. It also states the skip rule the `[targets]` readers
follow, and the rule a writer follows across schema versions.

These tests pin the CONTENT: each value is the vocabulary the clients accept
today, so the schema cannot under- or over-state it. The companion module
`test_the_clients_agree_with_the_declaration_schema` drives the clients with
entries generated from it. The descriptor vocabulary is documented in
`tests/client/declaration_schema_harness.py`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.unit.test_the_declaration_schema_states_every_stacks_declaration
"""

import unittest

from tests.client.declaration_schema_harness import STACKS, load_schema

BUN_FRAMEWORKS = ["bun-test", "vitest", "playwright", "playwright-bdd"]
# The schema's `version` before the bun gate exempted the entry marked
# `"test": true` (read from `develop`'s `clients/crucible-declaration.schema.json`
# when that exemption was written). The exemption made it one more: a reader
# computing the gate rule from the earlier version would refuse that entry.
VERSION_BEFORE_THE_MARKED_ENTRY_EXEMPTION = 2
RESERVED = {
    "bun": BUN_FRAMEWORKS,
    "rust": ["nextest"],
    "python": ["pytest", "unittest"],
    "maven": ["surefire"],
    "arduino": ["arduino-native"],
    "go": ["go-test"],
}


class _SchemaCase(unittest.TestCase):

    def setUp(self):
        self.schema = load_schema(self)
        self.stacks = self.schema.get("stacks") or {}

    def entry(self, stack):
        return self.stacks[stack]["entry"]

    def field(self, stack, name):
        return self.entry(stack)["fields"][name]


class TheSchemaIsAVersionedPlainDescriptorTest(_SchemaCase):

    def test_the_version_is_an_integer_starting_at_one(self):
        version = self.schema.get("version")
        self.assertIs(type(version), int, f"version is {version!r}, not an integer")
        self.assertGreaterEqual(version, 1)

    def test_the_version_is_one_more_since_the_gate_exempted_the_marked_entry(self):
        self.assertEqual(self.schema.get("version"),
                         VERSION_BEFORE_THE_MARKED_ENTRY_EXEMPTION + 1)

    def test_the_description_says_it_is_not_a_json_schema(self):
        description = self.schema.get("description")
        self.assertIsInstance(description, str)
        self.assertIn("not a json schema", description.lower())
        self.assertNotIn("$schema", self.schema)

    def test_the_stacks_map_names_exactly_the_six_stacks(self):
        self.assertEqual(set(self.stacks), set(STACKS))


class EachStackStatesWhereItsDeclarationLivesTest(_SchemaCase):

    def test_each_stack_names_its_file_and_table(self):
        expected = {
            "bun": {"file": "package.json", "table": "crucible.targets"},
            "rust": {"file": "crucible.toml", "table": "targets.<key>"},
            "arduino": {"file": "crucible.toml", "table": "targets.<key>"},
            "maven": {"file": "crucible.toml", "table": "targets.<key>"},
            "python": {"file": "crucible.toml", "table": "python"},
            "go": {"file": "crucible.toml", "table": "go"},
        }
        for stack, location in expected.items():
            with self.subTest(stack=stack):
                self.assertEqual(self.stacks[stack]["location"], location)

    def test_python_declares_no_targets_entry(self):
        self.assertIsNone(self.stacks["python"]["entry"])

    def test_go_declares_no_targets_entry(self):
        self.assertIn("entry", self.stacks["go"])
        self.assertIsNone(self.stacks["go"]["entry"])

    def test_each_targets_stack_states_how_its_key_is_formed(self):
        self.assertEqual(self.entry("bun")["key"]["form"], "script")
        self.assertEqual(self.entry("rust")["key"]["form"], "profile")
        self.assertEqual(self.entry("arduino")["key"]["form"], "dir/target")
        self.assertEqual(self.entry("arduino")["key"]["dir_default"], "tests/native")
        self.assertEqual(self.entry("maven")["key"]["form"], "tier")

    def test_bun_states_the_gates_key_rule_for_a_non_bun_test_entry(self):
        gate = self.entry("bun")["key"]["gate"]
        self.assertEqual(gate["template"], "test:<tier>")
        self.assertEqual(gate["exempt"], ["bun-test"])
        self.assertEqual(gate["in"], "scripts")

    def test_bun_states_the_test_marker_true_only_on_one_entry_at_most(self):
        marker = self.entry("bun")["key"]["marker"]
        self.assertEqual(marker["field"], "test")
        self.assertEqual(marker["values"], [True])
        self.assertIs(marker["values"][0], True)
        self.assertEqual(marker["at_most"], 1)
        self.assertEqual(marker["script"], "present-with-body")
        self.assertEqual(marker["entry_not_a_table"], "skipped")


class EachStacksFieldsAreStatedExactlyTest(_SchemaCase):

    def test_every_field_descriptor_states_its_default_and_whether_required(self):
        def walk(where, fields):
            for name, desc in fields.items():
                with self.subTest(field=f"{where}.{name}"):
                    self.assertIn("default", desc)
                    self.assertIsInstance(desc.get("required"), bool)
                if "fields" in desc:
                    walk(f"{where}.{name}", desc["fields"])
        for stack in STACKS:
            entry = self.stacks[stack]["entry"]
            if entry is not None:
                walk(stack, entry["fields"])
            table = self.stacks[stack].get("stack_table")
            if table is not None:
                walk(f"{stack}.table", table["fields"])

    def test_bun_fields_and_their_values(self):
        fields = self.entry("bun")["fields"]
        self.assertEqual(set(fields), {"framework", "stream", "junit", "console", "coverage"})
        self.assertEqual(fields["framework"]["values"], BUN_FRAMEWORKS)
        self.assertIs(fields["framework"]["required"], True)
        self.assertEqual(set(fields["stream"]["fields"]), {"codec", "path"})
        self.assertEqual(fields["stream"]["fields"]["codec"]["values"],
                         {"board-listed": "codecs.stream"})
        self.assertEqual(fields["stream"]["fields"]["path"]["values"], ["env:CRUCIBLE_STREAM"])
        self.assertEqual(fields["junit"]["values"], {"pattern": ["flag", "env:<VAR>"]})
        self.assertEqual(fields["console"]["values"], {"board-listed": "codecs.view"})
        self.assertEqual(fields["coverage"]["values"], ["lcov"])
        for name in ("stream", "junit", "console", "coverage"):
            with self.subTest(field=name):
                self.assertIs(fields[name]["required"], False)

    def test_rust_fields_default_to_the_nextest_entry(self):
        fields = self.entry("rust")["fields"]
        self.assertEqual(set(fields), {"framework", "stream"})
        self.assertEqual(fields["framework"]["values"], ["nextest"])
        self.assertEqual(fields["framework"]["default"], "nextest")
        self.assertIs(fields["framework"]["required"], False)
        self.assertEqual(fields["stream"]["default"], {"codec": "nextest", "path": "stdout"})
        self.assertEqual(fields["stream"]["fields"]["codec"]["values"], ["nextest"])
        self.assertEqual(fields["stream"]["fields"]["path"]["values"], ["stdout"])

    def test_arduino_fields_are_all_required(self):
        fields = self.entry("arduino")["fields"]
        self.assertEqual(set(fields), {"framework", "stream"})
        self.assertEqual(fields["framework"]["values"], ["arduino-native"])
        self.assertIs(fields["framework"]["required"], True)
        self.assertIs(fields["stream"]["required"], True)
        stream = fields["stream"]["fields"]
        self.assertEqual(stream["codec"]["values"], ["crucible-events"])
        self.assertEqual(stream["path"]["values"], ["env:CRUCIBLE_STREAM"])
        self.assertIs(stream["codec"]["required"], True)
        self.assertIs(stream["path"]["required"], True)

    def test_maven_fields_are_all_required(self):
        fields = self.entry("maven")["fields"]
        self.assertEqual(set(fields), {"framework", "console"})
        self.assertEqual(fields["framework"]["values"], ["surefire"])
        self.assertEqual(fields["console"]["values"], ["surefire-console"])
        self.assertIs(fields["framework"]["required"], True)
        self.assertIs(fields["console"]["required"], True)

    def test_every_targets_entry_is_open(self):
        for stack in ("bun", "rust", "arduino", "maven"):
            with self.subTest(stack=stack):
                self.assertIs(self.entry(stack)["open"], True)

    def test_every_stream_table_keeps_a_subfield_it_does_not_list(self):
        for stack in ("bun", "rust", "arduino"):
            with self.subTest(stack=stack):
                stream = self.field(stack, "stream")
                self.assertEqual(set(stream["fields"]), {"codec", "path"})
                self.assertIs(stream.get("open"), True,
                              f"{stack}'s `stream` does not state it is open")

    def test_maven_has_no_stream_table_to_state_open(self):
        self.assertNotIn("stream", self.entry("maven")["fields"])
        self.assertIn("stream", self.entry("maven")["refused"])

    def test_each_stack_names_its_refused_entry_fields(self):
        self.assertEqual(self.entry("bun")["refused"], [])
        self.assertEqual(self.entry("rust")["refused"], ["junit", "console", "coverage"])
        self.assertEqual(self.entry("arduino")["refused"], ["junit", "console", "coverage"])
        self.assertEqual(self.entry("maven")["refused"], ["junit", "stream", "coverage"])

    def test_bun_names_its_refused_package_level_keys(self):
        package = self.stacks["bun"]["package"]
        self.assertEqual(package["file"], "package.json")
        self.assertEqual(package["refused"], ["crucible.reportPath", "crucible.rawReport",
                                              "crucible.testScript"])


class BunsCrossFieldRulesAreStatedTest(_SchemaCase):

    def test_exactly_one_of_stream_and_junit(self):
        fields = self.entry("bun")["fields"]
        self.assertEqual(set(self.entry("bun")["requires"]["one_of"]), {"stream", "junit"})
        self.assertIn("junit", fields["stream"]["excludes"])
        self.assertIn("stream", fields["junit"]["excludes"])

    def test_console_only_on_a_junit_entry(self):
        console = self.field("bun", "console")
        self.assertEqual(console["requires"], {"junit": True})

    def test_bun_console_only_with_bun_test(self):
        console = self.field("bun", "console")
        self.assertEqual(console["when"], {"bun-console": {"requires": {"framework": ["bun-test"]}}})

    def test_coverage_only_lcov_on_a_junit_flag_bun_test_entry(self):
        coverage = self.field("bun", "coverage")
        self.assertEqual(coverage["requires"], {"junit": ["flag"], "framework": ["bun-test"]})


class EachStackTableIsStatedTest(_SchemaCase):

    def test_bun_package_dir_is_a_run_time_path_holding_package_json(self):
        table = self.stacks["bun"]["stack_table"]
        self.assertEqual((table["file"], table["table"]), ("crucible.toml", "bun"))
        self.assertEqual(set(table["fields"]), {"package_dir"})
        self.assertEqual(table["fields"]["package_dir"]["values"],
                         {"path": {"holds": "package.json"}})
        self.assertIs(table["fields"]["package_dir"]["required"], False)

    def test_python_runner_is_unittest_by_default_or_pytest_and_a_flag_overrides_it(self):
        table = self.stacks["python"]["stack_table"]
        self.assertEqual((table["file"], table["table"]), ("crucible.toml", "python"))
        runner = table["fields"]["runner"]
        self.assertEqual(sorted(runner["values"]), ["pytest", "unittest"])
        self.assertEqual(runner["default"], "unittest")
        self.assertIs(runner["required"], False)
        self.assertEqual(runner["overridden_by"], "--runner")

    def test_go_module_dir_is_a_run_time_path_holding_go_mod(self):
        table = self.stacks["go"]["stack_table"]
        self.assertEqual((table["file"], table["table"]), ("crucible.toml", "go"))
        self.assertEqual(set(table["fields"]), {"module_dir"})
        module_dir = table["fields"]["module_dir"]
        self.assertEqual(module_dir["values"], {"path": {"holds": "go.mod"}})
        self.assertIs(module_dir["required"], False)
        self.assertIsNone(module_dir["default"])

    def test_rust_arduino_and_maven_have_no_stack_table(self):
        for stack in ("rust", "arduino", "maven"):
            with self.subTest(stack=stack):
                self.assertIsNone(self.stacks[stack].get("stack_table"))


class TheShapeAndParseRulesAreStatedTest(_SchemaCase):

    def test_a_targets_that_is_not_a_table_is_undeclared_for_every_stack(self):
        for stack in ("bun", "rust", "arduino", "maven"):
            with self.subTest(stack=stack):
                self.assertEqual(self.entry(stack)["shape"]["targets_not_a_table"], "undeclared")

    def test_an_entry_that_is_not_a_table_is_refused(self):
        for stack in ("bun", "rust", "arduino", "maven"):
            with self.subTest(stack=stack):
                self.assertEqual(self.entry(stack)["shape"]["entry_not_a_table"], "refused")

    def test_a_crucible_toml_that_does_not_parse(self):
        for stack in ("rust", "arduino", "maven"):
            with self.subTest(stack=stack):
                self.assertEqual(self.entry(stack)["shape"]["file_does_not_parse"], "refused")
        for stack in ("bun", "python", "go"):
            with self.subTest(stack=stack):
                self.assertEqual(
                    self.stacks[stack]["stack_table"]["shape"]["file_does_not_parse"],
                    "undeclared")


class TheReservedFrameworksAndTheSkipRuleAreStatedTest(_SchemaCase):

    def test_the_reserved_frameworks_per_stack(self):
        reserved = self.schema["reserved_frameworks"]
        self.assertEqual(set(reserved), set(RESERVED))
        for owner, frameworks in RESERVED.items():
            with self.subTest(owner=owner):
                self.assertEqual(sorted(reserved[owner]), sorted(frameworks))

    def test_each_targets_stacks_framework_values_are_its_reserved_frameworks(self):
        reserved = self.schema["reserved_frameworks"]
        for stack in ("bun", "rust", "arduino", "maven"):
            with self.subTest(stack=stack):
                self.assertEqual(sorted(self.field(stack, "framework")["values"]),
                                 sorted(reserved[stack]))

    def test_the_targets_readers_skip_and_bun_refuses_another_stacks_framework(self):
        skip = self.schema["skip_rule"]
        self.assertEqual(sorted(skip["readers"]), ["arduino", "maven", "rust"])
        self.assertEqual(skip["decided_on"], "framework")
        self.assertIn("namespace", skip["description"].lower())
        for stack in ("rust", "arduino", "maven"):
            with self.subTest(stack=stack):
                self.assertEqual(self.entry(stack)["other_stacks"], "skipped")
        self.assertEqual(self.entry("bun")["other_stacks"], "refused")


class TheWriterRuleIsWrittenDownTest(_SchemaCase):

    def setUp(self):
        super().setUp()
        self.writer = self.schema["writer"]

    def test_a_writer_writes_the_stacks_and_fields_it_knows_and_always_framework(self):
        self.assertEqual(self.writer["writes"], "known")
        self.assertEqual(self.writer["always_writes"], ["framework"])

    def test_a_newer_version_warns_naming_it_and_never_blocks(self):
        newer = self.writer["newer_version"]
        self.assertEqual(newer, {"writes": "known", "warn": True,
                                 "names_version": True, "blocked": False})

    def test_a_writer_never_removes_a_field_it_does_not_know(self):
        self.assertEqual(self.writer["unknown_field"], "keep")

    def test_with_no_schema_a_writer_writes_nothing_it_cannot_check_and_warns(self):
        self.assertEqual(self.writer["no_schema"], {"writes": "nothing-unchecked",
                                                    "warn": True, "blocked": False})
        self.assertIn("declaration_schema", self.writer["description"])


if __name__ == "__main__":
    unittest.main()
