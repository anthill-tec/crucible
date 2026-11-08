"""The clients and the declaration schema agree: every client's declaration
check is driven with entries generated from
`clients/crucible-declaration.schema.json`, and does what the schema says.

  - every allowed value is accepted (a sample for a pattern or an open codec
    name), every refused field and wrong value is refused, every cross-field
    rule holds, and an unlisted field is accepted: a cross product of each
    field absent, at each allowed value and at each wrong value, with each
    refused field and one unlisted field added, is judged by the schema and
    by the client, and the two verdicts must match on every entry;
  - every shape and parse rule holds;
  - rust, arduino and maven SKIP each other stack's complete valid entry
    (every reserved framework, `go-test` included), deciding the skip on
    `framework` before any other field, so a maven entry carrying `console`
    is skipped by rust, not refused;
  - an entry with no `framework` is rust's: rust reads it, arduino and maven
    refuse it;
  - bun refuses a non-bun framework, and bun's key rules hold (any script
    name; the gate's `test:<tier>` rule; the `"test": true` marker);
  - the board-listed codecs are checked against a stub health that lists,
    and one that omits, a sample codec;
  - the stack tables: `[bun] package_dir` (a directory holding
    `package.json`) and `[python] runner` (with `probe=False`).

No board is touched. The seams are a temporary project dir holding
`crucible.toml` or `package.json`, and the clients' own checks, loaded by file
path: bun `_read_target_entry`, `_declared_target`, `_marked_test_script`,
`_off_template_target`, `_refuse_old_keys`, `_resolve_package_dir`,
`_target_board_refusal`; rust `_targets_refusal`; arduino `_declared_key`,
`_declared_entry`; maven `_declared_entry`, `_check_console_declaration`;
python `_declared_runner`, `_resolve_runner`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.test_the_clients_agree_with_the_declaration_schema
"""

import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from tests.client.declaration_schema_harness import (
    ACCEPTED,
    READER_KEYS,
    REFUSED,
    SAMPLE_CODEC,
    SKIPPED,
    TARGETS_READERS,
    UNDECLARED,
    UNLISTED_FIELD,
    UNPARSEABLE_TOML,
    candidate_entries,
    client,
    complete_entries,
    declaration_refused,
    entry_verdict,
    load_schema,
    new_project,
    no_python_args,
    other_frameworks,
    reader_verdict,
    sample_values,
    schema_verdict,
    write_package,
    write_targets_toml,
    write_toml,
)

# What a `[targets]` reader's own check answers for an entry it skips: rust
# reports no refusal (the run goes on undeclared), arduino and maven report the
# key undeclared.
SKIP_OUTCOME = {"rust": ACCEPTED, "arduino": UNDECLARED, "maven": UNDECLARED}

_CLIENT_ENV = ("BUN_CRUCIBLE_PACKAGE_DIR", "BUN_CRUCIBLE_PROJECT_DIR",
               "MVN_CRUCIBLE_PROJECT_DIR", "PY_CRUCIBLE_PYTHON")


def _short(value, limit=120):
    text = repr(value)
    return text if len(text) <= limit else text[:limit] + "..."


