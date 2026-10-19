// An archived project's analytics are refused, the way every agent and write
// route already refuses it: the four analytics reads (velocity, burndown,
// forecast, changes) answer 404 with `project is archived: <key>` and the
// archived help, after their existing malformed-key 400 and unknown-project
// 404. A live project's analytics answers are untouched, and so are the reads
// that deliberately keep answering an archived project — the plan pointer
// (`/next`) and the archived collection reads (queue, releases, milestones,
// release-proposals), which answer 200 with an empty collection.
//
// Why this matters: an archived project's queue reads as empty while its
// declaration journal does not, so before the refusal its burndown answered
// 200 with `totalPoints: 0` — neither the release's real total nor a refusal.
//
// Drives the REAL production server (`startServer` on an ephemeral port and a
// scratch database), seeded only through the HTTP routes: project create,
// orchestrator register, release-proposal, queue/plan (with points),
// milestones, archive.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import { hints } from "../src/hints.ts";

interface AnyBody {
  ok?: boolean;
  error?: string;
  help?: string[];
  [key: string]: unknown;
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

/** A per-test scratch store on an OS-assigned port — never the live board. */
function boot(): ServerHandle {
  const dir = mkdtempSync(join(tmpdir(), "archived-analytics-"));
  scratchDirs.push(dir);
  handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
  return handle;
}

function base(): string {
  return `http://localhost:${handle!.server.port}`;
}

async function readBody(res: Response): Promise<AnyBody> {
  try {
    return (await res.json()) as AnyBody;
  } catch {
    // A non-JSON answer fails on the FIELDS asserted below, never on a parse throw.
    return {};
  }
}

async function post(path: string, body: unknown): Promise<{ status: number; body: AnyBody }> {
  const res = await fetch(`${base()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await readBody(res) };
}

async function get(path: string): Promise<{ status: number; body: AnyBody }> {
  const res = await fetch(`${base()}${path}`);
  return { status: res.status, body: await readBody(res) };
}

const ORCH = "orchestrator-fixture";
const RELEASE = "7.1.0";
const RECORDED_RELEASE = "7.0.0";
const TARGET_AT = 1_791_158_400; // 2026-10-04T00:00:00Z, epoch seconds
const ITEM_A = "ITEM-ALPHA";
const ITEM_B = "ITEM-BETA";
const POINTS_A = 3;
const POINTS_B = 5;
const RELEASE_TOTAL = POINTS_A + POINTS_B;

const ANALYTICS_ROUTES = ["velocity", "burndown", "forecast", "changes"] as const;

function analyticsPath(key: string, route: string, release: string = RELEASE): string {
  return `/api/v2/projects/${key}/analytics/${route}?release=${encodeURIComponent(release)}`;
}

/**
 * A project with a live release proposal, two pointed items planned into it,
 * and one recorded release milestone — every collection the non-goal reads
 * serve holds something, so an archived read that answers empty is the
 * archive's exclusion at work, not an empty fixture.
 */
async function seedProject(name: string): Promise<string> {
  const created = await post("/api/v2/projects", { name });
  expect(created.status).toBe(200);
  const key = (created.body.project as { key: string }).key;

  const registered = await post("/api/v2/agents/register", {
    projectKey: key,
    agentId: ORCH,
    role: "ORCHESTRATOR",
  });
  expect(registered.status).toBe(200);

  const proposed = await post(`/api/v2/projects/${key}/release-proposals`, {
    agentId: ORCH,
    label: RELEASE,
    targetAt: TARGET_AT,
  });
  expect(proposed.status).toBe(200);

  for (const [cr, points, title] of [
    [ITEM_A, POINTS_A, "first fixture item"],
    [ITEM_B, POINTS_B, "second fixture item"],
  ] as const) {
    const planned = await post(`/api/v2/projects/${key}/queue/plan`, {
      agentId: ORCH,
      cr,
      release: RELEASE,
      wave: 1,
      title,
      points,
    });
    expect(planned.status).toBe(200);
  }

  const recorded = await post("/api/v2/milestones", {
    projectKey: key,
    agentId: ORCH,
    type: "release",
    label: RECORDED_RELEASE,
    commit: "fixture01",
  });
  expect(recorded.status).toBe(201);
  return key;
}

async function archive(key: string): Promise<void> {
  const res = await post(`/api/v2/projects/${key}/archive`, {});
  expect(res.status).toBe(200);
}

describe("an archived project's analytics reads are refused with the archived 404", () => {
  for (const route of ANALYTICS_ROUTES) {
    test(`GET …/analytics/${route}?release= on an archived project with items planned into the release answers 404 'project is archived: <key>' with the archived help, never a 200`, async () => {
      boot();
      const key = await seedProject(`archived-${route}`);

      // The fixture is real: before the archive the release IS answerable —
      // its burndown carries the release's whole pointed total.
      const live = await get(analyticsPath(key, "burndown"));
      expect(live.status).toBe(200);
      expect(live.body.totalPoints).toBe(RELEASE_TOTAL);

      await archive(key);

      const res = await get(analyticsPath(key, route));
      // POSITIVE — the exact refusal the agent and write routes give.
      expect(res.body.error).toBe(`project is archived: ${key}`);
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
      expect(res.body.help).toEqual(hints.archivedProject);
      // NEGATIVE — no analytics payload leaks beside the refusal.
      expect(res.body.release).toBeUndefined();
      expect(res.body.totalPoints).toBeUndefined();
      expect(res.body.remainingPoints).toBeUndefined();
      expect(res.body.days).toBeUndefined();
      expect(res.body.changes).toBeUndefined();
    });
  }

  test("the archived burndown no longer answers 200 with a zero total for a release whose journal still names its pointed items", async () => {
    boot();
    const key = await seedProject("archived-burndown-zero-total");
    await archive(key);

    const res = await get(analyticsPath(key, "burndown"));
    // NEGATIVE — the misleading answer the archive used to get.
    expect(res.status).not.toBe(200);
    expect(res.body.totalPoints).toBeUndefined();
    // POSITIVE — the refusal in its place.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(`project is archived: ${key}`);
  });

  test("unarchiving restores each analytics read's answer — the refusal is the archived state's, not a loss of the release", async () => {
    boot();
    const key = await seedProject("archived-then-restored");
    await archive(key);
    for (const route of ANALYTICS_ROUTES) {
      expect((await get(analyticsPath(key, route))).status).toBe(404);
    }

    const restored = await post(`/api/v2/projects/${key}/unarchive`, {});
    expect(restored.status).toBe(200);

    const burndown = await get(analyticsPath(key, "burndown"));
    expect(burndown.status).toBe(200);
    expect(burndown.body.totalPoints).toBe(RELEASE_TOTAL);
    for (const route of ANALYTICS_ROUTES) {
      const res = await get(analyticsPath(key, route));
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.release).toBe(RELEASE);
    }
  });
});

describe("the analytics reads check the key's shape and existence before the archived state", () => {
  for (const route of ANALYTICS_ROUTES) {
    test(`GET …/analytics/${route} with a malformed project key still answers 400 'projectKey must be a UUID' with the unknown-project help`, async () => {
      boot();
      const res = await get(analyticsPath("not-a-project-key", route));
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe("projectKey must be a UUID");
      expect(res.body.help).toEqual(hints.unknownProject);
      expect(res.body.error).not.toContain("archived");
    });

    test(`GET …/analytics/${route} with a well-formed key no project holds still answers the unknown-project 404, never the archived one`, async () => {
      boot();
      // An archived project exists on the same board, so a refusal that
      // consulted the archived state first could not hide behind an empty store.
      const archivedKey = await seedProject(`order-${route}`);
      await archive(archivedKey);

      const unknownKey = "00000000-0000-4000-8000-00000000a404";
      const res = await get(analyticsPath(unknownKey, route));
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe(`unknown project: ${unknownKey}`);
      expect(res.body.help).toEqual(hints.unknownProject);
      expect(res.body.help).not.toEqual(hints.archivedProject);
    });
  }
});

describe("a live project's analytics answers are unchanged", () => {
  test("beside an archived project on the same board, a live project's velocity, burndown, forecast and changes still answer 200 with the release's figures", async () => {
    boot();
    const archivedKey = await seedProject("archived-neighbour");
    const liveKey = await seedProject("live-project");
    await archive(archivedKey);

    const velocity = await get(analyticsPath(liveKey, "velocity"));
    expect(velocity.status).toBe(200);
    expect(velocity.body.ok).toBe(true);
    expect(velocity.body.release).toBe(RELEASE);
    // Nothing merged yet: every day of the series is a real zero.
    const days = velocity.body.days as Array<{ day: string; points: number }>;
    expect(days.length).toBeGreaterThanOrEqual(1);
    expect(days.length).toBeLessThanOrEqual(2);
    expect(days.every((d) => d.points === 0)).toBe(true);
    expect(velocity.body.sampleDays).toBe(days.length);
    expect(velocity.body.pointsPerDay).toBe(0);
    expect((velocity.body.flow as { sampleCycles: number }).sampleCycles).toBe(0);

    const burndown = await get(analyticsPath(liveKey, "burndown"));
    expect(burndown.status).toBe(200);
    expect(burndown.body.ok).toBe(true);
    expect(burndown.body.release).toBe(RELEASE);
    expect(burndown.body.totalPoints).toBe(RELEASE_TOTAL);
    expect(burndown.body.target).toBe(TARGET_AT);
    expect(burndown.body.unpointed).toEqual([]);

    const forecast = await get(analyticsPath(liveKey, "forecast"));
    expect(forecast.status).toBe(200);
    expect(forecast.body.ok).toBe(true);
    expect(forecast.body.release).toBe(RELEASE);
    expect(forecast.body.remainingPoints).toBe(RELEASE_TOTAL);
    expect(forecast.body.status).toBe("insufficient_history");

    const changes = await get(analyticsPath(liveKey, "changes"));
    expect(changes.status).toBe(200);
    expect(changes.body.ok).toBe(true);
    expect(changes.body.release).toBe(RELEASE);
    expect(changes.body.changes).toEqual({ "spec-design": 0, "gap-analysis": 0, unrecorded: 0 });
    expect(changes.body.aborts).toEqual({ "spec-design": 0, "gap-analysis": 0, unrecorded: 0 });
  });

  test("a live project's analytics still refuse a release no item was ever planned into with their own 404, not the archived one", async () => {
    boot();
    const liveKey = await seedProject("live-unplanned-release");

    for (const route of ANALYTICS_ROUTES) {
      const res = await get(analyticsPath(liveKey, route, "0.0.1"));
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("release 0.0.1");
      expect(res.body.error).not.toContain("archived");
    }
  });
});

describe("the plan pointer and the archived collection reads keep their answers", () => {
  test("GET …/next on an archived project still answers 200 with the drained no-roadmap decision, never the archived refusal", async () => {
    boot();
    const key = await seedProject("archived-next");
    await archive(key);

    const res = await get(`/api/v2/projects/${key}/next`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.decision).toBe("DRAINED");
    expect(res.body.reason).toBe("no-roadmap");
    expect(res.body.error).toBeUndefined();
  });

  test("GET …/queue on an archived project still answers 200 with no entries and no tracks", async () => {
    boot();
    const key = await seedProject("archived-queue");
    await archive(key);

    const res = await get(`/api/v2/projects/${key}/queue`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.entries).toEqual([]);
    expect(res.body.tracks).toEqual([]);
    expect(res.body.error).toBeUndefined();
  });

  test("GET …/releases on an archived project still answers 200 with an empty list", async () => {
    boot();
    const key = await seedProject("archived-releases");
    await archive(key);

    const res = await get(`/api/v2/projects/${key}/releases`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.releases).toEqual([]);
    expect(res.body.error).toBeUndefined();
  });

  test("GET …/milestones?type=release on an archived project still answers 200 with an empty list", async () => {
    boot();
    const key = await seedProject("archived-milestones");
    await archive(key);

    const res = await get(`/api/v2/projects/${key}/milestones?type=release`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.milestones).toEqual([]);
    expect(res.body.totalCount).toBe(0);
    expect(res.body.error).toBeUndefined();
  });

  test("GET …/release-proposals on an archived project still answers 200 with an empty list", async () => {
    boot();
    const key = await seedProject("archived-release-proposals");
    await archive(key);

    const res = await get(`/api/v2/projects/${key}/release-proposals`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.proposals).toEqual([]);
    expect(res.body.totalCount).toBe(0);
    expect(res.body.error).toBeUndefined();
  });
});
