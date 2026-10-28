// A `pre-merge-gate` milestone keeps the gate's `scope` and `suites` beside
// its verdict: POST /api/v2/milestones carries them only when both are
// well-formed and refuses the whole post (400, nothing recorded) when either
// is not; the milestone reads (`GET /api/v2/projects/<key>/milestones?type=`
// and `GET /api/v2/events/<id>`) serve them back unchanged beside the verdict
// fields `outcome`/`passed`/`failed`/`failingTests`; and health states the
// capability as `milestones: { gate: ["scope", "suites"] }` beside `codecs`.
//
// Well-formed: `scope` is "full" or "scoped"; `suites` is a list whose every
// entry has a non-empty string `target`, an `outcome` of "pass" or "fail",
// `passed` and `failed` both non-negative integers or both absent (absent
// only on "fail"), and an optional `failingTests` that is a list of strings.
//
// Driven through the real production HTTP surface (`startServer`, in-memory
// store) with a registered caller, as the gate-milestone server tests are.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";

const CALLER = "orchestrator-1";

interface MilestoneRecord {
  id: string;
  kind: string;
  type?: string;
  label?: string;
  outcome?: string;
  passed?: number;
  failed?: number;
  failingTests?: string[];
  scope?: unknown;
  suites?: unknown;
  [key: string]: unknown;
}

interface MilestonesResponse {
  ok: boolean;
  milestones: MilestoneRecord[];
  totalCount: number;
}

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): string {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  handles.push(handle);
  return `http://127.0.0.1:${handle.server.port}`;
}

async function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson<T>(base: string, path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

/** A project with the milestone caller registered, as the gate-milestone tests set one up. */
async function createProject(base: string, name: string): Promise<string> {
  const res = await postJson(base, "/api/v2/projects", { name });
  expect(res.ok).toBe(true);
  const key = ((await res.json()) as { project: { key: string } }).project.key;
  const reg = await postJson(base, "/api/v2/agents/register", {
    projectKey: key,
    agentId: CALLER,
    role: "ORCHESTRATOR",
  });
  expect(reg.status).toBe(200);
  return key;
}

/** A well-formed red verdict, today's fields only. */
function redVerdict(): Record<string, unknown> {
  return { outcome: "fail", passed: 8634, failed: 1, failingTests: ["python::test_setup_defect"] };
}

function gateMilestone(key: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectKey: key,
    agentId: CALLER,
    type: "pre-merge-gate",
    label: "CR-XYZ-001",
    ...redVerdict(),
    ...extra,
  };
}

/** Two well-formed entries: a passing suite and a failing one with its failing test. */
function wellFormedSuites(): Record<string, unknown>[] {
  return [
    { target: "bun", outcome: "pass", passed: 4111, failed: 0 },
    {
      target: "python",
      outcome: "fail",
      passed: 4522,
      failed: 1,
      failingTests: ["python::test_setup_defect"],
    },
  ];
}

async function preMergeGateMilestones(base: string, key: string): Promise<MilestonesResponse> {
  return getJson<MilestonesResponse>(base, `/api/v2/projects/${key}/milestones?type=pre-merge-gate`);
}

async function milestoneEventCount(base: string, key: string): Promise<number> {
  const body = await getJson<{ events: { kind: string }[] }>(base, `/api/v2/events?project=${key}`);
  return body.events.filter((e) => e.kind === "milestone").length;
}

