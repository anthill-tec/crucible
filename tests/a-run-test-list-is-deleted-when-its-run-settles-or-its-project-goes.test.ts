// A run's stored test list (`run_test_lists`) lives only as long as the open
// run it was given to — on a real server (`startServer`, port 0, ":memory:"):
//  - the close (`POST /api/v2/runs` naming `nextest`) deletes it;
//  - an abort deletes it, by the client's own `POST /api/v2/runs/<runId>/abort`
//    and by the sweep (`Store#sweepOpenRuns` driven with a `now`), whether the
//    run streamed or not;
//  - a project's cascade delete (`DELETE /api/v2/projects/<key>`, archived
//    and `userApproved: true`) deletes its runs' lists, and leaves another
//    project's list alone.
//
// Each test first reads the list held (one row), so its absence after is
// never vacuous.
import { describe, test, expect, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { shippedLimits } from "../src/limits.ts";
import type { ServerHandle } from "../src/server.ts";
import {
  closeNextest,
  listOf,
  postList,
  streamNextest,
  suiteStarted,
  testName,
  testOk,
} from "./helpers/nextest-harness.ts";
import { base, bootOn, openRun, postJson, readyProject, register } from "./helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

const AGENT = "list-holder";
const CRATE = "nxlife";

/** Two matched lib tests: a listed total of 2. */
const LIST = listOf([
  {
    crate: CRATE,
    binaryName: CRATE,
    kind: "lib",
    tests: [
      { path: "tests::a", matches: true },
      { path: "tests::b", matches: true },
    ],
  },
]);

/** Both listed tests, passing: the stream the close reads. */
const STREAM =
  suiteStarted(CRATE, CRATE, "lib", 2) +
  testOk(testName(CRATE, CRATE, "tests::a"), 0.001) +
  testOk(testName(CRATE, CRATE, "tests::b"), 0.002);

function dbOf(handle: ServerHandle): Database {
  return (handle.store as unknown as { db: Database }).db;
}

/** The run's rows in `run_test_lists`. */
function listRows(handle: ServerHandle, runId: string): number {
  return dbOf(handle)
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM run_test_lists WHERE run_id = ?")
    .get(runId)!.n;
}

interface Subject {
  handle: ServerHandle;
  key: string;
  runId: string;
}

interface Liveness {
  staleAfterMs: number;
  tombstoneAfterMs: number;
  pruneAfterMs: number;
}

const ABANDON_MS = shippedLimits().run_abandon_ms?.recommended ?? 3_600_000;

/** Liveness windows far past the abandon deadline: the sweep can only find the run abandoned. */
const NEVER_TOMBSTONED: Liveness = {
  staleAfterMs: ABANDON_MS * 10,
  tombstoneAfterMs: ABANDON_MS * 20,
  pruneAfterMs: ABANDON_MS * 40,
};

/** An open rust run that has taken its list (one row held), on a project of its own. */
async function runWithAList(handle: ServerHandle, name: string, liveness?: Liveness): Promise<Subject> {
  let key: string;
  if (liveness === undefined) {
    key = await readyProject(handle, [AGENT], name);
  } else {
    key = crypto.randomUUID();
    handle.store.addProject({ key, name, type: "backend", sutRoot: `/tmp/${name}`, liveness });
    await register(handle, key, AGENT);
  }
  const runId = await openRun(handle, key, AGENT, { stack: "rust", tier: "unit" });
  const listed = await postList(handle, runId, key, AGENT, LIST);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  expect(listRows(handle, runId)).toBe(1);
  return { handle, key, runId };
}

async function abortByClient(s: Subject): Promise<void> {
  const res = await postJson(s.handle, `/api/v2/runs/${s.runId}/abort`, {
    projectKey: s.key,
    agentId: AGENT,
    reason: "runner crashed",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(s.handle.store.getRun(s.runId)?.state).toBe("aborted");
}

async function archive(handle: ServerHandle, key: string): Promise<void> {
  const res = await postJson(handle, `/api/v2/projects/${key}/archive`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function deleteProject(handle: ServerHandle, key: string): Promise<number> {
  const res = await fetch(`${base(handle)}/api/v2/projects/${key}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userApproved: true }),
  });
  await res.json();
  return res.status;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("a run's list is gone once the run closes", () => {
  test("a streamed nextest run closed under nextest holds no list row after its close", async () => {
    const s = await runWithAList(boot(), "list-closed");
    await streamNextest(s.handle, s.runId, s.key, AGENT, STREAM);
    const closed = await closeNextest(s.handle, s.key, AGENT, s.runId);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(s.handle.store.getRun(s.runId)?.state).toBe("ended");
    expect(listRows(s.handle, s.runId)).toBe(0);
  });
});

describe("a run's list is gone once the run aborts", () => {
  test("aborted by its client after streaming: no list row is left", async () => {
    const s = await runWithAList(boot(), "list-aborted");
    await streamNextest(s.handle, s.runId, s.key, AGENT, STREAM);
    await abortByClient(s);
    expect(listRows(s.handle, s.runId)).toBe(0);
  });

  test("aborted by its client before any batch: the list it took is not left behind", async () => {
    const s = await runWithAList(boot(), "list-aborted-unstreamed");
    await abortByClient(s);
    expect(listRows(s.handle, s.runId)).toBe(0);
  });

  test("aborted by the sweep as abandoned: no list row is left", async () => {
    const s = await runWithAList(boot(), "list-abandoned", NEVER_TOMBSTONED);
    await streamNextest(s.handle, s.runId, s.key, AGENT, STREAM);
    const startedAt = s.handle.store.getRun(s.runId)?.startedAt as number;
    const aborted = s.handle.store.sweepOpenRuns(startedAt + ABANDON_MS);
    expect(aborted.map((e) => e.abortReason)).toEqual(["abandoned"]);
    expect(listRows(s.handle, s.runId)).toBe(0);
  });
});

describe("a run's list is gone once its project is deleted", () => {
  test("DELETE /api/v2/projects/<key> leaves no list row of its open run, and another project's list stays", async () => {
    const handle = boot();
    const doomed = await runWithAList(handle, "list-doomed");
    await streamNextest(handle, doomed.runId, doomed.key, AGENT, STREAM);
    const kept = await runWithAList(handle, "list-kept");
    await archive(handle, doomed.key);

    expect(await deleteProject(handle, doomed.key)).toBe(200);

    expect(handle.store.getRun(doomed.runId)).toBeNull();
    expect(listRows(handle, doomed.runId)).toBe(0);
    expect(listRows(handle, kept.runId)).toBe(1);
  });
});