class _AgreementCase(unittest.TestCase):

    def setUp(self):
        self.schema = load_schema(self)
        patcher = mock.patch.dict(os.environ)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in _CLIENT_ENV:
            os.environ.pop(name, None)

    def entry_desc(self, stack):
        return self.schema["stacks"][stack]["entry"]

    def assert_verdicts_match(self, stack):
        """Every generated entry: the client's verdict is the schema's."""
        project = new_project(self)
        candidates = candidate_entries(self.schema, stack)
        mismatches, verdicts = [], {ACCEPTED: 0, REFUSED: 0}
        for entry in candidates:
            expected = schema_verdict(self.schema, stack, entry)
            actual = entry_verdict(stack, project, entry)
            verdicts[actual] = verdicts.get(actual, 0) + 1
            if actual != expected:
                mismatches.append((entry, expected, actual))
        shown = "; ".join(f"{_short(e)} schema={x} client={a}" for e, x, a in mismatches[:4])
        self.assertEqual(len(mismatches), 0,
                         f"{len(mismatches)} of {len(candidates)} {stack} entries "
                         f"disagree, e.g. {shown}")
        # Bound: the cross product exercises both outcomes and nothing else.
        self.assertGreater(verdicts[ACCEPTED], 0)
        self.assertGreater(verdicts[REFUSED], 0)
        self.assertEqual(set(verdicts), {ACCEPTED, REFUSED})
        return candidates

    def assert_every_allowed_value_is_accepted(self, stack, candidates):
        project = new_project(self)
        for name, fdesc in self.entry_desc(stack)["fields"].items():
            for value in sample_values(fdesc):
                with self.subTest(stack=stack, field=name, value=value):
                    accepted = [c for c in candidates if isinstance(c, dict)
                                and c.get(name, object()) == value
                                and schema_verdict(self.schema, stack, c) == ACCEPTED]
                    self.assertTrue(accepted, f"no accepted {stack} entry carries "
                                              f"{name} = {value!r}")
                    self.assertEqual(entry_verdict(stack, project, accepted[0]), ACCEPTED)

    def assert_refused_fields_and_unlisted_field(self, stack):
        project = new_project(self)
        for entry in complete_entries(self.schema, stack)[:1]:
            for field in self.entry_desc(stack)["refused"]:
                with self.subTest(stack=stack, refused=field):
                    self.assertEqual(entry_verdict(stack, project, {**entry, field: "flag"}),
                                     REFUSED)
            with self.subTest(stack=stack, unlisted=UNLISTED_FIELD):
                self.assertIs(self.entry_desc(stack)["open"], True)
                self.assertEqual(entry_verdict(stack, project,
                                               {**entry, UNLISTED_FIELD: "kept"}), ACCEPTED)


class EveryGeneratedEntryGetsTheSchemasVerdictTest(_AgreementCase):

    def test_bun_entries_match_the_schema_across_every_field_and_cross_field_rule(self):
        candidates = self.assert_verdicts_match("bun")
        self.assert_every_allowed_value_is_accepted("bun", candidates)
        self.assert_refused_fields_and_unlisted_field("bun")

    def test_rust_entries_match_the_schema(self):
        candidates = self.assert_verdicts_match("rust")
        self.assert_every_allowed_value_is_accepted("rust", candidates)
        self.assert_refused_fields_and_unlisted_field("rust")

    def test_arduino_entries_match_the_schema(self):
        candidates = self.assert_verdicts_match("arduino")
        self.assert_every_allowed_value_is_accepted("arduino", candidates)
        self.assert_refused_fields_and_unlisted_field("arduino")

    def test_maven_entries_match_the_schema(self):
        candidates = self.assert_verdicts_match("maven")
        self.assert_every_allowed_value_is_accepted("maven", candidates)
        self.assert_refused_fields_and_unlisted_field("maven")


class EveryStreamTableKeepsAnUnlistedSubfieldTest(_AgreementCase):
    """An unlisted `stream` subfield is kept by every client that reads a
    `stream` table, and the generated entries carry one."""

    STREAM_STACKS = ("bun", "rust", "arduino")

    def stream_entries(self, stack, unlisted):
        return [c for c in candidate_entries(self.schema, stack)
                if isinstance(c, dict) and isinstance(c.get("stream"), dict)
                and (UNLISTED_FIELD in c["stream"]) is unlisted]

    def test_the_generated_entries_carry_an_unlisted_stream_subfield(self):
        for stack in self.STREAM_STACKS:
            with self.subTest(stack=stack):
                carrying = self.stream_entries(stack, True)
                self.assertTrue(carrying, f"no generated {stack} entry carries an "
                                          f"unlisted `stream` subfield")
                self.assertTrue(all(c["stream"][UNLISTED_FIELD] == "kept" for c in carrying))
                self.assertTrue(any(schema_verdict(self.schema, stack, c) == ACCEPTED
                                    for c in carrying))

    def test_every_stream_reader_accepts_a_complete_stream_with_an_unlisted_subfield(self):
        project = new_project(self)
        for stack in self.STREAM_STACKS:
            for entry in complete_entries(self.schema, stack):
                if not isinstance(entry.get("stream"), dict):
                    continue
                extended = {**entry, "stream": {**entry["stream"], UNLISTED_FIELD: "kept"}}
                with self.subTest(stack=stack, entry=_short(extended)):
                    self.assertEqual(schema_verdict(self.schema, stack, extended), ACCEPTED)
                    self.assertEqual(entry_verdict(stack, project, extended), ACCEPTED)

    def test_an_unlisted_subfield_does_not_excuse_a_wrong_stream_value(self):
        project = new_project(self)
        for stack in self.STREAM_STACKS:
            entry = next(e for e in complete_entries(self.schema, stack)
                         if isinstance(e.get("stream"), dict))
            wrong = {**entry, "stream": {**entry["stream"], "path": "env:OTHER_STREAM",
                                         UNLISTED_FIELD: "kept"}}
            with self.subTest(stack=stack):
                self.assertEqual(schema_verdict(self.schema, stack, wrong), REFUSED)
                self.assertEqual(entry_verdict(stack, project, wrong), REFUSED)


