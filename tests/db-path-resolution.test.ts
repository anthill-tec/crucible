// CR-CRU-043 §S1-§S3 — DB path resolution order.
//
// Resolution order, first match wins:
//   1. explicit opts.dbPath (":memory:" included — the whole suite depends on it)
//   2. CRUCIBLE_DB env var
//   3. an already-existing ./data/crucible.db relative to CWD (ADOPT ONLY, never create)
//   4. $XDG_DATA_HOME/crucible/crucible.db, falling back to
//      ~/.local/share/crucible/crucible.db when XDG_DATA_HOME is unset
//
// GREEN must export a pure resolver from src/server.ts:
//
//   export interface ResolveDbPathOpts {
//     cwd?: string;
//     env?: NodeJS.ProcessEnv;
//     dbPath?: string;
//   }
//   export function resolveDbPath(opts?: ResolveDbPathOpts): string
//
// and wire startServer() to call it (reading CRUCIBLE_DB from process.env the
// same way CRUCIBLE_PORT/CRUCIBLE_HOST already are) instead of the hardcoded
// `opts?.dbPath ?? "data/crucible.db"` default at src/server.ts:147.
//
// NOTE (verified while writing this suite): Bun's os.homedir() reads HOME
// ONCE at process startup and does NOT observe a runtime `process.env.HOME`
// mutation — so the "XDG_DATA_HOME unset -> ~/.local/share fallback" case
// can only be exercised safely by passing an explicit `env: { HOME: ... }`
// into resolveDbPath, never by mutating process.env.HOME. GREEN's fallback
// must therefore consult `env.HOME` (from the passed-in opts.env, defaulting
// to process.env when opts.env is omitted) rather than calling os.homedir()
// directly, or this contract cannot be unit-tested at all.
//
// SAFETY: every test here uses a fresh os.tmpdir() scratch directory for both
// the "CWD" and the "XDG home" side of the story. Nothing here ever writes to
// the real ~/.local/share, and nothing here touches this repo's own
// data/crucible.db (the live dog-food database).
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveDbPath, startServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

function freshTmpDir(): string {
  // NEVER inside the repo — a fresh OS tmpdir per test.
  return fs.mkdtempSync(path.join(os.tmpdir(), "crucible-dbpath-test-"));
}

describe("resolveDbPath — pure resolution logic (§S1-§S3)", () => {
  test("precedence: explicit opts.dbPath wins over CRUCIBLE_DB, an existing ./data/crucible.db, and XDG", () => {
    const cwd = freshTmpDir();
    fs.mkdirSync(path.join(cwd, "data"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "data", "crucible.db"), "existing");

    const result = resolveDbPath({
      cwd,
      dbPath: "/explicit/path/x.db",
      env: { CRUCIBLE_DB: "/env/path/y.db", XDG_DATA_HOME: "/xdg" },
    });

    expect(result).toBe("/explicit/path/x.db");
  });

  test("precedence: CRUCIBLE_DB wins over an existing ./data/crucible.db and the XDG default", () => {
    const cwd = freshTmpDir();
    fs.mkdirSync(path.join(cwd, "data"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "data", "crucible.db"), "existing");

    const result = resolveDbPath({
      cwd,
      env: { CRUCIBLE_DB: "/env/path/y.db", XDG_DATA_HOME: "/xdg" },
    });

    expect(result).toBe("/env/path/y.db");
  });

  test("precedence: an existing ./data/crucible.db wins over the XDG default when no override is set", () => {
    const cwd = freshTmpDir();
    fs.mkdirSync(path.join(cwd, "data"), { recursive: true });
    const existing = path.join(cwd, "data", "crucible.db");
    fs.writeFileSync(existing, "existing");

    const result = resolveDbPath({ cwd, env: { XDG_DATA_HOME: "/xdg" } });

    expect(result).toBe(existing);
  });

  test("adopt-only: a data/ directory with no crucible.db file inside it never wins — falls through to XDG", () => {
    const cwd = freshTmpDir();
    fs.mkdirSync(path.join(cwd, "data"), { recursive: true }); // dir exists, file does not

    const result = resolveDbPath({ cwd, env: { XDG_DATA_HOME: "/xdg-home" } });

    expect(result).toBe(path.join("/xdg-home", "crucible", "crucible.db"));
    expect(result).not.toBe(path.join(cwd, "data", "crucible.db"));
  });

  test("falls through to $XDG_DATA_HOME/crucible/crucible.db when nothing else matches", () => {
    const cwd = freshTmpDir(); // no data/crucible.db here, no env overrides

    const result = resolveDbPath({ cwd, env: { XDG_DATA_HOME: "/xdg-home" } });

    expect(result).toBe(path.join("/xdg-home", "crucible", "crucible.db"));
  });

  test("XDG_DATA_HOME unset falls back to <HOME>/.local/share/crucible/crucible.db, never touching the real home", () => {
    const cwd = freshTmpDir(); // no data/crucible.db
    const fakeHome = "/fake/home/for/crucible/testing/only";

    const result = resolveDbPath({ cwd, env: { HOME: fakeHome } });

    expect(result).toBe(path.join(fakeHome, ".local", "share", "crucible", "crucible.db"));
    // Purely a string computation — nothing should exist on disk from it.
    expect(fs.existsSync(fakeHome)).toBe(false);
  });

  test(":memory: as explicit dbPath is returned unchanged, ignoring CRUCIBLE_DB and any existing data/crucible.db", () => {
    const cwd = freshTmpDir();
    fs.mkdirSync(path.join(cwd, "data"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "data", "crucible.db"), "existing");

    const result = resolveDbPath({
      cwd,
      dbPath: ":memory:",
      env: { CRUCIBLE_DB: "/should/be/ignored" },
    });

    expect(result).toBe(":memory:");
  });
});

