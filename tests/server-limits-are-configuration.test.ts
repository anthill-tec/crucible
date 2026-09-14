// CR-CRU-131 §S1/§S1b — the SERVER's limits are CONFIGURATION, resolved from
// the server's OWN `crucible.toml` at the POINT OF USE.
//
// The rule (PRD §4.13, user ruling 2026-09-14): a limit is configuration,
// never a constant compiled into source. It was earned — `DEFAULT_RETENTION =
// 100` was a number one author chose, reachable by nobody, and it evicted
// every release this project had ever shipped (PRD §4.7). CR-CRU-129 removed
// that one. This file covers the three the SERVER still enforces:
//
//   run_abandon_ms       src/store.ts:836  `runAbandonAfterMs()`  — the sweep
//   project_inactive_ms  src/v2.ts:366     `projectInactiveMs()`  — the read
//   retention            src/store.ts:744  `defaultRetention()`   — the cap
//
// The client's three (`truncate_field_chars`, `error_detail_chars`,
// `roadmap_list_rows`) are NOT here and must not be: a limit is owned by the
// process that ENFORCES it, and the clients are not necessarily on this
// machine. Their half lives in
// tests/client/test_client_limits_resolve_from_configuration.py.
//
// ── The seam this file is written against — src/limits.ts ──────────────────
//
//   export interface LimitDeclaration {
//     description: string; recommended: number; min: number; max: number;
//   }
//   export const SERVER_LIMIT_NAMES: readonly string[];
//   export function shippedLimits(): Record<string, LimitDeclaration>;
//   export function serverConfigPath(): string;
//   export function limitDeclarations(): Record<string, LimitDeclaration>;
//   export function resolveLimit(name: string): number;
//   export function limitDisclosures(): string[];
//
// `shippedLimits()` is the PACKAGE DATA table — the last resort, readable
// without the operator's file being present or even valid, which is what makes
// "no literal in source" reachable (§S1c). `limitDeclarations()` is what is in
// EFFECT: the operator's file when it parses, the shipped table otherwise. The
// operator's file carries the same four fields, and the field an operator
// EDITS to change a limit is `recommended` — which is why widening `max` in
// that same table can make a previously-refused `recommended` resolve.
//
// ── Read at the POINT OF USE, not imported ─────────────────────────────────
//
// Measured on this machine, 2026-09-14, bun 1.3.14:
//
//   const a = (await import(p)).default.limits.run_abandon_ms.recommended;
//   // …rewrite the file…
//   const b = (await import(p)).default.limits.run_abandon_ms.recommended;
//   // a === b  ->  the module graph CACHED the table; the edit was invisible
//   Bun.TOML.parse(await Bun.file(p).text())  // <- saw the new value
//
// So `import cfg from "./crucible.toml"` is exactly the mistake this CR must
// not make, and the no-restart tests below are the only thing standing between
// it and a board whose operator edits a file that does nothing. Each of them
// asserts the FIRST call's behaviour before the edit, so "it changed" is a
// claim about the edit and not about the fixture.
//
// ── No test pins a limit VALUE (PRD §4.13, user ruling) ────────────────────
//
// Nothing below spells 1_800_000, 3_600_000, 100 or any other limit. Every
// expectation is derived from the declaration READ BACK off the table the
// operator edits — a test that hardcodes the limit it checks freezes the same
// defect from the other side. The only numbers written out are the limit
// NAMES' vocabulary and arithmetic on values read back (`min - 1`, `max + 1`),
// which is what a boundary test is.
//
// ── Safety ─────────────────────────────────────────────────────────────────
//
// Every Store is ":memory:" and every `crucible.toml` is in a fresh OS tmpdir
// (same convention as tests/boot-safety.test.ts). `CRUCIBLE_DB` is set only so
// the config path RESOLVES beside it — no database at that path is ever opened
// or created, and `data/crucible.db` is never touched.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store.ts";
import { startServer, retentionDisclosure } from "../src/server.ts";
import type { SuiteNode } from "../src/types.ts";

/** The four fields §S1b requires of every limit. A vocabulary, not a limit. */
const DECLARED_FIELDS = ["description", "recommended", "min", "max"] as const;

/**
 * The three limits the SERVER enforces, by their OWN names — not
 * transliterations of the retired constants (`DEFAULT_RUN_ABANDON_MS`,
 * `DEFAULT_PROJECT_INACTIVE_MS`), which would carry an accident of the old
 * source into the file an operator reads.
 *
 * Written out because this is the VOCABULARY under test, exactly as
 * tests/retention-disposable-kinds.test.ts writes out its disposable kinds: a
 * vocabulary is not a limit, and a completeness check compared against a set
 * derived from the thing it is checking would assert nothing.
 *
 * `TOON_MAX_BYTES` is deliberately absent — CR-CRU-132 deletes the feature it
 * bounds, so the server's count is THREE, not four (CR-CRU-131 Risk).
 */
const SERVER_LIMITS = ["run_abandon_ms", "project_inactive_ms", "retention"] as const;

/** The limits a CLIENT enforces. Here only so the ownership NEGATIVE can name
 *  one; the server must never resolve any of them. */
const CLIENT_LIMITS = ["truncate_field_chars", "error_detail_chars", "roadmap_list_rows"] as const;

interface LimitDeclaration {
  description: string;
  recommended: number;
  min: number;
  max: number;
}

