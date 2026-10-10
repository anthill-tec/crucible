"""RED tests — AC8/§S6: `clients/STATUS-CONTRACT.md` documents the
work-in-flight `status` contract (version 3.0.0), not the unfiltered
history it used to describe.

RED today: the doc is still version 2.0.0. Its top-level field table has no
`filed` row, its `plans` field description and terminal-states section still
describe "every plan"/"no plan is filed" as the empty meaning rather than
the three §S4 states (work in flight / none open / never filed), its row
schema's `status` field still reads "`open` / closed" (every plan, not just
the open ones this verb now reads), its `count` field still reads "Total
plans available", it names no `queue` read for every CR/plan, and it
documents no `--format json` shape at all. Every assertion below fails
against the current 2.0.0 text for one of these reasons.

Deliberately narrow, meaning-bearing assertions (not whole-paragraph
matches) so GREEN retains room to write good prose, per the RED-agent
brief.

Invocation:
    python3 -m unittest tests.client.test_status_contract_documents_the_work_in_flight
"""

import json
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
STATUS_CONTRACT_PATH = REPO_ROOT / "clients" / "STATUS-CONTRACT.md"


def _normalize(text):
    """Lowercase, backtick-stripped, whitespace-collapsed — the same
    normalization `test_crucible_axi_shared.py`'s contract-doc suite already
    uses so a phrase check survives Markdown emphasis/backtick reformatting."""
    return " ".join(text.replace("`", "").split()).lower()


