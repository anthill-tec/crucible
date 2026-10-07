// CR-CRU-164 §S2 — read by release: GET /api/v2/events?project=<key>&release=X.Y.Z
// docs/changes/CR-CRU-164-a-releases-verification-runs-are-filed-under-it.md
//
// SERVER ONLY (cycle 600, C1): the ROUTE half of AC4 — the roadmap-band chip
// that opens the Runs tab filtered to a release (C3, the page) is NOT this
// suite's concern.
//
// RED. Measured on this build: `handleEventsList` (src/v2.ts) reads `project`,
// `cycleId` and `limit` off the query string and NOTHING else — a `release`
// param is silently ignored and the plain recent-N feed is served instead, so
// every filtering assertion below fails for that reason (not a typo), and the
// brief carries no `release` key because no route ever stamps one.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface EventBrief {
  id: string;
  [key: string]: unknown;
}

interface EventsListResponse extends OkResponse {
  events: EventBrief[];
}

function parsedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 },
    tree: [
      { name: "s", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 5 }] },
    ],
    ...overrides,
  };
}

describe("CR-CRU-164 §S2 — GET /api/v2/events?release=X answers exactly that release's runs (server route)", () => {
  let handle: ServerHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function boot(): void {
    handle = startServer({ port: 0, dbPath: ":memory:" });
  }

  async function send(method: string, path_: string, body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${handle!.server.port}${path_}`, {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
  }

  async function postJson(path_: string, body: unknown): Promise<Response> {
    return send("POST", path_, body);
  }

  async function getJson(path_: string): Promise<Response> {
    return send("GET", path_);
  }

  async function createProject(): Promise<string> {
    const res = await postJson("/api/v2/projects", { name: `cr164s2-${crypto.randomUUID()}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  async function register(key: string, agentId: string): Promise<void> {
    const res = await postJson("/api/v2/agents/register", {
      projectKey: key,
      agentId,
      role: "ORCHESTRATOR",
    });
    expect(res.status).toBe(200);
  }

  function declareViaLiveProposal(key: string, release: string): void {
    handle!.store.recordReleaseProposal(key, "fixture-setup", {
      label: release,
      targetAt: Math.floor(Date.now() / 1000) + 86_400,
    });
  }

  async function ingestParsed(
    key: string,
    agentId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId,
      ...parsedBody(),
      ...overrides,
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as OkResponse & { event: string }).event;
  }

  async function startRun(
    key: string,
    agentId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await postJson("/api/v2/runs/start", { projectKey: key, agentId, ...overrides });
    expect(res.status).toBe(202);
    return ((await res.json()) as { runId: string }).runId;
  }

  async function abortRun(key: string, agentId: string, runId: string): Promise<void> {
    const res = await postJson(`/api/v2/runs/${runId}/abort`, {
      projectKey: key,
      agentId,
      reason: "test abort — CR-CRU-164 §S2 fixture",
    });
    expect(res.status).toBe(200);
  }

  async function plainList(key: string, limit = 100): Promise<EventBrief[]> {
    const res = await getJson(`/api/v2/events?project=${key}&limit=${limit}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as EventsListResponse).events;
  }

  async function releaseList(key: string, release: string): Promise<EventBrief[]> {
    const res = await getJson(
      `/api/v2/events?project=${key}&release=${encodeURIComponent(release)}`,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as EventsListResponse).events;
  }

  test("answers exactly one release's events, newest first, excluding a sibling release and an unstamped run", async () => {
    boot();
    const key = await createProject();
    await register(key, "orch-rel-a");
    declareViaLiveProposal(key, "7.1.0");
    declareViaLiveProposal(key, "7.2.0");

    const idA1 = await ingestParsed(key, "orch-rel-a", { release: "7.1.0" });
    await Bun.sleep(5);
    const idA2 = await ingestParsed(key, "orch-rel-a", { release: "7.1.0" });
    await Bun.sleep(5);
    const idB = await ingestParsed(key, "orch-rel-a", { release: "7.2.0" });
    const idUnstamped = await ingestParsed(key, "orch-rel-a", {});

    const filtered = await releaseList(key, "7.1.0");

    expect(filtered.map((e) => e.id)).toEqual([idA2, idA1]);
    expect(filtered.some((e) => e.id === idB)).toBe(false);
    expect(filtered.some((e) => e.id === idUnstamped)).toBe(false);
  });

  test("includes an ABORTED run filed under the release", async () => {
    boot();
    const key = await createProject();
    await register(key, "orch-rel-abort");
    declareViaLiveProposal(key, "7.3.0");

    const runId = await startRun(key, "orch-rel-abort", { release: "7.3.0" });
    await abortRun(key, "orch-rel-abort", runId);

    const filtered = await releaseList(key, "7.3.0");

    expect(filtered.length).toBe(1);
    expect(filtered[0]!.status).toBe("aborted");
    expect(filtered[0]!.release).toBe("7.3.0");
  });

  test("a release-filtered entry is the SAME brief shape as the plain list's entry for the same event id — never a second vocabulary", async () => {
    boot();
    const key = await createProject();
    await register(key, "orch-rel-shape");
    declareViaLiveProposal(key, "7.4.0");

    const id = await ingestParsed(key, "orch-rel-shape", { release: "7.4.0" });

    const plain = await plainList(key);
    const filtered = await releaseList(key, "7.4.0");
    const fromPlain = plain.find((e) => e.id === id);
    const fromFiltered = filtered.find((e) => e.id === id);

    expect(fromPlain).toBeDefined();
    expect(fromFiltered).toEqual(fromPlain);
  });

  test("an unknown/undeclared release label answers 200 with an EMPTY list — the unknown-cycleId anchor's own contract, applied the same way", async () => {
    boot();
    const key = await createProject();
    await register(key, "orch-rel-unknown");

    const res = await getJson(`/api/v2/events?project=${key}&release=9.9.9-never-declared`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as EventsListResponse;
    expect(body.events).toEqual([]);
  });

  // ── regression pins: the two EXISTING anchors stay byte-unchanged ────────

  test("PIN — the plain list (no release, no cycleId param) carries no `release` key on an unstamped event", async () => {
    boot();
    const key = await createProject();
    await register(key, "orch-rel-plain-pin");

    const id = await ingestParsed(key, "orch-rel-plain-pin", {});

    const plain = await plainList(key);
    const brief = plain.find((e) => e.id === id);

    expect(brief).toBeDefined();
    expect("release" in (brief as object)).toBe(false);
  });

  test("PIN — the cycleId anchor (?project=&cycleId=) still answers a bound run's events, unaffected by the new release column", async () => {
    boot();
    const key = await createProject();
    await register(key, "orch-rel-cyc-pin");
    const filed = await postJson(`/api/v2/projects/${key}/plans`, {
      agentId: "orch-rel-cyc-pin",
      cr: `CR-CR164S2-${crypto.randomUUID().slice(0, 8)}`,
      cycles: [{ label: "solo" }],
    });
    expect(filed.status).toBe(201);
    const plan = (await filed.json()) as { planId: number; cycles: Array<{ id: number }> };
    const cycleId = plan.cycles[0]!.id;
    const activated = await send(
      "PATCH",
      `/api/v2/projects/${key}/plans/${plan.planId}/cycles/${cycleId}`,
      { agentId: "orch-rel-cyc-pin", status: "active" },
    );
    expect(activated.status).toBe(200);

    const id = await ingestParsed(key, "orch-rel-cyc-pin", { context: { cycleId } });

    const res = await getJson(`/api/v2/events?project=${key}&cycleId=${cycleId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResponse & { events: EventBrief[] };
    const brief = body.events.find((e) => e.id === id);

    expect(brief).toBeDefined();
    expect((brief as EventBrief).context).toEqual({ cycleId });
    expect("release" in (brief as object)).toBe(false);
  });
});
