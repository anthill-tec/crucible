// The words for lint records: the PRD, the RUNBOOK and the CHANGELOG each say
// what the board does with a lint run. Pinned by phrase, never by whole
// sentence:
//  - the PRD has a lint section: lint is a client verb, run by the gate after
//    `check`; its findings are marked compile records; the linter's exit is
//    the verdict; `check` never lints;
//  - the PRD's compile-ingest section (4.5) names the `ruff` and `clippy`
//    decoders and the lint exception to gcc's raw fallback;
//  - the PRD's status shape names `lastLint` beside `lastCompile`;
//  - the PRD's compile route body names `lint` and `runnerExit`;
//  - the RUNBOOK's retention section says lint records count toward retention;
//  - the CHANGELOG's unreleased section has an entry naming lint records.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogSection } from "./helpers/changelog-section.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRD = readFileSync(path.join(REPO_ROOT, "docs", "research", "PRD-crucible-v2.md"), "utf8");
const RUNBOOK = readFileSync(path.join(REPO_ROOT, "docs", "RUNBOOK.md"), "utf8");
const CHANGELOG = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");

/** Collapses every run of whitespace to one space, so a phrase may wrap. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * The section under the first heading matching `heading`: from that heading to
 * the next heading of the same or a higher level, on one line. Undefined when
 * no heading matches.
 */
function section(doc: string, heading: RegExp): string | undefined {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => /^#{1,6} /.test(l) && heading.test(l));
  if (start === -1) return undefined;
  const level = /^(#+)/.exec(lines[start]!)![1]!.length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = /^(#{1,6}) /.exec(lines[i]!);
    if (m !== null && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return flat(lines.slice(start, end).join("\n"));
}

/** The document's blank-line-separated blocks, each on one line. */
function blocks(doc: string): string[] {
  return doc.split(/\n\s*\n/).map(flat);
}

describe("the PRD has a lint section", () => {
  const lint = section(PRD, /\blint\b/i);

  test("the PRD has a section headed with lint", () => {
    expect(lint, "a PRD heading names lint").toBeDefined();
  });

  test("it says lint is a client verb run by the gate after `check`", () => {
    expect(lint ?? "").toContain("`lint`");
    expect(/\bclients?\b/i.test(lint ?? ""), "it names the client").toBe(true);
    expect(/\bgate\b/i.test(lint ?? ""), "it names the gate").toBe(true);
    expect(/\bafter `check`/i.test(lint ?? ""), "it runs after `check`").toBe(true);
  });

  test("it says lint findings are marked compile records", () => {
    expect(/\bmarked compile records?\b/i.test(lint ?? ""), "findings are marked compile records").toBe(true);
  });

  test("it says the linter's exit is the verdict", () => {
    expect(/\blinter.s exit\b[^.]*\bverdict\b/i.test(lint ?? ""), "the linter's exit is the verdict").toBe(true);
  });

  test("it says `check` never lints", () => {
    expect(/`check`[^.]*\bnever lints?\b/i.test(lint ?? ""), "`check` never lints").toBe(true);
  });
});

describe("the PRD's compile ingest names the lint decoders and the lint exception", () => {
  const compileIngest = section(PRD, /^### 4\.5 /);

  test("section 4.5 names the `ruff` and `clippy` decoders", () => {
    expect(compileIngest, "the PRD has section 4.5").toBeDefined();
    expect(compileIngest ?? "").toContain("`ruff`");
    expect(compileIngest ?? "").toContain("`clippy`");
  });

  test("section 4.5 names the lint exception to gcc's raw fallback in one sentence", () => {
    expect(
      /\blint\b[^.]*\braw\b|\braw\b[^.]*\blint\b/i.test(compileIngest ?? ""),
      "one sentence names lint and the raw fallback",
    ).toBe(true);
  });
});

describe("the PRD's status shape and compile route body name the lint fields", () => {
  test("the status shape names `lastLint` beside `hasData`, `lastTest` and `lastCompile`", () => {
    expect(/\{[^{}]*\bhasData\b[^{}]*\blastTest\b[^{}]*\blastCompile\b[^{}]*\blastLint\b[^{}]*\}/.test(flat(PRD))).toBe(true);
  });

  test("the compile route's body names `lint` and `runnerExit`", () => {
    const routeBlocks = blocks(PRD).filter(
      (b) => b.includes("runs/compile") && b.includes("`lint`") && b.includes("`runnerExit`"),
    );
    expect(routeBlocks.length, "one PRD block names /runs/compile with `lint` and `runnerExit`").toBeGreaterThanOrEqual(1);
  });
});

describe("the RUNBOOK says lint records count toward retention", () => {
  test("its Retention section names lint records as counted", () => {
    const retention = section(RUNBOOK, /^## Retention\b/);
    expect(retention, "the RUNBOOK has a Retention section").toBeDefined();
    expect(
      /\blint records?\b[^.]*\bcount|\bcount[^.]*\blint records?\b/i.test(retention ?? ""),
      "lint records count toward retention",
    ).toBe(true);
  });
});

describe("the CHANGELOG records lint records", () => {
  test("its Unreleased section has an entry naming lint records", () => {
    const unreleased = flat(changelogSection(CHANGELOG));
    expect(unreleased, "the CHANGELOG has an Unreleased section").toBeDefined();
    expect(/\blint records?\b/i.test(unreleased ?? ""), "an unreleased entry names lint records").toBe(true);
  });
});