class BunsCrossFieldRulesHoldTest(_AgreementCase):
    """Each rule the schema states for bun, driven on its edge."""

    def verdict(self, entry):
        return entry_verdict("bun", None, entry)

    def test_an_entry_with_both_stream_and_junit_or_neither_is_refused(self):
        stream = {"codec": SAMPLE_CODEC, "path": "env:CRUCIBLE_STREAM"}
        self.assertEqual(self.verdict({"framework": "vitest", "stream": stream}), ACCEPTED)
        self.assertEqual(self.verdict({"framework": "vitest", "junit": "flag"}), ACCEPTED)
        self.assertEqual(self.verdict({"framework": "vitest", "stream": stream,
                                       "junit": "flag"}), REFUSED)
        self.assertEqual(self.verdict({"framework": "vitest"}), REFUSED)
        for entry in ({"framework": "vitest", "stream": stream, "junit": "flag"},
                      {"framework": "vitest"}):
            self.assertEqual(schema_verdict(self.schema, "bun", entry), REFUSED)

    def test_console_is_refused_on_a_stream_entry(self):
        entry = {"framework": "vitest", "console": SAMPLE_CODEC,
                 "stream": {"codec": SAMPLE_CODEC, "path": "env:CRUCIBLE_STREAM"}}
        self.assertEqual(self.verdict(entry), REFUSED)
        self.assertEqual(schema_verdict(self.schema, "bun", entry), REFUSED)

    def test_bun_console_is_refused_beside_any_framework_but_bun_test(self):
        for framework in self.entry_desc("bun")["fields"]["framework"]["values"]:
            entry = {"framework": framework, "junit": "flag", "console": "bun-console"}
            expected = ACCEPTED if framework == "bun-test" else REFUSED
            with self.subTest(framework=framework):
                self.assertEqual(self.verdict(entry), expected)
                self.assertEqual(schema_verdict(self.schema, "bun", entry), expected)

    def test_coverage_is_refused_off_a_junit_flag_bun_test_entry(self):
        cases = {("bun-test", "flag"): ACCEPTED, ("vitest", "flag"): REFUSED,
                 ("bun-test", "env:JUNIT_OUT"): REFUSED}
        for (framework, junit), expected in cases.items():
            entry = {"framework": framework, "junit": junit, "coverage": "lcov"}
            with self.subTest(framework=framework, junit=junit):
                self.assertEqual(self.verdict(entry), expected)
                self.assertEqual(schema_verdict(self.schema, "bun", entry), expected)

    def test_a_stream_path_other_than_the_stream_variable_is_refused(self):
        entry = {"framework": "playwright",
                 "stream": {"codec": SAMPLE_CODEC, "path": "env:OTHER_STREAM"}}
        self.assertEqual(self.verdict(entry), REFUSED)
        self.assertEqual(schema_verdict(self.schema, "bun", entry), REFUSED)


