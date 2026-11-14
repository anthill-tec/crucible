"""What each doc test's changelog checks ask, check by check.

A doc test asks the changelog one of two things, and each kind reads its own
part of it:

  * RECORDED — a feature IS named. It searches every release section of the
    changelog (`[Unreleased]` and every dated section, the link block at the
    foot excluded), so it stays green when the next release's section is
    written above the one that records the feature. Its reader is
    `changelog_entries` / `changelogEntries`.
  * ABSENT — stale wording is NOT there. It reads only the section being
    written (the topmost one), so an old release's honest record of its day
    never fails it. Its reader is `changelog_section` / `changelogSection`.

A python check is named `Class.method` within its module under
`tests/client/`; a bun check is named `innermost describe › test title` within
its file under `tests/`. Every check of a listed module that reads the
changelog is here, and nothing else is.
"""

#: The python doc tests, under tests/client/: module -> the kinds of its checks.
PYTHON_CHECKS = {
    "test_a_runs_coverage_files_are_documented": {
        "recorded": (
            "TheReadersReadWhatTheyAreAskedTest."
            "test_the_documents_and_the_bullet_are_there_to_read",
            "TheChangelogNamesTheBlockTheFlagAndTheGatesRowsTest."
            "test_unreleased_names_every_key_of_the_block",
            "TheChangelogNamesTheBlockTheFlagAndTheGatesRowsTest."
            "test_unreleased_names_every_key_of_a_file_row",
            "TheChangelogNamesTheBlockTheFlagAndTheGatesRowsTest."
            "test_unreleased_names_run_with_its_files_flag",
            "TheChangelogNamesTheBlockTheFlagAndTheGatesRowsTest."
            "test_unreleased_names_the_gates_coverage_runs",
        ),
        "absent": (),
    },
    "test_project_create_is_documented": {
        "recorded": (
            "ProjectCreateIsDocumentedTest."
            "test_the_unreleased_added_section_has_a_bullet_for_the_verb",
        ),
        "absent": (),
    },
    "test_the_arduino_stream_declaration_is_documented": {
        "recorded": (
            "TheChangelogNamesTheArduinoDeclarationTest."
            "test_the_stack_declaration_changes_have_an_arduino_part",
            "TheChangelogNamesTheArduinoDeclarationTest."
            "test_the_arduino_part_names_the_declaration",
            "TheChangelogNamesTheArduinoDeclarationTest."
            "test_the_arduino_part_names_the_crucible_stream_make_contract",
        ),
        "absent": (),
    },
    "test_the_declaration_schema_is_documented": {
        "recorded": (
            "TheChangelogNamesTheDeclarationSchemaTest."
            "test_the_section_names_the_schema_file",
            "TheChangelogNamesTheDeclarationSchemaTest."
            "test_the_section_names_the_schemas_installed_path",
            "TheChangelogNamesTheDeclarationSchemaTest."
            "test_the_section_names_the_shipped_schemas_version",
            "TheChangelogNamesTheDeclarationSchemaTest."
            "test_the_section_states_the_schema_version_one_more_than_before_the_marked_entry_exemption",
            "TheChangelogNamesTheDeclarationSchemaTest."
            "test_the_section_states_the_writer_rule",
            "TheChangelogNamesTheDeclarationSchemaTest."
            "test_the_rust_part_names_the_skip_of_another_stacks_entry",
            "TheChangelogNamesTheDeclarationSchemaTest."
            "test_go_test_joining_the_arduino_and_maven_skip_sets_is_named",
        ),
        "absent": (),
    },
    "test_the_docs_say_regression_and_the_gate_read_the_marker": {
        "recorded": (
            "TheChangelogSaysRegressionAndTheGateReadTheMarkerTest."
            "test_the_marker_bullet_names_regression_and_the_gate_and_the_tier_verbs_ignoring_it",
            "TheChangelogSaysRegressionAndTheGateReadTheMarkerTest."
            "test_a_changed_bullet_says_regression_and_the_gate_run_the_marked_entry_and_coverage_goes_only_to_bun_test",
            "TheChangelogSaysRegressionAndTheGateReadTheMarkerTest."
            "test_a_version_bullet_names_the_marked_entrys_gate_exemption_and_its_readers",
            "TheChangelogSaysRegressionAndTheGateReadTheMarkerTest."
            "test_version_two_adding_the_go_stack_is_still_named",
        ),
        "absent": (
            "NothingStillSaysOnlyTestReadsTheMarkerTest."
            "test_the_changelogs_unreleased_section",
        ),
    },
    "test_the_go_client_is_documented": {
        "recorded": (
            "TheChangelogNamesTheGoStackTest.test_the_schema_part_states_version_two",
            "TheChangelogNamesTheGoStackTest.test_the_section_keeps_a_go_part",
            "TheChangelogNamesTheGoStackTest.test_the_go_part_names_the_module_dir_table",
            "TheChangelogNamesTheGoStackTest."
            "test_the_go_part_names_the_go_stack_joining_the_schema",
            "TheChangelogNamesTheGoStackTest."
            "test_the_go_part_states_that_test_main_runs_twice_per_run",
            "TheChangelogNamesGosCheckAndCoverageTest.test_names_gos_check",
            "TheChangelogNamesGosCheckAndCoverageTest.test_names_gos_check_tests",
            "TheChangelogNamesGosCheckAndCoverageTest.test_names_gos_coverage_flag",
            "TheChangelogNamesGosCheckAndCoverageTest."
            "test_states_go_coverage_is_statement_coverage_on_the_lines_axis",
            "TheChangelogNamesGosCheckAndCoverageTest."
            "test_states_that_goflags_carries_coverpkg",
            "TheChangelogNamesGosTiersTest."
            "test_names_every_fact_of_gos_build_tag_tiers",
            "TheChangelogNamesGosTiersTest."
            "test_says_check_tests_compiles_each_declared_tier",
        ),
        "absent": (
            "TheChangelogNamesGosTiersTest.test_nothing_says_go_declares_no_tier",
        ),
    },
    "test_the_lint_verb_and_gate_stage_are_documented_where_operators_read_them": {
        "recorded": (
            "TheChangelogNamesTheLintVerbAndTheRustMappingTest."
            "test_an_entry_names_the_lint_verb_in_every_client",
            "TheChangelogNamesTheLintVerbAndTheRustMappingTest."
            "test_it_maps_the_rust_gates_stage_to_lint",
            "TheChangelogNamesTheLintVerbAndTheRustMappingTest."
            "test_it_maps_the_rust_gates_abort_warning_to_lint_gate_abort",
            "TheChangelogNamesTheLintVerbAndTheRustMappingTest."
            "test_it_keeps_skip_clippy_as_an_alias_of_skip_lint",
        ),
        "absent": (),
    },
    "test_the_maven_console_declaration_is_documented": {
        "recorded": (
            "TheChangelogNamesTheMavenDeclarationTest."
            "test_the_stack_declaration_changes_have_a_maven_part",
            "TheChangelogNamesTheMavenDeclarationTest."
            "test_the_maven_part_names_the_declaration",
            "TheChangelogNamesTheMavenDeclarationTest."
            "test_the_maven_part_names_the_surefire_console_view_codec",
        ),
        "absent": (),
    },
    "test_the_rust_targets_declaration_is_documented": {
        "recorded": (
            "TheChangelogsStackDeclarationChangesNameTheRustTableTest."
            "test_the_unreleased_entry_carries_the_section_with_a_rust_part",
            "TheChangelogsStackDeclarationChangesNameTheRustTableTest."
            "test_the_rust_part_names_the_table_and_the_rust_entry",
            "TheChangelogsStackDeclarationChangesNameTheRustTableTest."
            "test_the_rust_part_names_the_standard_profiles",
            "TheChangelogsStackDeclarationChangesNameTheRustTableTest."
            "test_the_rust_part_says_undeclared_profiles_stream_by_default",
            "TheChangelogsStackDeclarationChangesNameTheRustTableTest."
            "test_the_rust_part_names_the_minimum_nextest",
            "TheChangelogsStackDeclarationChangesNameTheRustTableTest."
            "test_the_rust_part_names_the_retirement_of_ignore_run_fail",
        ),
        "absent": (),
    },
}

