// THE TARGET PARTITION GUARD — no test file may fall outside every target.
//
// `bunfig.toml` carries no `pathIgnorePatterns` and tests/suite-integrity.test.ts
// asserts it stays that way, so nothing can be hidden from a bare `bun test`
// (CR-CRU-047 §S1). Targets reintroduce the SAME hazard one level up: a file
// that neither `test:unit` nor `test:integration` names is a test the
// target-based workflow never runs, even though full discovery still sees it.
// This file closes that, and it closes it the way the runner actually decides —
// by calling the runner's own classifier, never a copy of its rule.
//
// The markers are IMPORTED and never spelled here. Spelling one of them as a
// literal in this file's source would classify THIS file as integration and
// make the guard's own home a lie — which is exactly what happened on the
// first run of the last test below; planting them from `INTEGRATION_MARKERS`
// keeps the guard in the fast target where it belongs.
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import * as path from "node:path";
import {
  classifyTestSource,
  enumerateTestFiles,
  INTEGRATION_MARKERS,
  partitionTestFiles,
  REPO_ROOT,
} from "../scripts/test-targets";

/** The on-disk truth, walked independently of the runner's own enumeration so
 *  the two can disagree. A recursive `readdirSync` here would just be the same
 *  call the runner makes; this walks by hand for that reason. */
function walkTestFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__pycache__") continue;
      walkTestFiles(abs, found);
    } else if (entry.name.endsWith(".test.ts")) {
      found.push(path.relative(REPO_ROOT, abs));
    }
  }
  return found;
}

describe("test targets partition every test file", () => {
  test("unit and integration together name every `.test.ts` on disk, with no file in both", async () => {
    const onDisk = walkTestFiles(path.join(REPO_ROOT, "tests")).sort();
    expect(onDisk.length).toBeGreaterThanOrEqual(100);

    const { unit, integration } = await partitionTestFiles();
    expect([...unit, ...integration].sort()).toEqual(onDisk);
    expect(unit.filter((file) => integration.includes(file))).toEqual([]);
  });

  test("the runner's own enumeration agrees with an independent walk", async () => {
    const onDisk = walkTestFiles(path.join(REPO_ROOT, "tests")).sort();
    expect((await enumerateTestFiles()).sort()).toEqual(onDisk);
  });

  test("both targets are non-empty — a target naming nothing would report a vacuous green", async () => {
    const { unit, integration } = await partitionTestFiles();
    expect(unit.length).toBeGreaterThan(0);
    expect(integration.length).toBeGreaterThan(0);
  });

  test("every marker classifies as integration, and a file naming none is unit", () => {
    for (const marker of INTEGRATION_MARKERS) {
      expect(classifyTestSource(`const probe = "${marker}";`)).toBe("integration");
    }
    expect(classifyTestSource("expect(add(1, 2)).toBe(3);")).toBe("unit");
  });

  test("this guard itself sits in the fast target", async () => {
    const { unit } = await partitionTestFiles();
    expect(unit).toContain(path.join("tests", "test-targets.test.ts"));
  });
});
