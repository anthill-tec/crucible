// An ingest is bounded by two SERVER limits, declared like every other one:
//
//   ingest_body_bytes  the largest ingest body the server reads
//   raw_output_chars   the most captured runner output a run stores
//
// Both are configuration (PRD §4.13): a `[limits.<name>]` table in the
// distribution's own `src/crucible.toml`, resolved through `resolveLimit`
// (src/limits.ts) from the operator's `crucible.toml` beside the server's
// database, with an out-of-range `value` refused, disclosed and run at the
// recommendation. This file proves the DECLARATION and the RESOLUTION; what
// each limit then bounds (the 413, the stored-output cap) is proved where it
// is enforced.
//
// ── The one place a limit's figures are written out ─────────────────────────
//
// PRD §4.13's "tests inherit the rule" forbids a test that hardcodes the
// limit it CHECKS at its enforcement site. The figures below are not that:
// they are the DOCUMENTATION the change specifies for the two new tables —
// their description, recommendation and supportable range — and the only way
// to prove the distribution ships the declaration that was specified is to
// compare it against the specification. Every RESOLUTION expectation further
// down is derived from the declaration read back off the shipped table
// (`shippedLimits()`), never from these constants.
//
// ── Everything that counts the server's limits counts five ──────────────────
//
// The server enforced three limits; it now enforces five. A count written in
// prose is a claim nothing else checks, so each document that states the
// server's count — the two source files' comments, the RUNBOOK's prose and
// PRD §4.13's prose — is held to the new number here, and its stale "three"
// phrasing is named so a document that kept it fails by name.
//
// ── Safety ──────────────────────────────────────────────────────────────────
//
// Every `crucible.toml` is in a fresh OS tmpdir via `serverConfigDir()`
// (tests/helpers/server-limits-fixture.ts): `CRUCIBLE_DB` is pointed there only
// so the config path resolves beside it; no database is opened there.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  declare,
  restoreServerLimitsFixture,
  serverConfigDir,
  writeConfig,
  type LimitDeclaration,
} from "./helpers/server-limits-fixture.ts";
import {
  SERVER_LIMIT_NAMES,
  limitDisclosures,
  resolveLimit,
  shippedLimits,
} from "../src/limits.ts";

afterEach(restoreServerLimitsFixture);

const REPO = path.join(import.meta.dir, "..");

/** The two limits this change adds — the vocabulary under test. */
const INGEST_LIMITS = ["ingest_body_bytes", "raw_output_chars"] as const;

/** The three the server already enforced, which must survive unchanged. */
const EARLIER_SERVER_LIMITS = ["run_abandon_ms", "project_inactive_ms", "retention"] as const;

/**
 * The declarations the change specifies, field for field. Documentation, not a
 * running value — see the header.
 */
const SPECIFIED: Record<(typeof INGEST_LIMITS)[number], LimitDeclaration> = {
  ingest_body_bytes: {
    description: "the largest ingest body the server reads",
    // 128 MiB — Bun's default body limit, the one the server ran at before.
    recommended: 134217728,
    min: 1048576,
    max: 1073741824,
  },
  raw_output_chars: {
    description: "the most captured runner output a run stores",
    recommended: 2000000,
    min: 10000,
    max: 50000000,
  },
};

/** The shipped declaration of one of the new limits, failing by name when the
 *  distribution does not declare it at all. */
function shipped(name: string): LimitDeclaration {
  const d = shippedLimits()[name];
  expect(d, `src/crucible.toml declares no [limits.${name}] table`).toBeDefined();
  return d!;
}

function disclosureNaming(name: string): string | undefined {
  return limitDisclosures().find((line) => line.includes(`\`${name}\``));
}

// ═══════════════════════════════════════════════════════════════════════════
// The declaration
// ═══════════════════════════════════════════════════════════════════════════

