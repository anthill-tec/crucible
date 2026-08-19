// CR-CRU-007 §S4 item 0 — tier-driven drill-in presentation, pure logic.
//
// CR-CRU-007 C5b FINAL re-baseline (user correction, 2026-07-15): the mode
// badge/switch is REMOVED ENTIRELY — there is no `drillin-mode` DOM element,
// no toggle, no persistence. Presentation is decided PURELY by tier:
// `L.drillinDefaultMode(tier)` survives as that pure tier -> presentation
// mapping (kept verbatim: "regression"/"e2e" -> "Density", everything else
// -> "Detail" — the function's OWN behavior didn't change, only what calls
// it and how the result is used did). `L.drillinModeStorageKey(tier)` is
// DELETED from the contract — there is nothing left to persist, since there
// is no manual override to remember. Same not-yet-existing-export
// convention as tests/app-logic.test.ts: a namespace import
// (`import * as AppLogic`) stays loadable even for a not-yet-exported name,
// so calling `AppLogic.drillinDefaultMode(...)` fails at CALL time ("... is
// not a function") — that TypeError IS the RED signal here (bun test has no
// static type-check gate on this import).
//
// Contract this file defines for GREEN:
//   - drillinDefaultMode(tier): "regression" | "e2e" -> "Density";
//     everything else ("unit" | "module" | "integration" | ...) -> "Detail".
//     Single-argument — there is NO test-count parameter anywhere, matching
//     "no code path selects presentation from test count".
//   - drillinModeStorageKey is NOT exported from public/app-logic.mjs (the
//     export is gone — nothing left to persist).
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as AppLogic from "../public/app-logic.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe("app-logic — drillinDefaultMode (§S4.0 tier-default mode, round 10)", () => {
  test("regression tier defaults to Density", () => {
    expect(AppLogic.drillinDefaultMode("regression")).toBe("Density");
  });

  test("e2e tier defaults to Density", () => {
    expect(AppLogic.drillinDefaultMode("e2e")).toBe("Density");
  });

  test("unit tier defaults to Detail", () => {
    expect(AppLogic.drillinDefaultMode("unit")).toBe("Detail");
  });

  test("module tier defaults to Detail", () => {
    expect(AppLogic.drillinDefaultMode("module")).toBe("Detail");
  });

  test("integration tier defaults to Detail", () => {
    expect(AppLogic.drillinDefaultMode("integration")).toBe("Detail");
  });

  test("bound: no test-count auto-decision — an extra second argument (however large) never changes the result", () => {
    const fn = AppLogic.drillinDefaultMode as unknown as (tier: string, count?: number) => string;
    expect(fn("unit", 200)).toBe("Detail");
    expect(fn("unit", 0)).toBe("Detail");
    expect(fn("regression", 1)).toBe("Density");
    expect(fn("regression", 10_000)).toBe("Density");
  });
});

// DROPPED + REPLACED per the CR-CRU-007 C5b FINAL re-baseline: the mode
// badge/switch is removed entirely, so drillinModeStorageKey has nothing
// left to persist — the whole "per-tier-group persistence keys" describe
// block above is superseded by proving the export itself is gone.
describe("app-logic — drillinModeStorageKey is DELETED from the contract (§S4.0 FINAL re-baseline)", () => {
  test("drillinModeStorageKey is not exported from app-logic.mjs", () => {
    expect((AppLogic as unknown as Record<string, unknown>).drillinModeStorageKey).toBeUndefined();
  });
});

// AC: "Purely tier-contextual: NO `drillin-mode` element exists anywhere
// (DOM + grep assertion) ... no mode persistence key exists." — the DOM half
// is covered by tests/drill-in.test.ts + tests/density.test.ts; this is the
// grep half, over the real production source.
describe("app-logic + app.js — no drillin-mode source references remain (grep AC)", () => {
  test("public/app.js never references the data-testid \"drillin-mode\"", () => {
    const src = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
    expect(src).not.toContain("drillin-mode");
  });

  test("public/app-logic.mjs never references drillinModeStorageKey", () => {
    const src = readFileSync(path.join(REPO_ROOT, "public/app-logic.mjs"), "utf8");
    expect(src).not.toContain("drillinModeStorageKey");
  });
});
