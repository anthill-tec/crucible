// CR-CRU-068 — the server never says which store it opened.
//
// `resolveDbPath` (CR-CRU-043 §S1-§S3) picks the store by a four-rule cascade:
//   1. explicit `dbPath`              -> rule "explicit"
//   2. `CRUCIBLE_DB`                  -> rule "CRUCIBLE_DB"
//   3. an ALREADY-EXISTING <cwd>/data/crucible.db  -> rule "cwd-data"
//   4. <XDG_DATA_HOME|$HOME/.local/share>/crucible/crucible.db -> rule "user-data"
//
// Rule 3 is CWD-relative, so the SAME binary opens a DIFFERENT database
// depending on where it was launched from — and today nothing in the server's
// output says which one it chose. This suite pins the disclosure.
//
// ── The contract GREEN must implement (nothing here may be weakened) ───────
//
//   export type StoreRule = "explicit" | "CRUCIBLE_DB" | "cwd-data" | "user-data";
//   export interface StoreResolution { path: string; rule: StoreRule }
//   export function resolveStore(opts?: ResolveDbPathOpts): StoreResolution;
//
//   // AC2 — ADDITIVE. `resolveDbPath(opts): string` keeps its EXACT signature
//   // and return type and DELEGATES to resolveStore(opts).path. No existing
//   // call site (src/server.ts:192, tests/db-path-resolution.test.ts,
//   // tests/e2e/teardown-contracts/crucible-db-isolation.test.ts) is edited.
//
//   export interface ServerHandle {
//     server: ...; store: Store; stop(): void;
//     storeResolution: StoreResolution;   // AC1 — additive, beside the rest
//   }
//
//   // AC3 — the shared healthPayload() closure (src/server.ts:200), consumed
//   // by GET /api/health (226) and passed into handleV2 (235), gains ONE
//   // additive key so both routes cannot drift:
//   //   store: { path, rule }
//
// AC1 is asserted from the RETURNED handle, never by capturing console — the
// startup banner stays in the `import.meta.main` boot block by design.
//
// SAFETY: every store here is an mkdtempSync scratch file or ":memory:", every
// server binds port 0 (ephemeral — NEVER the live dog-food :3849), and nothing
// reads or writes this repo's data/crucible.db or the real ~/.local/share.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ResolveDbPathOpts, ServerHandle } from "../src/server.ts";
import * as serverModule from "../src/server.ts";

const RULES = ["explicit", "CRUCIBLE_DB", "cwd-data", "user-data"] as const;
type StoreRule = (typeof RULES)[number];
interface StoreResolution {
  path: string;
  rule: StoreRule;
}

const handles: ServerHandle[] = [];
const scratchDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crucible-cr068-"));
  scratchDirs.push(dir);
  return dir;
}

function boot(opts: { port?: number; dbPath?: string }): ServerHandle {
  const handle = serverModule.startServer({ port: 0, ...opts });
  handles.push(handle);
  return handle;
}