class StatusContractDocumentsTheWorkInFlightTest(unittest.TestCase):
    """AC8/§S6 — the contract doc's version, field table, terminal states,
    degrade shape and row schema describe §S1-§S5 (the open-plans-only
    verb, `filed`, the three §S4 states), names `queue` as the read for
    every CR/plan, documents `--format json` (§S8) with a parseable
    example, and drops the sentences that described the old unfiltered
    behaviour as current."""

    def _read(self):
        self.assertTrue(
            STATUS_CONTRACT_PATH.exists(),
            f"the contract doc must exist at {STATUS_CONTRACT_PATH}")
        return STATUS_CONTRACT_PATH.read_text()

    # ── version ──────────────────────────────────────────────────────────

    def test_version_line_is_3_0_0(self):
        text = self._read()
        self.assertIn(
            "**Version: 3.0.0**", text,
            "AC8 requires the contract doc's version to be 3.0.0 (a "
            "BREAKING change to the rows a consumer gets); the old "
            "2.0.0 line must be gone")
        self.assertNotIn(
            "**Version: 2.0.0**", text,
            "the OLD 2.0.0 version line must not survive alongside 3.0.0")

    def test_versioning_section_names_the_3_0_0_bump_as_breaking(self):
        text = self._read()
        match = re.search(r"##\s*Versioning(.*)", text, re.DOTALL | re.IGNORECASE)
        assert match is not None, (
            "the contract doc must keep its ## Versioning section")
        section = match.group(1)
        self.assertTrue(
            re.search(r"3\.0\.0", section),
            f"the Versioning section must carry a bullet naming the "
            f"3.0.0 bump; got section={section[:400]!r}")
        self.assertIn(
            "breaking", section.lower(),
            "the 3.0.0 bullet must name the change as BREAKING — it "
            "changes the rows a consumer gets (§S6)")

    # ── top-level field table ────────────────────────────────────────────

    def test_top_level_field_table_has_a_filed_row(self):
        text = self._read()
        normalized = _normalize(text)
        self.assertIn(
            "| filed |", normalized,
            f"the top-level envelope field table must gain a `filed` "
            f"row (§S2's second published project fact); none found")
        self.assertIn(
            "ever filed", normalized,
            "the `filed` row must state the §S2 computation — the number "
            "of plans the project has EVER filed, whatever their status "
            "— not a paraphrase")

    def test_plans_row_describes_open_plans_not_every_plan_or_filed_as_empty(self):
        text = self._read()
        row_match = re.search(r"\|\s*`plans`\s*\|([^\n]*)\|", text)
        assert row_match is not None, (
            "the top-level field table must keep a `plans` row")
        row_text = row_match.group(1).lower()
        self.assertIn(
            "open plan", row_text,
            f"the `plans` row must describe the OPEN plans (the work in "
            f"flight, §S3) — got row={row_match.group(0)!r}")
        self.assertNotIn(
            "every plan", row_text,
            f"the `plans` row must not still describe every plan the "
            f"project has filed — got row={row_match.group(0)!r}")
        self.assertNotIn(
            "no plan is filed", row_text,
            f"the `plans` row must not equate emptiness with 'no plan is "
            f"filed' — an aborted-only or closed-only board is FILED "
            f"but has no open plan (§S4's 'none open' state); got "
            f"row={row_match.group(0)!r}")

    def test_count_field_no_longer_describes_total_plans_available(self):
        normalized = _normalize(self._read())
        self.assertNotIn(
            "total plans available", normalized,
            "the `count` field's old description ('Total plans "
            "available') must be gone — count is now the number of OPEN "
            "plan ROWS (§S3), a different fact from `filed`")

    # ── row schema (`plans[]`) ───────────────────────────────────────────

    def test_row_schema_status_field_no_longer_reads_open_slash_closed(self):
        normalized = _normalize(self._read())
        self.assertNotIn(
            "the plan lifecycle status (open / closed)", normalized,
            "the plans[] row schema's `status` field must no longer "
            "describe 'open / closed' as the base row's meaning — every "
            "row this verb returns is now an OPEN plan (§S3)")

    # ── terminal states + degrade ────────────────────────────────────────

    def test_terminal_states_section_lists_the_three_s4_states(self):
        text = self._read()
        match = re.search(
            r"##\s*Terminal states(.*?)(?=\n##\s)", text,
            re.DOTALL | re.IGNORECASE)
        assert match is not None, (
            "the contract doc must keep its ## Terminal states section")
        section = match.group(1).lower()
        for phrase in ("work in flight", "none open", "never filed"):
            self.assertIn(
                phrase, section,
                f"the Terminal states section must name the §S4 state "
                f"{phrase!r}; got section={section[:600]!r}")

    def test_degrade_shape_documents_filed_null(self):
        normalized = _normalize(self._read())
        self.assertIn(
            "status-unavailable", normalized,
            "the tolerant-degrade shape must still be documented")
        self.assertIn(
            "filed: null", normalized,
            "the §S5 degrade shape must document the ADDED field "
            "filed: null (the plan count is unknown, not zero, when the "
            "board could not be read)")

    # ── `queue` named as the read for every CR/plan ─────────────────────

    def test_queue_named_as_the_read_for_every_cr_and_plan(self):
        normalized = _normalize(self._read())
        self.assertTrue(
            re.search(r"queue.{0,120}every cr and plan"
                      r"|every cr and plan.{0,120}queue", normalized),
            f"the contract doc must name `queue` as the read for EVERY "
            f"CR and plan (§S6) — status gains no flag for it; text="
            f"{normalized[:2000]!r}")

    # ── `--format json` (§S8) ────────────────────────────────────────────

    def test_format_json_is_documented_with_a_parseable_example_containing_filed(self):
        text = self._read()
        normalized = _normalize(text)
        self.assertIn(
            "--format json", normalized,
            "the contract doc must document the --format json flag (§S8)")
        blocks = re.findall(r"```(?:json)?\n(.*?)```", text, re.DOTALL)
        parsed_examples = []
        for block in blocks:
            try:
                parsed_examples.append(json.loads(block))
            except (json.JSONDecodeError, ValueError):
                continue
        self.assertTrue(
            parsed_examples,
            f"the contract doc must carry at least one FENCED JSON "
            f"example that actually parses as JSON (§S8's example "
            f"object); no parseable fenced block found among "
            f"{len(blocks)} fenced block(s)")
        self.assertTrue(
            any(isinstance(example, dict) and "filed" in example
                for example in parsed_examples),
            f"at least one parseable JSON example must be an object "
            f"carrying the `filed` key (the same unwrapped axi shape "
            f"§S8 describes); got examples={parsed_examples!r}")


if __name__ == "__main__":
    unittest.main()
