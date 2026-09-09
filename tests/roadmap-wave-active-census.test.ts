// CR-CRU-116 §S4 — THE CENSUS: no assertion anywhere still reads activeness
// off the release's kind.
//
// §S4 retired a RELEASE-level reading of activeness. `focusedReleaseView`
// computed one flag for the whole release and copied it into every wave box,
// so a release holding two waves marked both. The replacement is a per-WAVE
// derivation, and the danger of a retirement like this one is not the code —
// which changed in one place — but the ASSERTIONS that pinned the old rule
// across four suites.
//
// WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. It proves that no file under
// `tests/` reintroduces the retired LITERAL `kind === "proposed"` as an
// activeness reading. It does NOT prove that no file still states the retired
// PREMISE, and no census over `tests/` could: not one of the six retired
// assertion sites in §S4's supersession table contained that literal at all —
// the deleted `roadmap-wave-header:482-483` was
// `expect(activeAttr("1")).toBe("true")` — so re-adding any of them verbatim
// leaves this file fully green. The retired premise is discharged by the four
// repaired suites asserting the new contract directly; this file is the
// tripwire against the LITERAL returning, and it is scoped to that.
//
// The AC this file discharges, verbatim: "No file under `tests/` reintroduces
// the retired LITERAL `kind === \"proposed\"` as an activeness reading: a
// census reports zero surviving sites, pins the three legitimate release-gate
// reads by file and count, and asserts both the number of sites examined and
// the number of files walked, so a collapsed walker fails loudly." Every
// clause is load-bearing. The counts exist because a walker that silently
// returns nothing reports zero surviving sites too, and the difference between
// "nothing left" and "nothing looked at" is the whole value of the check.
//
// WHERE THE TEETH ARE: in the PINNED COUNTS, not in the statement classifier.
// `SITES_PINNED` and `RELEASE_KIND_READS` are what fail when the literal comes
// back. The classifier below only decides how an occurrence is CLASSIFIED, and
// it is beatable: a violation spelled across two statements (`const isProposed
// = release.kind === "proposed"; … expect(box.active).toBe(isProposed);`) or
// inside a multi-line arrow body (`releases.map((r) => { return r.kind ===
// "proposed"; })`) carries no `/activ/i` in its OWN statement, so the
// zero-surviving-sites assertion stays green and only the count pins catch it.
// Read the counts as the guard and the classifier as triage, not the reverse.
//
// WHAT IS NOT A VIOLATION, stated precisely rather than left to the reader.
// The release strip legitimately GROUPS releases by kind — a shipped leg and a
// proposed leg are drawn differently, and reading `kind` to say which is which
// has nothing to do with which wave holds work in flight. Three such reads
// survive, in two suites, and they are recorded below by file and count so a
// FOURTH cannot appear without a reader deciding which sort it is. Three more
// occurrences are PROSE — the supersession notes that name the retired rule in
// order to say it is retired — and prose that narrates a retirement is the
// opposite of an assertion that depends on it.
//
// The classifier's discriminator is the STATEMENT an occurrence sits in, not
// the file it sits in: a read of the release kind whose own statement names
// activeness is reading activeness off the kind, whatever it is called. It is
// deliberately generous — any spelling of the stem (`active`, `isActive`,
// `data-active`, `activeness`) trips it — because the two error directions are
// not symmetric. Reporting a gate read that happens to mention activeness
// costs one line of triage; missing a revived release-level reading costs the
// invariant this CR exists to place.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { jsUncommented, listFiles, REPO_ROOT, unnestedEnd } from "./helpers/source-scan";

// The retired reading, exactly as it was spelled. A global regex, re-`exec`ed
// through `matchAll`, so every occurrence on a line is seen and not just the
// first.
const RETIRED_READING = /kind === "proposed"/g;

// This file spells the pattern it scans for, so it necessarily matches itself.
// Excluding it by name is the only honest option — and the exclusion is not
// taken on trust: the test below asserts that every live-code occurrence in
// this file sits in the pattern's own declaration, which is what makes the
// carve-out a fact rather than a hiding place.
const SELF = "tests/roadmap-wave-active-census.test.ts";

// Non-vacuity floor for the WALK. `tests/` holds 183 `.ts` files (measured
// 2026-09-09); a floor rather than the exact figure because files arriving is
// ordinary and a walker collapsing to nothing is not.
const TEST_FILE_FLOOR = 150;

