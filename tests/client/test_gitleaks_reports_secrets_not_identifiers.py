"""gitleaks reports secrets, not identifiers.

The repo's `.gitleaks.toml` extends gitleaks' default rules and disables
none. Its one value allowance is a label allowlist: it lets a hyphen-joined
label of short segments through, only for the `generic-api-key` rule and only
under `tests/`, so the made-up fixture labels the tests use stop drowning a
real secret. It also excludes the gitignored run output (`test-reports/`,
`__pycache__/`) by path. It allows no UUID: the design note's one UUID line
carries an inline `gitleaks:allow` instead.

gitleaks itself is not on CI, so nothing here runs the binary. The file is
parsed with `tomllib` and its allowlists are evaluated by `_allows`, a mirror
of how gitleaks 8.30.1 applies an allowlist to a finding
(`checkCommitOrPathAllowed` and `checkFindingAllowed` in gitleaks'
detect/detect.go):

* a global allowlist with no `targetRules` applies to every rule; one with
  `targetRules`, or one under a `[[rules]]` entry, applies to those rules only;
* its `condition` is OR by default: any one of its paths, regexes or
  stopwords allows the finding. Under AND, every criterion it sets must hold;
* a path or regex allows by an unanchored search (Go's `MatchString`), a
  stopword by a case-insensitive substring of the secret; a `--no-git` scan
  carries no commit, so a `commits` entry never matches;
* table keys are read case-insensitively, as gitleaks' config loader reads
  them.

Every path is checked in two forms: relative to the repo root (a scan of
`--source .`) and absolute (pi-lens passes the absolute project directory as
`--source`, so gitleaks reports absolute paths). A correct allowlist holds
under both.

gitleaks compiles its regexes with Go's RE2; this test compiles them with
Python's `re` (with `re.ASCII`, as RE2's classes are ASCII). They must stay in
the syntax the two share, so no construct either one lacks: lookaround,
backreferences, atomic groups, possessive quantifiers, conditionals, `\\Z`.

The label shape is decided here. A label is two or more segments joined by
single hyphens, with nothing else in it (no `_`, `.` or `=`). Each segment is
either

* a word: 1 to 16 letters all of one case, optionally followed by a number of
  1 to 3 digits and then at most 3 more letters of that case (`agg`, `cr022`,
  `C165`, `e2e`), or
* a bare number of 1 to 3 digits (`1`, `117`).

So a segment that mixes letter cases, runs past 16 letters or 3 digits, starts
with digits and continues with letters, or interleaves several digit runs is
not a label segment, and a token holding one is reported. Every fixture label
gitleaks' default rules report in the tracked tree today has this shape;
`CURRENT_FIXTURE_LABELS` lists them (one id-shaped namespace prefix is swapped
for a synthetic one of the same shape, keeping it off the id tripwire).

No secret-shaped value is written whole in this file: each is assembled at
run time from short pieces, so this file gives a gitleaks scan of the tree
nothing to report.
"""

# pi-lens-ignore: I001 — pi-lens lints with its own ruff configuration, which sets no target version, so ruff files `tomllib` as third-party whatever the declared floor
import re  # noqa: I001
import tomllib
import unittest
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
GITLEAKS_CONFIG_PATH = REPO_ROOT / ".gitleaks.toml"
DESIGN_NOTE_PATH = REPO_ROOT / "docs" / "research" / "DN-crucible-api-reconstruction.md"

LABEL_RULE = "generic-api-key"
OTHER_RULES = ("github-pat", "aws-access-token", "private-key", "slack-bot-token")

# A rule entry may add allowlists and a description; any other key changes
# what a default rule detects or reports.
RULE_KEYS_THAT_ONLY_ADD_ALLOWLISTS = {"id", "description", "allowlist", "allowlists"}

