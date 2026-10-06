// CR-CRU-158 §S2/§S3 — each stream frame refreshes only the slices it can
// have changed, the stream's first open does not repeat the boot refresh,
// and every refresh (a scope change's included) goes through the one
// single-flight gate.
//
// Spec: docs/changes/CR-CRU-158-a-runs-detail-stays-responsive-while-agents-run.md
//       §S2 ("Single-flight refresh", "Analytics only when they can have
//       changed"), §S3 ("each resource is fetched once per load"); AC1 (the
//       run view's reads stay fast while agents run: the events list — this
//       project's whole retention window — is the read a heartbeat must not
//       cost the server).
//
// The frame-kind rule pinned here, by the requests each frame makes:
//   - `agents` (a heartbeat or a registration) reads the cheap slices it can
//     move: agents, projects (their agentsOnline/agentsTotal) and health —
//     never the events list, plans, the roadmap or the analytics;
//   - `projects` reads the projects slice alone;
//   - `events` reads projects, the events list, plans, the roadmap and the
//     analytics — never agents or health;
//   - `hello`, and a frame with no parseable type, read nothing.
// The stream's FIRST open reads nothing (the boot refresh already read every
// resource); an open that follows an error (a reconnect) re-reads every
// resource once.
import { describe, test, expect, afterEach } from "bun:test";
import { gateFetch } from "./helpers/fetch-gate";
import {
  countReads,
  mountWorkspace,
  RESOURCES,
  ROADMAP_RESOURCES,
  settle,
  unmount,
} from "./helpers/stream-workspace-harness";

afterEach(unmount);

const ALL = Object.keys(RESOURCES);

/** Expects exactly `expected[name]` reads of each named resource, and none
 *  of every resource not named. */
function expectReads(urls: readonly string[], expected: Record<string, number>, why: string): void {
  const counts = countReads(urls);
  for (const name of ALL) {
    const want = expected[name] ?? 0;
    expect(counts[name], `${why}: ${name} read ${counts[name]} times, expected ${want}`).toBe(want);
  }
}

/** A loaded workspace whose stream has opened; returns the log offset. */
async function loaded(key: string) {
  const page = await mountWorkspace([key]);
  await settle();
  page.source().open();
  await settle();
  return page;
}

describe("a stream frame refreshes only the slices its kind can have changed", () => {
  test("an `agents` frame (a heartbeat) reads agents, projects and health — never the events list, plans, roadmap or analytics", async () => {
    const page = await loaded("frame-agents");
    const from = page.fetchLog.length;
    page.source().dispatch("agents", "frame-agents");
    await settle();
    expectReads(page.fetchLog.slice(from), { agents: 1, projects: 1, health: 1 }, "an agents frame");
  });

  test("a `projects` frame reads the projects slice alone", async () => {
    const page = await loaded("frame-projects");
    const from = page.fetchLog.length;
    page.source().dispatch("projects", "frame-projects");
    await settle();
    expectReads(page.fetchLog.slice(from), { projects: 1 }, "a projects frame");
  });

  test("an `events` frame reads projects, the events list, plans, the roadmap and the analytics — never agents or health", async () => {
    const page = await loaded("frame-events");
    const from = page.fetchLog.length;
    page.source().dispatch("events", "frame-events");
    await settle();
    const expected: Record<string, number> = { projects: 1, "events list": 1, plans: 1 };
    for (const name of ROADMAP_RESOURCES) expected[name] = 1;
    expectReads(page.fetchLog.slice(from), expected, "an events frame");
  });

  test("a `hello` frame and a frame with no parseable type read nothing", async () => {
    const page = await loaded("frame-hello");
    const from = page.fetchLog.length;
    page.source().dispatch("hello", "frame-hello");
    page.source().dispatchRaw("not a json frame");
    page.source().dispatchRaw(JSON.stringify({ projectKey: "frame-hello" }));
    await settle();
    expectReads(page.fetchLog.slice(from), {}, "hello and untyped frames");
  });

  test("a burst of heartbeat and events frames during an in-flight refresh runs one trailing refresh reading the union of their slices", async () => {
    const key = "frame-union";
    const page = await loaded(key);
    const from = page.fetchLog.length;
    // Hold the events list read: the events frame's refresh stays in flight.
    const gate = gateFetch((url) => url.startsWith("/api/v2/events?"));
    try {
      page.source().dispatch("events", key);
      await settle(3);
      expect(gate.held.length).toBe(1);
      for (let i = 0; i < 5; i++) {
        page.source().dispatch("agents", key);
        page.source().dispatch("events", key);
        await settle(1);
      }
      gate.passThrough();
      await settle();
      await settle();
      // The in-flight events refresh (projects, events list, plans, roadmap,
      // analytics) plus ONE trailing refresh of the union of the burst's
      // slices: projects, agents, health and the events slice.
      const expected: Record<string, number> = {
        projects: 2,
        agents: 1,
        health: 1,
        "events list": 2,
        plans: 2,
      };
      for (const name of ROADMAP_RESOURCES) expected[name] = 2;
      expectReads(page.fetchLog.slice(from), expected, "an events refresh plus a burst");
    } finally {
      gate.restore();
    }
  });
});

