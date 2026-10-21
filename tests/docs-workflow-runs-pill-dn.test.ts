// The responsive-model DN's decision 11 (the Workflow surface) states where
// `→ Runs` lives on each band: at the phone band only in a history line's
// expanded runs, as a ≥44px row of its own; every history line with a runs
// boundary (done, active, failed, skipped) expands there; elsewhere the pill
// is a ≥44px touch target on touch media.
//
// Spec: the change request "a phone tap on a history cycle line opens its
// runs", its step "the design record follows" and its criterion "The record"
// (docs/changes/, filed for wave 8).
//
// Follows the docs-*.test.ts substance-over-prose precedent
// (docs-webkit-provisioning-dn.test.ts): a bounded window anchored on the
// decision's own table row, load-bearing facts within reach of each other
// rather than a pinned sentence. Calibrated against today's row: it names
// neither the phone band, the expanded runs, the failed/skipped lines nor
// touch media — its one `≥44px` belongs to the old, band-free "nested
// affordances stay separate ≥44px targets", so a bare 44px is never asserted
// on its own.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const DN_PATH = join(REPO_ROOT, "docs", "research", "DN-crucible-responsive-model.md");

/** Decision 11's table row, start of line to end of line; "" when the row is
 *  gone, so assertions fail as assertions rather than as a crash. */
function decision11Row(dn: string): string {
  const row = dn.split("\n").find((line) => line.startsWith("| **11** |"));
  return row ?? "";
}

/** Every window of `radius` characters either side of each occurrence of
 *  `anchor` (case-insensitive) in `text`. */
function windowsAround(text: string, anchor: RegExp, radius: number): string[] {
  const flags = anchor.flags.includes("g") ? anchor.flags : `${anchor.flags}g`;
  const windows: string[] = [];
  for (const match of text.matchAll(new RegExp(anchor.source, flags))) {
    const at = match.index ?? 0;
    windows.push(text.slice(Math.max(0, at - radius), at + match[0].length + radius));
  }
  return windows;
}

const FORTY_FOUR_PX = /(?:≥|>=|at least )\s*44\s*px/i;

describe("DN responsive model — decision 11 states where → Runs lives on each band", () => {
  test("decision 11 is still the Workflow row and still names → Runs", () => {
    const row = decision11Row(readFileSync(DN_PATH, "utf8"));
    expect(row.length).toBeGreaterThan(0);
    expect(row).toContain("**Workflow**");
    expect(row).toContain("→ Runs");
  });

  test("at the phone band → Runs lives only in a history line's expanded runs, never on the line", () => {
    const row = decision11Row(readFileSync(DN_PATH, "utf8"));
    const phoneRule = windowsAround(row, /phone/i, 300).some(
      (w) => w.includes("→ Runs") && /expanded runs/i.test(w) && /\b(?:only|never|not)\b/i.test(w),
    );
    expect(phoneRule).toBe(true);
  });

  test("the phone band's → Runs in the expanded runs is a row of at least 44px", () => {
    const row = decision11Row(readFileSync(DN_PATH, "utf8"));
    const rowRule = windowsAround(row, /expanded runs/i, 200).some(
      (w) => /\brow\b/i.test(w) && FORTY_FOUR_PX.test(w),
    );
    expect(rowRule).toBe(true);
  });

  test("every history line with a runs boundary expands at the phone band: done, active, failed and skipped", () => {
    const row = decision11Row(readFileSync(DN_PATH, "utf8"));
    const everyBoundary = windowsAround(row, /\bexpand(?:s|ed)?\b/i, 300).some(
      (w) =>
        /\bdone\b/i.test(w) && /\bactive\b/i.test(w) && /\bfailed\b/i.test(w) && /\bskipped\b/i.test(w),
    );
    expect(everyBoundary).toBe(true);
  });

  test("elsewhere the → Runs pill is a touch target of at least 44px on touch media", () => {
    const row = decision11Row(readFileSync(DN_PATH, "utf8"));
    const pillRule = windowsAround(row, /touch media/i, 200).some(
      (w) => /\bpill\b/i.test(w) && FORTY_FOUR_PX.test(w),
    );
    expect(pillRule).toBe(true);
  });
});
