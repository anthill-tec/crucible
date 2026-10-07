// RED — the server's analytics cache (velocity, burndown, forecast and the
// plan-change counts), and its invalidation.
//
// Spec locked §S2: "The server caches the analytics answers (velocity,
// burndown, forecast, and the plan-change counts) until the store changes in
// a way that can move them, so even a misbehaving page cannot pin the server
// with repeated analytics reads." AC (asserted on the server): a second
// analytics read with no intervening store change is answered from the
// cache; a change that can move the figures invalidates it.
//
// Invalidation rule this file pins: an analytics answer is cached per
// (project key, route, release — for the three routes that take one) until
// an `events`-kind `Store` change (`Store`'s `ChangeKind`, from
// `Store.onChange`) fires for THAT project. An `agents`-kind change (a
// heartbeat / registration touch) never invalidates it, and an `events`-kind
// change in a DIFFERENT project never invalidates THIS project's cache.
//
// Baseline (measured against current src/v2.ts / src/analytics.ts): none of
// the four analytics handlers (the `analytics` segment dispatched inside
// `handleV2`) consult any cache — each calls `store.listQueue` directly,
// unconditionally, exactly once per request, with no memo layer in front of
// it. A second identical read therefore costs a second real `listQueue`
// call exactly like the first, so every "no additional computation after
// the first read" assertion below is expected to FAIL against production:
// the spy's call count for the project keeps climbing on every single read,
// cached or not.
//
// Proof technique (never timing): `listQueue` is the one store method every
// one of the four analytics handlers calls directly — `entries:
// store.listQueue(key)` inside each of them — so spying on it and counting
// calls BY PROJECT KEY (`call[0] === key`) is an exact proxy for "did this
// project's analytics recompute," immune to another project's traffic
// interleaved through the very same spy.
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import type { ChangeRecord } from "../src/types.ts";

/** Narrow a store op's `T | { error: string }` union, loudly. */
function planned<T extends object>(result: T): Exclude<T, { error: string }> {
  if ("error" in result) throw new Error(`plan op refused: ${String((result as { error: string }).error)}`);
  return result as Exclude<T, { error: string }>;
}

function record(reason: string, cause: "spec-design" | "gap-analysis"): ChangeRecord {
  return { reason, cause, specRef: `ref-${reason}` };
}

const scratchDirs: string[] = [];
let handle: ServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

function boot(): ServerHandle {
  const dir = mkdtempSync(join(tmpdir(), "analytics-cache-"));
  scratchDirs.push(dir);
  handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
  return handle;
}

function base(): string {
  return `http://localhost:${handle!.server.port}`;
}

interface ChangesBody {
  ok?: boolean;
  release?: string;
  changes?: { "spec-design"?: number; "gap-analysis"?: number; unrecorded?: number };
  [key: string]: unknown;
}

async function getJson(path: string): Promise<{ status: number; body: ChangesBody }> {
  const res = await fetch(`${base()}${path}`);
  let body: ChangesBody = {};
  try {
    body = (await res.json()) as ChangesBody;
  } catch {
    // No JSON body on some failure shapes — fail on the FIELDS below, never
    // on a JSON.parse throw.
  }
  return { status: res.status, body };
}

/** The four analytics routes §S2 names, for one project/release. */
function routesFor(key: string, release: string): Array<{ name: string; path: string }> {
  return [
    { name: "velocity", path: `/api/v2/projects/${key}/analytics/velocity?release=${encodeURIComponent(release)}` },
    {
      name: "burndown",
      path: `/api/v2/projects/${key}/analytics/burndown?release=${encodeURIComponent(release)}`,
    },
    {
      // The UNSEEDED forecast — the only forecast answer the cache holds (a
      // seeded read is the test-only deterministic draw, computed per read).
      name: "forecast",
      path: `/api/v2/projects/${key}/analytics/forecast?release=${encodeURIComponent(release)}`,
    },
    {
      name: "changes",
      path: `/api/v2/projects/${key}/analytics/changes?release=${encodeURIComponent(release)}`,
    },
  ];
}

