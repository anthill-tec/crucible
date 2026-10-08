// §S4/AC6 — the design documents say so: PRD-crucible-v2's "Gate events +
// Workflow tab" paragraph and DN-model-b-language's "Cycle / plan (live)"
// row describe the Workflow tab as Now and History, per storyboard F22
// (.lavish/crucible-v2-design.html, "Workflow in two panes — Now, and a
// History of releases…") — never the retired wording "beside the
// no-mistakes gate pane" / "no-mistakes gate pane beside it".
//
// Current-doc facts verified on this branch:
//   - docs/research/PRD-crucible-v2.md's paragraph reads "...a per-CR todo
//     view (active cycle expanded with its live runs) beside the
//     **no-mistakes gate pane**; the Wave -> [Track] -> CR -> Cycle history
//     lens below." — lowercase "history", no "Now", the retired phrase
//     present. Every assertion below is genuine RED against that text.
//   - docs/research/DN-model-b-language.md's row reads "**Workflow tab**
//     live section: per-CR todo view, active cycle = open span collecting
//     runs; no-mistakes gate pane beside it" — no "Now", no "History" at
//     all, the retired phrase present (word order differs slightly from
//     the PRD's but is the same claim).
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PRD_PATH = path.join(REPO_ROOT, "docs/research/PRD-crucible-v2.md");
const DN_PATH = path.join(REPO_ROOT, "docs/research/DN-model-b-language.md");

// A paragraph in these docs runs from its named anchor until the next bold
// section header ("\n  **<Title>...") or EOF — never a fixed line count, so
// a paragraph GREEN grows or shrinks is still read whole rather than cut
// off mid-sentence.
function paragraphStartingAt(text: string, anchor: string): string {
  const start = text.indexOf(anchor);
  if (start === -1) {
    throw new Error(`workflow-tab-now-and-history-doc-wording.test.ts: anchor ${JSON.stringify(anchor)} not found in ${PRD_PATH}`);
  }
  const rest = text.slice(start + anchor.length);
  const nextHeader = /\n\s*\*\*[A-Z][^*]*\*\*/.exec(rest);
  const end = nextHeader === null ? text.length : start + anchor.length + nextHeader.index;
  return text.slice(start, end);
}

// A markdown table row runs from its named row-start to the end of its line.
function tableRow(text: string, rowStart: string): string {
  const start = text.indexOf(rowStart);
  if (start === -1) {
    throw new Error(`workflow-tab-now-and-history-doc-wording.test.ts: row ${JSON.stringify(rowStart)} not found in ${DN_PATH}`);
  }
  const end = text.indexOf("\n", start);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

describe("§S4/AC6 — PRD-crucible-v2 and DN-model-b-language describe the Workflow tab as Now and History (F22)", () => {
  test("PRD-crucible-v2's 'Gate events + Workflow tab' paragraph names Now and History, and drops 'beside the no-mistakes gate pane'", () => {
    const prd = readFileSync(PRD_PATH, "utf8");
    const paragraph = paragraphStartingAt(prd, "**Gate events + Workflow tab");

    // NEGATIVE — the retired wording F22 replaces.
    expect(paragraph).not.toContain("beside the no-mistakes gate pane");

    // POSITIVE — both pane names, as F22 draws them (capitalized — the
    // pane's own name, never a bare lowercase "history lens" mention).
    expect(paragraph).toMatch(/\bNow\b/);
    expect(paragraph).toMatch(/\bHistory\b/);
  });

  test("DN-model-b-language's 'Cycle / plan (live)' row names Now and History, and drops 'no-mistakes gate pane beside it'", () => {
    const dn = readFileSync(DN_PATH, "utf8");
    const row = tableRow(dn, "| Cycle / plan (live) |");

    // NEGATIVE — the retired wording F22 replaces.
    expect(row).not.toContain("no-mistakes gate pane beside it");

    // POSITIVE — both pane names.
    expect(row).toMatch(/\bNow\b/);
    expect(row).toMatch(/\bHistory\b/);
  });
});
