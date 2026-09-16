// CR-CRU-117 §S1 (cycle 414) — THE ROUND-TRIP PIN: `gate.inFlight` survives the
// real POST → server → read-back path.
//
// THIS FILE PASSES ON ARRIVAL AND REQUIRED NO PRODUCTION CHANGE. It is not a
// RED for missing behaviour; it is a regression pin on behaviour that today
// holds only by COMPOSITION, which is exactly why nothing guarded it:
//
//   * `post_gate` (clients/_crucible_axi.py) sends the gate object VERBATIM;
//   * `handleGates` (src/v2.ts) validates ONLY `intent`, `outcome` and
//     steps-is-an-array, then forwards the WHOLE object onwards;
//   * `recordGateEvent` (src/store.ts) stores it verbatim;
//   * `src/types.ts` writes the promise the CR's settled design leans on down
//     as a comment — "forward-tolerant: fields outside the ladder round-trip
//     untouched" — and a comment is not a test.
//
// The CR asserts its CLIENT half at the transport seam (the POST body, with
// `module._post` patched) and its BROWSER half against injected event
// fixtures. The middle — the wire — had no test at all. A future author
// "tidying" the route into `recordGateEvent(pk.key, agentId, {intent, outcome,
// steps})` would delete the mark from every gate on the board, restore the
// false green this whole CR exists to remove, and break nothing. This file is
// the test that would break.
//
// TIER: INTEGRATION. `startServer` binds a real HTTP listener and every
// assertion below reads a value that came back over the socket — never the
// object that was sent. A listener is a dependency, so by the project's own
// dependency rule this is `integration`, not `unit`.
//
// HARNESS: the `startServer({ port: 0, dbPath: ":memory:" })` + real `fetch`
// pattern of tests/agent-cycle-binding.test.ts and tests/agent-lifecycle.test.ts.
// No new mechanism.
//
// FIXTURES: the exact interim body `stream_axi_ladder` builds for a mid-run
// snapshot, taken from the client suite that pins it
// (tests/client/test_a_run_in_flight_streams_its_ladder.py): nine rows from
// `no-mistakes` v1.70.1 (captured 2026-09-10), `review` still `running`, the
// six unrun steps `pending`, `outcome: "checks-passed"`, `inFlight: true`, and
// NO top-level `version`.

import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { Store } from "../src/store.ts";

interface GateStep {
  name: string;
  status: string;
}

interface GatePostResponse {
  ok: boolean;
  event: string;
  [key: string]: unknown;
}

interface EventBrief {
  id: string;
  kind: string;
  agentId: string;
  gate?: unknown;
  version?: string;
  [key: string]: unknown;
}

interface EventsListResponse {
  ok: boolean;
  events: EventBrief[];
  [key: string]: unknown;
}

// The mark, spelled as the client posts it — a key INSIDE the gate object
// (settled 2026-09-10, docs/research/DN-crucible-wave-track-release.md D3).
const IN_FLIGHT_KEY = "inFlight";

// The commit a REAL seal names. An in-flight gate has none.
const SEAL_COMMIT = "a5ad01346d028653be14854f1573562d8769d4b0";

// The release label a seal stamps as the event's top-level `version` (a SIBLING
// of `gate`, per CR-CRU-073 §S1). An interim gate deliberately carries none.
const SEAL_VERSION = "0.2.0-rt-pin";

/** The nine rows mid-run, with the client's MAPPED statuses — the shape
 *  `gate_from_axi(decoded, intent, final=False)` produces from a live `axi
 *  status` snapshot: two resolved, `review` running, six still `pending`. */
function interimLadder(): GateStep[] {
  return [
    { name: "intent", status: "passed" },
    { name: "rebase", status: "passed" },
    { name: "review", status: "running" },
    { name: "test", status: "pending" },
    { name: "document", status: "pending" },
    { name: "lint", status: "pending" },
    { name: "push", status: "pending" },
    { name: "pr", status: "pending" },
    { name: "ci", status: "pending" },
  ];
}

