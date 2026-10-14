// §S3/AC "Docs" — the PRD and the client-fleet DN stop promising client
// self-registration.
//
// Spec: the spec for this change, under docs/changes/
//   §S3: "The PRD's transition-shim line that names 'idempotent
//   self-registration', and the client-fleet DN's `_project_key` row that
//   describes arduino's `_ensure_project`, say instead that clients never
//   register projects and that a project is registered by an explicit act."
//   AC "Docs": "The PRD and the client-fleet DN no longer describe client
//   self-registration."
//
// Current-doc facts verified on this branch:
//   - docs/research/PRD-crucible-v2.md's §4.1 bullet reads "`POST
//     /api/projects/add` with an existing key → HTTP 400 (clients rely on
//     this for idempotent self-registration)." — it names
//     self-registration, and never states that clients never register
//     projects. Every assertion below is genuine RED against that text.
//   - docs/research/DN-client-fleet-inventory.md's `_project_key` row reads
//     "...needed for arduino's unique `_ensure_project`/`POST
//     /api/projects/add` self-registration, per
//     DN-crucible-api-reconstruction.md §4)..." — it names both
//     `_ensure_project` and self-registration, and never states that
//     clients never register projects.
//
// Assertions target MEANING, not exact sentences: the negative checks guard
// against the retired vocabulary ("self-registration", `_ensure_project`)
// surviving a reword in any form; the positive check accepts any reasonable
// phrasing that puts "client(s)", "never", "regist*" and "project" near each
// other in that reading order, so a correct GREEN rewrite passes without the
// test being pinned to one exact sentence.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

function readText(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

const PRD_PATH = join("docs", "research", "PRD-crucible-v2.md");
const DN_PATH = join("docs", "research", "DN-client-fleet-inventory.md");

// Slices from a start marker up to (but excluding) an end marker that must
// appear later in the same file — never a fixed line/char count, so a
// GREEN rewrite that grows or shrinks the passage is still read whole.
function slice(text: string, startMarker: string, endMarker: string, filePath: string): string {
  const start = text.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`client-fleet-docs-no-self-registration-wording.test.ts: start marker ${JSON.stringify(startMarker)} not found in ${filePath}`);
  }
  const end = text.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error(`client-fleet-docs-no-self-registration-wording.test.ts: end marker ${JSON.stringify(endMarker)} not found after start in ${filePath}`);
  }
  return text.slice(start, end);
}

// The retired vocabulary this CR removes, in any inflection
// ("self-registration", "self-register", "self-registers", ...).
const SELF_REGISTRATION_WORDING = /self-regist(er|ration)\w*/i;

// The replacement claim: clients never register projects. Bounded windows
// (not a fixed phrase) so inserted words/line-wraps don't break a genuine
// rewrite, but the four concepts still have to appear close together and in
// this reading order to count as the same claim.
const CLIENTS_NEVER_REGISTER_PROJECTS = /client\w*[\s\S]{0,40}never[\s\S]{0,40}regist\w*[\s\S]{0,40}project\w*/i;

describe("§S3/AC Docs — PRD-crucible-v2's transition-shim line drops self-registration", () => {
  test("the `POST /api/projects/add` duplicate-key bullet no longer calls the 400 behaviour self-registration", () => {
    const prd = readText(PRD_PATH);
    const bullet = slice(
      prd,
      "`POST /api/projects/add` with an existing key",
      "- Heartbeat `identity`",
      PRD_PATH,
    );

    // NEGATIVE — the retired vocabulary this CR removes.
    expect(bullet).not.toMatch(SELF_REGISTRATION_WORDING);
  });

  test("the same bullet states that clients never register projects", () => {
    const prd = readText(PRD_PATH);
    const bullet = slice(
      prd,
      "`POST /api/projects/add` with an existing key",
      "- Heartbeat `identity`",
      PRD_PATH,
    );

    // POSITIVE — the replacement claim §S3 requires.
    expect(bullet).toMatch(CLIENTS_NEVER_REGISTER_PROJECTS);
  });
});

describe("§S3/AC Docs — DN-client-fleet-inventory's `_project_key` row drops arduino's self-registration bootstrap", () => {
  test("the `_project_key` row no longer names `_ensure_project` or calls anything self-registration", () => {
    const dn = readText(DN_PATH);
    const row = slice(
      dn,
      "| `_project_key` |",
      "## Functions I could not confidently classify",
      DN_PATH,
    );

    // NEGATIVE — the retired symbol and the retired vocabulary this CR
    // removes. A reader must not be able to find either in the row once
    // GREEN deletes the bootstrap this row used to justify.
    expect(row).not.toMatch(/_ensure_project\b/);
    expect(row).not.toMatch(SELF_REGISTRATION_WORDING);
  });

  test("the `_project_key` row states that clients never register projects", () => {
    const dn = readText(DN_PATH);
    const row = slice(
      dn,
      "| `_project_key` |",
      "## Functions I could not confidently classify",
      DN_PATH,
    );

    // POSITIVE — the replacement claim §S3 requires.
    expect(row).toMatch(CLIENTS_NEVER_REGISTER_PROJECTS);
  });
});
