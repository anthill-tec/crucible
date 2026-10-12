// A gate run's own release stamp (`version`) should outlive it across every
// later snapshot the SAME no-mistakes run posts, even though only the first
// of them is ever given the label explicitly.
//
// The contract under test (absent until the store/route grow it):
//   POST /api/v2/gates already accepts a sibling top-level `version` and
//   stores it first-class, and already lifts `gate.run.id` onto the stored
//   event as `runId`. What does NOT exist yet: when a posted snapshot omits
//   `version` and its `gate.run.id` names a run, the server must look up
//   that SAME run's latest earlier snapshot IN THE SAME PROJECT and stamp
//   the new one with whatever `version` it carried. A run that was never
//   given one stays release-less, a snapshot naming no run is never looked
//   up at all, an explicit `version` is never overwritten, and a run id that
//   happens to match a DIFFERENT project's run is never consulted.
//
// This file drives the real production server (`startServer`) end to end —
// every assertion below fails against production as it stands, because
// nothing inherits anything yet.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer, type ServerHandle } from "../src/server.ts";

interface OkResponse {
  ok: true;
  event?: string;
  [key: string]: unknown;
}

interface EventDetail {
  id: string;
  kind: string;
  runId?: string;
  version?: string;
  [key: string]: unknown;
}

interface EventDetailResponse {
  ok: true;
  event: EventDetail;
}

describe("a run's snapshots keep the run's release", () => {
  let handle: ServerHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function boot(): ServerHandle {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    return handle;
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

  async function createProject(name: string, agentId = "orchestrator-1"): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    const key = body.project.key;
    const regRes = await postJson("/api/v2/agents/register", {
      projectKey: key,
      agentId,
      role: "ORCHESTRATOR",
    });
    expect(regRes.status).toBe(200);
    return key;
  }

  function defaultGate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      intent: "release gate",
      outcome: "passed",
      steps: [{ name: "test", status: "passed" }],
      ...overrides,
    };
  }

  /** Posts one gate snapshot; returns its stored event id. */
  async function postGate(
    key: string,
    agentId: string,
    gateOverrides: Record<string, unknown> = {},
    version?: string,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      projectKey: key,
      agentId,
      gate: defaultGate(gateOverrides),
    };
    if (version !== undefined) body.version = version;
    const res = await postJson("/api/v2/gates", body);
    expect(res.status).toBe(201);
    const parsed = (await res.json()) as OkResponse;
    return parsed.event as string;
  }

  async function getEventDetail(id: string): Promise<EventDetail> {
    const res = await getJson(`/api/v2/events/${id}`);
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as EventDetailResponse;
    return parsed.event;
  }

  describe("server inheritance — POST /api/v2/gates", () => {
    test("a release-less snapshot inherits its run's version; a run never given one, and a snapshot naming no run, stay release-less", async () => {
      boot();
      const key = await createProject("inherit-basic");

      // The run's sealed snapshot carries a release; a later snapshot of the
      // SAME run, posted with no version at all, inherits it.
      await postGate(key, "orchestrator-1", { run: { id: "run-basic-a" } }, "0.4.0");
      const followUpId = await postGate(key, "orchestrator-1", { run: { id: "run-basic-a" } });
      const followUp = await getEventDetail(followUpId);
      expect(followUp.version).toBe("0.4.0");

      // A different run in the same project that was NEVER given a release:
      // its own release-less snapshots stay release-less, even though the
      // project holds a versioned run elsewhere.
      const neverA = await postGate(key, "orchestrator-1", { run: { id: "run-basic-never" } });
      const neverB = await postGate(key, "orchestrator-1", { run: { id: "run-basic-never" } });
      expect((await getEventDetail(neverA)).version).toBeUndefined();
      expect((await getEventDetail(neverB)).version).toBeUndefined();

      // A snapshot naming no run at all (no `run` key on the gate object)
      // stays release-less too — nothing to inherit FROM.
      const noRunId = await postGate(key, "orchestrator-1", {});
      expect((await getEventDetail(noRunId)).version).toBeUndefined();
    });

    test("an explicit version is kept, not overridden; inheritance follows the run's LATEST earlier snapshot; and a matching run id in another project is never read", async () => {
      boot();
      const keyA = await createProject("inherit-latest-a");
      const runId = "run-latest-shared";

      const sealId = await postGate(keyA, "orchestrator-1", { run: { id: runId } }, "0.4.0");
      expect((await getEventDetail(sealId)).version).toBe("0.4.0");

      // A later snapshot of the SAME run that carries its OWN version is
      // never overwritten by the earlier one.
      const ownId = await postGate(keyA, "orchestrator-1", { run: { id: runId } }, "0.5.0");
      expect((await getEventDetail(ownId)).version).toBe("0.5.0");

      // A still-later release-less snapshot inherits the LATEST earlier
      // snapshot's version (0.5.0), not the first one the run ever carried
      // (0.4.0) — "latest earlier snapshot", not "any earlier snapshot".
      const inheritsLatestId = await postGate(keyA, "orchestrator-1", { run: { id: runId } });
      expect((await getEventDetail(inheritsLatestId)).version).toBe("0.5.0");

      // A second project whose own run happens to share the EXACT SAME run
      // id never sees project A's version — runs in another project are
      // never read.
      const keyB = await createProject("inherit-latest-b");
      const crossProjectId = await postGate(keyB, "orchestrator-1", { run: { id: runId } });
      expect((await getEventDetail(crossProjectId)).version).toBeUndefined();
    });
  });

  describe("end to end — gate-run then gate-respond on the same run, against a live board", () => {
    test("every snapshot gate-respond posts, and its own seal, is stored with the release gate-run stamped", async () => {
      boot();
      const key = await createProject("end-to-end-release", "agent-1");
      const runId = "run-end-to-end";

      // gate-run --release 0.4.0: the opening, version-carrying post for this
      // run — the only one of the sequence that ever names a release.
      const gateRunSeal = await postGate(
        key,
        "agent-1",
        { run: { id: runId }, outcome: "passed" },
        "0.4.0",
      );

      // gate-respond, driving the SAME run further, never sends --release —
      // it posts interim snapshots while the run is still going...
      const interim1 = await postGate(key, "agent-1", {
        run: { id: runId },
        outcome: "passed",
        inFlight: true,
      });
      const interim2 = await postGate(key, "agent-1", {
        run: { id: runId },
        outcome: "passed",
        inFlight: true,
      });
      // ...and its own seal once the run finishes.
      const respondSeal = await postGate(key, "agent-1", { run: { id: runId }, outcome: "passed" });

      for (const id of [gateRunSeal, interim1, interim2, respondSeal]) {
        const event = await getEventDetail(id);
        expect(event.version).toBe("0.4.0");
      }
    });
  });
});
