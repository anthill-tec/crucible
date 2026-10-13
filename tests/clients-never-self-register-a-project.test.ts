// A project is registered by an explicit act (the board's "+ Add project"
// form, or a direct POST /api/v2/projects) — never by a client script
// reacting to an unrecognised key in its own .env. This file is the fleet
// census: nothing under clients/ posts to the project-creation endpoint, and
// the one bootstrap that used to (arduino's self-registration, plus the
// shared pre_register hook arduino wired it through) is gone outright —
// asserted over the real, checked-in source, never over behaviour alone, so
// a reintroduced caller is caught even before a test happens to exercise it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const CLIENTS_DIR = join(REPO_ROOT, "clients");

const CLIENT_SCRIPTS = [
  "python-crucible.py",
  "bun-crucible.py",
  "rust-crucible.py",
  "mvn-crucible.py",
  "arduino-crucible.py",
];

function readClientSource(fileName: string): string {
  return readFileSync(join(CLIENTS_DIR, fileName), "utf8");
}

// Matches the bare literal `"/api/v2/projects"` (or the single-quoted form),
// the exact project-creation endpoint — never the LONGER project-scoped
// paths every client's `plans_path` builds from an f-string
// (`/api/v2/projects/{key}/plans`), which legitimately contain the same
// prefix and must stay untouched by this census.
const PROJECT_CREATE_ENDPOINT_LITERAL = /(?:"|')\/api\/v2\/projects(?:"|')/;

describe("no client posts to POST /api/v2/projects (project registration stays an explicit act)", () => {
  for (const fileName of [...CLIENT_SCRIPTS, "_crucible_axi.py"]) {
    test(`clients/${fileName} never names the bare project-creation endpoint`, () => {
      const src = readClientSource(fileName);
      expect(src).not.toMatch(PROJECT_CREATE_ENDPOINT_LITERAL);
    });
  }
});

describe("arduino's self-registration bootstrap is gone outright, not merely unreachable", () => {
  test("_ensure_project has no definition left in clients/arduino-crucible.py", () => {
    const src = readClientSource("arduino-crucible.py");
    expect(src).not.toMatch(/^def _ensure_project\(/m);
  });

  test("_ensure_project_registered (arduino's pre_register hook) has no definition left", () => {
    const src = readClientSource("arduino-crucible.py");
    expect(src).not.toMatch(/^def _ensure_project_registered\(/m);
  });

  test("arduino's cmd_register no longer wires _ensure_project_registered as the shared pre_register hook", () => {
    const src = readClientSource("arduino-crucible.py");
    expect(src).not.toContain("pre_register=_ensure_project_registered");
  });

  test("nothing in clients/arduino-crucible.py calls _ensure_project( anywhere (unit/test, check/compile, auto-ingest, register)", () => {
    const src = readClientSource("arduino-crucible.py");
    expect(src).not.toMatch(/\b_ensure_project\(/);
  });
});