#: The bun doc tests, under tests/: file stem -> the kinds of its checks.
BUN_CHECKS = {
    "docs-describe-lint-records": {
        "recorded": (
            "the CHANGELOG records lint records › "
            "its Unreleased section has an entry naming lint records",
        ),
        "absent": (),
    },
    "coverage-file-table-docs": {
        "recorded": (
            "the changelog's unreleased section states the per-file coverage › "
            "it names the read of a run's coverage files",
            "the changelog's unreleased section states the per-file coverage › "
            "it names the two keys the ingest answer gains",
            "the changelog's unreleased section states the per-file coverage › "
            "it says the board keeps a run's coverage file by file and shows it",
        ),
        "absent": (),
    },
    "coverage-outside-the-runs-tree-docs": {
        "recorded": (
            "the documents say a run's coverage keeps only the files inside its tree › "
            "the changelog's unreleased section says a coverage file outside the run's tree is not kept",
            "the passages the rule is written into are there to be read › "
            "the changelog has an unreleased section that speaks of coverage files",
        ),
        "absent": (),
    },
    "release-flow-names-the-release-notes-verb": {
        "recorded": (
            "the CHANGELOG's unreleased section says what the release-notes verb does › "
            "an unreleased entry names release-notes, --format markdown and --date, "
            "and says each line carries a title and an id",
            "the CHANGELOG's unreleased section says what the release-notes verb does › "
            "the changelog has an unreleased section with entries to read",
        ),
        "absent": (),
    },
}

#: Each kind's reader, by language.
PYTHON_READERS = {"recorded": "changelog_entries", "absent": "changelog_section"}
TS_READERS = {"recorded": "changelogEntries", "absent": "changelogSection"}


def readers_needed(kinds, readers):
    """The readers a module's checks need: one per kind it has a check of."""
    return sorted(readers[kind] for kind in ("recorded", "absent") if kinds[kind])