describe("a pre-merge-gate milestone keeps the gate's scope and suites", () => {
  test("a full gate's scope and two suite entries read back unchanged through the milestone read, beside today's verdict", async () => {
    const base = boot();
    const key = await createProject(base, "gate-scope-suites-full");
    const suites = wellFormedSuites();

    const res = await postJson(base, "/api/v2/milestones", gateMilestone(key, { scope: "full", suites }));
    expect(res.status).toBe(201);
    const posted = (await res.json()) as { ok: boolean; event: string };
    expect(posted.ok).toBe(true);

    const read = await preMergeGateMilestones(base, key);
    expect(read.totalCount).toBe(1);
    const record = read.milestones[0]!;
    expect(record.id).toBe(posted.event);
    expect(record.outcome).toBe("fail");
    expect(record.passed).toBe(8634);
    expect(record.failed).toBe(1);
    expect(record.failingTests).toEqual(["python::test_setup_defect"]);
    expect(record.scope).toBe("full");
    expect(record.suites).toEqual(suites);
  });

  test("the event read of the posted milestone serves the same scope and suites", async () => {
    const base = boot();
    const key = await createProject(base, "gate-scope-suites-event-read");
    const suites = wellFormedSuites();

    const res = await postJson(base, "/api/v2/milestones", gateMilestone(key, { scope: "full", suites }));
    expect(res.status).toBe(201);
    const eventId = ((await res.json()) as { event: string }).event;

    const body = await getJson<{ ok: boolean; event: MilestoneRecord }>(base, `/api/v2/events/${eventId}`);
    expect(body.event.kind).toBe("milestone");
    expect(body.event.type).toBe("pre-merge-gate");
    expect(body.event.outcome).toBe("fail");
    expect(body.event.scope).toBe("full");
    expect(body.event.suites).toEqual(suites);
  });

  test("a scoped gate's failing entry that could not report keeps its counts absent on the read", async () => {
    const base = boot();
    const key = await createProject(base, "gate-scope-suites-scoped-uncounted");
    const suites = [{ target: "python", outcome: "fail" }];

    const res = await postJson(base, "/api/v2/milestones", gateMilestone(key, { scope: "scoped", suites }));
    expect(res.status).toBe(201);

    const read = await preMergeGateMilestones(base, key);
    expect(read.totalCount).toBe(1);
    const record = read.milestones[0]!;
    expect(record.scope).toBe("scoped");
    expect(record.suites).toEqual([{ target: "python", outcome: "fail" }]);
    const entry = (record.suites as Record<string, unknown>[])[0]!;
    expect("passed" in entry).toBe(false);
    expect("failed" in entry).toBe(false);
  });

  test("a green scoped gate with one passing suite reads back its scope and its single entry", async () => {
    const base = boot();
    const key = await createProject(base, "gate-scope-suites-scoped-green");
    const suites = [{ target: "python", outcome: "pass", passed: 4523, failed: 0 }];

    const res = await postJson(
      base,
      "/api/v2/milestones",
      gateMilestone(key, { outcome: "pass", passed: 4523, failed: 0, failingTests: undefined, scope: "scoped", suites }),
    );
    expect(res.status).toBe(201);

    const read = await preMergeGateMilestones(base, key);
    expect(read.totalCount).toBe(1);
    const record = read.milestones[0]!;
    expect(record.outcome).toBe("pass");
    expect(record.scope).toBe("scoped");
    expect(record.suites).toEqual(suites);
  });

  test("a gate milestone posted without scope or suites is stored and read back exactly as before, with neither key", async () => {
    const base = boot();
    const key = await createProject(base, "gate-scope-suites-absent");

    const res = await postJson(base, "/api/v2/milestones", gateMilestone(key));
    expect(res.status).toBe(201);

    const read = await preMergeGateMilestones(base, key);
    expect(read.totalCount).toBe(1);
    const record = read.milestones[0]!;
    expect(record.type).toBe("pre-merge-gate");
    expect(record.label).toBe("CR-XYZ-001");
    expect(record.outcome).toBe("fail");
    expect(record.passed).toBe(8634);
    expect(record.failed).toBe(1);
    expect(record.failingTests).toEqual(["python::test_setup_defect"]);
    expect("scope" in record).toBe(false);
    expect("suites" in record).toBe(false);
  });
});

// Each ill-formed case is posted beside a well-formed verdict and a
// well-formed counterpart field, so the ONLY defect in the body is the one the
// case names.
const ILL_FORMED_SCOPES: [string, unknown][] = [
  ["a scope that is neither full nor scoped (partial)", "partial"],
  ["a numeric scope", 1],
  ["an empty scope", ""],
];