/** The same nine rows once the run resolved — the SEAL's ladder. */
function sealLadder(): GateStep[] {
  return interimLadder().map((step) => ({ name: step.name, status: "passed" }));
}

/** The interim gate object, byte-for-byte the client's: an outcome it is
 *  FORCED to send (`checks-passed` is one of the server's four), the live
 *  ladder, and the mark that keeps a reader from taking it for a verdict. */
function interimGate(intent: string): Record<string, unknown> {
  return {
    intent,
    outcome: "checks-passed",
    steps: interimLadder(),
    [IN_FLIGHT_KEY]: true,
  };
}

/** The sealing gate of the SAME run: no `inFlight` key at all, and a commit. */
function sealGate(intent: string): Record<string, unknown> {
  return {
    intent,
    outcome: "passed",
    steps: sealLadder(),
    push: { commit: SEAL_COMMIT },
  };
}

describe("CR-CRU-117 §S1 — an in-flight gate's mark survives the real client→server→read-back round trip (integration)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function base(): string {
    return `http://localhost:${handle!.server.port}`;
  }

  function seedProject(store: Store): string {
    const key = crypto.randomUUID();
    store.addProject({ key, name: "P", type: "backend", sutRoot: "/tmp/p" });
    return key;
  }

  /** Registers the poster through the REAL registration route — gates refuse
   *  an unregistered caller (CR-CRU-056 §S2b), and an ORCHESTRATOR may
   *  register unbound, which is what a gate poster is. */
  async function registerPoster(key: string, agentId: string): Promise<void> {
    const res = await fetch(`${base()}/api/v2/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey: key, agentId, role: "ORCHESTRATOR" }),
    });
    expect(res.status).toBe(200);
  }

  /** POSTs exactly the body `post_gate` builds and returns the new event id. */
  async function postGate(
    key: string,
    agentId: string,
    gate: Record<string, unknown>,
    version?: string,
  ): Promise<string> {
    const res = await fetch(`${base()}/api/v2/gates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectKey: key,
        agentId,
        gate,
        ...(version !== undefined ? { version } : {}),
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as GatePostResponse;
    expect(body.ok).toBe(true);
    return body.event;
  }

  /** Reads the timeline back over the socket. Everything asserted below comes
   *  out of THIS payload — never out of the object that was posted. */
  async function readEvents(key: string): Promise<EventBrief[]> {
    const res = await fetch(`${base()}/api/v2/events?project=${key}`, {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EventsListResponse;
    expect(body.ok).toBe(true);
    return body.events;
  }

  function eventById(events: EventBrief[], id: string): EventBrief {
    const found = events.find((e) => e.id === id);
    expect(found).toBeDefined();
    return found!;
  }

  function gateObjectOf(event: EventBrief): Record<string, unknown> {
    expect(event.kind).toBe("gate");
    expect(typeof event.gate).toBe("object");
    expect(event.gate).not.toBeNull();
    return event.gate as Record<string, unknown>;
  }

  test("an interim gate POSTed with inFlight:true reads back from GET /api/v2/events with gate.inFlight still exactly true", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = seedProject(handle.store);
    const agentId = "round-trip-poster";
    await registerPoster(key, agentId);
    const intent = "CR-CRU-117 — cycle 414 close-out";

    const eventId = await postGate(key, agentId, interimGate(intent));

    const events = await readEvents(key);
    // BOUND — exactly one gate event exists, so the assertions below cannot be
    // satisfied by some other row the harness happened to create.
    expect(events.filter((e) => e.kind === "gate")).toHaveLength(1);
    const gate = gateObjectOf(eventById(events, eventId));

    // POSITIVE — the mark is present BY KEY on the value that came back over
    // the wire, and is the boolean `true`, not merely truthy.
    expect(Object.keys(gate)).toContain(IN_FLIGHT_KEY);
    expect(gate[IN_FLIGHT_KEY]).toBe(true);
    // …and the rest of the gate is the one that was posted, so this is the
    // interim snapshot's own row and not a coincidence.
    expect(gate.intent).toBe(intent);
    expect(gate.outcome).toBe("checks-passed");
  });

  test("the ANTI-VACUITY twin: in ONE read-back, the interim gate carries inFlight:true and the same run's SEAL carries no inFlight key at all", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = seedProject(handle.store);
    const agentId = "round-trip-poster";
    await registerPoster(key, agentId);
    const intent = "CR-CRU-117 — cycle 414 close-out";

    const interimId = await postGate(key, agentId, interimGate(intent));
    const sealId = await postGate(key, agentId, sealGate(intent), SEAL_VERSION);

    const events = await readEvents(key);
    const marked = gateObjectOf(eventById(events, interimId));
    const seal = gateObjectOf(eventById(events, sealId));

    // The PAIR is the point: a route that dropped the key for everyone fails
    // the first assertion; a route that fabricated `inFlight` (or defaulted it
    // to `false`) fails the second. Only a verbatim carry satisfies both.
    expect(marked[IN_FLIGHT_KEY]).toBe(true);
    expect(IN_FLIGHT_KEY in seal).toBe(false);
    expect(Object.keys(seal)).not.toContain(IN_FLIGHT_KEY);
    // KEY ABSENCE, not `false` — the readers exclude on the key's presence.
    expect(seal[IN_FLIGHT_KEY]).toBeUndefined();
    // The seal's OWN extra-ladder field round-trips too, so forward tolerance
    // is shown to be a property of the object, not a special case for one key.
    expect(seal.push).toEqual({ commit: SEAL_COMMIT });
  });

  test("the interim gate's nine-row ladder reads back intact — every name, the tool's own order, and all six pending rows still pending", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = seedProject(handle.store);
    const agentId = "round-trip-poster";
    await registerPoster(key, agentId);

    const eventId = await postGate(key, agentId, interimGate("CR-CRU-117 — ladder fidelity"));

    const gate = gateObjectOf(eventById(await readEvents(key), eventId));

    // POSITIVE — deep equality against the posted ladder: names, mapped
    // statuses and ORDER, all nine rows, as the wire returned them.
    expect(gate.steps).toEqual(interimLadder());
    const steps = gate.steps as GateStep[];
    // BOUND — exactly nine rows (no row dropped, none synthesised).
    expect(steps).toHaveLength(9);
    // NEGATIVE — `pending` is REPRESENTED, not normalised into green on the
    // way through: exactly six rows, and not one `passed` beyond the two the
    // snapshot really resolved.
    expect(steps.filter((s) => s.status === "pending")).toHaveLength(6);
    expect(steps.filter((s) => s.status === "passed")).toHaveLength(2);
    // NEGATIVE — an in-flight gate has no commit to name, and the round trip
    // does not invent one.
    expect("push" in gate).toBe(false);
  });

  test("an interim gate POSTed with no top-level version reads back with no version key, while the same run's seal reads back carrying its version", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = seedProject(handle.store);
    const agentId = "round-trip-poster";
    await registerPoster(key, agentId);
    const intent = "CR-CRU-117 — version stamping";

    const interimId = await postGate(key, agentId, interimGate(intent));
    const sealId = await postGate(key, agentId, sealGate(intent), SEAL_VERSION);

    const events = await readEvents(key);
    const interim = eventById(events, interimId);
    const seal = eventById(events, sealId);

    // Retention's LIVE_GATE exemption (src/store.ts) keys on
    // `json_extract(payload, '$.version') IS NOT NULL`, so a stamped interim
    // gate would be unprunable for a whole release. CR-CRU-117 leaves it
    // unstamped, and this is the read-back proof.
    expect("version" in interim).toBe(false);
    expect(interim.version).toBeUndefined();
    // …nor does the stamp hide INSIDE the gate object.
    expect("version" in gateObjectOf(interim)).toBe(false);
    // TWIN — the route really does carry a version when one is sent, so the
    // absence above is a fact about the interim POST, not a dead field.
    expect(seal.version).toBe(SEAL_VERSION);
  });
});
