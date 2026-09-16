// Shared SERVER-LIMITS fixture: a scratch `crucible.toml` beside a scratch
// database path, the `[limits.<name>]` table shapes an operator actually
// writes, and the store/server fixtures that observe a limit AT ITS
// ENFORCEMENT SITE rather than by reading a resolver's return value.
//
// LIFTED, not re-derived — the standing rule this directory already states in
// tests/helpers/source-scan.ts's own header (CR-CRU-097 §S6). Everything below
// was file-local to tests/server-limits-are-configuration.test.ts, which
// proved it in CR-CRU-131 C1. C2 retires the environment-variable layer, so
// the six suites that used to drive a limit through `$CRUCIBLE_DEFAULT_RETENTION`,
// `$CRUCIBLE_RUN_ABANDON_MS` or `$CRUCIBLE_PROJECT_INACTIVE_MS` must configure
// it through the FILE instead. SEVEN files needing the same temp
// `crucible.toml` is precisely where a second hand-rolled copy gets written,
// and a fixture that disagreed with C1's about what an operator's file looks
// like would make the migrated suites prove something the shipped schema does
// not say.
//
// Behaviour is unchanged by the lift: the bodies and their derivation comments
// moved verbatim. `ingest` additionally RETURNS the ids it wrote, which its
// existing callers ignore — the retirement's eviction proofs need to say WHICH
// rows survived, not merely how many.
//
// ── Safety ─────────────────────────────────────────────────────────────────
//
// Every directory is a fresh OS tmpdir (tests/boot-safety.test.ts's
// convention), NEVER inside the repo. `CRUCIBLE_DB` is set only so the config
// path RESOLVES beside it (`serverConfigPath()` in src/limits.ts ->
// `resolveStore()` in src/server.ts:65) — no database at that path is ever
// opened or created, every Store a caller opens is ":memory:", and the live
// `data/crucible.db` is never touched.
import { expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../../src/store.ts";
import { startServer } from "../../src/server.ts";
import type { SuiteNode } from "../../src/types.ts";

/**
 * §S1b — one limit as an operator meets it: four fields of DOCUMENTATION and,
 * only where they have set one, their own `value`.
 *
 * `value` is deliberately not one of the four: it is the operator's setting,
 * optional, and absent from every shipped declaration.
 */
export interface LimitDeclaration {
  description: string;
  recommended: number;
  min: number;
  max: number;
  /** The OPERATOR's own setting. Absent on every shipped declaration. */
  value?: number;
}

/**
 * The environment variables CR-CRU-131 RETIRES as limit overrides — the
 * vocabulary of the retirement, declared ONCE so the fixture that clears them
 * and the scan that forbids them cannot drift into two lists. A fourth
 * retirement extends this array by one line and both consumers follow.
 *
 * All three were live overrides on release/0.2.0 before C2: src/store.ts:747
 * (`defaultRetention`), src/store.ts:843 (`runAbandonAfterMs`) and
 * src/v2.ts:371 (`projectInactiveMs`). Each read a number out of the process
 * environment ahead of the file — a limit with no `description`, no
 * `recommended`, no `min` and no `max`, which is the exact condition PRD §4.13
 * exists to end.
 */
export const RETIRED_LIMIT_ENV: readonly string[] = [
  "CRUCIBLE_DEFAULT_RETENTION",
  "CRUCIBLE_RUN_ABANDON_MS",
  "CRUCIBLE_PROJECT_INACTIVE_MS",
];

/**
 * The `CRUCIBLE_*` variables that are NOT limits and are EXPLICITLY OUT OF
 * SCOPE of the retirement (CR-CRU-131 Context; PRD §4.13).
 *
 * They answer *where am I* and *who am I* — the store to open and the project
 * a client belongs to — and they must be answerable BEFORE any file can be
 * found, because finding the file is what they decide.
 * A limit is the opposite: it carries a description, a recommendation and a
 * supportable range, and it is only ever needed once the process is already
 * running against a known store. That is the whole distinction, and it is why
 * a scan for retired names must exclude these BY NAME rather than by prefix.
 *
 * `CRUCIBLE_PORT` was a third entry here until CR-CRU-139 §S4, and it never
 * belonged: the listener is not asked BEFORE a file can be found, it is asked
 * after — by a process that has already opened the file `$CRUCIBLE_DB`
 * located. It was a connection setting listed among the bootstrap ones, which
 * is what kept the RUNBOOK documenting a knob `src/server.ts` had stopped
 * reading; `RETIRED_CONNECTION_ENV` below is where it lives now.
 */
export const BOOTSTRAP_ENV: readonly string[] = [
  "CRUCIBLE_DB",
  "CRUCIBLE_PROJECT_KEY",
];

/**
 * The environment variables the CONNECTION retirement removes — the server's
 * listener and the clients' board, which are declared in a `crucible.toml`
 * now and read from the environment nowhere.
 *
 * A SECOND list beside `RETIRED_LIMIT_ENV` rather than four more entries in
 * it, because the two retirements differ in a way a shared list would erase:
 *
 *   A retired LIMIT variable must VANISH from the shipped tree. A retired
 *   CONNECTION variable's retirement is RECORDED in the shipped tree.
 *
 * `RETIRED_LIMIT_ENV` drives a scan of `src/`, `clients/` and `public/` that
 * fails on ANY occurrence of a name, prose included
 * (tests/limits-have-no-environment-layer.test.ts) — a limit variable's whole
 * defect was that it was a second way to set a number, so naming it at all
 * teaches a mechanism that must not exist. The connection retirement is the
 * opposite: the code that stopped reading these SAYS SO where it used to read
 * them (`src/server.ts:158`, `:368`; `clients/_crucible_axi.py:127`, `:298`,
 * `:440`, `:441`), because a reader who arrives at the resolver holding an
 * export in their hand has to be told why it does nothing. Feeding these four
 * to that scan would convict CR-CRU-139's own lineage prose and leave GREEN a
 * choice between weakening the scan and deleting the explanation.
 *
 * So this list is consumed by the DOCUMENTATION guards — the RUNBOOK must
 * record each of these as retired and must present none of them as live
 * configuration — and never by the shipped-tree scan.
 */
export const RETIRED_CONNECTION_ENV: readonly string[] = [
  "CRUCIBLE_PORT",
  "CRUCIBLE_HOST",
  "CRUCIBLE_URL",
  "CRUCIBLE_BASE",
];

// ── Fixture plumbing ───────────────────────────────────────────────────────

const scratchDirs: string[] = [];
const envRestore: Array<[string, string | undefined]> = [];
const openHandles: Array<{ stop(): void }> = [];

export function scratch(prefix: string): string {
  // NEVER inside the repo (tests/boot-safety.test.ts's convention).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

export function setEnv(name: string, value: string): void {
  envRestore.push([name, process.env[name]]);
  process.env[name] = value;
}

export function clearEnv(name: string): void {
  envRestore.push([name, process.env[name]]);
  delete process.env[name];
}

/**
 * A scratch directory standing in for the server's own configuration
 * directory, pointed at by the SAME rule that resolves the database path
 * (`CRUCIBLE_DB`, src/server.ts:65). No database is opened there — every Store
 * in every caller is ":memory:"; only the config PATH is resolved from it.
 *
 * Every RETIRED variable is cleared, so nothing a caller asserts can pass on a
 * value the file did not supply — including one inherited from the shell that
 * launched the suite. That is not theoretical: this project's own board runs
 * with `CRUCIBLE_DEFAULT_RETENTION` set in its process environment, so a suite
 * launched from the same shell would inherit a cap nobody wrote down.
 */
export function serverConfigDir(): string {
  const dir = scratch("crucible-server-limits-");
  setEnv("CRUCIBLE_DB", path.join(dir, "crucible.db"));
  for (const name of RETIRED_LIMIT_ENV) clearEnv(name);
  return dir;
}

/** Render `[limits.<name>]` tables — the shape an operator meets: four fields
 *  of documentation, and their own `value` only where they set one. */
export function toml(tables: Record<string, LimitDeclaration>): string {
  return Object.entries(tables)
    .map(
      ([name, d]) =>
        `[limits.${name}]\n` +
        `description = ${JSON.stringify(d.description)}\n` +
        `recommended = ${d.recommended}\n` +
        `min = ${d.min}\n` +
        `max = ${d.max}\n` +
        (d.value === undefined ? "" : `value = ${d.value}\n`),
    )
    .join("\n");
}

export function writeConfig(dir: string, tables: Record<string, LimitDeclaration>): string {
  const file = path.join(dir, "crucible.toml");
  fs.writeFileSync(file, toml(tables));
  return file;
}

export function writeRaw(dir: string, text: string): string {
  const file = path.join(dir, "crucible.toml");
  fs.writeFileSync(file, text);
  return file;
}

/**
 * The same limit as the operator finds it BEFORE touching anything: four
 * fields of documentation and no `value` at all. This is what an installed,
 * unedited `crucible.toml` holds, and a limit must resolve to `recommended`
 * from it.
 *
 * `min`/`max` may be re-stated so a caller can move the bound a value is
 * judged against. Two kinds of caller need that, and both are legitimate
 * operator files: the widen/narrow proofs, which are ABOUT the bound; and the
 * migrated wall-clock suites, whose fixtures must settle a run in
 * milliseconds, far beneath a floor chosen for a real fleet. The loader reads
 * `min`/`max` off the very table the operator edits (§S1b), so a re-stated
 * bound is configuration, not a bypass.
 */
export function documentOnly(
  shipped: LimitDeclaration,
  bounds?: { min?: number; max?: number },
): LimitDeclaration {
  return {
    description: shipped.description,
    recommended: shipped.recommended,
    min: bounds?.min ?? shipped.min,
    max: bounds?.max ?? shipped.max,
  };
}

/**
 * The operator's file for ONE limit they HAVE set: the shipped documentation
 * carried through VERBATIM — `description` and `recommended` untouched — plus
 * their own `value` beside it.
 *
 * `recommended` is never overwritten here, and that is deliberate: this helper
 * is the only way a test configures anything, so no test CAN accidentally
 * express the in-place edit the schema exists to prevent.
 */
export function declare(
  shipped: LimitDeclaration,
  value: number,
  bounds?: { min?: number; max?: number },
): LimitDeclaration {
  return { ...documentOnly(shipped, bounds), value };
}

// ── Observing a limit at its enforcement site ──────────────────────────────

const emptyTree: SuiteNode[] = [];

/**
 * A project whose agents never tombstone within the horizon a sweep is driven
 * to. `sweepOpenRuns` settles an open run as `agent died` BEFORE it ever
 * considers the abandon deadline (src/store.ts:3737-3742), so a run-abandon
 * test that let its agent tombstone would be measuring liveness and reporting
 * it as a deadline. The thresholds are derived from the horizon under test,
 * never pinned.
 */
export function projectOutlivingHorizon(
  store: Store,
  horizonMs: number,
  name = "limits-subject",
): string {
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
export function backdateEvent(store: Store, eventId: string, msAgo: number): void {
  (store as unknown as { db: RawDb }).db
    .query(`UPDATE events SET timestamp = ? WHERE id = ?`)
    .run(Date.now() - msAgo, eventId);
}

/** Backdate an agent's last_seen column (same convention). */
export function backdateAgent(
  store: Store,
  projectKey: string,
  agentId: string,
  msAgo: number,
): void {
  (store as unknown as { db: RawDb }).db
    .query(`UPDATE agents SET last_seen = ? WHERE project_key = ? AND agent_id = ?`)
    .run(Date.now() - msAgo, projectKey, agentId);
}

/** A project whose only activity is `msAgo` old and whose only agent went
 *  silent at the same moment — so `active` is decided by the window alone. */
export function projectLastActiveAgo(store: Store, msAgo: number, name: string): string {
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

export type BootedServer = ReturnType<typeof startServer>;

/** The `active` verdict per project, read off the REAL route the dashboard
 *  reads (`GET /api/v2/projects`) rather than off the resolver. */
export async function activeFlags(handle: BootedServer): Promise<Map<string, boolean>> {
  const res = await fetch(`http://127.0.0.1:${handle.server.port}/api/v2/projects`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; projects: ProjectActivityRow[] };
  expect(body.ok).toBe(true);
  return new Map(body.projects.map((p) => [p.key, p.active]));
}

export function boot(): BootedServer {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  openHandles.push(handle);
  return handle;
}

/** A project with no `retention` of its own, so the fleet cap is what decides
 *  what it keeps. */
export function seedProject(store: Store, name: string): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name, type: "backend", sutRoot: "/tmp/limits" });
  return key;
}

/** `n` telemetry events, oldest first; returns the ids in the order written. */
export function ingest(store: Store, key: string, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      store.recordTestEvent(key, "limits-agent", {
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
        tree: emptyTree,
      }).id,
    );
  }
  return ids;
}

export function eventCount(store: Store, key: string): number {
  return store.listEvents(key, Number.MAX_SAFE_INTEGER).length;
}

/** The ids retention LEFT BEHIND, oldest first — the same order `ingest`
 *  returns, so the two are directly comparable and a proof can say WHICH rows
 *  survived instead of only how many. */
export function survivingIds(store: Store, key: string): string[] {
  return store
    .listEvents(key, Number.MAX_SAFE_INTEGER)
    .map((e) => e.id)
    .reverse();
}

/**
 * Undo everything the fixture touched: every booted server stopped, every
 * environment variable back to the value it held (including "absent"), every
 * scratch directory removed. Call it from each suite's `afterEach`.
 *
 * Servers first, because a running server holds the store a later assertion
 * might otherwise still be reading; environment restored in REVERSE order, so
 * a variable set twice inside one test lands back on the value it had before
 * the FIRST set rather than on the intermediate one.
 */
export function restoreServerLimitsFixture(): void {
  while (openHandles.length > 0) openHandles.pop()!.stop();
  while (envRestore.length > 0) {
    const [name, value] = envRestore.pop()!;
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  while (scratchDirs.length > 0) fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
}