function callsFor(spy: ReturnType<typeof spyOn>, key: string): number {
  return (spy.mock.calls as unknown[][]).filter((call) => call[0] === key).length;
}

/** A project holding one pointed, release-scoped CR with a filed open plan. */
function seedProject(key: string, cr: string, release: string, points: number): { planId: number } {
  handle!.store.addProject({ key, name: `cache-${cr}`, type: "backend", sutRoot: "/tmp", retention: 1_000_000 });
  handle!.store.upsertQueueEntry(key, { cr, release, wave: "1", title: cr, points });
  const plan = planned(handle!.store.filePlan(key, { cr, cycles: [{ label: "c1", kind: "red-green" }] }));
  return { planId: plan.planId };
}

const P1 = "00000000-0000-4000-8000-0000a0000001";
const P2 = "00000000-0000-4000-8000-0000a0000002";

describe("the server's analytics cache (§S2) — velocity, burndown, forecast, changes", () => {
  test("a second identical read of each of velocity/burndown/forecast/changes costs no additional store computation, and returns the byte-identical payload", async () => {
    boot();
    const release = "9.9.0";
    seedProject(P1, "CR-ALPHA", release, 3);

    const spy = spyOn(handle!.store, "listQueue");
    const routes = routesFor(P1, release);

    const first: ChangesBody[] = [];
    for (const route of routes) {
      const { status, body } = await getJson(route.path);
      expect(status).toBe(200);
      first.push(body);
    }
    // POSITIVE — one real computation per route, the first time each is read.
    expect(callsFor(spy, P1)).toBe(routes.length);

    const second: ChangesBody[] = [];
    for (const route of routes) {
      const { status, body } = await getJson(route.path);
      expect(status).toBe(200);
      second.push(body);
    }
    // POSITIVE/BOUND — the identical second read costs NO further
    // computation: the call count for this project stays exactly at
    // `routes.length`, never `2 * routes.length`.
    expect(callsFor(spy, P1)).toBe(routes.length);
    // POSITIVE — the cache changes no payload: byte-identical to the first.
    for (let i = 0; i < routes.length; i++) {
      expect(JSON.stringify(second[i])).toBe(JSON.stringify(first[i]));
    }
  });

  test("an `events`-kind change (a recorded, non-FIX plan append) invalidates ALL FOUR cached answers for the project, and the next read recomputes and reflects the change", async () => {
    boot();
    const release = "9.9.0";
    const { planId } = seedProject(P1, "CR-ALPHA", release, 3);

    const spy = spyOn(handle!.store, "listQueue");
    const routes = routesFor(P1, release);

    // Populate the cache for all four routes.
    for (const route of routes) {
      const { status } = await getJson(route.path);
      expect(status).toBe(200);
    }
    expect(callsFor(spy, P1)).toBe(routes.length);

    // Confirm the `changes` payload starts at zero before the recorded
    // change — the "reflects the change" half of this test needs a known
    // starting value to move away from.
    const before = await getJson(routes.find((r) => r.name === "changes")!.path);
    expect(before.body.changes?.["spec-design"]).toBe(0);

    // The `events`-kind change: a recorded (non-FIX) cycle append, cause
    // spec-design — `Store.appendCycle` emits `"events"` for this project.
    planned(
      handle!.store.appendCycle(
        P1,
        planId,
        { label: "c2 extra", kind: "red-green" },
        undefined,
        record("append", "spec-design"),
      ),
    );

    const after: ChangesBody[] = [];
    for (const route of routes) {
      const { status, body } = await getJson(route.path);
      expect(status).toBe(200);
      after.push(body);
    }
    // POSITIVE — every one of the four routes recomputed: one more real
    // `listQueue` call each, never served stale from the invalidated cache.
    expect(callsFor(spy, P1)).toBe(routes.length * 2);
    // POSITIVE — the recompute REFLECTS the change: `changes["spec-design"]`
    // moved from 0 to 1.
    const changesAfter = after[routes.findIndex((r) => r.name === "changes")]!;
    expect(changesAfter.changes?.["spec-design"]).toBe(1);
  });

  test("a plain queue points change (an `events` emission outside plan/cycle code) also invalidates the cache — invalidation follows the store's change KIND, not one call site", async () => {
    boot();
    const release = "9.9.0";
    seedProject(P1, "CR-ALPHA", release, 3);

    const spy = spyOn(handle!.store, "listQueue");
    const velocityPath = routesFor(P1, release)[0]!.path;

    await getJson(velocityPath);
    expect(callsFor(spy, P1)).toBe(1);
    await getJson(velocityPath);
    // BOUND — still 1: the identical second read was cached.
    expect(callsFor(spy, P1)).toBe(1);

    // `events`-kind emission from a plain queue write (points move 3 -> 5),
    // never touching filePlan/appendCycle at all.
    handle!.store.upsertQueueEntry(P1, { cr: "CR-ALPHA", release, wave: "1", title: "CR-ALPHA", points: 5 });

    await getJson(velocityPath);
    // POSITIVE — invalidated: one more real computation.
    expect(callsFor(spy, P1)).toBe(2);
  });

  test("a heartbeat (`agents`-kind change) does NOT invalidate the cache", async () => {
    boot();
    const release = "9.9.0";
    seedProject(P1, "CR-ALPHA", release, 3);

    const spy = spyOn(handle!.store, "listQueue");
    const routes = routesFor(P1, release);

    const first: ChangesBody[] = [];
    for (const route of routes) {
      const { body } = await getJson(route.path);
      first.push(body);
    }
    expect(callsFor(spy, P1)).toBe(routes.length);

    // The `agents`-kind change: a heartbeat/registration touch —
    // `Store.touchAgent` emits `"agents"`, never `"events"`.
    handle!.store.touchAgent(P1, "heartbeat-agent");

    const second: ChangesBody[] = [];
    for (const route of routes) {
      const { body } = await getJson(route.path);
      second.push(body);
    }
    // POSITIVE/BOUND — the heartbeat triggered NO recompute: call count for
    // this project stays exactly at `routes.length`.
    expect(callsFor(spy, P1)).toBe(routes.length);
    // POSITIVE — payloads are unaffected, byte-identical to before the
    // heartbeat.
    for (let i = 0; i < routes.length; i++) {
      expect(JSON.stringify(second[i])).toBe(JSON.stringify(first[i]));
    }
  });

  test("an `events`-kind change in ANOTHER project never invalidates this project's cache", async () => {
    boot();
    const release1 = "9.9.0";
    const release2 = "9.8.0";
    seedProject(P1, "CR-ALPHA", release1, 3);
    seedProject(P2, "CR-BETA", release2, 5);

    const spy = spyOn(handle!.store, "listQueue");
    const routesP1 = routesFor(P1, release1);
    const routesP2 = routesFor(P2, release2);

    const first: ChangesBody[] = [];
    for (const route of routesP1) {
      const { body } = await getJson(route.path);
      first.push(body);
    }
    expect(callsFor(spy, P1)).toBe(routesP1.length);

    // Read + invalidate-and-recompute P2's own cache — traffic that must
    // never leak into P1's call count.
    for (const route of routesP2) {
      await getJson(route.path);
    }
    expect(callsFor(spy, P2)).toBe(routesP2.length);
    handle!.store.upsertQueueEntry(P2, { cr: "CR-BETA", release: release2, wave: "1", title: "CR-BETA", points: 8 });
    for (const route of routesP2) {
      await getJson(route.path);
    }
    expect(callsFor(spy, P2)).toBe(routesP2.length * 2);

    // P1's cache is untouched by ANY of P2's reads or its `events` change.
    const second: ChangesBody[] = [];
    for (const route of routesP1) {
      const { body } = await getJson(route.path);
      second.push(body);
    }
    // POSITIVE/BOUND — still exactly `routesP1.length`: P2's traffic, cached
    // or invalidated, never recomputed P1's answers.
    expect(callsFor(spy, P1)).toBe(routesP1.length);
    for (let i = 0; i < routesP1.length; i++) {
      expect(JSON.stringify(second[i])).toBe(JSON.stringify(first[i]));
    }
  });

  test("the cache never serves another project's or another release's answer", async () => {
    boot();
    const release1 = "9.9.0";
    const release2 = "9.8.0";
    seedProject(P1, "CR-ALPHA", release1, 3);
    // A second release in the SAME project, with its own member CR.
    handle!.store.upsertQueueEntry(P1, { cr: "CR-GAMMA", release: release2, wave: "1", title: "CR-GAMMA", points: 5 });
    seedProject(P2, "CR-BETA", release1, 8); // same release LABEL, other project.

    const burndownPath = (key: string, release: string): string =>
      `/api/v2/projects/${key}/analytics/burndown?release=${encodeURIComponent(release)}`;

    const spy = spyOn(handle!.store, "listQueue");

    const p1r1 = await getJson(burndownPath(P1, release1));
    const p1r2 = await getJson(burndownPath(P1, release2));
    const p2r1 = await getJson(burndownPath(P2, release1));
    expect(callsFor(spy, P1)).toBe(2); // one per DISTINCT release in P1.
    expect(callsFor(spy, P2)).toBe(1);

    // POSITIVE — each answer names its OWN release, never a neighbour's.
    expect(p1r1.body.release).toBe(release1);
    expect(p1r2.body.release).toBe(release2);
    expect(p2r1.body.release).toBe(release1);
    // NEGATIVE — the two "release1" answers (different projects, SAME
    // release label) are NOT the same cached object: CR-ALPHA's 3-point
    // burndown differs from CR-BETA's 8-point one.
    expect(JSON.stringify(p1r1.body)).not.toBe(JSON.stringify(p2r1.body));

    // Re-reading all three is served from cache: no further computation.
    await getJson(burndownPath(P1, release1));
    await getJson(burndownPath(P1, release2));
    await getJson(burndownPath(P2, release1));
    expect(callsFor(spy, P1)).toBe(2);
    expect(callsFor(spy, P2)).toBe(1);
  });

  test("a seeded forecast read is computed on every read and never held, so the cache cannot grow by seed; the unseeded answer is still held", async () => {
    boot();
    const release = "9.9.0";
    seedProject(P1, "CR-ALPHA", release, 3);
    const forecastPath = (seed?: number): string =>
      `/api/v2/projects/${P1}/analytics/forecast?release=${encodeURIComponent(release)}` +
      (seed === undefined ? "" : `&seed=${seed}`);

    const spy = spyOn(handle!.store, "listQueue");

    // The same seed twice: computed twice (the same deterministic answer).
    const first = await getJson(forecastPath(7));
    const again = await getJson(forecastPath(7));
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(callsFor(spy, P1)).toBe(2);
    expect(JSON.stringify(again.body)).toBe(JSON.stringify(first.body));

    // Many distinct seeds: each one computed, none held.
    for (let seed = 100; seed < 110; seed++) {
      expect((await getJson(forecastPath(seed))).status).toBe(200);
    }
    expect(callsFor(spy, P1)).toBe(12);

    // No seeded read populated the unseeded slot: the first unseeded read
    // computes, the second is served from the cache.
    const unseeded = await getJson(forecastPath());
    expect(unseeded.status).toBe(200);
    expect(callsFor(spy, P1)).toBe(13);
    const unseededAgain = await getJson(forecastPath());
    expect(callsFor(spy, P1)).toBe(13);
    expect(JSON.stringify(unseededAgain.body)).toBe(JSON.stringify(unseeded.body));

    // A seeded read after the unseeded answer is held is still computed, and
    // never answered with the held unseeded figures.
    await getJson(forecastPath(7));
    expect(callsFor(spy, P1)).toBe(14);
  });
});
