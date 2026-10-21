// The responsive-model DN's "WebKit provisioning" section records that the
// local Docker pass (`bun run webkit:docker`) runs through the bun Crucible
// client and is filed on the board like every other e2e run.
//
// Spec: the change request "a phone tap on a history cycle line opens its
// runs", its step "the design record follows" and its criterion "The record"
// (docs/changes/, filed for wave 8).
//
// Follows the docs-*.test.ts substance-over-prose precedent
// (docs-release-process-ci-gates-dn.test.ts): bounded windows anchored on
// real headings, load-bearing facts rather than a pinned sentence. Calibrated
// against today's section: it names neither `bun-crucible.py` nor any
// filed/files/filing word (its one "client" is Playwright's client
// connection, and its one "board" is the supervised dev board on :3850 — so
// neither word is asserted on its own).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const DN_PATH = join(REPO_ROOT, "docs", "research", "DN-crucible-responsive-model.md");

/** From the "WebKit provisioning" heading to the next heading of the same or a
 *  higher level; "" when the heading is gone, so assertions fail as
 *  assertions rather than as a crash. */
function provisioningSection(dn: string): string {
  const start = dn.indexOf("### WebKit provisioning");
  if (start === -1) return "";
  const rest = dn.slice(start + 3);
  const next = rest.search(/\n#{2,3} /);
  return next === -1 ? dn.slice(start) : dn.slice(start, start + 3 + next);
}

describe("DN responsive model — WebKit provisioning says the Docker pass runs through the client and is filed", () => {
  test("the section still exists and still names the one local command", () => {
    const section = provisioningSection(readFileSync(DN_PATH, "utf8"));
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain("bun run webkit:docker");
  });

  test("the section names the bun Crucible client's e2e verb as what the Docker pass runs", () => {
    const section = provisioningSection(readFileSync(DN_PATH, "utf8"));
    expect(section).toMatch(/bun-crucible\.py[`'"]?\s+e2e\b/);
  });

  test("the section says the Docker pass's run is filed (a filed/files/filing word within reach of the client's name)", () => {
    const section = provisioningSection(readFileSync(DN_PATH, "utf8"));
    const filedNearClient =
      /bun-crucible\.py[\s\S]{0,300}\bfil(?:ed|es|ing)\b/i.test(section) ||
      /\bfil(?:ed|es|ing)\b[\s\S]{0,300}bun-crucible\.py/i.test(section);
    expect(filedNearClient).toBe(true);
  });
});