interface LimitsModule {
  SERVER_LIMIT_NAMES: readonly string[];
  shippedLimits(): Record<string, LimitDeclaration>;
  serverConfigPath(): string;
  limitDeclarations(): Record<string, LimitDeclaration>;
  resolveLimit(name: string): number;
  limitDisclosures(): string[];
}

/**
 * The seam, loaded LAZILY per test rather than at module scope.
 *
 * A top-level `import` of a module that does not exist yet collapses the whole
 * file into one collection error, and a RED phase that reports one failure for
 * twenty contracts tells GREEN nothing about which of them it has satisfied.
 * Loaded here, each test fails on its own and names what it wanted — the same
 * reason `disposableKinds()` in tests/retention-disposable-kinds.test.ts throws
 * a named error instead of letting an absent export read as an empty set.
 */
async function limits(): Promise<LimitsModule> {
  let mod: unknown;
  try {
    mod = await import("../src/limits.ts");
  } catch (cause) {
    throw new Error(
      `CR-CRU-131 §S1: src/limits.ts does not load. The server's limits must resolve from a ` +
        `\`crucible.toml\` beside its own configuration, through ONE loader — not from literals ` +
        `at src/store.ts:834, src/v2.ts:362 and src/store.ts:744. (${String(cause)})`,
    );
  }
  for (const name of [
    "SERVER_LIMIT_NAMES",
    "shippedLimits",
    "serverConfigPath",
    "limitDeclarations",
    "resolveLimit",
    "limitDisclosures",
  ]) {
    if (!(name in (mod as object))) {
      throw new Error(
        `CR-CRU-131 §S1: src/limits.ts exports no \`${name}\`. The loader has to be checkable ` +
          `from outside — an unexported resolver is a promise the server makes to itself.`,
      );
    }
  }
  return mod as LimitsModule;
}

// ── Fixture plumbing ───────────────────────────────────────────────────────

const scratchDirs: string[] = [];
const envRestore: Array<[string, string | undefined]> = [];
const openHandles: Array<{ stop(): void }> = [];

function scratch(prefix: string): string {
  // NEVER inside the repo (tests/boot-safety.test.ts's convention).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function setEnv(name: string, value: string): void {
  envRestore.push([name, process.env[name]]);
  process.env[name] = value;
}

function clearEnv(name: string): void {
  envRestore.push([name, process.env[name]]);
  delete process.env[name];
}

/**
 * A scratch directory standing in for the server's own configuration
 * directory, pointed at by the SAME rule that resolves the database path
 * (`CRUCIBLE_DB`, src/server.ts:65). No database is opened there — every Store
 * below is ":memory:"; only the config PATH is resolved from it.
 *
 * The env vars this CR retires as limit overrides are cleared, so nothing here
 * can pass on a value the file did not supply.
 */
function serverConfigDir(): string {
  const dir = scratch("crucible-server-limits-");
  setEnv("CRUCIBLE_DB", path.join(dir, "crucible.db"));
  clearEnv("CRUCIBLE_DEFAULT_RETENTION");
  clearEnv("CRUCIBLE_RUN_ABANDON_MS");
  clearEnv("CRUCIBLE_PROJECT_INACTIVE_MS");
  return dir;
}

/** Render `[limits.<name>]` tables — the shape an operator edits. */
function toml(tables: Record<string, LimitDeclaration>): string {
  return Object.entries(tables)
    .map(
      ([name, d]) =>
        `[limits.${name}]\n` +
        `description = ${JSON.stringify(d.description)}\n` +
        `recommended = ${d.recommended}\n` +
        `min = ${d.min}\n` +
        `max = ${d.max}\n`,
    )
    .join("\n");
}

function writeConfig(dir: string, tables: Record<string, LimitDeclaration>): string {
  const file = path.join(dir, "crucible.toml");
  fs.writeFileSync(file, toml(tables));
  return file;
}

function writeRaw(dir: string, text: string): string {
  const file = path.join(dir, "crucible.toml");
  fs.writeFileSync(file, text);
  return file;
}

/**
 * The operator's declaration of ONE limit: the shipped documentation with the
 * value the operator chose substituted for `recommended`, and `min`/`max`
 * optionally re-stated. Everything a test configures goes through here, so no
 * test ever writes a bound the shipped table did not supply.
 */
function declare(
  shipped: LimitDeclaration,
  value: number,
  bounds?: { min?: number; max?: number },
): LimitDeclaration {
  return {
    description: shipped.description,
    recommended: value,
    min: bounds?.min ?? shipped.min,
    max: bounds?.max ?? shipped.max,
  };
}

const emptyTree: SuiteNode[] = [];

/**
 * A project whose agents never tombstone within the horizon a sweep is driven
 * to. `sweepOpenRuns` settles an open run as `agent died` BEFORE it ever
 * considers the abandon deadline (src/store.ts:3737-3742), so a run-abandon
 * test that let its agent tombstone would be measuring liveness and reporting
 * it as a deadline. The thresholds are derived from the horizon under test,
 * never pinned.
 */
function projectOutlivingHorizon(store: Store, horizonMs: number, name = "limits-subject"): string {
  const key = crypto.randomUUID();
  store.addProject({
    key,
    name,
    type: "backend",
    sutRoot: "/tmp/limits",
    liveness: {
      staleAfterMs: horizonMs * 4,
      tombstoneAfterMs: horizonMs * 8,
      pruneAfterMs: horizonMs * 16,
    },
  });
  return key;
}