class TheTargetsReadersSkipEveryOtherStacksCompleteEntryTest(_AgreementCase):
    """Rust, arduino and maven skip an entry naming another stack's reserved
    framework, decided on `framework` before any other field is checked."""

    def other_stacks_entries(self, reader):
        """Each other stack's complete valid entries, by framework: generated
        from that stack's descriptor where it has a `[targets]` entry; for a
        framework with none (python's, `go-test`), the bare framework and the
        framework beside every field the reader refuses."""
        refused = dict.fromkeys(self.entry_desc(reader)["refused"], "flag")
        for owner, frameworks in self.schema["reserved_frameworks"].items():
            if owner == reader:
                continue
            owner_desc = self.schema["stacks"].get(owner, {}).get("entry")
            for framework in frameworks:
                if owner_desc is not None:
                    entries = complete_entries(self.schema, owner, framework)
                else:
                    entries = [{"framework": framework}, {"framework": framework, **refused}]
                yield owner, framework, entries

    def assert_skips(self, reader):
        project = new_project(self)
        seen = set()
        for owner, framework, entries in self.other_stacks_entries(reader):
            self.assertTrue(entries, f"no complete {owner} entry for {framework}")
            for entry in entries:
                with self.subTest(reader=reader, owner=owner, entry=_short(entry)):
                    self.assertEqual(schema_verdict(self.schema, reader, entry), SKIPPED)
                    self.assertEqual(entry_verdict(reader, project, entry),
                                     SKIP_OUTCOME[reader])
            seen.add(framework)
        self.assertEqual(seen, other_frameworks(self.schema, reader))
        self.assertIn("go-test", seen)

    def test_rust_skips_every_other_stacks_complete_entry(self):
        self.assert_skips("rust")

    def test_arduino_skips_every_other_stacks_complete_entry(self):
        self.assert_skips("arduino")

    def test_maven_skips_every_other_stacks_complete_entry(self):
        self.assert_skips("maven")

    def test_rust_skips_a_complete_maven_entry_carrying_console_rather_than_refusing_it(self):
        project = new_project(self)
        maven_entries = complete_entries(self.schema, "maven", "surefire")
        self.assertEqual(maven_entries, [{"framework": "surefire",
                                          "console": "surefire-console"}])
        write_targets_toml(project, "e2e", maven_entries[0])
        self.assertIsNone(client("rust")._targets_refusal(project, "e2e"))

    def test_arduino_and_maven_skip_a_complete_go_test_entry(self):
        project = new_project(self)
        for reader in ("arduino", "maven"):
            refused = dict.fromkeys(self.entry_desc(reader)["refused"], "flag")
            for entry in ({"framework": "go-test"}, {"framework": "go-test", **refused}):
                with self.subTest(reader=reader, entry=entry):
                    self.assertEqual(entry_verdict(reader, project, entry), UNDECLARED)

    def test_a_reader_still_refuses_a_framework_no_stack_reserves(self):
        project = new_project(self)
        for reader in TARGETS_READERS:
            entry = {**complete_entries(self.schema, reader)[0], "framework": "cargo-test"}
            with self.subTest(reader=reader):
                self.assertEqual(entry_verdict(reader, project, entry), REFUSED)


class EachReadersSkipSetIsTheOtherStacksReservedFrameworksTest(_AgreementCase):
    """Each `[targets]` reader's skip set holds exactly the frameworks every
    other owner reserves in the schema, `go-test` included: no framework the
    schema does not reserve (which a generated entry would never name), and
    none left out."""

    def assert_skip_set(self, reader):
        skip_set = client(reader)._OTHER_STACKS_FRAMEWORKS
        expected = other_frameworks(self.schema, reader)
        self.assertEqual(set(skip_set), expected,
                         f"{reader} skips {sorted(set(skip_set) - expected)} the schema "
                         f"does not reserve for another stack, and misses "
                         f"{sorted(expected - set(skip_set))}")
        self.assertEqual(len(skip_set), len(set(skip_set)), f"{reader} repeats a framework")
        self.assertIn("go-test", skip_set)
        self.assertNotIn(self.entry_desc(reader)["fields"]["framework"]["values"][0],
                         skip_set)

    def test_rusts_skip_set_is_every_other_owners_reserved_frameworks(self):
        self.assert_skip_set("rust")

    def test_arduinos_skip_set_is_every_other_owners_reserved_frameworks(self):
        self.assert_skip_set("arduino")

    def test_mavens_skip_set_is_every_other_owners_reserved_frameworks(self):
        self.assert_skip_set("maven")


