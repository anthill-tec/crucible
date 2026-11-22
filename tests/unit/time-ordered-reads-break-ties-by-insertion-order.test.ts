// Time-ordered store reads break a timestamp tie by insertion order.
//
// Six `Store` reads (`listProjects`, both `listAgents` queries, both
// `listOpenRuns` queries and `sweepOpenRuns`) order rows by a millisecond
// timestamp. When two rows share that millisecond, the order they come back
// in must be the order they were written, in the read's own direction — never
// whatever the query plan happens to produce.
//
// Every test here:
//   - runs on `new Store(":memory:")`;
//   - pins the clock with `setSystemTime`, restored in `afterEach`;
//   - writes rows only through the store's own methods;
//   - gives its rows keys (project keys, agent ids, run ids) that sort the
//     OPPOSITE way to the order it asserts, so the answer cannot come from key
//     order. Run ids are minted by `startRun` from `crypto.randomUUID`, so the
//     run tests script that one seam with `spyOn` to choose them.
//
// The sweep reads the server's limits from the `crucible.toml` beside the
// resolved store path; its describe points `CRUCIBLE_DB` at a fresh temp dir
// so no operator file is ever read. No database at that path is opened.
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/store.ts";

/** The one millisecond every row in a test is written in. */
const TIED_AT = 1_700_000_000_000;

type Uuid = ReturnType<typeof crypto.randomUUID>;

/** A run id that sorts FIRST by key. */
const LOW_UUID: Uuid = "00000000-0000-4000-8000-000000000000";
/** A run id that sorts LAST by key. */
const HIGH_UUID: Uuid = "ffffffff-ffff-4fff-bfff-ffffffffffff";

const restorers: Array<() => void> = [];

afterEach(() => {
  setSystemTime();
  for (const restore of restorers.splice(0).reverse()) restore();
});

/** Script the run ids `startRun` mints, in order; any extra mint fails loudly. */
function scriptRunIds(...uuids: Uuid[]): void {
  const queue = [...uuids];
  const spy = spyOn(crypto, "randomUUID").mockImplementation((): Uuid => {
    const next = queue.shift();
    if (next === undefined) throw new Error("more run ids were minted than the test scripted");
    return next;
  });
  restorers.push(() => spy.mockRestore());
}

function addProject(store: Store, key: string): void {
  store.addProject({ key, name: key, type: "backend", sutRoot: "/tmp" });
}

describe("listProjects breaks a created-at tie by insertion order, oldest first", () => {
  test("two projects created in the same millisecond list in the order they were created", () => {
    const store = new Store(":memory:");
    setSystemTime(TIED_AT);
    // Created first, yet its key sorts last.
    addProject(store, "zz-project");
    addProject(store, "aa-project");

    const projects = store.listProjects();

    expect(projects.map((p) => p.createdAt)).toEqual([TIED_AT, TIED_AT]);
    expect(projects.map((p) => p.key)).toEqual(["zz-project", "aa-project"]);
  });
});

describe("listAgents breaks a last-seen tie by registration order, newest-registered first", () => {
  test("across all projects, two agents seen in the same millisecond list newest-registered first", () => {
    const store = new Store(":memory:");
    setSystemTime(TIED_AT);
    addProject(store, "aa-project");
    addProject(store, "zz-project");
    // Registered first, and its project key and agent id both sort first.
    store.touchAgent("aa-project", "aa-agent");
    store.touchAgent("zz-project", "zz-agent");

    const agents = store.listAgents();

    expect(agents.map((a) => a.lastSeen)).toEqual([TIED_AT, TIED_AT]);
    expect(agents.map((a) => [a.projectKey, a.agentId])).toEqual([
      ["zz-project", "zz-agent"],
      ["aa-project", "aa-agent"],
    ]);
  });

  test("within one project, two agents seen in the same millisecond list newest-registered first", () => {
    const store = new Store(":memory:");
    setSystemTime(TIED_AT);
    addProject(store, "the-project");
    // Registered first, and its agent id sorts first.
    store.touchAgent("the-project", "aa-agent");
    store.touchAgent("the-project", "zz-agent");

    const agents = store.listAgents("the-project");

    expect(agents.map((a) => a.lastSeen)).toEqual([TIED_AT, TIED_AT]);
    expect(agents.map((a) => a.agentId)).toEqual(["zz-agent", "aa-agent"]);
  });

  test("a heartbeat from the older agent in the same millisecond does not move it ahead of the newer one", () => {
    const store = new Store(":memory:");
    setSystemTime(TIED_AT);
    addProject(store, "the-project");
    store.touchAgent("the-project", "aa-agent");
    store.touchAgent("the-project", "zz-agent");
    // The older agent heartbeats after the newer one registered: its row is
    // updated last, but it was still created first.
    store.touchAgent("the-project", "aa-agent", { status: "busy", message: "running tests" });

    const agents = store.listAgents("the-project");

    expect(agents.map((a) => a.lastSeen)).toEqual([TIED_AT, TIED_AT]);
    expect(agents.map((a) => [a.agentId, a.status, a.message])).toEqual([
      ["zz-agent", "online", ""],
      ["aa-agent", "busy", "running tests"],
    ]);
  });
});