interface QueryHandle {
  run(...args: unknown[]): void;
}
interface RawDb {
  query(sql: string): QueryHandle;
}

/** Backdate an event's timestamp column (tests/v2-projects-activity.test.ts's
 *  convention — Store stamps Date.now() with no override lever). */
function backdateEvent(store: Store, eventId: string, msAgo: number): void {
  (store as unknown as { db: RawDb }).db
    .query(`UPDATE events SET timestamp = ? WHERE id = ?`)
    .run(Date.now() - msAgo, eventId);
}

/** Backdate an agent's last_seen column (same convention). */
function backdateAgent(store: Store, projectKey: string, agentId: string, msAgo: number): void {
  (store as unknown as { db: RawDb }).db
    .query(`UPDATE agents SET last_seen = ? WHERE project_key = ? AND agent_id = ?`)
    .run(Date.now() - msAgo, projectKey, agentId);
}

/** A project whose only activity is `msAgo` old and whose only agent went
 *  silent at the same moment — so `active` is decided by the window alone. */
function projectLastActiveAgo(store: Store, msAgo: number, name: string): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name, type: "backend", sutRoot: "/tmp/inactive" });
  const ev = store.recordTestEvent(
    key,
    `${name}-ghost`,
    { summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 }, tree: emptyTree },
    { tier: "unit" },
  );
  backdateEvent(store, ev.id, msAgo);
  backdateAgent(store, key, `${name}-ghost`, msAgo);
  return key;
}

interface ProjectActivityRow {
  key: string;
  active: boolean;
}

type BootedServer = ReturnType<typeof startServer>;

async function activeFlags(handle: BootedServer): Promise<Map<string, boolean>> {
  const res = await fetch(`http://127.0.0.1:${handle.server.port}/api/v2/projects`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; projects: ProjectActivityRow[] };
  expect(body.ok).toBe(true);
  return new Map(body.projects.map((p) => [p.key, p.active]));
}

function boot(): BootedServer {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  openHandles.push(handle);
  return handle;
}

function ingest(store: Store, key: string, n: number): void {
  for (let i = 0; i < n; i++) {
    store.recordTestEvent(key, "limits-agent", {
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
      tree: emptyTree,
    });
  }
}

function eventCount(store: Store, key: string): number {
  return store.listEvents(key, Number.MAX_SAFE_INTEGER).length;
}

