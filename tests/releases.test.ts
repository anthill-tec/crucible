// CR-CRU-074 §S1 (a release is a recorded event) + §S3 (reading releases
// back) — C1 RED tests.
//
// Verified current-code facts this file is RED against:
//   - MILESTONE_TYPES (src/v2.ts:1044) = {gap-analysis, design-review,
//     stage-flip, custom, cr-merged} — no "release", so POST
//     /api/v2/milestones {type:"release"} 400s today with
//     `type must be one of: …` (which likewise does NOT yet name "release").
//   - GET /api/v2/projects/<key>/releases does not exist in the route table,
//     so every read below 404s through the catch-all until GREEN wires it.
//   - No schema change is needed: Store.recordMilestoneEvent (src/store.ts:1580)
//     already persists `label` (the version) and `commit` (the tagged sha) as
//     conditional spreads. SCHEMA_VERSION stays 6.
//
// Existing coverage this must not disturb: tests/gate-milestone-server.test.ts
// owns the milestone route's server contract (CR-CRU-013 §S4b/§S4c).
//
// AC1-c deliberately asserts each pre-existing type INDIVIDUALLY with a
// literal string rather than importing MILESTONE_TYPES and looping — an
// imported set would make the assertion vacuous the instant the set changes.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";

interface OkResponse {
  ok: true;
  changed?: boolean;
  event?: string;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error: string;
  help?: string[];
  [key: string]: unknown;
}

interface EventBrief {
  id: string;
  projectKey: string;
  agentId: string;
  kind: string;
  type?: string;
  label?: string;
  commit?: string;
  timestamp: number;
  [key: string]: unknown;
}

interface EventsListResponse extends OkResponse {
  events: EventBrief[];
}

interface ReleaseBrief {
  version: string;
  commit: string;
  timestamp: number;
  [key: string]: unknown;
}

interface ReleasesListResponse extends OkResponse {
  releases: ReleaseBrief[];
}