# Every fixture label the default rules report under tests/ today, one per
# distinct value (101 findings, 92 values).
CURRENT_FIXTURE_LABELS = (
    "agg-collapse-expand-1",
    "cr017-compile",
    "cr022-points-key",
    "cr025-accordion-badge-stopprop-1",
    "cr025-accordion-heuristic-1",
    "cr025-accordion-persist-1",
    "cr025-accordion-toggle-1",
    "cr025-badge-presence-1",
    "cr025-badge-shape-1",
    "cr025-badge-shape-inverse-1",
    "cr025-heuristic-1",
    "cr025-stoppropagation-1",
    "cr032-anchor-merge-1",
    "cr032-anchor-pruned-1",
    "cr032-pill-dims-1",
    "cr032-pill-dims-durable-1",
    "cr040-env-probe-key",
    "cr111-tier-modality-key",
    "cr111-tier-stamping-key",
    "cr111-tier-surface-key",
    "cr120-both-kinds",
    "cr122-save-failed",
    "cr122-save-slow",
    "cr150-c9-landings",
    "cr179-folded-runs-1",
    "CR-ABORT-UNAPPROVED-1",
    "CR-ABORT-UNAPPROVED-2",
    "QA-QAX-041-C1-GREEN-bun-cycle",
    "QA-QAX-056-C2-stamp-gates",
    "QA-QAX-056-C2-stamp-matching",
    "QA-QAX-056-C2-stamp-runs",
    "QA-QAX-056-C5-echo-explicit",
    "QA-QAX-056-C5-echo-gates",
    "QA-QAX-056-C5-echo-runs",
    "QA-QAX-056-T2-closed",
    "QA-QAX-056-T2-pending",
    "QA-QAX-056-T5-rebind-A",
    "QA-QAX-056-T5-rebind-B",
    "QA-QAX-057-compile-stamp",
    "QA-QAX-057-echo-gates",
    "QA-QAX-057-echo-runs",
    "QA-QAX-057-gate-stamp",
    "QA-QAX-140-S3-EXPLICIT",
    "QA-QAX-140-S3-VISIBLE",
    "QA-QAX-162-C1-decision-bound",
    "CR-FCST-BIMODAL-LOW-1",
    "CR-FCST-BIMODAL-LOW-2",
    "CR-FCST-BIMODAL-LOW-3",
    "CR-INGEST-CYCLE-SIBLING-A1",
    "CR-INGEST-CYCLE-SIBLING-A2",
    "CR-LEGACY-ABORTED-C165",
    "CR-Q99-GATE-BIND",
    "cru164-verified-chip-key",
    "evt-landing-ac1-absent-1",
    "evt-landing-ac1-held-1",
    "evt-landing-ac1-stale-1",
    "evt-landing-gate-arrives-1",
    "f13-runcount-singular-1",
    "f23-hist-skip-recorded",
    "f23-hist-skip-unrecorded",
    "hist-collapse-1",
    "hist-cru177-no-pending-row",
    "hist-exclude-1",
    "landing-ac1-held-stale-1",
    "landing-turns-busy-gate-1",
    "landing-turns-busy-plan-1",
    "landing-turns-idle-plan-1",
    "mgr-liveness-default-1",
    "mgr-retention-default-1",
    "milestone-scoping-1",
    "orch-gate-ingest-1",
    "orch-milestone-1",
    "proj-align-hist-1",
    "proj-focus-persist-1",
    "proj-header-visible-ws-1",
    "proj-inpane-compile-1",
    "proj-inpane-focus-1",
    "proj-inpane-regression-ctx-1",
    "proj-live-ws-glyph-1",
    "proj-s1-both-alive",
    "proj-s1-mixed-tomb",
    "proj-s2-raw-empty-1",
    "proj-vitals-velocity-order-1",
    "test-key-cr039-regression",
    "test-key-cr061-skip",
    "test-key-cr061-skip-e2e",
    "test-key-gate-respond-argv-e2e",
    "trend-geom-20-coarsened",
    "trend-geom-20-coarsened-caption",
    "trend-geom-90-buckets",
    "wf-117-boundary-sealed",
    "wf-primary-badge-1",
)

# A few labels used where one stands for them all.
SAMPLE_LABELS = (
    "agg-collapse-expand-1",
    "cr022-points-key",
    "CR-LEGACY-ABORTED-C165",
    "test-key-gate-respond-argv-e2e",
)

# The longest word and number a segment may hold.
LONGEST_WORD_LABEL = "characterization-1"  # 16 letters
LONGEST_NUMBER_LABEL = "wf-117-boundary-sealed"  # 3 digits

UNDER_TESTS = (
    "tests/client/test_a_run_without_agent_files_nothing.py",
    "tests/project-namespace-tripwire.test.ts",
    "tests/e2e/a-board-flow.spec.ts",
    "tests/fixtures/a-fixture.json",
)