afterEach(() => {
  while (openHandles.length > 0) openHandles.pop()!.stop();
  while (envRestore.length > 0) {
    const [name, value] = envRestore.pop()!;
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  while (scratchDirs.length > 0) fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// §S1b — the schema is complete and self-describing
// ═══════════════════════════════════════════════════════════════════════════
//
// RED, all four: src/limits.ts does not exist, so there is no table to read.
// If GREEN shipped the loader but only some of the declarations, the
// completeness test names exactly which limit is undocumented.

describe("CR-CRU-131 §S1b — every server limit declares itself", () => {
  test("each limit is a [limits.<name>] table declaring description, recommended, min and max", async () => {
    const { shippedLimits } = await limits();
    const table = shippedLimits();

    const missing: string[] = [];
    for (const name of SERVER_LIMITS) {
      const declaration = table[name] as unknown as Record<string, unknown> | undefined;
      if (declaration === undefined) {
        missing.push(`${name}: no [limits.${name}] table at all`);
        continue;
      }
      for (const field of DECLARED_FIELDS) {
        if (!(field in declaration)) missing.push(`${name}.${field}`);
      }
    }
    expect(missing).toEqual([]);

    // Typed, not merely present: a `min` that is a string is a bound nothing
    // can enforce, and a `description` that is a number documents nothing.
    for (const name of SERVER_LIMITS) {
      const d = table[name]!;
      expect(typeof d.description, `${name}.description must be text`).toBe("string");
      for (const field of ["recommended", "min", "max"] as const) {
        expect(
          Number.isFinite(d[field]),
          `${name}.${field} must be a finite number, got ${String(d[field])}`,
        ).toBe(true);
      }
    }
  });

  test("the table declares EXACTLY the limits the server enforces — a seventh added without its documentation fails here", async () => {
    const { shippedLimits, SERVER_LIMIT_NAMES } = await limits();

    // Both directions. Undocumented-but-enforced is the defect this CR exists
    // to prevent; documented-but-unenforced is a bound nothing checks, which is
    // the OTHER defect it exists to prevent.
    expect([...SERVER_LIMIT_NAMES].sort()).toEqual([...SERVER_LIMITS].sort());
    expect(Object.keys(shippedLimits()).sort()).toEqual([...SERVER_LIMITS].sort());
  });

  test("each declared recommended lies inside that limit's own declared [min, max]", async () => {
    const { shippedLimits } = await limits();
    const table = shippedLimits();

    for (const name of SERVER_LIMITS) {
      const d = table[name]!;
      expect(d.min, `${name}: min must be below max, or the range admits nothing`).toBeLessThan(d.max);
      expect(
        d.recommended,
        `${name}: the shipped value must satisfy its own floor`,
      ).toBeGreaterThanOrEqual(d.min);
      expect(
        d.recommended,
        `${name}: the shipped value must satisfy its own ceiling`,
      ).toBeLessThanOrEqual(d.max);
    }
  });

  test("each description is a sentence, not a bare echo of the limit's own key", async () => {
    // The rule CR-CRU-128 §S3.2 established for flag help, reused rather than
    // re-invented: `--no-wait` described as "no wait" teaches nothing the
    // flag's own spelling did not, and `run_abandon_ms` described as "run
    // abandon ms" teaches nothing the key did not. Same squash, same verdict.
    const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");
    const { shippedLimits } = await limits();
    const table = shippedLimits();

    const empty: string[] = [];
    const echoes: string[] = [];
    for (const name of SERVER_LIMITS) {
      const description = String(table[name]?.description ?? "");
      if (description.trim() === "") empty.push(name);
      else if (squash(description) === squash(name)) echoes.push(`${name}: ${description}`);
    }
    expect(empty).toEqual([]);
    expect(echoes).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §S1 — each limit resolves FROM THE FILE, at the point of use
// ═══════════════════════════════════════════════════════════════════════════
//
// RED, all of them: nothing reads a file today. `runAbandonAfterMs()` falls
// back to `DEFAULT_RUN_ABANDON_MS` (src/store.ts:834), `projectInactiveMs()` to
// `DEFAULT_PROJECT_INACTIVE_MS` (src/v2.ts:362), and `defaultRetention()` to
// `undefined` — so a configured file changes nothing and every assertion below
// reads the compiled number instead of the configured one.

describe("CR-CRU-131 §S1 — run_abandon_ms resolves from the server's file", () => {
  test("the configured deadline decides when the sweep abandons an open run, and spares one that has not reached it", async () => {
    const dir = serverConfigDir();
    const shipped = (await limits()).shippedLimits().run_abandon_ms!;
    // The smallest deadline the declaration admits: legal by construction, and
    // far from the shipped recommendation, so a resolver that ignored the file
    // would land somewhere else.
    const deadline = shipped.min;
    writeConfig(dir, { run_abandon_ms: declare(shipped, deadline) });

    const store = Store.open(":memory:");
    const key = projectOutlivingHorizon(store, deadline);
    const run = store.startRun(key, "abandon-subject");

    // NEGATIVE — one millisecond short of the configured deadline settles
    // nothing. Without this, a sweep that abandoned everything would pass.
    expect(store.sweepOpenRuns(run.startedAt + deadline - 1)).toEqual([]);
    expect(store.listOpenRuns(key).map((r) => r.runId)).toEqual([run.runId]);

    // POSITIVE — at the configured deadline, aborted for exactly that reason.
    const aborted = store.sweepOpenRuns(run.startedAt + deadline);
    expect(aborted.map((e) => e.abortReason)).toEqual(["abandoned"]);
    expect(store.listOpenRuns(key)).toEqual([]);
  });

  test("EDITING the file moves the deadline on the NEXT sweep, with no restart — a cached table fails here", async () => {
    const dir = serverConfigDir();
    const shipped = (await limits()).shippedLimits().run_abandon_ms!;
    const tight = shipped.min;
    const loose = shipped.max;
    expect(loose, "the declaration must admit two distinguishable deadlines").toBeGreaterThan(tight);

    const store = Store.open(":memory:");

    // FIRST call's behaviour, asserted BEFORE the edit — so "it changed" below
    // is a claim about the edit and not about the fixture.
    writeConfig(dir, { run_abandon_ms: declare(shipped, tight) });
    const keyA = projectOutlivingHorizon(store, loose, "before-edit");
    const first = store.startRun(keyA, "before-edit-agent");
    expect(store.sweepOpenRuns(first.startedAt + tight).map((e) => e.abortReason)).toEqual([
      "abandoned",
    ]);

    // The operator edits the file. Nothing restarts; the same Store object,
    // the same process, the same module graph.
    writeConfig(dir, { run_abandon_ms: declare(shipped, loose) });

    const keyB = projectOutlivingHorizon(store, loose, "after-edit");
    const second = store.startRun(keyB, "after-edit-agent");

    // A loader that cached the table at import — `import cfg from
    // "./crucible.toml"`, measured to be stale after a rewrite — would still be
    // holding `tight` and would abandon this run. The whole no-restart contract
    // `runAbandonAfterMs()` already keeps is this one assertion.
    expect(store.sweepOpenRuns(second.startedAt + tight)).toEqual([]);
    expect(store.listOpenRuns(keyB).map((r) => r.runId)).toEqual([second.runId]);

    // …and the NEW deadline is genuinely in force, not merely "not the old one".
    expect(store.sweepOpenRuns(second.startedAt + loose).map((e) => e.abortReason)).toEqual([
      "abandoned",
    ]);
  });
});

describe("CR-CRU-131 §S1 — project_inactive_ms resolves from the server's file", () => {
  test("the configured window decides which projects read inactive on GET /api/v2/projects", async () => {
    const dir = serverConfigDir();
    const shipped = (await limits()).shippedLimits().project_inactive_ms!;
    const window = shipped.min;
    writeConfig(dir, { project_inactive_ms: declare(shipped, window) });

    const handle = boot();
    const fresh = projectLastActiveAgo(handle.store, Math.floor(window / 2), "within-window");
    const stale = projectLastActiveAgo(handle.store, window * 2, "beyond-window");

    const active = await activeFlags(handle);
    expect(active.get(fresh)).toBe(true);
    expect(active.get(stale)).toBe(false);
  });

  test("EDITING the file re-decides activity on the NEXT read, with no restart — a cached table fails here", async () => {
    const dir = serverConfigDir();
    const shipped = (await limits()).shippedLimits().project_inactive_ms!;
    const tight = shipped.min;
    const loose = shipped.max;
    const age = tight + Math.floor((loose - tight) / 2);
    expect(age, "the fixture's age must exceed the tight window").toBeGreaterThan(tight);
    expect(age, "…and sit inside the loose one").toBeLessThan(loose);

    writeConfig(dir, { project_inactive_ms: declare(shipped, tight) });
    const handle = boot();
    const key = projectLastActiveAgo(handle.store, age, "edit-subject");

    // FIRST read, before the edit.
    expect((await activeFlags(handle)).get(key)).toBe(false);

    // The operator widens the window. The SAME server keeps serving.
    writeConfig(dir, { project_inactive_ms: declare(shipped, loose) });

    expect((await activeFlags(handle)).get(key)).toBe(true);
  });
});

describe("CR-CRU-131 §S1 — retention's fleet fallback resolves from the server's file", () => {
  test("the configured fleet cap evicts telemetry down to itself for a project that declares none", async () => {
    const dir = serverConfigDir();
    const shipped = (await limits()).shippedLimits().retention!;
    const cap = shipped.min;
    expect(
      cap,
      "retention's floor must stay small enough that a behavioural eviction test is practical; " +
        "a floor in the tens of thousands is a floor nobody can observe",
    ).toBeLessThanOrEqual(10_000);
    writeConfig(dir, { retention: declare(shipped, cap) });

    const store = Store.open(":memory:");
    const key = crypto.randomUUID();
    // No per-project `retention` — the FLEET fallback is the subject.
    store.addProject({ key, name: "fleet-capped", type: "backend", sutRoot: "/tmp/r" });

    ingest(store, key, cap + 2);

    // POSITIVE, and bounded: exactly the configured cap survives — not "at
    // most", not "fewer than everything".
    expect(eventCount(store, key)).toBe(cap);
  });

  test("EDITING the file moves the fleet cap on the NEXT ingest, with no restart — a cached table fails here", async () => {
    const dir = serverConfigDir();
    const shipped = (await limits()).shippedLimits().retention!;
    const tight = shipped.min;
    const loose = tight + 5;
    expect(loose, "the declaration must admit a wider cap than its floor").toBeLessThanOrEqual(
      shipped.max,
    );
    expect(tight).toBeLessThanOrEqual(10_000);

    writeConfig(dir, { retention: declare(shipped, tight) });
    const store = Store.open(":memory:");
    const key = crypto.randomUUID();
    store.addProject({ key, name: "fleet-recapped", type: "backend", sutRoot: "/tmp/r2" });

    // FIRST cap, asserted before the edit.
    ingest(store, key, tight + 2);
    expect(eventCount(store, key)).toBe(tight);

    // The operator raises the fleet cap. Same Store, same process.
    writeConfig(dir, { retention: declare(shipped, loose) });

    ingest(store, key, 2);
    // Under a CACHED table the cap would still be `tight` and the count would
    // not have moved.
    expect(eventCount(store, key)).toBe(tight + 2);
  });

});

describe("CR-CRU-131 §S1 — each limit governs its OWN site and no other", () => {
  test("configuring run_abandon_ms does not move the project-inactive verdict — one setting is not wired to another's site", async () => {
    const dir = serverConfigDir();
    const mod = await limits();
    const abandon = mod.shippedLimits().run_abandon_ms!;
    const inactive = mod.shippedLimits().project_inactive_ms!;
    const window = inactive.min;
    const age = window * 2;

    writeConfig(dir, {
      project_inactive_ms: declare(inactive, window),
      run_abandon_ms: declare(abandon, abandon.min),
    });
    const handle = boot();
    const key = projectLastActiveAgo(handle.store, age, "independence-subject");
    expect((await activeFlags(handle)).get(key)).toBe(false);

    // Move the run-abandon deadline to the other end of its range and change
    // NOTHING else. The inactive verdict must not notice.
    writeConfig(dir, {
      project_inactive_ms: declare(inactive, window),
      run_abandon_ms: declare(abandon, abandon.max),
    });
    expect((await activeFlags(handle)).get(key)).toBe(false);

    // CONTROL — the verdict is movable at all, by its OWN setting. Without
    // this, a read that always answered `false` would satisfy the pair above.
    expect(age, "the fixture must sit inside the widened window").toBeLessThan(inactive.max);
    writeConfig(dir, {
      project_inactive_ms: declare(inactive, inactive.max),
      run_abandon_ms: declare(abandon, abandon.max),
    });
    expect((await activeFlags(handle)).get(key)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §S1 — an UNCONFIGURED limit resolves to its SHIPPED DEFAULT, not to unbounded
// ═══════════════════════════════════════════════════════════════════════════
//
// Observed as BEHAVIOUR, never as a value read back: the expectation is
// derived from the shipped declaration, and what is asserted is what the server
// DOES at that boundary.

describe("CR-CRU-131 §S1 — with nothing configured, a limit runs at its shipped recommendation", () => {
  test("run_abandon_ms: the sweep abandons at the shipped recommendation and not before — an unconfigured deadline is not infinite", async () => {
    serverConfigDir(); // no crucible.toml written at all
    const shipped = (await limits()).shippedLimits().run_abandon_ms!;

    const store = Store.open(":memory:");
    const key = projectOutlivingHorizon(store, shipped.recommended);
    const run = store.startRun(key, "unconfigured-subject");

    expect(store.sweepOpenRuns(run.startedAt + shipped.recommended - 1)).toEqual([]);
    expect(
      store.sweepOpenRuns(run.startedAt + shipped.recommended).map((e) => e.abortReason),
    ).toEqual(["abandoned"]);
  });

  test("project_inactive_ms: activity is judged against the shipped recommendation when nothing is configured", async () => {
    serverConfigDir();
    const shipped = (await limits()).shippedLimits().project_inactive_ms!;

    const handle = boot();
    const fresh = projectLastActiveAgo(
      handle.store,
      Math.floor(shipped.recommended / 2),
      "unconfigured-fresh",
    );
    const stale = projectLastActiveAgo(handle.store, shipped.recommended * 2, "unconfigured-stale");

    const active = await activeFlags(handle);
    expect(active.get(fresh)).toBe(true);
    expect(active.get(stale)).toBe(false);
  });

  test("retention is the documented exception: nothing configured means NO cap, and the boot disclosure still names the uncapped project", async () => {
    // GREEN-GUARD on CR-CRU-129's shipped semantics, which this CR moves the
    // HOME of and must not change: keeping more events costs disk, so unbounded
    // is the honest answer when an operator has configured nothing — and the
    // server says so at boot rather than growing quietly (PRD §4.7/§4.13).
    // Passes today; it is the bound on everything above it, because a loader
    // that gave retention a shipped cap the way the other two get one would
    // silently start evicting on every board that has no file.
    serverConfigDir();

    const store = Store.open(":memory:");
    const key = crypto.randomUUID();
    store.addProject({ key, name: "Uncapped Project", type: "backend", sutRoot: "/tmp/u" });

    ingest(store, key, 12);
    expect(eventCount(store, key)).toBe(12);

    const disclosure = retentionDisclosure(store);
    expect(disclosure, "an unbounded board must disclose it at boot").not.toBeNull();
    expect(disclosure).toContain("Uncapped Project");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §S1b — the RANGE is enforced, from the same table that documents it
// ═══════════════════════════════════════════════════════════════════════════

function refusalFor(disclosures: readonly string[], name: string): string | undefined {
  return disclosures.find((line) => line.includes(name));
}

/** min-1 refused · min accepted · max accepted · max+1 refused, for one limit. */
async function assertBothEndsOfBothBounds(name: string): Promise<void> {
  const dir = serverConfigDir();
  const mod = await limits();
  const shipped = mod.shippedLimits()[name]!;

  for (const legal of [shipped.min, shipped.max]) {
    writeConfig(dir, { [name]: declare(shipped, legal) });
    expect(
      mod.resolveLimit(name),
      `${name}: ${legal} is inside its own range and must resolve`,
    ).toBe(legal);
    expect(
      refusalFor(mod.limitDisclosures(), name),
      `${name}: ${legal} is legal — nothing may be disclosed about it`,
    ).toBeUndefined();
  }

  for (const illegal of [shipped.min - 1, shipped.max + 1]) {
    writeConfig(dir, { [name]: declare(shipped, illegal) });

    // REFUSED, not clamped to the bound it crossed.
    const resolved = mod.resolveLimit(name);
    expect(resolved, `${name}: ${illegal} must be refused, not used`).not.toBe(illegal);
    expect(resolved, `${name}: a refusal must not silently clamp to the bound`).not.toBe(
      illegal < shipped.min ? shipped.min : shipped.max,
    );
    expect(resolved, `${name}: a refusal falls back to the documented recommendation`).toBe(
      shipped.recommended,
    );

    // …and the refusal SAYS all four things §S1b requires of it.
    const message = refusalFor(mod.limitDisclosures(), name);
    expect(message, `${name}: ${illegal} was refused in silence`).toBeDefined();
    expect(message).toContain(String(illegal));
    expect(message).toContain(String(shipped.min));
    expect(message).toContain(String(shipped.max));
    expect(message).toContain(String(shipped.recommended));
  }
}

describe("CR-CRU-131 §S1b — a value outside [min, max] is REFUSED at resolution", () => {
  test("run_abandon_ms: below min and above max are both refused; min and max themselves resolve", async () => {
    await assertBothEndsOfBothBounds("run_abandon_ms");
  });

  test("project_inactive_ms: below min and above max are both refused; min and max themselves resolve", async () => {
    await assertBothEndsOfBothBounds("project_inactive_ms");
  });

  test("retention: below min and above max are both refused; min and max themselves resolve", async () => {
    await assertBothEndsOfBothBounds("retention");
  });

  test("a refused run_abandon_ms leaves the SWEEP running at the recommendation, not at the bound it crossed", async () => {
    // The not-clamped claim, proved by what the server DOES rather than by what
    // a resolver returns. A clamp to `min` and a fallback to `recommended` are
    // distinguishable only here, at a horizon between the two.
    const dir = serverConfigDir();
    const mod = await limits();
    const shipped = mod.shippedLimits().run_abandon_ms!;
    expect(shipped.min, "a clamp and the fallback must be distinguishable").toBeLessThan(
      shipped.recommended,
    );
    writeConfig(dir, { run_abandon_ms: declare(shipped, shipped.min - 1) });

    const store = Store.open(":memory:");
    const key = projectOutlivingHorizon(store, shipped.recommended);
    const run = store.startRun(key, "refused-subject");

    // A clamp to `min` would have abandoned this run. The documented fallback
    // does not.
    expect(store.sweepOpenRuns(run.startedAt + shipped.min)).toEqual([]);
    // …and the fallback really is the recommendation.
    expect(
      store.sweepOpenRuns(run.startedAt + shipped.recommended).map((e) => e.abortReason),
    ).toEqual(["abandoned"]);
    // …and the operator was told, rather than left to wonder.
    expect(refusalFor(mod.limitDisclosures(), "run_abandon_ms")).toBeDefined();
  });

  test("a refused retention leaves the fleet cap at the recommendation, not clamped to the floor", async () => {
    const dir = serverConfigDir();
    const mod = await limits();
    const shipped = mod.shippedLimits().retention!;
    expect(shipped.min).toBeLessThan(shipped.recommended);
    expect(shipped.min).toBeLessThanOrEqual(10_000);
    writeConfig(dir, { retention: declare(shipped, shipped.min - 1) });

    const store = Store.open(":memory:");
    const key = crypto.randomUUID();
    store.addProject({ key, name: "refused-cap", type: "backend", sutRoot: "/tmp/rc" });

    ingest(store, key, shipped.min + 2);
    // Clamped to the floor, this would read `shipped.min`. Falling back to the
    // recommendation — which is larger — nothing is evicted yet.
    expect(eventCount(store, key)).toBe(shipped.min + 2);
    expect(refusalFor(mod.limitDisclosures(), "retention")).toBeDefined();
  });

  test("WIDENING max in the file makes a previously-refused value resolve — the file is the source, not a second copy", async () => {
    const dir = serverConfigDir();
    const mod = await limits();
    const shipped = mod.shippedLimits().run_abandon_ms!;
    const value = shipped.min;
    expect(value, "the chosen value must be distinguishable from the fallback").toBeLessThan(
      shipped.recommended,
    );

    // The operator declares a legal VALUE but a ceiling below it. Refused.
    writeConfig(dir, { run_abandon_ms: declare(shipped, value, { max: value - 1 }) });
    expect(mod.resolveLimit("run_abandon_ms")).toBe(shipped.recommended);
    expect(refusalFor(mod.limitDisclosures(), "run_abandon_ms")).toBeDefined();

    const store = Store.open(":memory:");
    const keyBefore = projectOutlivingHorizon(store, shipped.recommended, "before-widening");
    const before = store.startRun(keyBefore, "before-widening-agent");
    expect(store.sweepOpenRuns(before.startedAt + value)).toEqual([]);

    // ONE field changes: `max`. The value the operator asked for is untouched.
    writeConfig(dir, { run_abandon_ms: declare(shipped, value, { max: shipped.max }) });

    expect(mod.resolveLimit("run_abandon_ms")).toBe(value);
    expect(refusalFor(mod.limitDisclosures(), "run_abandon_ms")).toBeUndefined();

    const keyAfter = projectOutlivingHorizon(store, shipped.recommended, "after-widening");
    const after = store.startRun(keyAfter, "after-widening-agent");
    expect(store.sweepOpenRuns(after.startedAt + value).map((e) => e.abortReason)).toEqual([
      "abandoned",
    ]);
  });

  test("NARROWING max in the file makes a previously-accepted value refuse — the enforced bound and the documented bound are one datum", async () => {
    const dir = serverConfigDir();
    const mod = await limits();
    const shipped = mod.shippedLimits().run_abandon_ms!;
    const value = shipped.min;
    expect(value).toBeLessThan(shipped.recommended);

    writeConfig(dir, { run_abandon_ms: declare(shipped, value) });
    expect(mod.resolveLimit("run_abandon_ms")).toBe(value);

    const store = Store.open(":memory:");
    const keyBefore = projectOutlivingHorizon(store, shipped.recommended, "before-narrowing");
    const before = store.startRun(keyBefore, "before-narrowing-agent");
    expect(store.sweepOpenRuns(before.startedAt + value).map((e) => e.abortReason)).toEqual([
      "abandoned",
    ]);

    // ONE field changes: `max` drops below the value already in the file.
    writeConfig(dir, { run_abandon_ms: declare(shipped, value, { max: value - 1 }) });

    expect(mod.resolveLimit("run_abandon_ms")).toBe(shipped.recommended);
    expect(refusalFor(mod.limitDisclosures(), "run_abandon_ms")).toBeDefined();

    const keyAfter = projectOutlivingHorizon(store, shipped.recommended, "after-narrowing");
    const after = store.startRun(keyAfter, "after-narrowing-agent");
    expect(store.sweepOpenRuns(after.startedAt + value)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §S1b — OWNERSHIP: the server reads its OWN file and nobody else's
// ═══════════════════════════════════════════════════════════════════════════

describe("CR-CRU-131 §S1b — a limit is owned by the process that enforces it", () => {
  test("the server's crucible.toml sits beside its database, resolved by the same rule", async () => {
    const dir = serverConfigDir();
    const { serverConfigPath } = await limits();
    expect(serverConfigPath()).toBe(path.join(dir, "crucible.toml"));
  });

  test("a SERVER limit configured in the PROJECT's file has no effect on the server", async () => {
    const serverDir = serverConfigDir();
    const projectDir = scratch("crucible-project-dir-");
    fs.writeFileSync(path.join(projectDir, ".env"), `CRUCIBLE_PROJECT_KEY=${crypto.randomUUID()}\n`);

    const mod = await limits();
    const shipped = mod.shippedLimits().run_abandon_ms!;
    const value = shipped.min;
    expect(value).toBeLessThan(shipped.recommended);

    // It really IS set — in the wrong file. Parsed back from disk, so this is a
    // fact about the file and not about the string the test just wrote.
    const wrongFile = writeConfig(projectDir, { run_abandon_ms: declare(shipped, value) });
    const parsed = Bun.TOML.parse(fs.readFileSync(wrongFile, "utf8")) as {
      limits: Record<string, LimitDeclaration>;
    };
    expect(parsed.limits.run_abandon_ms!.recommended).toBe(value);

    // …and the server does not see it: it runs at the shipped recommendation.
    expect(mod.resolveLimit("run_abandon_ms")).toBe(shipped.recommended);

    const store = Store.open(":memory:");
    const key = projectOutlivingHorizon(store, shipped.recommended, "wrong-file");
    const run = store.startRun(key, "wrong-file-agent");
    expect(store.sweepOpenRuns(run.startedAt + value)).toEqual([]);

    // POSITIVE CONTROL — the SAME declaration, in the server's own file, DOES
    // move the deadline. Without this the assertions above would pass against a
    // loader that read nothing at all.
    fs.copyFileSync(wrongFile, path.join(serverDir, "crucible.toml"));
    expect(mod.resolveLimit("run_abandon_ms")).toBe(value);

    const key2 = projectOutlivingHorizon(store, shipped.recommended, "right-file");
    const run2 = store.startRun(key2, "right-file-agent");
    expect(store.sweepOpenRuns(run2.startedAt + value).map((e) => e.abortReason)).toEqual([
      "abandoned",
    ]);
  });

  test("a CLIENT limit written into the SERVER's file is still not a limit the server resolves", async () => {
    const dir = serverConfigDir();
    const mod = await limits();
    const shipped = mod.shippedLimits().run_abandon_ms!;

    // A display width, in the server's own configuration. The server has no
    // business dictating one to a machine it cannot see.
    const file = writeConfig(dir, {
      run_abandon_ms: declare(shipped, shipped.min),
      truncate_field_chars: {
        description: "Visible characters of a text field before the size hint.",
        recommended: 40,
        min: 1,
        max: 4000,
      },
    });
    const parsed = Bun.TOML.parse(fs.readFileSync(file, "utf8")) as {
      limits: Record<string, LimitDeclaration>;
    };
    expect(parsed.limits.truncate_field_chars!.recommended).toBe(40);

    for (const clientLimit of CLIENT_LIMITS) {
      expect([...mod.SERVER_LIMIT_NAMES]).not.toContain(clientLimit);
      expect(
        () => mod.resolveLimit(clientLimit),
        `${clientLimit} is enforced by a CLIENT; the server must refuse to answer for it ` +
          `rather than silently resolving a limit it does not own`,
      ).toThrow();
    }

    // …and the foreign table does not disturb the limits the server DOES own.
    expect(mod.resolveLimit("run_abandon_ms")).toBe(shipped.min);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §S1b — degradation: an unreadable file is disclosed, never fatal
// ═══════════════════════════════════════════════════════════════════════════
//
// With the environment layer retired there is nothing beneath the file, so
// `recommended` has to be reachable WITHOUT the file being valid — the loader
// carries the shipped table as its last resort and says so, in the shape
// CR-CRU-129's boot disclosure established (src/server.ts:311).

describe("CR-CRU-131 §S1b — a malformed or absent crucible.toml degrades and discloses", () => {
  test("a file with a syntax error does not crash the server: every limit runs at its recommendation", async () => {
    const dir = serverConfigDir();
    const file = writeRaw(dir, "[limits.run_abandon_ms\nrecommended = = 5\n");
    const mod = await limits();

    expect(mod.resolveLimit("run_abandon_ms")).toBe(mod.shippedLimits().run_abandon_ms!.recommended);
    expect(mod.resolveLimit("project_inactive_ms")).toBe(
      mod.shippedLimits().project_inactive_ms!.recommended,
    );

    // The disclosure names WHICH file it could not read — an operator told only
    // that "a config file is broken", on a machine carrying two of them, learns
    // nothing.
    expect(mod.limitDisclosures().join("\n")).toContain(file);
  });

  test("a malformed file leaves the sweep running at the shipped recommendation, observed on the sweep itself", async () => {
    const dir = serverConfigDir();
    writeRaw(dir, "this is not TOML at all ][\n");
    const shipped = (await limits()).shippedLimits().run_abandon_ms!;

    const store = Store.open(":memory:");
    const key = projectOutlivingHorizon(store, shipped.recommended, "malformed");
    const run = store.startRun(key, "malformed-agent");

    expect(store.sweepOpenRuns(run.startedAt + shipped.recommended - 1)).toEqual([]);
    expect(
      store.sweepOpenRuns(run.startedAt + shipped.recommended).map((e) => e.abortReason),
    ).toEqual(["abandoned"]);
  });

  test("an absent file is disclosed by PATH too, and every limit still resolves", async () => {
    const dir = serverConfigDir(); // nothing written
    const mod = await limits();
    const expected = path.join(dir, "crucible.toml");
    expect(fs.existsSync(expected)).toBe(false);

    for (const name of ["run_abandon_ms", "project_inactive_ms"] as const) {
      expect(mod.resolveLimit(name)).toBe(mod.shippedLimits()[name]!.recommended);
    }
    expect(mod.limitDisclosures().join("\n")).toContain(expected);
  });
});