class AFrameworklessEntryIsRustsTest(_AgreementCase):

    def test_rust_reads_a_frameworkless_entry_and_arduino_and_maven_refuse_it(self):
        project = new_project(self)
        self.assertEqual(self.schema["writer"]["always_writes"], ["framework"])
        for entry in complete_entries(self.schema, "rust", "nextest"):
            frameworkless = {k: v for k, v in entry.items() if k != "framework"}
            with self.subTest(entry=frameworkless):
                self.assertEqual(entry_verdict("rust", project, frameworkless), ACCEPTED)
                for reader in ("arduino", "maven"):
                    self.assertEqual(schema_verdict(self.schema, reader, frameworkless),
                                     REFUSED)
                    self.assertEqual(entry_verdict(reader, project, frameworkless), REFUSED)


class BunRefusesANonBunFrameworkTest(_AgreementCase):

    def test_every_other_stacks_framework_is_refused_in_crucible_targets(self):
        bun = client("bun")
        project = new_project(self)
        base = complete_entries(self.schema, "bun", "vitest")[0]
        self.assertEqual(self.entry_desc("bun")["other_stacks"], REFUSED)
        for framework in sorted(other_frameworks(self.schema, "bun")):
            entry = {**base, "framework": framework}
            with self.subTest(framework=framework):
                write_package(project, {"scripts": {"test:e2e": "vitest run"},
                                        "crucible": {"targets": {"test:e2e": entry}}})
                target, refusal = bun._declared_target(project, "test:e2e")
                self.assertIsNone(target)
                self.assertIn(framework, refusal)
                self.assertIn("framework", refusal)


class BunsKeyRulesHoldTest(_AgreementCase):

    def setUp(self):
        super().setUp()
        self.bun = client("bun")
        self.key = self.entry_desc("bun")["key"]
        self.project = new_project(self)

    def package(self, scripts, targets):
        write_package(self.project, {"scripts": scripts, "crucible": {"targets": targets}})

    def test_an_entry_under_any_script_name_is_read(self):
        entry = complete_entries(self.schema, "bun", "bun-test")[0]
        self.package({"build:docs": "bun test docs"}, {"build:docs": entry})
        target, refusal = self.bun._declared_target(self.project, "build:docs")
        self.assertIsNone(refusal)
        self.assertEqual(target["framework"], "bun-test")

    def test_the_gate_refuses_a_non_bun_test_entry_off_the_test_tier_template(self):
        gate = self.key["gate"]
        head = gate["template"].split("<tier>")[0]
        surface = SimpleNamespace(target=gate["template"])
        args = SimpleNamespace(project_dir=self.project, package_dir=None)
        for framework in self.entry_desc("bun")["fields"]["framework"]["values"]:
            entry = complete_entries(self.schema, "bun", framework)[0]
            exempt = framework in gate["exempt"]
            cases = {  # key, scripts -> off the template?
                ("build", True): not exempt,
                (f"{head}e2e", True): False,
                (f"{head}e2e", False): not exempt,
            }
            for (key, in_scripts), off in cases.items():
                with self.subTest(framework=framework, key=key, in_scripts=in_scripts):
                    scripts = {key: "run it"} if in_scripts else {"other": "run"}
                    self.package(scripts, {key: entry})
                    found = self.bun._off_template_target(args, surface)
                    self.assertEqual(found, key if off else None)

    def test_one_entry_marked_true_names_its_script(self):
        marker = self.key["marker"]
        entry = {**complete_entries(self.schema, "bun", "vitest")[0],
                 marker["field"]: marker["values"][0]}
        self.package({"test:e2e": "vitest run"}, {"test:e2e": entry})
        self.assertEqual(self.bun._marked_test_script(self.project),
                         ("test:e2e", "vitest", None))

    def test_a_marker_that_is_not_json_true_is_refused(self):
        marker = self.key["marker"]
        base = complete_entries(self.schema, "bun", "vitest")[0]
        for wrong in ("true", 1, False):
            with self.subTest(marker=wrong):
                self.assertNotIn(wrong, [v for v in marker["values"] if v is wrong])
                self.package({"test:e2e": "vitest run"},
                             {"test:e2e": {**base, marker["field"]: wrong}})
                script, framework, refusal = self.bun._marked_test_script(self.project)
                self.assertEqual((script, framework), (None, None))
                self.assertIn("must be true", refusal)

    def test_more_marked_entries_than_allowed_are_refused(self):
        marker = self.key["marker"]
        base = complete_entries(self.schema, "bun", "vitest")[0]
        names = [f"test:t{i}" for i in range(marker["at_most"] + 1)]
        self.package(dict.fromkeys(names, "vitest run"),
                     {n: {**base, marker["field"]: True} for n in names})
        script, _framework, refusal = self.bun._marked_test_script(self.project)
        self.assertIsNone(script)
        for name in names:
            self.assertIn(name, refusal)

    def test_a_marked_script_must_be_present_with_a_body(self):
        marker = self.key["marker"]
        self.assertEqual(marker["script"], "present-with-body")
        entry = {**complete_entries(self.schema, "bun", "vitest")[0], marker["field"]: True}
        for scripts, said in (({"other": "run"}, "does not hold"), ({"test:e2e": "  "}, "empty")):
            with self.subTest(scripts=scripts):
                self.package(scripts, {"test:e2e": entry})
                script, _framework, refusal = self.bun._marked_test_script(self.project)
                self.assertIsNone(script)
                self.assertIn(said, refusal)

    def test_the_marker_scan_passes_over_an_entry_that_is_not_a_table(self):
        marker = self.key["marker"]
        self.assertEqual(marker["entry_not_a_table"], SKIPPED)
        entry = {**complete_entries(self.schema, "bun", "vitest")[0], marker["field"]: True}
        self.package({"test:e2e": "vitest run", "lint": "x"},
                     {"lint": "not-a-table", "test:e2e": entry})
        self.assertEqual(self.bun._marked_test_script(self.project),
                         ("test:e2e", "vitest", None))