const ILL_FORMED_SUITES: [string, unknown][] = [
  ["suites that is an object, not a list", { target: "bun", outcome: "pass", passed: 1, failed: 0 }],
  ["suites that is a string, not a list", "bun"],
  ["an entry that is not an object", ["bun"]],
  ["an entry with an empty target", [{ target: "", outcome: "pass", passed: 1, failed: 0 }]],
  ["an entry with no target", [{ outcome: "pass", passed: 1, failed: 0 }]],
  ["an entry whose target is not a string", [{ target: 7, outcome: "pass", passed: 1, failed: 0 }]],
  ["an entry whose outcome is neither pass nor fail (maybe)", [{ target: "bun", outcome: "maybe", passed: 1, failed: 0 }]],
  ["an entry with no outcome", [{ target: "bun", passed: 1, failed: 0 }]],
  ["an entry stating passed without failed", [{ target: "bun", outcome: "fail", passed: 3 }]],
  ["an entry stating failed without passed", [{ target: "bun", outcome: "fail", failed: 1 }]],
  ["a passing entry with its counts absent", [{ target: "bun", outcome: "pass" }]],
  ["an entry with a negative count", [{ target: "bun", outcome: "fail", passed: 3, failed: -1 }]],
  ["an entry with a non-integer count", [{ target: "bun", outcome: "pass", passed: 1.5, failed: 0 }]],
  ["an entry with a count given as a string", [{ target: "bun", outcome: "pass", passed: "3", failed: 0 }]],
  ["an entry whose failingTests is a string, not a list", [{ target: "bun", outcome: "fail", passed: 3, failed: 1, failingTests: "t1" }]],
  ["an entry whose failingTests holds a non-string", [{ target: "bun", outcome: "fail", passed: 3, failed: 1, failingTests: [1] }]],
  [
    "one well-formed entry beside one ill-formed entry",
    [
      { target: "bun", outcome: "pass", passed: 4111, failed: 0 },
      { target: "python", outcome: "maybe", passed: 4522, failed: 1 },
    ],
  ],
];

async function expectRefusedAndNothingRecorded(base: string, key: string, body: Record<string, unknown>) {
  const res = await postJson(base, "/api/v2/milestones", body);
  expect(res.status).toBe(400);
  const err = (await res.json()) as { ok: boolean; error?: unknown };
  expect(err.ok).toBe(false);
  expect(typeof err.error).toBe("string");

  const read = await preMergeGateMilestones(base, key);
  expect(read.totalCount).toBe(0);
  expect(read.milestones).toEqual([]);
  expect(await milestoneEventCount(base, key)).toBe(0);
}

describe("a pre-merge-gate milestone with an ill-formed scope is refused with 400 and nothing recorded", () => {
  for (const [name, scope] of ILL_FORMED_SCOPES) {
    test(`${name} is refused and no milestone is recorded`, async () => {
      const base = boot();
      const key = await createProject(base, "gate-scope-ill-formed");
      await expectRefusedAndNothingRecorded(base, key, gateMilestone(key, { scope, suites: wellFormedSuites() }));
    });
  }
});

describe("a pre-merge-gate milestone with ill-formed suites is refused whole with 400 and nothing recorded", () => {
  for (const [name, suites] of ILL_FORMED_SUITES) {
    test(`${name} is refused and no milestone is recorded`, async () => {
      const base = boot();
      const key = await createProject(base, "gate-suites-ill-formed");
      await expectRefusedAndNothingRecorded(base, key, gateMilestone(key, { scope: "full", suites }));
    });
  }
});

describe("health states that the board records a gate's scope and suites", () => {
  for (const route of ["/api/health", "/api/v2/health"]) {
    test(`GET ${route} carries milestones.gate naming scope and suites beside codecs`, async () => {
      const base = boot();
      const body = await getJson<Record<string, unknown>>(base, route);
      expect(body.ok).toBe(true);
      expect(body.milestones).toEqual({ gate: ["scope", "suites"] });
      expect(body.codecs).toEqual({ test: ["junit", "playwright"], coverage: ["jacoco", "lcov"] });
    });
  }
});