afterEach(() => {
  while (handles.length > 0) {
    handles.pop()?.stop();
  }
  while (scratchDirs.length > 0) {
    fs.rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

/** Narrows an unknown value to the pinned `{ path, rule }` disclosure shape. */
function asResolution(value: unknown, missing: string): StoreResolution {
  if (value === undefined || value === null) {
    throw new Error(missing);
  }
  if (typeof value !== "object" || !("path" in value) || !("rule" in value)) {
    throw new Error(
      `CR-CRU-068: disclosed value is not a { path, rule } resolution: ${JSON.stringify(value)}`,
    );
  }
  const { path: p, rule } = value;
  if (typeof p !== "string" || typeof rule !== "string") {
    throw new Error(
      `CR-CRU-068: disclosed { path, rule } must both be strings, got ${JSON.stringify(value)}`,
    );
  }
  // Checked above; `rule` is compared against RULES by the assertions themselves.
  return { path: p, rule: rule as StoreRule };
}

/** AC2 — the additive `{ path, rule }` entry point. Absent until GREEN. */
function resolveStore(opts?: ResolveDbPathOpts): StoreResolution {
  const mod: object = serverModule;
  if (!("resolveStore" in mod) || typeof mod.resolveStore !== "function") {
    throw new Error(
      "CR-CRU-068 AC2: src/server.ts exports no additive `resolveStore(opts) => { path, rule }` " +
        "entry point — the matched resolution rule is still un-disclosed and un-returnable.",
    );
  }
  // Unchecked by necessity: this suite exists to pin that signature.
  const resolve = mod.resolveStore as (o?: ResolveDbPathOpts) => unknown;
  return asResolution(resolve(opts), "CR-CRU-068 AC2: resolveStore returned nothing.");
}

/** AC1 — the resolution the handle must carry. Absent until GREEN. */
function disclosureOf(handle: ServerHandle): StoreResolution {
  const h: object = handle;
  const got = "storeResolution" in h ? h.storeResolution : undefined;
  return asResolution(
    got,
    "CR-CRU-068 AC1: startServer()'s ServerHandle exposes no `storeResolution` — the boot path " +
      "opens a store and returns nothing about WHICH store or WHICH rule matched.",
  );
}

async function health(handle: ServerHandle, route: string): Promise<Record<string, unknown>> {
  const res = await fetch(`http://localhost:${handle.server.port}${route}`);
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  if (body === null || typeof body !== "object") {
    throw new Error(`CR-CRU-068: GET ${route} did not return a JSON object`);
  }
  return { ...body };
}

/** AC3 — the store identity health must report. Absent until GREEN. */
function storeOf(body: Record<string, unknown>, route: string): StoreResolution {
  return asResolution(
    body.store,
    `CR-CRU-068 AC3: GET ${route} reports no \`store\` { path, rule } — a split-store instance ` +
      "is undiagnosable from the server's own health output.",
  );
}

/** Reads a project row straight out of the sqlite file AT the disclosed path. */
function readProjectNameFromFile(dbPath: string, key: string): string | undefined {
  const db = new Database(dbPath);
  try {
    const row: unknown = db.query("SELECT name FROM projects WHERE key = ?").get(key);
    if (row !== null && typeof row === "object" && "name" in row && typeof row.name === "string") {
      return row.name;
    }
    return undefined;
  } finally {
    db.close();
  }
}

async function createProject(handle: ServerHandle, name: string): Promise<string> {
  const res = await fetch(`http://localhost:${handle.server.port}/api/v2/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  if (body === null || typeof body !== "object" || !("project" in body)) {
    throw new Error("CR-CRU-068: POST /api/v2/projects returned no project");
  }
  const project = body.project;
  if (
    project === null ||
    typeof project !== "object" ||
    !("key" in project) ||
    typeof project.key !== "string"
  ) {
    throw new Error("CR-CRU-068: POST /api/v2/projects returned no project.key");
  }
  return project.key;
}

describe("CR-CRU-068 — the server discloses which store it opened", () => {
  test("AC2 — resolveStore returns { path, rule } for all four rules, and resolveDbPath still returns exactly that path as a bare string", () => {
    // Rule 3's probe is driven by opts.cwd and rule 4 by opts.env — process.env
    // is NEVER mutated here (Bun caches HOME at startup; see CR-CRU-043's suite).
    const explicitCwd = tmpDir();
    fs.mkdirSync(path.join(explicitCwd, "data"), { recursive: true });
    fs.writeFileSync(path.join(explicitCwd, "data", "crucible.db"), "existing");

    const envCwd = tmpDir();
    fs.mkdirSync(path.join(envCwd, "data"), { recursive: true });
    fs.writeFileSync(path.join(envCwd, "data", "crucible.db"), "existing");

    const adoptCwd = tmpDir();
    fs.mkdirSync(path.join(adoptCwd, "data"), { recursive: true });
    const adopted = path.join(adoptCwd, "data", "crucible.db");
    fs.writeFileSync(adopted, "existing");

    const xdgCwd = tmpDir(); // no data/crucible.db -> falls through to rule 4
    const homeCwd = tmpDir();
    const fakeHome = "/fake/home/for/cr068/testing/only";

    const cases: Array<{ what: string; opts: ResolveDbPathOpts; path: string; rule: StoreRule }> = [
      {
        what: "explicit dbPath outranks CRUCIBLE_DB, an existing data/crucible.db, and XDG",
        opts: {
          cwd: explicitCwd,
          dbPath: "/explicit/path/x.db",
          env: { CRUCIBLE_DB: "/env/path/y.db", XDG_DATA_HOME: "/xdg" },
        },
        path: "/explicit/path/x.db",
        rule: "explicit",
      },
      {
        what: "CRUCIBLE_DB outranks an existing data/crucible.db and XDG",
        opts: { cwd: envCwd, env: { CRUCIBLE_DB: "/env/path/y.db", XDG_DATA_HOME: "/xdg" } },
        path: "/env/path/y.db",
        rule: "CRUCIBLE_DB",
      },
      {
        what: "an already-existing <cwd>/data/crucible.db is adopted over XDG",
        opts: { cwd: adoptCwd, env: { XDG_DATA_HOME: "/xdg" } },
        path: adopted,
        rule: "cwd-data",
      },
      {
        what: "nothing else matches -> $XDG_DATA_HOME/crucible/crucible.db",
        opts: { cwd: xdgCwd, env: { XDG_DATA_HOME: "/xdg-home" } },
        path: path.join("/xdg-home", "crucible", "crucible.db"),
        rule: "user-data",
      },
      {
        what: "XDG unset -> <HOME>/.local/share/crucible/crucible.db is STILL rule 4",
        opts: { cwd: homeCwd, env: { HOME: fakeHome } },
        path: path.join(fakeHome, ".local", "share", "crucible", "crucible.db"),
        rule: "user-data",
      },
    ];

    for (const c of cases) {
      const resolution = resolveStore(c.opts);
      expect([...RULES], `rule for: ${c.what}`).toContain(resolution.rule);
      expect(resolution.rule, `rule for: ${c.what}`).toBe(c.rule);
      expect(resolution.path, `path for: ${c.what}`).toBe(c.path);

      // Delegation, not duplication: the pinned string entry point is unchanged
      // and returns byte-for-byte what the rich one reports.
      const bare = serverModule.resolveDbPath(c.opts);
      expect(typeof bare, `resolveDbPath return type for: ${c.what}`).toBe("string");
      expect(bare, `resolveDbPath delegation for: ${c.what}`).toBe(resolution.path);
    }

    // Pure string computation — rule 4 never creates anything on disk.
    expect(fs.existsSync(fakeHome)).toBe(false);
  });

  test("AC1 — startServer returns the resolved absolute store path AND the matched rule on its handle", () => {
    const dbPath = path.join(tmpDir(), "cr068-ac1.db");

    const handle = boot({ dbPath });

    expect(handle.server.port).not.toBe(3849);
    const disclosed = disclosureOf(handle);
    expect(path.isAbsolute(disclosed.path)).toBe(true);
    expect(disclosed.path).toBe(dbPath);
    expect(disclosed.rule).toBe("explicit");
    expect([...RULES]).toContain(disclosed.rule);

    // The same boot path must disclose a NON-explicit rule too — otherwise the
    // 0.1.2 defect (a surprising CRUCIBLE_DB/XDG store) stays unexplained.
    const savedEnvDb = process.env.CRUCIBLE_DB;
    const savedXdg = process.env.XDG_DATA_HOME;
    const envDbPath = path.join(tmpDir(), "cr068-ac1-env.db");
    try {
      process.env.CRUCIBLE_DB = envDbPath;
      delete process.env.XDG_DATA_HOME;

      const envHandle = boot({});

      const envDisclosed = disclosureOf(envHandle);
      expect(envDisclosed.path).toBe(envDbPath);
      expect(envDisclosed.rule).toBe("CRUCIBLE_DB");
    } finally {
      if (savedEnvDb === undefined) delete process.env.CRUCIBLE_DB;
      else process.env.CRUCIBLE_DB = savedEnvDb;
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
    }
  });

  test("AC3 — GET /api/health and GET /api/v2/health both report the store path + rule, with IDENTICAL values", async () => {
    const dbPath = path.join(tmpDir(), "cr068-ac3.db");
    const handle = boot({ dbPath });

    const v1Body = await health(handle, "/api/health");
    const v2Body = await health(handle, "/api/v2/health");
    const v1Store = storeOf(v1Body, "/api/health");
    const v2Store = storeOf(v2Body, "/api/v2/health");

    // One shared healthPayload() closure => parity is structural, not coincidental.
    expect(v1Store).toEqual(v2Store);
    expect(v1Store.path).toBe(dbPath);
    expect(v1Store.rule).toBe("explicit");
    expect(v1Store).toEqual(disclosureOf(handle));

    // Additive only: every pre-CR health field keeps its name and type.
    for (const body of [v1Body, v2Body]) {
      expect(body.ok).toBe(true);
      expect(typeof body.version).toBe("string");
      expect(typeof body.counts).toBe("object");
    }
    expect(v1Body.status).toBe("healthy");
  });

  test("AC4 — an in-memory store is disclosed verbatim as ':memory:' on the handle and on both health routes, never absolutised", async () => {
    const handle = boot({ dbPath: ":memory:" });

    const disclosed = disclosureOf(handle);
    expect(disclosed.path).toBe(":memory:");
    expect(disclosed.rule).toBe("explicit");
    expect(path.isAbsolute(disclosed.path)).toBe(false);

    for (const route of ["/api/health", "/api/v2/health"]) {
      const reported = storeOf(await health(handle, route), route);
      expect(reported.path).toBe(":memory:");
      expect(reported.rule).toBe("explicit");
    }

    // The rich entry point holds the same identity (":memory:" in, ":memory:" out).
    expect(resolveStore({ dbPath: ":memory:" })).toEqual({ path: ":memory:", rule: "explicit" });
  });

  test("AC5 — two servers on two different stores report DIFFERENT identities, each matching its own file", async () => {
    const dbA = path.join(tmpDir(), "cr068-a.db");
    const dbB = path.join(tmpDir(), "cr068-b.db");
    const handleA = boot({ dbPath: dbA });
    const handleB = boot({ dbPath: dbB });

    const storeA = storeOf(await health(handleA, "/api/health"), "/api/health");
    const storeB = storeOf(await health(handleB, "/api/health"), "/api/health");

    expect(storeA.path).not.toBe(storeB.path);
    expect(storeA.path).toBe(dbA);
    expect(storeB.path).toBe(dbB);
    expect(storeA.path).toBe(disclosureOf(handleA).path);
    expect(storeB.path).toBe(disclosureOf(handleB).path);

    // The divergence is diagnosable from the servers alone: a project written to
    // A exists in the file A disclosed and is absent from the file B disclosed —
    // no /proc, fuser, or file-size forensics needed.
    const keyA = await createProject(handleA, "cr068-only-in-a");
    expect(readProjectNameFromFile(storeA.path, keyA)).toBe("cr068-only-in-a");
    expect(readProjectNameFromFile(storeB.path, keyA)).toBeUndefined();
  });

  test("AC-truth — the disclosed path is the file the Store actually opened: a write through the server is readable from the sqlite file AT that path", async () => {
    const dbPath = path.join(tmpDir(), "cr068-truth.db");
    const handle = boot({ dbPath });

    const key = await createProject(handle, "cr068-disclosed-is-real");

    // Disclosure is taken FROM the running server, never recomputed with the
    // helper under test — that is the whole point of AC4/AC-truth.
    const disclosed = storeOf(await health(handle, "/api/v2/health"), "/api/v2/health");
    expect(disclosed.path.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(disclosed.path)).toBe(true);
    expect(readProjectNameFromFile(disclosed.path, key)).toBe("cr068-disclosed-is-real");
    expect(disclosureOf(handle).path).toBe(disclosed.path);
  });
});