class TheBoardListedCodecsAreCheckedAgainstHealthTest(_AgreementCase):

    def board_listed_fields(self):
        """`(path, kind)` for each board-listed field bun states."""
        def walk(prefix, fields):
            for name, desc in fields.items():
                if "fields" in desc:
                    yield from walk(f"{prefix}{name}.", desc["fields"])
                elif isinstance(desc["values"], dict) and "board-listed" in desc["values"]:
                    yield f"{prefix}{name}", desc["values"]["board-listed"]
        return list(walk("", self.entry_desc("bun")["fields"]))

    def test_a_health_listing_the_sample_codec_passes_and_one_omitting_it_refuses(self):
        bun = client("bun")
        listed = self.board_listed_fields()
        self.assertEqual(sorted(listed), [("console", "codecs.view"),
                                          ("stream.codec", "codecs.stream")])
        candidates = candidate_entries(self.schema, "bun")
        for path, where in listed:
            kind = where.split(".", 1)[1]
            top, _, sub = path.partition(".")
            entry = next(c for c in candidates
                         if schema_verdict(self.schema, "bun", c) == ACCEPTED
                         and "coverage" not in c and UNLISTED_FIELD not in c
                         and (c.get(top, {}).get(sub) if sub else c.get(top)) == SAMPLE_CODEC)
            target, refusal = bun._read_target_entry("crucible.targets.k", entry)
            self.assertIsNone(refusal)
            with self.subTest(field=path, health="lists"):
                health = {"ok": True, "codecs": {kind: [SAMPLE_CODEC]}}
                self.assertIsNone(bun._target_board_refusal("test:e2e", target, health))
            with self.subTest(field=path, health="omits"):
                health = {"ok": True, "codecs": {kind: ["another-codec"]}}
                refusal = bun._target_board_refusal("test:e2e", target, health)
                self.assertIn(SAMPLE_CODEC, refusal)
                self.assertIn(where, refusal)