describe("the ingest body limit and the stored-output limit are declared server limits", () => {
  test("the server enforces exactly five limits — the three it had, plus ingest_body_bytes and raw_output_chars", () => {
    const five = [...EARLIER_SERVER_LIMITS, ...INGEST_LIMITS].sort();
    expect([...SERVER_LIMIT_NAMES].sort()).toEqual(five);
    expect(Object.keys(shippedLimits()).sort()).toEqual(five);
  });

  test("ingest_body_bytes ships the specified description, recommended 128 MiB, range [1 MiB, 1 GiB], and no value", () => {
    const d = shipped("ingest_body_bytes");
    expect(d).toEqual(SPECIFIED.ingest_body_bytes);
    expect(d.value, "a shipped declaration carries no operator value").toBeUndefined();
  });

  test("raw_output_chars ships the specified description, recommended 2000000, range [10000, 50000000], and no value", () => {
    const d = shipped("raw_output_chars");
    expect(d).toEqual(SPECIFIED.raw_output_chars);
    expect(d.value, "a shipped declaration carries no operator value").toBeUndefined();
  });

  test("the distribution's own data file holds both tables — the declaration is package data, not a table in the resolver", () => {
    const parsed = Bun.TOML.parse(
      fs.readFileSync(path.join(REPO, "src", "crucible.toml"), "utf8"),
    ) as { limits: Record<string, Record<string, unknown>> };
    for (const name of INGEST_LIMITS) {
      const table = parsed.limits[name];
      expect(table, `src/crucible.toml has no [limits.${name}] table`).toBeDefined();
      expect({
        description: table!.description,
        recommended: table!.recommended,
        min: table!.min,
        max: table!.max,
      }).toEqual({ ...SPECIFIED[name] });
      expect("value" in table!, `${name}: the shipped file must not set a value`).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Resolution through the operator's file
// ═══════════════════════════════════════════════════════════════════════════

describe("each ingest limit resolves from the operator's crucible.toml", () => {
  test("with no operator file, ingest_body_bytes and raw_output_chars resolve to their shipped recommendations", () => {
    const dir = serverConfigDir();
    expect(fs.existsSync(path.join(dir, "crucible.toml")), "the fixture must start with no file").toBe(
      false,
    );

    expect(resolveLimit("ingest_body_bytes")).toBe(shipped("ingest_body_bytes").recommended);
    expect(resolveLimit("raw_output_chars")).toBe(shipped("raw_output_chars").recommended);
    // …which are the specified recommendations, not merely self-consistent ones.
    expect(resolveLimit("ingest_body_bytes")).toBe(SPECIFIED.ingest_body_bytes.recommended);
    expect(resolveLimit("raw_output_chars")).toBe(SPECIFIED.raw_output_chars.recommended);

    // An absent file refuses nothing, so neither limit is named in a refusal.
    for (const name of INGEST_LIMITS) expect(disclosureNaming(name)).toBeUndefined();
  });

  for (const name of INGEST_LIMITS) {
    test(`${name}: an operator value inside the range is what it runs at — min and max themselves included`, () => {
      const dir = serverConfigDir();
      const d = shipped(name);
      const midway = Math.floor((d.min + d.recommended) / 2);
      expect(midway, "a value distinguishable from the recommendation").not.toBe(d.recommended);

      for (const legal of [midway, d.min, d.max]) {
        writeConfig(dir, { [name]: declare(d, legal) });
        expect(resolveLimit(name), `${name}: ${legal} is inside its range`).toBe(legal);
        expect(disclosureNaming(name), `${name}: ${legal} is legal; nothing is owed`).toBeUndefined();
      }
      // Setting a value leaves the shipped recommendation reading as ours.
      expect(shippedLimits()[name]!.recommended).toBe(d.recommended);
      expect(shippedLimits()[name]!.value).toBeUndefined();
    });

    test(`${name}: a value below min or above max is refused — it runs at the recommendation, not clamped, and the refusal is disclosed`, () => {
      const dir = serverConfigDir();
      const d = shipped(name);

      for (const illegal of [d.min - 1, d.max + 1]) {
        writeConfig(dir, { [name]: declare(d, illegal) });

        const resolved = resolveLimit(name);
        expect(resolved, `${name}: ${illegal} must be refused`).not.toBe(illegal);
        expect(resolved, `${name}: a refusal does not clamp to the bound`).not.toBe(
          illegal < d.min ? d.min : d.max,
        );
        expect(resolved, `${name}: a refusal falls back to the recommendation`).toBe(d.recommended);

        const refusal = disclosureNaming(name);
        expect(refusal, `${name}: ${illegal} was refused in silence`).toBeDefined();
        expect(refusal).toContain(String(illegal));
        expect(refusal).toContain(String(d.min));
        expect(refusal).toContain(String(d.max));
        expect(refusal).toContain(String(d.recommended));
      }
    });
  }

  test("an edit to the operator file is read on the next resolution, with no restart", () => {
    const dir = serverConfigDir();
    const body = shipped("ingest_body_bytes");
    const raw = shipped("raw_output_chars");

    writeConfig(dir, {
      ingest_body_bytes: declare(body, body.min),
      raw_output_chars: declare(raw, raw.min),
    });
    expect(resolveLimit("ingest_body_bytes")).toBe(body.min);
    expect(resolveLimit("raw_output_chars")).toBe(raw.min);

    writeConfig(dir, {
      ingest_body_bytes: declare(body, body.max),
      raw_output_chars: declare(raw, raw.max),
    });
    expect(resolveLimit("ingest_body_bytes")).toBe(body.max);
    expect(resolveLimit("raw_output_chars")).toBe(raw.max);
  });

  test("setting one ingest limit moves neither the other nor any earlier server limit", () => {
    const dir = serverConfigDir();
    const body = shipped("ingest_body_bytes");
    const raw = shipped("raw_output_chars");

    writeConfig(dir, { ingest_body_bytes: declare(body, body.min) });
    expect(resolveLimit("ingest_body_bytes")).toBe(body.min);
    expect(resolveLimit("raw_output_chars")).toBe(raw.recommended);

    writeConfig(dir, { raw_output_chars: declare(raw, raw.min) });
    expect(resolveLimit("raw_output_chars")).toBe(raw.min);
    expect(resolveLimit("ingest_body_bytes")).toBe(body.recommended);
    for (const earlier of EARLIER_SERVER_LIMITS) {
      expect(resolveLimit(earlier), `${earlier} must not move`).toBe(
        shippedLimits()[earlier]!.recommended,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Every place that counts the server's limits counts five
// ═══════════════════════════════════════════════════════════════════════════

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

/** The text from `start` up to (not including) the first `end` match after it. */
function section(text: string, start: RegExp, end: RegExp): string {
  const at = text.search(start);
  expect(at, `no section matching ${start}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(at);
  // Search for the end only AFTER the heading line, so a heading cannot end
  // its own section.
  const bodyFrom = rest.indexOf("\n") + 1;
  const stop = rest.slice(bodyFrom).search(end);
  return stop < 0 ? rest : rest.slice(0, bodyFrom + stop);
}

/** The stale phrases a document counting THREE server limits used; none may survive. */
function staleCounts(text: string, phrases: readonly RegExp[]): string[] {
  return phrases.filter((p) => p.test(text)).map(String);
}

describe("every document that counts the server's limits counts five", () => {
  test("PRD §4.13 names ingest_body_bytes and raw_output_chars and counts the server's five", () => {
    const prd = section(read("docs/research/PRD-crucible-v2.md"), /^### 4\.13 /m, /^#{2,3} /m);
    for (const name of INGEST_LIMITS) {
      expect(prd.includes(name), `PRD §4.13 does not name \`${name}\``).toBe(true);
    }
    expect(prd).toMatch(/server's five\b/i);
    expect(staleCounts(prd, [/server's three\b/i])).toEqual([]);
  });

  test("the RUNBOOK's prose on the server's limits counts five", () => {
    const runbook = section(
      read("docs/RUNBOOK.md"),
      /^### The server's limits/m,
      /^### The project's limits/m,
    );
    expect(runbook).toMatch(/\bfive\b/i);
    expect(staleCounts(runbook, [/\bthree limits\b/i, /server's three\b/i])).toEqual([]);
  });

  test("src/limits.ts's comments count the server's five limits", () => {
    const source = read("src/limits.ts");
    expect(source).toMatch(/\bfive\b/i);
    expect(
      staleCounts(source, [/server's three\b/i, /\bthree limits\b/i, /\bTHREE, not four\b/]),
    ).toEqual([]);
  });

  test("src/crucible.toml's comments count five, and its header says raw_output_chars is the one limit with no earlier value", () => {
    const text = read("src/crucible.toml");
    expect(text).toMatch(/\bfive\b/i);
    expect(staleCounts(text, [/server's three\b/i, /\bthree limits\b/i])).toEqual([]);

    // The header — every comment before the first table — owes the operator
    // the one exception to "an install with no operator file behaves exactly as
    // it did before": raw output was stored whole and is now capped.
    const header = text.slice(0, text.search(/^\[/m));
    expect(header.includes("raw_output_chars"), "the header does not name raw_output_chars").toBe(
      true,
    );
  });
});
