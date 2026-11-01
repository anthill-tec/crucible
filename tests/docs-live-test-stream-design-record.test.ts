// The record of the live test stream's design (§S5, AC13) — plain text
// presence in the documents that carry it, each read within its own section:
//
//   - `ingest_body_bytes`' description, in the shipped src/crucible.toml and
//     in docs/RUNBOOK.md's limits row, states that it bounds one request body
//     AND a stream's total (tests/docs-runbook-documents-every-limit.test.ts
//     already holds the RUNBOOK row to the shipped description verbatim);
//   - PRD §4.13 records `LIVE_FRAME_MS` as the one cadence compiled into
//     source, and `ingest_body_bytes` as also bounding a stream's total;
//   - PRD §4.4 and §3.3 each name the `crucible-events` codec, the stream
//     route `/runs/<runId>/stream` and the close that decodes the held stream;
//   - the design note states that Playwright's steps are in the run's
//     record, not the live state, and assigns them to no later CR; and it
//     states that a stream which only feeds the view
//     (`bun-console`, maven's console) is CR-CRU-201's and CR-CRU-203's to
//     define — each in ONE statement (a paragraph, or one table row), so two
//     unrelated mentions far apart never pass for it.
//
// Each check reads a section bounded by its own heading, so a mention in
// another section never satisfies it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

function readText(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

const PRD = join("docs", "research", "PRD-crucible-v2.md");
const DN = join("docs", "research", "DN-crucible-live-test-progress.md");
const RUNBOOK = join("docs", "RUNBOOK.md");
const SHIPPED_TOML = join("src", "crucible.toml");

/**
 * The section a markdown heading opens — from the heading whose text starts
 * with `numbered` (e.g. "4.13") to the next heading of the same or a higher
 * level. "" when no such heading exists, so a check fails on its assertion.
 */
function section(md: string, numbered: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^#{1,6}\\s+${numbered.replace(/\./g, "\\.")}\\s`).test(line));
  if (start === -1) return "";
  const level = (/^(#+)/.exec(lines[start] ?? "")?.[1] ?? "#").length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const heading = /^(#+)\s/.exec(lines[i] ?? "");
    if (heading !== null && (heading[1] ?? "").length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** The document's statements: each paragraph, with a table split into its rows. */
function statements(md: string): string[] {
  const out: string[] = [];
  for (const paragraph of md.split(/\n\s*\n/)) {
    const lines = paragraph.split("\n");
    if (lines.every((line) => line.trimStart().startsWith("|"))) out.push(...lines);
    else out.push(paragraph);
  }
  return out;
}

/** A stream's total named as bounded: "a stream's total", "the stream's total size", "the total of a stream". */
const STREAM_TOTAL = /stream['’]s total|total (?:size )?of (?:a|the|one) stream/i;

const STREAM_ROUTE = /\/runs\/<runId>\/stream/;

describe("ingest_body_bytes states that it bounds one request body and a stream's total", () => {
  test("the shipped description in src/crucible.toml", () => {
    const shipped = Bun.TOML.parse(readText(SHIPPED_TOML)) as {
      limits?: Record<string, { description?: unknown }>;
    };
    const description = String(shipped.limits?.ingest_body_bytes?.description ?? "");
    expect(description).toMatch(/request body/);
    expect(description).toMatch(STREAM_TOTAL);
  });

  test("its row in docs/RUNBOOK.md's limits table", () => {
    const rows = readText(RUNBOOK)
      .split("\n")
      .filter((line) => line.trimStart().startsWith("| `ingest_body_bytes`"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/request body/);
    expect(rows[0]).toMatch(STREAM_TOTAL);
  });
});

describe("PRD §4.13 records the frame cadence and the stream bound", () => {
  test("§4.13 names LIVE_FRAME_MS as the one cadence compiled into source", () => {
    const s413 = section(readText(PRD), "4.13");
    expect(s413.length).toBeGreaterThan(0);
    // Booleans, not `toContain` on the section: a failure names the fact, not the whole section's text.
    expect(s413.includes("LIVE_FRAME_MS"), "§4.13 names LIVE_FRAME_MS").toBe(true);
    expect(
      /LIVE_FRAME_MS[\s\S]{0,300}(?:source|constant)|(?:source|constant)[\s\S]{0,300}LIVE_FRAME_MS/.test(s413),
      "§4.13 states LIVE_FRAME_MS is compiled into source",
    ).toBe(true);
  });

  test("§4.13 records ingest_body_bytes as also bounding a stream's total", () => {
    const s413 = section(readText(PRD), "4.13");
    expect(statements(s413).some((st) => st.includes("ingest_body_bytes") && STREAM_TOTAL.test(st))).toBe(true);
  });
});

describe("PRD §4.4 and §3.3 name the codec, the stream route and the close", () => {
  for (const numbered of ["4.4", "3.3"]) {
    test(`§${numbered} names \`crucible-events\`, the stream route and the close that decodes the held stream`, () => {
      const body = section(readText(PRD), numbered);
      expect(body.length).toBeGreaterThan(0);
      expect(body.includes("crucible-events"), `§${numbered} names the crucible-events codec`).toBe(true);
      expect(STREAM_ROUTE.test(body), `§${numbered} names the stream route`).toBe(true);
      // The close, beside what it does: decodes the stream the run holds.
      expect(
        /clos\w*[\s\S]{0,200}(?:held|hold|decod)\w*|(?:held|hold|decod)\w*[\s\S]{0,200}clos\w*/i.test(body),
        `§${numbered} names the close that decodes the held stream`,
      ).toBe(true);
    });
  }
});

describe("the design note assigns what this CR leaves to later ones", () => {
  test("Playwright's steps are in the run's record, not the live state, and no later CR is assigned them", () => {
    // Each list item on its own: a list's items share one paragraph.
    const dn = statements(readText(DN)).flatMap((st) => st.split(/\n(?=\s*- )/));
    const PLAYWRIGHT_STEPS = /Playwright['’]s (?:\w+ )?steps/;
    // POSITIVE — the ruling, in one statement: the steps are in the record, not the live state.
    const ruled = dn.some(
      (st) => PLAYWRIGHT_STEPS.test(st) && /record/.test(st) && /not in the live state/.test(st),
    );
    expect(ruled, "one statement puts Playwright's steps in the record, not the live state").toBe(true);
    // NEGATIVE — no item assigns them to a CR as its work ("are <CR>'s").
    const assigned = dn.filter((st) => PLAYWRIGHT_STEPS.test(st) && /\bare CR-[A-Z]+-\d+['’]s\b/.test(st));
    expect(assigned).toEqual([]);
  });

  test("a stream that only feeds the view — bun-console, maven's console — is CR-CRU-201's and CR-CRU-203's to define", () => {
    const found = statements(readText(DN)).some(
      (st) =>
        st.includes("bun-console") &&
        /maven/i.test(st) &&
        st.includes("CR-CRU-201") &&
        st.includes("CR-CRU-203") &&
        /view/i.test(st),
    );
    expect(found).toBe(true);
  });
});