describe("listOpenRuns breaks a started-at tie by insertion order, newest first", () => {
  test("across all projects, two runs started in the same millisecond list the later-started first", () => {
    const store = new Store(":memory:");
    setSystemTime(TIED_AT);
    addProject(store, "aa-project");
    addProject(store, "zz-project");
    // Started first, and its project key, agent id and run id all sort first.
    scriptRunIds(LOW_UUID, HIGH_UUID);
    const earlier = store.startRun("aa-project", "aa-agent");
    const later = store.startRun("zz-project", "zz-agent");
    expect([earlier.runId, later.runId]).toEqual([`run-${LOW_UUID}`, `run-${HIGH_UUID}`]);

    const open = store.listOpenRuns();

    expect(open.map((r) => r.startedAt)).toEqual([TIED_AT, TIED_AT]);
    expect(open.map((r) => [r.runId, r.projectKey, r.agentId])).toEqual([
      [`run-${HIGH_UUID}`, "zz-project", "zz-agent"],
      [`run-${LOW_UUID}`, "aa-project", "aa-agent"],
    ]);
  });

  test("within one project, two runs started in the same millisecond list the later-started first", () => {
    const store = new Store(":memory:");
    setSystemTime(TIED_AT);
    addProject(store, "the-project");
    // Started first, and its agent id and run id both sort first.
    scriptRunIds(LOW_UUID, HIGH_UUID);
    store.startRun("the-project", "aa-agent");
    store.startRun("the-project", "zz-agent");

    const open = store.listOpenRuns("the-project");

    expect(open.map((r) => r.startedAt)).toEqual([TIED_AT, TIED_AT]);
    expect(open.map((r) => [r.runId, r.agentId])).toEqual([
      [`run-${HIGH_UUID}`, "zz-agent"],
      [`run-${LOW_UUID}`, "aa-agent"],
    ]);
  });
});

describe("sweepOpenRuns aborts runs started in one millisecond in the order they started", () => {
  let savedDb: string | undefined;
  let configDir = "";

  beforeEach(() => {
    // The limits resolve beside CRUCIBLE_DB: a fresh, empty dir, so only the
    // shipped defaults apply and no operator file is read.
    configDir = mkdtempSync(join(tmpdir(), "tied-sweep-"));
    savedDb = process.env.CRUCIBLE_DB;
    process.env.CRUCIBLE_DB = join(configDir, "crucible.db");
  });

  afterEach(() => {
    if (savedDb === undefined) delete process.env.CRUCIBLE_DB;
    else process.env.CRUCIBLE_DB = savedDb;
    rmSync(configDir, { recursive: true, force: true });
  });

  test("the earlier-started run is aborted first, and the event feed lists the later-started run's abort first", () => {
    const store = new Store(":memory:");
    setSystemTime(TIED_AT);
    addProject(store, "the-project");
    // Started first, yet its run id sorts last; its agent id sorts first.
    scriptRunIds(HIGH_UUID, LOW_UUID);
    const earlier = store.startRun("the-project", "aa-agent");
    const later = store.startRun("the-project", "zz-agent");
    expect([earlier.runId, later.runId]).toEqual([`run-${HIGH_UUID}`, `run-${LOW_UUID}`]);
    // Both runners are gone, so the sweep aborts both runs in this millisecond.
    store.removeAgent("the-project", "aa-agent");
    store.removeAgent("the-project", "zz-agent");

    const aborted = store.sweepOpenRuns(TIED_AT);

    expect(aborted.map((e) => [e.agentId, e.startedAt, e.timestamp, e.status, e.abortReason])).toEqual([
      ["aa-agent", TIED_AT, TIED_AT, "aborted", "agent died"],
      ["zz-agent", TIED_AT, TIED_AT, "aborted", "agent died"],
    ]);
    expect(store.getRun(earlier.runId)?.eventId).toBe(aborted[0]!.id);
    expect(store.getRun(later.runId)?.eventId).toBe(aborted[1]!.id);
    expect(store.listOpenRuns("the-project")).toEqual([]);

    const feed = store.listEvents("the-project");

    expect(feed.map((e) => [e.id, e.agentId])).toEqual([
      [aborted[1]!.id, "zz-agent"],
      [aborted[0]!.id, "aa-agent"],
    ]);
  });
});
