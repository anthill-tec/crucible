// CR-CRU-024 §S3.2 — EDIT a cycle's label: `PATCH …/cycles/<id> {label}` is
// legal ONLY while the cycle is `pending`. The ACTIVE cycle is LOCKED (400:
// "the active cycle is locked — confirm or fail it first"); terminal cycles
// (done/skipped/failed) are HISTORY and immutable (400: "done/skipped/failed
// cycles are immutable history"). label+status in one body → 400 (one
// mutation per call, named in help[]).
//
// RED phase: every test below is expected to FAIL against CURRENT
// production. handleCycleTransition (src/v2.ts ~729) only ever reads
// `body.status` — there is no label-edit branch at all, so:
//   - a bare {label} PATCH currently 400s on "invalid status: undefined"
//     (never reaching a 200 label round-trip),
//   - there is no "locked"/"immutable history" wording anywhere (confirmed
//     by reading src/hints.ts — no such hint exists in the registry today),
//   - a combined {label, status} body is currently NOT rejected — status
//     alone drives the transition and label is silently ignored, so the
//     "one mutation per call" 400 never fires.
//
// Same harness pattern as tests/cycle-activation-guards.test.ts — drives
// the REAL production server via startServer, no guard implementation is
// stubbed or mocked.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";

interface CyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
}

interface PlanFileResponse {
  planId: number | string;
  cr: string;
  status: string;
  cycles: CyclePayload[];
  [key: string]: unknown;
}

interface PlanRecord {
  planId: number | string;
  cr: string;
  status: string;
  cycles: CyclePayload[];
  [key: string]: unknown;
}

interface PlansListResponse {
  ok: true;
  plans: PlanRecord[];
}

interface ErrResponse {
  ok: false;
  error: string;
  help?: unknown;
  [key: string]: unknown;
}

describe("PATCH …/cycles/<id> label edit (CR-CRU-024 §S3.2)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function patchJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`);
  }

  async function createProject(): Promise<string> {
    const res = await postJson("/api/v2/projects", { name: `cycle-edit-label-${crypto.randomUUID()}` });
    const body = (await res.json()) as { ok: true; project: { key: string } };
    return body.project.key;
  }

  function plansPath(key: string, suffix = ""): string {
    return `/api/v2/projects/${key}/plans${suffix}`;
  }

  async function fileSolo(key: string, cr: string): Promise<{ planId: number | string; cycleId: number }> {
    const res = await postJson(plansPath(key), {
      cr,
      cycles: [{ label: "solo" }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PlanFileResponse;
    return { planId: body.planId, cycleId: body.cycles[0]!.id };
  }

  async function editLabel(
    key: string,
    planId: number | string,
    cycleId: number,
    label: string,
  ): Promise<Response> {
    return patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { label });
  }

  async function transition(
    key: string,
    planId: number | string,
    cycleId: number,
    status: string,
  ): Promise<Response> {
    return patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), { status });
  }

  async function getCycle(key: string, cr: string, cycleId: number): Promise<CyclePayload> {
    const res = await getJson(plansPath(key, `?cr=${encodeURIComponent(cr)}`));
    const body = (await res.json()) as PlansListResponse;
    const plan = body.plans.find((p) => p.cr === cr)!;
    return plan.cycles.find((c) => c.id === cycleId)!;
  }

  function helpText(body: ErrResponse): string {
    expect(Array.isArray(body.help)).toBe(true);
    const help = body.help as unknown[];
    expect(help.length).toBeGreaterThan(0);
    for (const line of help) {
      expect(typeof line).toBe("string");
      expect((line as string).length).toBeGreaterThan(0);
    }
    return (help as string[]).join(" | ");
  }

  test("PENDING cycle: PATCH {label} -> 200, label round-trips via GET", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, cycleId } = await fileSolo(key, "CR-EDIT-1");

    const res = await editLabel(key, planId, cycleId, "renamed pending cycle");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; changed: true; cycle: CyclePayload };
    expect(body.ok).toBe(true);
    expect(body.cycle.label).toBe("renamed pending cycle");
    expect(body.cycle.status).toBe("pending");

    const after = await getCycle(key, "CR-EDIT-1", cycleId);
    expect(after.label).toBe("renamed pending cycle");
  });

  test("ACTIVE cycle: PATCH {label} -> 400 'locked', help[] non-empty, label unchanged", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, cycleId } = await fileSolo(key, "CR-EDIT-2");
    const activated = await transition(key, planId, cycleId, "active");
    expect(activated.status).toBe(200);

    const res = await editLabel(key, planId, cycleId, "sneaky rename");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("the active cycle is locked — confirm or fail it first");
    helpText(body);

    const after = await getCycle(key, "CR-EDIT-2", cycleId);
    expect(after.label).toBe("solo");
    expect(after.status).toBe("active");
  });

  test("DONE cycle: PATCH {label} -> 400 'immutable history', label unchanged", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, cycleId } = await fileSolo(key, "CR-EDIT-3");
    expect((await transition(key, planId, cycleId, "active")).status).toBe(200);
    expect((await transition(key, planId, cycleId, "done")).status).toBe(200);

    const res = await editLabel(key, planId, cycleId, "sneaky rename");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("done/skipped/failed cycles are immutable history");
    helpText(body);

    const after = await getCycle(key, "CR-EDIT-3", cycleId);
    expect(after.label).toBe("solo");
  });

  test("SKIPPED cycle: PATCH {label} -> 400 'immutable history', label unchanged", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, cycleId } = await fileSolo(key, "CR-EDIT-4");
    expect((await transition(key, planId, cycleId, "skipped")).status).toBe(200);

    const res = await editLabel(key, planId, cycleId, "sneaky rename");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("done/skipped/failed cycles are immutable history");
    helpText(body);

    const after = await getCycle(key, "CR-EDIT-4", cycleId);
    expect(after.label).toBe("solo");
  });

  test("FAILED cycle: PATCH {label} -> 400 'immutable history', label unchanged", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, cycleId } = await fileSolo(key, "CR-EDIT-5");
    expect((await transition(key, planId, cycleId, "active")).status).toBe(200);
    expect((await transition(key, planId, cycleId, "failed")).status).toBe(200);

    const res = await editLabel(key, planId, cycleId, "sneaky rename");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("done/skipped/failed cycles are immutable history");
    helpText(body);

    const after = await getCycle(key, "CR-EDIT-5", cycleId);
    expect(after.label).toBe("solo");
  });

  test("label+status in one body -> 400, help[] names one-mutation-per-call, nothing changed", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject();
    const { planId, cycleId } = await fileSolo(key, "CR-EDIT-6");

    const res = await patchJson(plansPath(key, `/${planId}/cycles/${cycleId}`), {
      label: "combined mutation",
      status: "active",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    const help = helpText(body);
    expect(help).toMatch(/one mutation per call/i);

    const after = await getCycle(key, "CR-EDIT-6", cycleId);
    expect(after.label).toBe("solo");
    expect(after.status).toBe("pending");
  });
});