OUTSIDE_TESTS = (
    "src/server.ts",
    "public/app.js",
    "clients/python-crucible.py",
    "crucible_axi/install.py",
    "docs/changes/a-change.md",
    "docs/research/DN-crucible-api-reconstruction.md",
    "README.md",
    "install.sh",
    # a directory whose name merely ends in `tests` is not `tests/`
    "src/contests/entry.ts",
)

RUN_OUTPUT = (
    "test-reports/an-agent/TEST-tests.client.test_a_feature.xml",
    "test-reports/an-agent-out/run-envelope.txt",
    "__pycache__/conftest.cpython-314.pyc",
    "tests/client/__pycache__/test_a_feature.cpython-314.pyc",
    "clients/__pycache__/_crucible_axi.cpython-314.pyc",
    "crucible_axi/__pycache__/install.cpython-314.pyc",
)

NOT_RUN_OUTPUT = (
    "tests/client/test_a_feature.py",
    "src/server.ts",
    "clients/_crucible_axi.py",
    "docs/research/DN-crucible-api-reconstruction.md",
    # names that only resemble the run-output directories
    "tests/fixtures/latest-test-reports/summary.json",
    "src/pycache_view.ts",
)


# --- secret-shaped values, assembled at run time --------------------------

GITHUB_TOKEN = "ghp_" + "".join(("R8mKq2Lw", "9TzXc4Vb", "N7yHd3Jf", "6PsGa1Ue", "5WoQ"))
HEX_KEY_40 = "".join(("9f86d081", "884c7d65", "9a2feaa0", "c55ad015", "a3bf4f1b"))
RANDOM_SECRET_32 = "".join(("Xq7Lm2Pz", "9KvT4wRb", "N8cJ3hYs", "6GdF1aUe"))
DESIGN_NOTE_UUID = "-".join(("019c9ff7", "222f", "7ae5", "9121", "2ae549e4d97a"))
RANDOM_UUID = "-".join(("f47ac10b", "58cc", "4372", "a567", "0e02b2c3d479"))
UUIDS = (DESIGN_NOTE_UUID, RANDOM_UUID, RANDOM_UUID.upper())

LONG_SEGMENT_TOKENS = (
    # a word segment past 16 letters
    "-".join(("qhzvkmwtr" + "plxbndfgs" + "7", "wjtrbq")),
    "-".join(("characteri" + "zations", "1")),  # 17 letters
    # a number segment past 3 digits
    "-".join(("run", "4821")),
    "-".join(("build", "2026" + "1019", "1")),
)
MIXED_SEGMENT_TOKENS = (
    # letter cases mixed inside a segment
    "-".join(("Kp7", "wQz3Rt", "nM8v")),
    "-".join(("sk", "proj", "Ab3dEf" + "9hJk2L")),
    # digit runs interleaved with letters inside a segment
    "-".join(("a8f3k2", "z9x7q1", "m4n6")),
    # digits leading into letters
    "-".join(("7ae5", "58cc", "x1")),
)

UUID_SHAPE = re.compile(
    r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"
)

# Constructs Go RE2 and Python `re` do not share.
NOT_IN_THE_SHARED_SYNTAX = (
    ("lookahead", re.compile(r"\(\?!|\(\?=")),
    ("lookbehind", re.compile(r"\(\?<[=!]")),
    ("atomic group", re.compile(r"\(\?>")),
    ("conditional", re.compile(r"\(\?\(")),
    ("named backreference", re.compile(r"\(\?P=")),
    ("numbered backreference", re.compile(r"(?<!\\)\\[1-9]")),
    ("possessive quantifier", re.compile(r"(?<!\\)[*+?}]\+")),
    ("python-only end anchor", re.compile(r"(?<!\\)\\Z")),
)


# --- the configuration, as gitleaks reads it ------------------------------

def _lower_keys(value: Any) -> Any:
    """gitleaks' config loader matches table keys case-insensitively."""
    if isinstance(value, dict):
        return {str(k).lower(): _lower_keys(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_lower_keys(v) for v in value]
    return value


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, dict):
        return [value]
    return list(value)