class BunsPackageLevelRefusedKeysTest(_AgreementCase):

    def test_each_refused_package_key_is_refused_naming_it(self):
        bun = client("bun")
        project = new_project(self)
        refused = self.schema["stacks"]["bun"]["package"]["refused"]
        self.assertEqual(len(refused), 3)
        for dotted in refused:
            key = dotted.split(".", 1)[1]
            with self.subTest(key=dotted):
                write_package(project, {"crucible": {key: "x"}})
                with self.assertRaises(declaration_refused("bun")) as caught:
                    bun._refuse_old_keys(project, "test")
                self.assertIn(dotted, str(caught.exception))

    def test_a_package_key_the_schema_does_not_refuse_is_not_refused(self):
        bun = client("bun")
        project = new_project(self)
        write_package(project, {"crucible": {"targets": {}, UNLISTED_FIELD: "kept"}})
        self.assertIsNone(bun._refuse_old_keys(project, "test"))


class TheShapeAndParseRulesHoldTest(_AgreementCase):

    def test_a_targets_that_is_not_a_table_is_undeclared(self):
        project = new_project(self)
        for reader in TARGETS_READERS:
            rule = self.entry_desc(reader)["shape"]["targets_not_a_table"]
            with self.subTest(stack=reader):
                write_toml(project, 'targets = "not-a-table"\n')
                expected = ACCEPTED if reader == "rust" else rule
                self.assertEqual(rule, UNDECLARED)
                self.assertEqual(reader_verdict(reader, project, READER_KEYS[reader]), expected)
        with self.subTest(stack="bun"):
            self.assertEqual(self.entry_desc("bun")["shape"]["targets_not_a_table"], UNDECLARED)
            write_package(project, {"scripts": {"test:e2e": "x"},
                                    "crucible": {"targets": "not-a-table"}})
            self.assertEqual(client("bun")._declared_target(project, "test:e2e"), (None, None))

    def test_an_entry_that_is_not_a_table_is_refused(self):
        project = new_project(self)
        for reader in TARGETS_READERS:
            with self.subTest(stack=reader):
                self.assertEqual(self.entry_desc(reader)["shape"]["entry_not_a_table"], REFUSED)
                write_targets_toml(project, READER_KEYS[reader], "not-a-table")
                self.assertEqual(reader_verdict(reader, project, READER_KEYS[reader]), REFUSED)
        with self.subTest(stack="bun"):
            self.assertEqual(self.entry_desc("bun")["shape"]["entry_not_a_table"], REFUSED)
            write_package(project, {"scripts": {"test:e2e": "x"},
                                    "crucible": {"targets": {"test:e2e": "not-a-table"}}})
            target, refusal = client("bun")._declared_target(project, "test:e2e")
            self.assertIsNone(target)
            self.assertIn("crucible.targets.test:e2e", refusal)

    def test_a_crucible_toml_that_does_not_parse_is_refused_by_the_targets_readers(self):
        project = new_project(self)
        write_toml(project, UNPARSEABLE_TOML)
        for reader in TARGETS_READERS:
            with self.subTest(stack=reader):
                self.assertEqual(self.entry_desc(reader)["shape"]["file_does_not_parse"], REFUSED)
                self.assertEqual(reader_verdict(reader, project, READER_KEYS[reader]), REFUSED)

    def test_a_crucible_toml_that_does_not_parse_declares_no_stack_table(self):
        project = new_project(self)
        write_toml(project, UNPARSEABLE_TOML)
        bun, python = client("bun"), client("python")
        for stack in ("bun", "python"):
            self.assertEqual(
                self.schema["stacks"][stack]["stack_table"]["shape"]["file_does_not_parse"],
                UNDECLARED)
        self.assertIsNone(bun._declared_package_dir(project)[0])
        self.assertEqual(bun._resolve_package_dir(None, project), project)
        self.assertIsNone(python._declared_runner(project)[0])
        default = self.schema["stacks"]["python"]["stack_table"]["fields"]["runner"]["default"]
        self.assertEqual(python._resolve_runner(no_python_args(), project, probe=False), default)


