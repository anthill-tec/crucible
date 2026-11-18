// A project is registered by an explicit act (the board's "+ Add project"
// form, a direct POST /api/v2/projects, or a client's `project-create` verb) —
// never by a client script reacting to an unrecognised key in its own .env.
// This file is the fleet census: the project-creation endpoint is named only
// in the shared project module, and only inside `project-create`'s
// implementation — no client script and no other shared module names it — and
// the one bootstrap that used to (arduino's self-registration, plus the
// shared pre_register hook arduino wired it through) is gone outright —
// asserted over the real, checked-in source, never over behaviour alone, so
// a reintroduced caller is caught even before a test happens to exercise it.
import { describe, expect, test } from "bun:test";
import { CLIENT_SOURCE_DIR } from "../helpers/test-install.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const CLIENTS_DIR = CLIENT_SOURCE_DIR;

const CLIENT_SCRIPTS = [
  "python-crucible.py",
  "bun-crucible.py",
  "rust-crucible.py",
  "mvn-crucible.py",
  "arduino-crucible.py",
  "go-crucible.py",
];

// The shared module holding a project's own verbs, `project-create` among them.
const PROJECT_MODULE = "_crucible_project.py";

// The shared modules every client loads: the core, and the run pipeline, the
// release-notes module and the project module the core loads by path and
// re-exports.
const SHARED_MODULES = [
  "_crucible_axi.py",
  "_crucible_run.py",
  "_crucible_release.py",
  PROJECT_MODULE,
  "_crucible_lint.py",
  "_crucible_board.py",
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
const PROJECT_CREATE_ENDPOINT_LITERALS = /(?:"|')\/api\/v2\/projects(?:"|')/g;

// One top-level `def` of a Python source: its name and the character span from
// its `def` line to the line before the next top-level statement. A line that
// is blank, indented, a comment or a closing `)` of a wrapped signature is
// still inside the function.
interface PyFunction {
  name: string;
  start: number;
  end: number;
}

function topLevelFunctions(src: string): PyFunction[] {
  const functions: PyFunction[] = [];
  let offset = 0;
  let open: PyFunction | null = null;
  for (const line of src.split("\n")) {
    const def = /^(?:async\s+)?def\s+(\w+)\s*\(/.exec(line);
    const continues = line === "" || /^[\s#)]/.test(line);
    if (open !== null && (def !== null || !continues)) {
      open.end = offset;
      functions.push(open);
      open = null;
    }
    if (def !== null) open = { name: def[1]!, start: offset, end: src.length };
    offset += line.length + 1;
  }
  if (open !== null) functions.push(open);
  return functions;
}

// The shared function(s) a client's own `cmd_project_create` hands the verb to:
// every `_axi().<name>(` call in that function's body.
function sharedEntryOf(clientSource: string): string[] {
  const fn = topLevelFunctions(clientSource).find((f) => f.name === "cmd_project_create");
  if (fn === undefined) return [];
  const body = clientSource.slice(fn.start, fn.end);
  return [...body.matchAll(/_axi\(\)\.(\w+)\(/g)].map((m) => m[1]!);
}

// Every top-level function of `src` reachable by calls from `entries`.
function reachableFunctions(src: string, entries: string[]): PyFunction[] {
  const functions = topLevelFunctions(src);
  const byName = new Map(functions.map((f) => [f.name, f]));
  const seen = new Set<string>();
  const queue = entries.filter((name) => byName.has(name));
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const fn = byName.get(name)!;
    const body = src.slice(fn.start, fn.end);
    for (const other of functions) {
      if (!seen.has(other.name) && new RegExp(`\\b${other.name}\\(`).test(body)) {
        queue.push(other.name);
      }
    }
  }
  return functions.filter((f) => seen.has(f.name));
}

describe("no client posts to POST /api/v2/projects (project registration stays an explicit act)", () => {
  for (const fileName of [...CLIENT_SCRIPTS, ...SHARED_MODULES.filter((m) => m !== PROJECT_MODULE)]) {
    test(`clients/${fileName} never names the bare project-creation endpoint`, () => {
      const src = readClientSource(fileName);
      expect(src).not.toMatch(PROJECT_CREATE_ENDPOINT_LITERAL);
    });
  }
});

describe("the project-creation endpoint is named only inside project-create's implementation", () => {
  test("every client's cmd_project_create hands the verb to the same shared function", () => {
    const entries = CLIENT_SCRIPTS.map((fileName) => sharedEntryOf(readClientSource(fileName)));
    for (const [index, entry] of entries.entries()) {
      expect({ client: CLIENT_SCRIPTS[index], entry }).toEqual({
        client: CLIENT_SCRIPTS[index],
        entry: entries[0]!,
      });
    }
    expect(entries[0]!.length).toBe(1);
    const defined = topLevelFunctions(readClientSource(PROJECT_MODULE)).map((f) => f.name);
    expect(defined).toContain(entries[0]![0]);
  });

  test(`clients/${PROJECT_MODULE} names the bare endpoint, and only in functions project-create reaches`, () => {
    const src = readClientSource(PROJECT_MODULE);
    const entry = sharedEntryOf(readClientSource("python-crucible.py"));
    const reached = reachableFunctions(src, entry);
    const hits = [...src.matchAll(PROJECT_CREATE_ENDPOINT_LITERALS)].map((m) => m.index!);
    expect(hits.length).toBeGreaterThan(0);
    const outside = hits.filter((at) => !reached.some((f) => f.start <= at && at < f.end));
    expect(outside).toEqual([]);
  });

  test("the census's function reader finds a literal inside a reached function and one outside it", () => {
    const synthetic = [
      "ROUTE = \"/api/v2/projects\"",
      "",
      "def cmd_project_create(args):",
      "    return _post_create(args)",
      "",
      "def _post_create(",
      "    args,",
      "):",
      "    return ops.post(\"/api/v2/projects\", {})",
      "",
      "def unrelated():",
      "    return \"/api/v2/projects\"",
      "",
    ].join("\n");
    const reached = reachableFunctions(synthetic, ["cmd_project_create"]).map((f) => f.name);
    expect(reached.sort()).toEqual(["_post_create", "cmd_project_create"]);
    const fns = reachableFunctions(synthetic, ["cmd_project_create"]);
    const hits = [...synthetic.matchAll(PROJECT_CREATE_ENDPOINT_LITERALS)].map((m) => m.index!);
    const inside = hits.filter((at) => fns.some((f) => f.start <= at && at < f.end));
    expect(hits.length).toBe(3);
    expect(inside.length).toBe(1);
    expect(sharedEntryOf("def cmd_project_create(args):\n    return _axi().cmd_project_create(args, d, _ops())\n"))
      .toEqual(["cmd_project_create"]);
  });
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
