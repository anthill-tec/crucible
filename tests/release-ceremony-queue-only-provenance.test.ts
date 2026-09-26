// scripts/release.sh must call neither the `plans` nor the `status` client
// verb (§S9, AC15) — the release ceremony's landing-commit source is now
// `queue`'s `mergeCommit` column exclusively.
//
// Spec: the "status shows the work in flight" change doc under
// docs/changes/, §S9/AC15.
//   AC15 — scripts/release.sh calls neither `plans` nor `status`, takes each
//   CR's landing commit from `queue`'s `mergeCommit`, and
//   tests/release-provenance.test.ts passes in full.
//
// RED today: plan_merge_map() (scripts/release.sh:~467) still invokes
// `python3 "$client" plans --fields mergeCommit`, so this static scan finds
// the forbidden verb and fails.
//
// Technique: a real STATIC scan of the script's OWN SOURCE for every
// `python3 … clients/python-crucible.py <verb>` invocation, never a stub —
// this is a property of the shell source itself, independent of any
// particular board state, so reading the text is the honest way to assert
// it never gets written, reachable or not. The exec-based coverage (a real
// board actually exercising `plan_merge_map`/the ceremony end to end) is
// tests/release-provenance.test.ts's job, cited above per AC15.
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

describe("scripts/release.sh calls neither `plans` nor `status` (§S9, AC15)", () => {
  test("every python3 …/python-crucible.py invocation in the script's source names a verb other than plans/status, and at least one call is queue", () => {
    const source = readFileSync(RELEASE_SH, "utf8");
    const verbs = clientVerbInvocations(source);

    // Non-vacuity — the scan itself must find calls to check, or a
    // completely deleted/renamed call path would pass this test for the
    // WRONG reason (finding nothing to forbid).
    expect(verbs.length).toBeGreaterThan(0);
    // POSITIVE — the queue verb IS still called (it is the ceremony's only
    // landing-commit source per AC15).
    expect(verbs).toContain("queue");

    // NEGATIVE — the two forbidden verbs, named exactly.
    expect(verbs).not.toContain("plans");
    expect(verbs).not.toContain("status");
  });
});
