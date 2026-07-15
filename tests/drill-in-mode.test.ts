// CR-CRU-007 §S4 item 0 — tier-default drill-in mode, pure logic.
//
// `L.drillinDefaultMode(tier)` and `L.drillinModeStorageKey(tier)` do not
// exist yet on public/app-logic.mjs. Same convention as the existing
// `projectActivity`/`orderProjects` RED tests in tests/app-logic.test.ts:
// a namespace import (`import * as AppLogic`) stays loadable even for a
// not-yet-exported name, so calling `AppLogic.drillinDefaultMode(...)`
// fails at CALL time ("... is not a function") — that TypeError IS the RED
// signal here (bun test has no static type-check gate on this import).
//
// Contract this file defines for GREEN (the round-10 mode-switch revision,
// §S4 item 0):
//   - drillinDefaultMode(tier): "regression" | "e2e" -> "Density";
//     everything else ("unit" | "module" | "integration" | ...) -> "Detail".
//     Single-argument — there is NO test-count parameter anywhere, matching
//     "no code path selects the mode from test count".
//   - drillinModeStorageKey(tier): returns the SAME key string for every
//     tier in the "broad" group (regression, e2e) and a DIFFERENT, but
//     mutually shared, key string for every tier in the "focused" group
//     (unit, module, integration) — the two localStorage keys the spec
//     calls "focused / broad".
import { describe, test, expect } from "bun:test";
import * as AppLogic from "../public/app-logic.mjs";

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

describe("app-logic — drillinModeStorageKey (§S4.0 per-tier-group persistence keys)", () => {
  test("regression and e2e (the broad group) share the same storage key", () => {
    expect(AppLogic.drillinModeStorageKey("regression")).toBe(AppLogic.drillinModeStorageKey("e2e"));
  });

  test("unit, module, and integration (the focused group) share the same storage key", () => {
    const focused = AppLogic.drillinModeStorageKey("unit");
    expect(AppLogic.drillinModeStorageKey("module")).toBe(focused);
    expect(AppLogic.drillinModeStorageKey("integration")).toBe(focused);
  });

  test("the focused-group key and the broad-group key are distinct strings", () => {
    expect(AppLogic.drillinModeStorageKey("unit")).not.toBe(AppLogic.drillinModeStorageKey("regression"));
  });

  test("bound: the key is a non-empty string usable directly as a localStorage key", () => {
    const key = AppLogic.drillinModeStorageKey("regression");
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
  });
});