def _scoped_allowlists(config):
    """Every allowlist in the file, with the rule ids it applies to (None for
    a global one that applies to every rule)."""
    scoped = []
    for allowlist in _as_list(config.get("allowlist")) + _as_list(config.get("allowlists")):
        targets = allowlist.get("targetrules") or []
        scoped.append((frozenset(targets) if targets else None, allowlist))
    for rule in _as_list(config.get("rules")):
        for allowlist in _as_list(rule.get("allowlist")) + _as_list(rule.get("allowlists")):
            scoped.append((frozenset({rule.get("id")}), allowlist))
    return scoped


def _value_allowlists(config):
    """The allowlists that let a finding through by its value."""
    return [
        (targets, allowlist)
        for targets, allowlist in _scoped_allowlists(config)
        if allowlist.get("regexes") or allowlist.get("stopwords")
    ]


def _search(pattern, text):
    return re.search(pattern, text, re.ASCII) is not None


def _allowlist_allows(allowlist, path, secret):
    paths = _as_list(allowlist.get("paths"))
    regexes = _as_list(allowlist.get("regexes"))
    stopwords = [str(word).lower() for word in _as_list(allowlist.get("stopwords"))]
    commits = _as_list(allowlist.get("commits"))

    path_allowed = any(_search(p, path) for p in paths)
    regex_allowed = any(_search(r, secret) for r in regexes)
    stopword_allowed = any(word in secret.lower() for word in stopwords)
    commit_allowed = False  # a --no-git scan carries no commit

    if str(allowlist.get("condition", "")).upper() in ("AND", "&&"):
        checks = []
        if commits:
            checks.append(commit_allowed)
        if paths:
            checks.append(path_allowed)
        if regexes:
            checks.append(regex_allowed)
        if stopwords:
            checks.append(stopword_allowed)
        return bool(checks) and all(checks)
    return commit_allowed or path_allowed or regex_allowed or stopword_allowed


def _allows(config, rule_id, path, secret):
    """Whether the repo's configuration lets this finding through."""
    return any(
        _allowlist_allows(allowlist, path, secret)
        for targets, allowlist in _scoped_allowlists(config)
        if targets is None or rule_id in targets
    )


def _path_forms(relative):
    """The path as a `--source .` scan reports it, and as pi-lens's absolute
    `--source` scan reports it."""
    return (relative, f"{REPO_ROOT.as_posix()}/{relative}")


def _all_regexes(config):
    found = []
    for _, allowlist in _scoped_allowlists(config):
        found.extend(_as_list(allowlist.get("paths")))
        found.extend(_as_list(allowlist.get("regexes")))
    return found


class _GitleaksConfigCase(unittest.TestCase):
    def _config(self) -> dict[str, Any]:
        if not GITLEAKS_CONFIG_PATH.is_file():
            self.fail(f"no gitleaks configuration at the repo root: {GITLEAKS_CONFIG_PATH}")
        with GITLEAKS_CONFIG_PATH.open("rb") as handle:
            return _lower_keys(tomllib.load(handle))

    def _allowed_findings(self, config, rule_ids, paths, secrets):
        """Every (rule, path form, secret) the configuration lets through."""
        return [
            (rule_id, form, secret)
            for rule_id in rule_ids
            for relative in paths
            for form in _path_forms(relative)
            for secret in secrets
            if _allows(config, rule_id, form, secret)
        ]

    def _reported_findings(self, config, rule_ids, paths, secrets):
        """Every (rule, path form, secret) the configuration still reports."""
        return [
            (rule_id, form, secret)
            for rule_id in rule_ids
            for relative in paths
            for form in _path_forms(relative)
            for secret in secrets
            if not _allows(config, rule_id, form, secret)
        ]

    def _assert_reported_in_a_test_file(self, secrets):
        config = self._config()
        # control: the label allowlist is live where the secrets are planted
        self.assertEqual(
            self._reported_findings(config, (LABEL_RULE,), UNDER_TESTS, SAMPLE_LABELS), [],
            "a fixture label under tests/ must be allowed",
        )
        self.assertEqual(
            self._allowed_findings(config, (LABEL_RULE,), UNDER_TESTS, secrets), [],
            "a secret in a test file must still be reported",
        )