describe("one read per load: the stream's open and the single-flight gate", () => {
  test("the stream opening after the boot refresh finished reads nothing more: each resource read exactly once on the load", async () => {
    const page = await mountWorkspace(["load-open-after"]);
    await settle();
    page.source().open();
    await settle();
    const expected: Record<string, number> = {
      projects: 1,
      agents: 1,
      health: 1,
      "events list": 1,
      plans: 1,
    };
    for (const name of ROADMAP_RESOURCES) expected[name] = 1;
    expectReads(page.fetchLog, expected, "a load whose stream opened after the boot refresh");
  });

  test("the stream opening while the boot refresh is in flight reads nothing more: velocity, burndown, forecast, releases, queue and release-proposals each read exactly once", async () => {
    const page = await mountWorkspace(["load-open-during"]);
    // The boot refresh is in flight now (public/app.js has just evaluated).
    page.source().open();
    page.source().dispatch("hello", "load-open-during");
    await settle();
    await settle();
    const counts = countReads(page.fetchLog);
    for (const name of ROADMAP_RESOURCES) {
      expect(counts[name], `${name} read ${counts[name]} times on one load`).toBe(1);
    }
    expect(counts["events list"], "the events list read more than once on one load").toBe(1);
  });

  test("a reconnect (the stream opens again after an error) re-reads every resource exactly once", async () => {
    const page = await loaded("load-reconnect");
    const from = page.fetchLog.length;
    page.source().dropAndRetry();
    await settle();
    page.source().open();
    await settle();
    const expected: Record<string, number> = {
      projects: 1,
      agents: 1,
      health: 1,
      "events list": 1,
      plans: 1,
    };
    for (const name of ROADMAP_RESOURCES) expected[name] = 1;
    expectReads(page.fetchLog.slice(from), expected, "a reconnect");
  });

  test("a scope change during an in-flight refresh waits for it, then reads the new project's resources once each", async () => {
    const target = "scope-to";
    const both = await mountWorkspace(["scope-from", target]);
    await settle();
    both.source().open();
    await settle();

    const gate = gateFetch((url) => url.startsWith("/api/v2/events?project=scope-from"));
    try {
      both.source().dispatch("events", "scope-from");
      await settle(3);
      expect(gate.held.length).toBe(1);
      const from = both.fetchLog.length;

      history.pushState(null, "", `/p/${target}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
      await settle();
      // Single-flight: nothing of the new scope is read while the old
      // refresh is still in flight.
      const during = both.fetchLog.slice(from).filter((u) => u.includes(target));
      expect(during, "the scope change read alongside an in-flight refresh").toEqual([]);

      gate.passThrough();
      await settle();
      await settle();
      const forTarget = both.fetchLog.slice(from).filter((u) => u.includes(target));
      const counts = countReads(forTarget);
      for (const name of [...ROADMAP_RESOURCES, "plans", "events list"]) {
        expect(counts[name], `${name} of the new project read ${counts[name]} times`).toBe(1);
      }
    } finally {
      gate.restore();
    }
  });
});
