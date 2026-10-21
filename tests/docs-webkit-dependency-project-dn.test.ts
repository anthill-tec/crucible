// The responsive-model DN's "WebKit provisioning" section says where
// `webkit-iphone`'s dependency project runs on the local Docker pass: in the
// container's Chromium, the same remote browser server the WebKit project
// connects to — never the host's Chromium (the host has no say once the
// endpoint is set, which is why the record must not claim otherwise).
//
// Spec: the change request "a phone tap on a history cycle line opens its
// runs", its step "the WebKit pass goes through the client", its step "the
// design record follows" and its criterion "The record" (docs/changes/).
//
// Follows the docs-*.test.ts substance-over-prose precedent: a window anchored
// on the real heading, load-bearing words rather than a pinned sentence.
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

/** The text that follows the section's mention of the dependency project, up
 *  to the end of that sentence; "" when the section no longer mentions it. */
function dependencyProjectSentence(section: string): string {
  const flat = section.replace(/\s+/g, " ");
  const at = flat.search(/dependency project/i);
  if (at === -1) return "";
  const end = flat.indexOf(". ", at);
  return end === -1 ? flat.slice(at) : flat.slice(at, end + 1);
}

describe("DN responsive model — WebKit provisioning says the dependency project runs in the container's Chromium", () => {
  test("the section still mentions webkit-iphone's dependency project", () => {
    const section = provisioningSection(readFileSync(DN_PATH, "utf8"));
    expect(section.length).toBeGreaterThan(0);
    expect(section.replace(/\s+/g, " ")).toMatch(/webkit-iphone`?'s dependency project/);
  });

  test("the section no longer says the dependency project runs on the host's Chromium", () => {
    const section = provisioningSection(readFileSync(DN_PATH, "utf8")).replace(/\s+/g, " ");
    expect(section).not.toMatch(/host['’]s Chromium/i);
    expect(dependencyProjectSentence(section)).not.toMatch(/\bhost\b/i);
  });

  test("the dependency project's sentence names the container's Chromium as where it runs", () => {
    const sentence = dependencyProjectSentence(provisioningSection(readFileSync(DN_PATH, "utf8")));
    expect(sentence).toMatch(/container['’]s Chromium/i);
  });
});