class GitleaksConfigurationExtendsTheDefaultsTest(_GitleaksConfigCase):
    def _extend(self) -> dict[str, Any]:
        extend = self._config().get("extend")
        if not isinstance(extend, dict):
            self.fail("the configuration has no [extend] table")
        return extend

    def test_the_configuration_extends_gitleaks_default_rules(self):
        extend = self._extend()
        self.assertIs(extend.get("usedefault"), True)
        self.assertNotIn("path", extend, "extending a path replaces the default rules")

    def test_the_configuration_disables_no_default_rule(self):
        extend = self._extend()
        self.assertIs(extend.get("usedefault"), True)
        self.assertEqual(extend.get("disabledrules", []), [])

    def test_a_rule_entry_only_adds_allowlists_to_the_generic_api_key_rule(self):
        config = self._config()
        rules = _as_list(config.get("rules"))
        for rule in rules:
            self.assertEqual(rule.get("id"), LABEL_RULE,
                             f"a rule entry other than {LABEL_RULE}: {rule.get('id')!r}")
            self.assertLessEqual(set(rule), RULE_KEYS_THAT_ONLY_ADD_ALLOWLISTS,
                                 f"{LABEL_RULE}'s entry changes what the default rule "
                                 f"detects or reports: {sorted(set(rule) - RULE_KEYS_THAT_ONLY_ADD_ALLOWLISTS)}")
        # the label allowlist is the configuration's reason to exist
        self.assertNotEqual(_value_allowlists(config), [], "the configuration has no label allowlist")


class GitleaksLabelAllowlistScopeTest(_GitleaksConfigCase):
    def test_the_label_allowlist_is_scoped_to_the_generic_api_key_rule_alone(self):
        value_allowlists = _value_allowlists(self._config())
        self.assertNotEqual(value_allowlists, [], "the configuration has no label allowlist")
        for targets, allowlist in value_allowlists:
            self.assertEqual(targets, frozenset({LABEL_RULE}),
                             f"a value allowlist must apply to {LABEL_RULE} alone: {allowlist}")

    def test_the_label_allowlist_needs_a_tests_path_and_the_label_shape_together(self):
        value_allowlists = _value_allowlists(self._config())
        self.assertNotEqual(value_allowlists, [], "the configuration has no label allowlist")
        for _, allowlist in value_allowlists:
            self.assertEqual(str(allowlist.get("condition", "")).upper(), "AND",
                             f"under OR a tests/ path alone allows any secret: {allowlist}")
            self.assertNotEqual(_as_list(allowlist.get("paths")), [],
                                f"a value allowlist with no path applies tree-wide: {allowlist}")
            self.assertIn(allowlist.get("regextarget", "secret"), ("secret",),
                          "the label shape is matched against the reported secret")
            self.assertNotIn("stopwords", allowlist,
                             "a stopword allows any secret that contains it")

    def test_a_fixture_label_under_tests_is_allowed_for_the_generic_api_key_rule(self):
        config = self._config()
        self.assertEqual(
            self._reported_findings(config, (LABEL_RULE,), UNDER_TESTS, SAMPLE_LABELS), [],
        )

    def test_a_fixture_label_outside_tests_is_still_reported(self):
        config = self._config()
        self.assertEqual(
            self._reported_findings(config, (LABEL_RULE,), UNDER_TESTS, SAMPLE_LABELS), [],
            "control: a fixture label under tests/ must be allowed",
        )
        self.assertEqual(
            self._allowed_findings(config, (LABEL_RULE,), OUTSIDE_TESTS, SAMPLE_LABELS), [],
        )

    def test_a_fixture_label_under_tests_is_still_reported_by_every_other_rule(self):
        config = self._config()
        self.assertEqual(
            self._reported_findings(config, (LABEL_RULE,), UNDER_TESTS, SAMPLE_LABELS), [],
            "control: a fixture label under tests/ must be allowed",
        )
        self.assertEqual(
            self._allowed_findings(config, OTHER_RULES, UNDER_TESTS, SAMPLE_LABELS), [],
        )