describe("startServer — real boot path wiring (§S1-§S3 regression + dog-food continuity)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let savedCwd: string;
  const ENV_KEYS = ["CRUCIBLE_DB", "XDG_DATA_HOME"] as const;
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    savedCwd = process.cwd();
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    process.chdir(savedCwd);
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("CRUCIBLE_DB env var with no explicit opts: the server opens exactly that path", () => {
    const dir = freshTmpDir();
    const target = path.join(dir, "x.db");
    process.env.CRUCIBLE_DB = target;
    delete process.env.XDG_DATA_HOME;

    handle = startServer({ port: 0 });
    const key = crypto.randomUUID();
    handle.store.addProject({ key, name: "env-db", type: "backend", sutRoot: "/tmp" });

    expect(fs.existsSync(target)).toBe(true);
    expect(handle.store.getProject(key)?.name).toBe("env-db");
  });

  test("scratch CWD with no data/crucible.db + XDG_DATA_HOME set: opens the XDG path and creates NO data/ dir in the CWD", () => {
    const scratchCwd = freshTmpDir();
    const xdgHome = freshTmpDir();
    delete process.env.CRUCIBLE_DB;
    process.env.XDG_DATA_HOME = xdgHome;
    process.chdir(scratchCwd);

    handle = startServer({ port: 0 });

    const expectedDbPath = path.join(xdgHome, "crucible", "crucible.db");
    expect(fs.existsSync(expectedDbPath)).toBe(true);
    // The defect's regression assertion: no data/ dir left behind in the CWD.
    expect(fs.existsSync(path.join(scratchCwd, "data"))).toBe(false);
  });

  test("scratch CWD WITH an existing data/crucible.db: adopts it and never touches the XDG location (dog-food continuity)", () => {
    const scratchCwd = freshTmpDir();
    const xdgHome = freshTmpDir();
    fs.mkdirSync(path.join(scratchCwd, "data"), { recursive: true });
    const existingDbPath = path.join(scratchCwd, "data", "crucible.db");

    const seedKey = crypto.randomUUID();
    const seedStore = Store.open(existingDbPath);
    seedStore.addProject({ key: seedKey, name: "dogfood", type: "backend", sutRoot: "/tmp" });

    delete process.env.CRUCIBLE_DB;
    process.env.XDG_DATA_HOME = xdgHome;
    process.chdir(scratchCwd);

    handle = startServer({ port: 0 });

    expect(handle.store.getProject(seedKey)?.name).toBe("dogfood");
    // Rule 3 is adopt-only: the pre-existing file must be the one in use, and
    // the XDG side must never be touched when it is.
    expect(fs.existsSync(path.join(xdgHome, "crucible"))).toBe(false);
  });

  test("opts.dbPath = ':memory:' still bypasses all directory creation on the real boot path", () => {
    const scratchCwd = freshTmpDir();
    process.chdir(scratchCwd);
    delete process.env.CRUCIBLE_DB;
    delete process.env.XDG_DATA_HOME;

    handle = startServer({ port: 0, dbPath: ":memory:" });

    expect(fs.existsSync(path.join(scratchCwd, "data"))).toBe(false);
  });
});