// The well-formed rule's remaining cases: an empty `suites` and a `null` for
// either field are ill-formed; `suites` may come without `scope`; an entry's
// `failingTests` keeps only its non-empty members and an entry keeps only its
// own keys; and a verdict that is not well-formed drops `scope` and `suites`
// with today's gate fields.
describe("the well-formed rule's remaining cases for a gate's scope and suites", () => {
  test("an empty suites list is refused and no milestone is recorded", async () => {
    const base = boot();
    const key = await createProject(base, "gate-suites-empty");
    await expectRefusedAndNothingRecorded(base, key, gateMilestone(key, { scope: "full", suites: [] }));
  });

  test("a null scope is refused and no milestone is recorded", async () => {
    const base = boot();
    const key = await createProject(base, "gate-scope-null");
    await expectRefusedAndNothingRecorded(base, key, gateMilestone(key, { scope: null, suites: wellFormedSuites() }));
  });

  test("a null suites is refused and no milestone is recorded", async () => {
    const base = boot();
    const key = await createProject(base, "gate-suites-null");
    await expectRefusedAndNothingRecorded(base, key, gateMilestone(key, { scope: "full", suites: null }));
  });

  test("suites posted without scope are stored and read back with suites and no scope", async () => {
    const base = boot();
    const key = await createProject(base, "gate-suites-without-scope");
    const suites = wellFormedSuites();

    const res = await postJson(base, "/api/v2/milestones", gateMilestone(key, { suites }));
    expect(res.status).toBe(201);

    const read = await preMergeGateMilestones(base, key);
    expect(read.totalCount).toBe(1);
    const record = read.milestones[0]!;
    expect(record.outcome).toBe("fail");
    expect(record.suites).toEqual(suites);
    expect("scope" in record).toBe(false);
  });

  test("an entry's failingTests keeps only its non-empty names", async () => {
    const base = boot();
    const key = await createProject(base, "gate-suites-empty-failing-name");
    const suites = [
      { target: "python", outcome: "fail", passed: 4522, failed: 1, failingTests: ["", "python::test_setup_defect"] },
    ];

    const res = await postJson(base, "/api/v2/milestones", gateMilestone(key, { scope: "full", suites }));
    expect(res.status).toBe(201);

    const read = await preMergeGateMilestones(base, key);
    expect(read.totalCount).toBe(1);
    expect(read.milestones[0]!.suites).toEqual([
      { target: "python", outcome: "fail", passed: 4522, failed: 1, failingTests: ["python::test_setup_defect"] },
    ]);
  });

  test("an entry with an unknown key is stored without that key", async () => {
    const base = boot();
    const key = await createProject(base, "gate-suites-unknown-key");
    const suites = [{ target: "bun", outcome: "pass", passed: 4111, failed: 0, coveredBy: "bun" }];

    const res = await postJson(base, "/api/v2/milestones", gateMilestone(key, { scope: "full", suites }));
    expect(res.status).toBe(201);

    const read = await preMergeGateMilestones(base, key);
    expect(read.totalCount).toBe(1);
    const entry = (read.milestones[0]!.suites as Record<string, unknown>[])[0]!;
    expect(entry).toEqual({ target: "bun", outcome: "pass", passed: 4111, failed: 0 });
    expect("coveredBy" in entry).toBe(false);
  });

  test("scope and suites beside a verdict that is not well-formed are recorded as today: the milestone without the gate fields, scope or suites", async () => {
    const base = boot();
    const key = await createProject(base, "gate-scope-suites-ill-formed-verdict");

    const res = await postJson(
      base,
      "/api/v2/milestones",
      gateMilestone(key, { outcome: "maybe", scope: "full", suites: wellFormedSuites() }),
    );
    expect(res.status).toBe(201);

    const read = await preMergeGateMilestones(base, key);
    expect(read.totalCount).toBe(1);
    const record = read.milestones[0]!;
    expect(record.type).toBe("pre-merge-gate");
    expect("outcome" in record).toBe(false);
    expect("passed" in record).toBe(false);
    expect("failed" in record).toBe(false);
    expect("failingTests" in record).toBe(false);
    expect("scope" in record).toBe(false);
    expect("suites" in record).toBe(false);
  });
});