class GitleaksLabelShapeTest(_GitleaksConfigCase):
    def test_every_current_fixture_label_has_the_allowed_shape(self):
        config = self._config()
        missed = [
            label for label in CURRENT_FIXTURE_LABELS
            if not all(_allows(config, LABEL_RULE, form, label)
                       for form in _path_forms(UNDER_TESTS[0]))
        ]
        self.assertEqual(missed, [])

    def test_a_segment_may_hold_sixteen_letters_and_three_digits(self):
        config = self._config()
        self.assertEqual(
            self._reported_findings(config, (LABEL_RULE,), UNDER_TESTS,
                                    (LONGEST_WORD_LABEL, LONGEST_NUMBER_LABEL)),
            [],
        )

    def test_a_github_token_in_a_test_file_is_reported(self):
        self._assert_reported_in_a_test_file((GITHUB_TOKEN,))

    def test_a_forty_character_hex_key_in_a_test_file_is_reported(self):
        self._assert_reported_in_a_test_file((HEX_KEY_40,))

    def test_a_thirty_two_character_random_secret_in_a_test_file_is_reported(self):
        self._assert_reported_in_a_test_file((RANDOM_SECRET_32,))

    def test_a_uuid_in_a_test_file_is_reported(self):
        self._assert_reported_in_a_test_file(UUIDS)

    def test_a_hyphenated_token_with_a_long_segment_in_a_test_file_is_reported(self):
        self._assert_reported_in_a_test_file(LONG_SEGMENT_TOKENS)

    def test_a_hyphenated_token_with_a_mixed_segment_in_a_test_file_is_reported(self):
        self._assert_reported_in_a_test_file(MIXED_SEGMENT_TOKENS)

    def test_every_regex_stays_within_the_syntax_go_re2_shares_with_python(self):
        regexes = _all_regexes(self._config())
        self.assertNotEqual(regexes, [], "the configuration carries no regex")
        for pattern in regexes:
            re.compile(pattern, re.ASCII)
            for construct, detector in NOT_IN_THE_SHARED_SYNTAX:
                self.assertIsNone(detector.search(pattern),
                                  f"{construct} is outside Go RE2's syntax: {pattern!r}")


class GitleaksAllowsNoUuidTest(_GitleaksConfigCase):
    def test_no_allowlist_lets_a_uuid_through_anywhere(self):
        config = self._config()
        self.assertEqual(
            self._reported_findings(config, (LABEL_RULE,), UNDER_TESTS, SAMPLE_LABELS), [],
            "control: a fixture label under tests/ must be allowed",
        )
        self.assertEqual(
            self._allowed_findings(config, (LABEL_RULE,) + OTHER_RULES,
                                   UNDER_TESTS + OUTSIDE_TESTS, UUIDS),
            [],
        )

    def test_the_configuration_names_no_uuid(self):
        self._config()
        text = GITLEAKS_CONFIG_PATH.read_text(encoding="utf-8")
        self.assertEqual(UUID_SHAPE.findall(text), [])

    def test_the_design_note_uuid_line_carries_an_inline_gitleaks_allow(self):
        lines = DESIGN_NOTE_PATH.read_text(encoding="utf-8").splitlines()
        uuid_lines = [line for line in lines if UUID_SHAPE.search(line)]
        self.assertEqual(len(uuid_lines), 1, f"the design note's UUID lines: {uuid_lines}")
        self.assertIn(DESIGN_NOTE_UUID, uuid_lines[0])
        self.assertIn("gitleaks:allow", uuid_lines[0])


class GitleaksRunOutputExclusionTest(_GitleaksConfigCase):
    def test_the_gitignored_run_output_is_excluded_for_every_rule(self):
        config = self._config()
        self.assertEqual(
            self._reported_findings(config, (LABEL_RULE,) + OTHER_RULES, RUN_OUTPUT,
                                    (GITHUB_TOKEN, HEX_KEY_40, RANDOM_SECRET_32)),
            [],
        )

    def test_the_run_output_exclusion_reaches_no_other_path(self):
        config = self._config()
        self.assertEqual(
            self._reported_findings(config, OTHER_RULES, RUN_OUTPUT, (GITHUB_TOKEN,)), [],
            "control: the run output must be excluded",
        )
        self.assertEqual(
            self._allowed_findings(config, (LABEL_RULE,) + OTHER_RULES, NOT_RUN_OUTPUT,
                                   (GITHUB_TOKEN, HEX_KEY_40, RANDOM_SECRET_32)),
            [],
        )


if __name__ == "__main__":
    unittest.main()