describe("CR-CRU-074 — releases are first class (§S1 milestone type + §S3 read route)", () => {
  let handle: ServerHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  /** An on-disk, per-boot ephemeral store — never data/crucible.db, and the
   *  server always takes an OS-assigned port (never 3849, the live board). */
  function boot(): ServerHandle {
    const dir = mkdtempSync(join(tmpdir(), "cru074-releases-"));
    return startServer({ port: 0, dbPath: join(dir, "crucible.db") });
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`);
  }

  async function registerAgent(projectKey: string, agentId: string): Promise<void> {
    const res = await postJson("/api/v2/agents/register", {
      projectKey,
      agentId,
      role: "ORCHESTRATOR",
    });
    expect(res.status).toBe(200);
  }

  /** Creates a project and registers the default poster (the milestone route
   *  requires a live registered caller — CR-CRU-056 §S2b). */
  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    await registerAgent(body.project.key, "orchestrator-1");
    return body.project.key;
  }

  function milestoneBody(projectKey: string, overrides: Record<string, unknown> = {}) {
    return {
      projectKey,
      agentId: "orchestrator-1",
      type: "gap-analysis",
      label: "CR-CRU-074 gap-analysis",
      ...overrides,
    };
  }

  async function postRelease(
    projectKey: string,
    version: string,
    commit: string,
  ): Promise<Response> {
    return postJson(
      "/api/v2/milestones",
      milestoneBody(projectKey, { type: "release", label: version, commit }),
    );
  }

  async function listEvents(key: string): Promise<EventBrief[]> {
    const res = await getJson(`/api/v2/events?project=${key}`);
    const body = (await res.json()) as EventsListResponse;
    return body.events;
  }

  function releasesPath(key: string): string {
    return `/api/v2/projects/${key}/releases`;
  }

  // Real (tiny) delays: the ordering contract is about the SERVER's own
  // wall-clock event timestamps, which no fake timer can advance — the
  // milestones are recorded in a separate HTTP request against the real
  // Date.now(). 8ms is only needed to make the ms-resolution timestamps
  // distinct, so the ordering assertion cannot pass by stable-sort accident.

  // ── AC1 — `release` is an accepted milestone type ───────────────────────
  describe("AC1 §S1 — `release` joins MILESTONE_TYPES", () => {
    test(
      "AC1-a POST /api/v2/milestones {type:'release', label:'0.2.0', commit:'deadbee'} → 201 " +
        "and the stored milestone event carries BOTH label (the version) and commit (the tagged sha)",
      async () => {
        handle = boot();
        const key = await createProject("release-type-accepted");

        const res = await postRelease(key, "0.2.0", "deadbee");
        expect(res.status).toBe(201);
        const body = (await res.json()) as OkResponse;
        expect(body.ok).toBe(true);

        const stored = (await listEvents(key)).find(
          (e) => e.kind === "milestone" && e.type === "release",
        );
        expect(stored).toBeDefined();
        expect(stored!.label).toBe("0.2.0");
        expect(stored!.commit).toBe("deadbee");
      },
    );

    test(
      "AC1-b an unknown type still 400s, and the enumerated accepted set in that error " +
        "message now includes 'release'",
      async () => {
        handle = boot();
        const key = await createProject("release-unknown-type");

        const res = await postJson("/api/v2/milestones", milestoneBody(key, { type: "deploy" }));
        expect(res.status).toBe(400);
        const err = (await res.json()) as ErrResponse;
        expect(err.ok).toBe(false);
        expect(err.error.toLowerCase()).toContain("type");
        expect(err.error).toContain("release");
      },
    );

    test("AC1-c 'gap-analysis' is still accepted → 201", async () => {
      handle = boot();
      const key = await createProject("keep-gap-analysis");
      const res = await postJson("/api/v2/milestones", milestoneBody(key, { type: "gap-analysis" }));
      expect(res.status).toBe(201);
    });

    test("AC1-c 'design-review' is still accepted → 201", async () => {
      handle = boot();
      const key = await createProject("keep-design-review");
      const res = await postJson(
        "/api/v2/milestones",
        milestoneBody(key, { type: "design-review" }),
      );
      expect(res.status).toBe(201);
    });

    test("AC1-c 'stage-flip' is still accepted → 201", async () => {
      handle = boot();
      const key = await createProject("keep-stage-flip");
      const res = await postJson("/api/v2/milestones", milestoneBody(key, { type: "stage-flip" }));
      expect(res.status).toBe(201);
    });

    test("AC1-c 'custom' is still accepted → 201", async () => {
      handle = boot();
      const key = await createProject("keep-custom");
      const res = await postJson("/api/v2/milestones", milestoneBody(key, { type: "custom" }));
      expect(res.status).toBe(201);
    });

    test("AC1-c 'cr-merged' is still accepted → 201", async () => {
      handle = boot();
      const key = await createProject("keep-cr-merged");
      const res = await postJson(
        "/api/v2/milestones",
        milestoneBody(key, { type: "cr-merged", label: "CR-CRU-074", commit: "abc1234" }),
      );
      expect(res.status).toBe(201);
    });
  });

  // ── AC4 §S3 — GET /api/v2/projects/<key>/releases ───────────────────────
  describe("AC4 §S3 — releases are readable newest-first", () => {
    test(
      "AC4-a three releases posted in ascending order come back NEWEST-FIRST with version, " +
        "commit and timestamp (timestamps strictly distinct, so the ordering assertion is real)",
      async () => {
        handle = boot();
        const key = await createProject("releases-newest-first");

        expect((await postRelease(key, "0.1.0", "aaa0001")).status).toBe(201);
        await Bun.sleep(8);
        expect((await postRelease(key, "0.1.1", "bbb0002")).status).toBe(201);
        await Bun.sleep(8);
        expect((await postRelease(key, "0.1.2", "ccc0003")).status).toBe(201);

        const res = await getJson(releasesPath(key));
        expect(res.status).toBe(200);
        const body = (await res.json()) as ReleasesListResponse;
        expect(body.ok).toBe(true);
        expect(Array.isArray(body.releases)).toBe(true);
        expect(body.releases.length).toBe(3);

        expect(body.releases.map((r) => r.version)).toEqual(["0.1.2", "0.1.1", "0.1.0"]);
        expect(body.releases.map((r) => r.commit)).toEqual(["ccc0003", "bbb0002", "aaa0001"]);

        for (const rel of body.releases) {
          expect(typeof rel.timestamp).toBe("number");
        }
        // Distinct AND descending — a stable-sort accident on equal
        // timestamps could not satisfy both.
        const ts = body.releases.map((r) => r.timestamp);
        expect(new Set(ts).size).toBe(3);
        expect(ts[0]!).toBeGreaterThan(ts[1]!);
        expect(ts[1]!).toBeGreaterThan(ts[2]!);
      },
    );

    test(
      "AC4-b an archived project's releases are excluded (the same NOT-archived subquery " +
        "listAgents/listEvents/listOpenRuns use) — 200 with an empty array, records intact",
      async () => {
        handle = boot();
        const key = await createProject("releases-archived");

        expect((await postRelease(key, "0.3.0", "arc0001")).status).toBe(201);
        const beforeRes = await getJson(releasesPath(key));
        expect(beforeRes.status).toBe(200);
        const before = (await beforeRes.json()) as ReleasesListResponse;
        expect(before.releases.length).toBe(1);

        expect((await postJson(`/api/v2/projects/${key}/archive`, {})).status).toBe(200);

        const whileArchived = await getJson(releasesPath(key));
        expect(whileArchived.status).toBe(200);
        const archivedBody = (await whileArchived.json()) as ReleasesListResponse;
        expect(archivedBody.releases).toEqual([]);

        // Excluded, never deleted — unarchive restores it.
        expect((await postJson(`/api/v2/projects/${key}/unarchive`, {})).status).toBe(200);
        const after = (await (await getJson(releasesPath(key))).json()) as ReleasesListResponse;
        expect(after.releases.length).toBe(1);
        expect(after.releases[0]!.version).toBe("0.3.0");
      },
    );

    test("AC4-c a project with no releases → 200 with an empty array, never 404", async () => {
      handle = boot();
      const key = await createProject("releases-none");

      const res = await getJson(releasesPath(key));
      expect(res.status).toBe(200);
      const body = (await res.json()) as ReleasesListResponse;
      expect(body.ok).toBe(true);
      expect(body.releases).toEqual([]);
    });

    test(
      "AC4-d only type 'release' appears — a cr-merged milestone in the SAME project does " +
        "not leak into the releases list",
      async () => {
        handle = boot();
        const key = await createProject("releases-no-leak");

        expect(
          (
            await postJson(
              "/api/v2/milestones",
              milestoneBody(key, {
                type: "cr-merged",
                label: "CR-CRU-073",
                commit: "merge001",
              }),
            )
          ).status,
        ).toBe(201);
        await Bun.sleep(8);
        expect((await postRelease(key, "0.4.0", "rel0004")).status).toBe(201);

        const res = await getJson(releasesPath(key));
        expect(res.status).toBe(200);
        const body = (await res.json()) as ReleasesListResponse;
        expect(body.releases.length).toBe(1);
        expect(body.releases[0]!.version).toBe("0.4.0");
        expect(body.releases[0]!.commit).toBe("rel0004");
        expect(body.releases.some((r) => r.version === "CR-CRU-073")).toBe(false);
        expect(body.releases.some((r) => r.commit === "merge001")).toBe(false);
      },
    );
  });
});