// Non-vacuity floor for the PATTERN, which the floor above cannot supply: a
// walk over 183 files that matches nothing at all would satisfy every other
// assertion here. Six occurrences survive §S4 (measured 2026-09-09) — three
// release-kind reads and three supersession notes — and a re-spelling of the
// retired reading that made this census blind would drop the count.
const SITES_PINNED = 6;

// The live-code survivors, by file and count. Not a list of line numbers: line
// numbers drift on every edit above them and re-pinning them teaches nobody
// anything. A count per file is the smallest thing that still forces a new
// occurrence to be classified deliberately.
const RELEASE_KIND_READS: Record<string, number> = {
  "tests/roadmap-release-strip.test.ts": 1,
  "tests/roadmap-visual-grammar.test.ts": 2,
};

// Any spelling of the activeness stem, in the statement around an occurrence.
const NAMES_ACTIVENESS = /activ/i;

interface Site {
  relPath: string;
  line: number;
  prose: boolean;
  statement: string;
}

// The statement an occurrence sits in: back to the last `;`, `{` or `}` that
// is not itself inside the occurrence, and forward to the first unnested `;`
// or the closer of the group that encloses it (`unnestedEnd`'s own rule, so a
// matcher chained after a closing paren stays inside the span). Run over the
// comment-blanked projection, whose offsets are identical to the raw file's,
// so a brace inside a comment cannot end a statement early.
function statementAround(live: string, at: number): string {
  let start = at;
  while (start > 0 && !";{}".includes(live[start - 1]!)) start -= 1;
  return live.slice(start, unnestedEnd(live, at, ";"));
}

// Every occurrence of the retired reading under `tests/`, each carrying
// whether it is prose and the statement it sits in. ONE walk; the two
// projections of it (raw text, comments blanked) share offsets by
// construction, which is what lets a prose occurrence be identified by
// ABSENCE from the second rather than by a second scan with different rules.
function census(): { filesScanned: number; sites: Site[]; self: Site[] } {
  const files = listFiles("tests", [".ts"]);
  const sites: Site[] = [];
  const self: Site[] = [];
  for (const abs of files) {
    const relPath = abs.slice(REPO_ROOT.length + 1);
    const raw = readFileSync(abs, "utf8");
    if (!raw.includes("kind ===")) continue;
    const live = jsUncommented(raw);
    const liveOffsets = new Set([...live.matchAll(RETIRED_READING)].map((m) => m.index));
    for (const match of raw.matchAll(RETIRED_READING)) {
      const at = match.index;
      const site: Site = {
        relPath,
        line: raw.slice(0, at).split("\n").length,
        prose: !liveOffsets.has(at),
        statement: liveOffsets.has(at) ? statementAround(live, at) : "",
      };
      (relPath === SELF ? self : sites).push(site);
    }
  }
  return { filesScanned: files.length, sites, self };
}

describe("§S4 — activeness is never read off the release kind", () => {
  test("the census walks the whole of tests/ and states how many sites it checked", () => {
    const { filesScanned, sites } = census();

    expect(filesScanned).toBeGreaterThanOrEqual(TEST_FILE_FLOOR);
    expect(sites.length).toBe(SITES_PINNED);
  });

  test("zero surviving sites read activeness off the release kind", () => {
    const surviving = census()
      .sites.filter((site) => !site.prose && NAMES_ACTIVENESS.test(site.statement))
      .map((site) => `${site.relPath}:${site.line} — ${site.statement.trim()}`);

    expect(surviving).toEqual([]);
  });

  test("the live-code occurrences that remain are release-kind reads, by file and count", () => {
    const counted: Record<string, number> = {};
    for (const site of census().sites) {
      if (site.prose) continue;
      counted[site.relPath] = (counted[site.relPath] ?? 0) + 1;
    }

    expect(counted).toEqual(RELEASE_KIND_READS);
  });

  test("three of the six surviving occurrences are prose, not live code", () => {
    const prose = census().sites.filter((site) => site.prose);

    // The complement of RELEASE_KIND_READS' three: with both pinned, a live
    // occurrence re-spelled as prose (or the reverse) moves one of the two.
    // Nothing is asserted here about `statement`, which `census` assigns `""`
    // by construction for exactly these sites — that assertion cannot fail.
    expect(prose.length).toBe(SITES_PINNED - 3);
  });

  test("this file's own self-exclusion hides nothing but the pattern's declaration", () => {
    const { self } = census();

    expect(self.length).toBeGreaterThanOrEqual(1);
    expect(
      self
        .filter((site) => !site.prose)
        .every((site) => site.statement.includes("RETIRED_READING")),
    ).toBe(true);
  });
});
