// The PRD's UI-stack line says how the dashboard is styled. Once Tailwind's
// browser runtime is replaced by its generated output served as a static
// stylesheet, the line names that: Tailwind 4's generated theme and base reset
// as a static, vendored stylesheet, not the browser runtime. The line's other
// commitments stay: no CDN or build step, and every UI asset vendored.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PRD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "docs", "research", "PRD-crucible-v2.md");

/** The PRD's "UI stack" bullet, from its bold label to the next top-level bullet, on one line. */
function uiStackLine(): string {
  const prd = readFileSync(PRD, "utf8");
  const start = prd.indexOf("- **UI stack");
  expect(start, "the PRD has a UI stack bullet").toBeGreaterThanOrEqual(0);
  const rest = prd.slice(start + 2);
  const next = rest.search(/\n- \*\*|\n#/);
  return (next < 0 ? rest : rest.slice(0, next)).replace(/\s+/g, " ");
}

describe("the PRD's UI-stack line names the static stylesheet", () => {
  test("it names Tailwind 4's generated theme and base reset as a static vendored stylesheet", () => {
    const line = uiStackLine();
    expect(line).toContain("Tailwind 4");
    expect(/\btheme\b/i.test(line), "it names the theme").toBe(true);
    expect(/\bbase reset\b/i.test(line), "it names the base reset").toBe(true);
    expect(/\bstatic\b[^.]*\bstylesheet\b/i.test(line), "it names a static stylesheet").toBe(true);
    expect(/\bvendored\b/i.test(line), "the stylesheet is vendored").toBe(true);
  });

  test("it no longer names the Tailwind browser runtime as what styles the dashboard", () => {
    expect(uiStackLine()).not.toContain("Tailwind 4 browser runtime");
  });

  test("it keeps no CDN or build step and every UI asset vendored", () => {
    const line = uiStackLine();
    expect(line).toContain("no CDN/build step");
    expect(/\ball (UI assets )?vendored\b/i.test(line), "every UI asset stays vendored").toBe(true);
  });
});