class EachTargetsReadersKeyFormHoldsTest(_AgreementCase):

    def test_arduino_joins_the_native_dir_to_the_make_target(self):
        arduino = client("arduino")
        key = self.entry_desc("arduino")["key"]
        self.assertEqual(arduino._declared_key(SimpleNamespace(dir=None), "unit"),
                         f"{key['dir_default']}/unit")
        self.assertEqual(arduino._declared_key(SimpleNamespace(dir="tests/sim/"), "unit"),
                         "tests/sim/unit")

    def test_an_entry_is_read_under_its_own_key_only(self):
        project = new_project(self)
        others = {"rust": "e2e", "arduino": "tests/native/other", "maven": "unit"}
        for reader in TARGETS_READERS:
            refused = {**complete_entries(self.schema, reader)[0],
                       self.entry_desc(reader)["refused"][0]: "flag"}
            with self.subTest(stack=reader):
                write_targets_toml(project, READER_KEYS[reader], refused)
                self.assertEqual(reader_verdict(reader, project, READER_KEYS[reader]), REFUSED)
                self.assertEqual(reader_verdict(reader, project, others[reader]),
                                 SKIP_OUTCOME[reader])

    def test_mavens_console_check_refuses_a_wrong_console_for_its_tier(self):
        mvn = client("maven")
        project = new_project(self)
        entry = {**complete_entries(self.schema, "maven")[0], "console": "not-a-declared-value"}
        write_targets_toml(project, "e2e", entry)
        args = SimpleNamespace(project_dir=project, agent=None)
        with self.assertRaises(declaration_refused("maven")) as caught:
            mvn._check_console_declaration(args, "e2e")
        self.assertIn("[targets.e2e]", str(caught.exception))
        self.assertIn("console", str(caught.exception))


class TheStackTablesHoldTest(_AgreementCase):

    def test_bun_package_dir_must_be_a_directory_holding_the_named_file(self):
        bun = client("bun")
        project = new_project(self)
        holds = (self.schema["stacks"]["bun"]["stack_table"]["fields"]["package_dir"]
                 ["values"]["path"]["holds"])
        Path(project, "pkg").mkdir()
        Path(project, "pkg", holds).write_text("{}", encoding="utf-8")
        Path(project, "empty").mkdir()
        write_toml(project, '[bun]\npackage_dir = "pkg"\n')
        self.assertEqual(bun._resolve_package_dir(None, project), os.path.join(project, "pkg"))
        for value in ('"empty"', '""', "5"):
            with self.subTest(package_dir=value):
                write_toml(project, f"[bun]\npackage_dir = {value}\n")
                with self.assertRaises(bun.PackageDirRefused):
                    bun._resolve_package_dir(None, project)
        write_toml(project, "[bun]\n")
        self.assertEqual(bun._resolve_package_dir(None, project), project)

    def test_python_runner_accepts_each_value_refuses_another_and_defaults(self):
        python = client("python")
        project = new_project(self)
        runner = self.schema["stacks"]["python"]["stack_table"]["fields"]["runner"]
        for value in runner["values"]:
            with self.subTest(runner=value):
                write_toml(project, f'[python]\nrunner = "{value}"\n')
                self.assertEqual(python._resolve_runner(no_python_args(), project,
                                                        probe=False), value)
        write_toml(project, '[python]\nrunner = "not-a-declared-value"\n')
        with self.assertRaises(python.RunnerRefused) as caught:
            python._resolve_runner(no_python_args(), project, probe=False)
        self.assertIn("not-a-declared-value", str(caught.exception))
        write_toml(project, "[python]\n")
        self.assertEqual(python._resolve_runner(no_python_args(), project, probe=False),
                         runner["default"])

    def test_the_runner_flag_overrides_the_declared_runner(self):
        python = client("python")
        project = new_project(self)
        runner = self.schema["stacks"]["python"]["stack_table"]["fields"]["runner"]
        self.assertEqual(runner["overridden_by"], python._RUNNER_FLAG)
        for declared in ('"unittest"', '"not-a-declared-value"'):
            with self.subTest(declared=declared):
                write_toml(project, f"[python]\nrunner = {declared}\n")
                args = no_python_args(runner="pytest")
                self.assertEqual(python._resolve_runner(args, project, probe=False), "pytest")


if __name__ == "__main__":
    unittest.main()
