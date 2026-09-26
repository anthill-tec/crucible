// scripts/release.sh must call neither the `plans` nor the `status` client
// verb, and must call `landings` with `--format json` (§S9, AC14) — the
// release ceremony's landing-commit source is now the `landings` verb, which
// reads the CLOSED PLANS directly (user ruling 2026-09-26, option C);
// `queue` stays unchanged and is NOT the source of merge commits.
//
// Spec: the "status shows the work in flight" change doc under
// docs/changes/, §S9/AC14.
//   AC14 — scripts/release.sh calls neither `plans` nor `status`, takes each
//   closed plan's landing commit (and each closed plan that recorded none)
//   from `landings --format json`, and tests/release-provenance.test.ts
//   passes in full.
//
// RED today: plan_merge_map() (scripts/release.sh:~467) still invokes
// `python3 "$client" plans --fields mergeCommit`, so this static scan finds
// the forbidden verb `plans` and finds no `landings` invocation at all.
//
// Technique: a real STATIC scan of the script's OWN SOURCE for every
// `python3 … clients/python-crucible.py <verb>` invocation, never a stub —
// this is a property of the shell source itself, independent of any
// particular board state, so reading the text is the honest way to assert
// it never gets written, reachable or not. The exec-based coverage (a real
// board actually exercising the ceremony end to end) is
// tests/release-provenance.test.ts's job, cited above per AC14.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const RELEASE_SH = join(REPO_ROOT, "scripts", "release.sh");

/** Every `python3 <client-path> <verb>` invocation in the script's source,
 *  the verb taken as the first non-flag token after the client path — the
 *  same shape every real call in the file uses today (`plan_merge_map`'s
 *  `plans`, `queue_read`'s `queue`, `emit_release_milestone`'s `milestone`). */
function clientVerbInvocations(source: string): string[] {
  const pattern =
    /python3\s+(?:"\$client"|"\$\(repo_root\)\/clients\/python-crucible\.py")\s+(\S+)/g;
  const verbs: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    verbs.push(match[1]!);
  }
  return verbs;
}

/** The line(s) invoking `landings`, so its `--format json` flag can be
 *  checked in context rather than merely that the verb token appears
 *  somewhere in the file. */
function landingsInvocationLines(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => /python3\s+.*\blandings\b/.test(line));
}

describe("scripts/release.sh reads landings, not plans/status (§S9, AC14)", () => {
  test("every python3 …/python-crucible.py invocation in the script's source names a verb other than plans/status, and at least one call is landings", () => {
    const source = readFileSync(RELEASE_SH, "utf8");
    const verbs = clientVerbInvocations(source);

    // Non-vacuity — the scan itself must find calls to check, or a
    // completely deleted/renamed call path would pass this test for the
    // WRONG reason (finding nothing to forbid).
    expect(verbs.length).toBeGreaterThan(0);
    // POSITIVE — the landings verb IS called (it is the ceremony's only
    // landing-commit source per AC14).
    expect(verbs).toContain("landings");

    // NEGATIVE — the two forbidden verbs, named exactly.
    expect(verbs).not.toContain("plans");
    expect(verbs).not.toContain("status");
  });

  test("the landings invocation passes --format json (§S8's JSON contract, cited by AC14)", () => {
    const source = readFileSync(RELEASE_SH, "utf8");
    const landingsLines = landingsInvocationLines(source);

    expect(landingsLines.length).toBeGreaterThan(0);
    expect(landingsLines.every((line) => line.includes("--format json"))).toBe(true);
  });
});
