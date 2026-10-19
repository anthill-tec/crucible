// An idle agent's badge names its cycle by the cycle's PLACE in its plan —
// `idle · <role> · <CR> · cycle <n>/<m> · …` — never by the board-wide cycle
// id its row stores, which counts every cycle ever filed in the project and
// says nothing about where the agent is in its CR.
//
// Driven against a real board: `startServer` on an in-memory store, seeded
// only through the production HTTP routes (register, release-propose,
// plan-file, cycle transitions, runs). The server composes the line at the
// agents read; the SPA's agent row renders it. The DOM half mounts the real
// shell (public/app.js) in happy-dom with its `fetch` forwarded to that same
// real server — no scripted payload, no hand-built line — and reads the
// agent row beside the roadmap lane badge, whose `cycle a/b` the badge must
// agree with while the bound cycle is the active one.
//
// The board is seeded so ids and places cannot be confused: a seven-cycle
// neighbour plan is filed FIRST, so the subject plan's second cycle carries
// board-wide id 9 while its place is 2 of 5.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import { settleDom } from "./helpers/dom-settle";

const REAL_FETCH = globalThis.fetch;
// The server runs in THIS process, so its handlers build their answers from
// the global `Response`. happy-dom's registration replaces the fetch-family
// globals with its own classes, which Bun's server refuses to send; they are
// put back to Bun's own after each registration so the real server keeps
// answering while the shell reads it.
const BUN_FETCH_GLOBALS = {
  Response: globalThis.Response,
  Request: globalThis.Request,
  Headers: globalThis.Headers,
};
const handles: ServerHandle[] = [];

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  globalThis.fetch = REAL_FETCH;
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  handles.push(handle);
  return handle;
}

function base(handle: ServerHandle): string {
  return `http://127.0.0.1:${handle.server.port}`;
}

async function send(
  handle: ServerHandle,
  method: "POST" | "PATCH",
  route: string,
  body: unknown,
): Promise<Response> {
  return REAL_FETCH(`${base(handle)}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(handle: ServerHandle, route: string): Promise<Record<string, unknown>> {
  const res = await REAL_FETCH(`${base(handle)}${route}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

interface AgentBrief {
  agentId: string;
  message: string;
  boundCycleId?: number;
  idleLine?: string;
  [key: string]: unknown;
}

async function agentById(handle: ServerHandle, key: string, agentId: string): Promise<AgentBrief> {
  const body = await getJson(handle, `/api/v2/agents?project=${key}`);
  const found = (body.agents as AgentBrief[]).find((a) => a.agentId === agentId);
  if (found === undefined) throw new Error(`no agent ${agentId} on the agents read`);
  return found;
}

// ── the board ───────────────────────────────────────────────────────────────

const ORCH = "fixture-orch";
const RELEASE = "0.9.0";
const TARGET_AT = 1_788_220_800;
const SUBJECT_CR = "badge-subject";
const NEIGHBOUR_CR = "badge-neighbour";

interface Board {
  key: string;
  subjectPlanId: number;
  subjectCycleIds: number[];
  neighbourPlanId: number;
  neighbourCycleIds: number[];
}

async function filePlan(
  handle: ServerHandle,
  key: string,
  cr: string,
  track: string,
  cycleCount: number,
): Promise<{ planId: number; cycleIds: number[] }> {
  const res = await send(handle, "POST", `/api/v2/projects/${key}/plans`, {
    cr,
    title: `${cr} title`,
    wave: "1",
    release: RELEASE,
    track,
    agentId: ORCH,
    cycles: Array.from({ length: cycleCount }, (_, i) => ({ label: `C${i + 1}` })),
  });
  expect(res.status).toBe(201);
  const plan = (await res.json()) as { planId: number; cycles: { id: number }[] };
  return { planId: plan.planId, cycleIds: plan.cycles.map((c) => c.id) };
}

async function setCycle(
  handle: ServerHandle,
  key: string,
  planId: number,
  cycleId: number,
  status: "active" | "done",
): Promise<void> {
  const res = await send(handle, "PATCH", `/api/v2/projects/${key}/plans/${planId}/cycles/${cycleId}`, {
    status,
    agentId: ORCH,
  });
  expect(res.status).toBe(200);
}

/** Two open plans on two lanes (so the roadmap shows lane badges): the
 *  neighbour (seven cycles, filed first) and the subject (five cycles), whose
 *  first cycle is done and whose SECOND is the active one. */
async function seedBoard(handle: ServerHandle): Promise<Board> {
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name: "Badge Project", type: "backend", sutRoot: "/tmp/badge" });
  const reg = await send(handle, "POST", "/api/v2/agents/register", {
    projectKey: key,
    agentId: ORCH,
    role: "ORCHESTRATOR",
  });
  expect(reg.status).toBe(200);
  const proposed = await send(handle, "POST", `/api/v2/projects/${key}/release-proposals`, {
    label: RELEASE,
    targetAt: TARGET_AT,
    agentId: ORCH,
  });
  expect(proposed.status).toBe(200);
  const neighbour = await filePlan(handle, key, NEIGHBOUR_CR, "track-2", 7);
  const subject = await filePlan(handle, key, SUBJECT_CR, "track-1", 5);
  await setCycle(handle, key, subject.planId, subject.cycleIds[0]!, "active");
  await setCycle(handle, key, subject.planId, subject.cycleIds[0]!, "done");
  await setCycle(handle, key, subject.planId, subject.cycleIds[1]!, "active");
  return {
    key,
    subjectPlanId: subject.planId,
    subjectCycleIds: subject.cycleIds,
    neighbourPlanId: neighbour.planId,
    neighbourCycleIds: neighbour.cycleIds,
  };
}

async function registerBound(
  handle: ServerHandle,
  key: string,
  agentId: string,
  role: string,
  cycleId: number,
): Promise<void> {
  const res = await send(handle, "POST", "/api/v2/agents/register", {
    projectKey: key,
    agentId,
    role,
    cycleId,
  });
  expect(res.status).toBe(200);
}

async function ingestPassingRun(handle: ServerHandle, key: string, agentId: string): Promise<void> {
  const started = await send(handle, "POST", "/api/v2/runs/start", { projectKey: key, agentId });
  expect(started.status).toBe(202);
  const { runId } = (await started.json()) as { runId: string };
  const parsed = await send(handle, "POST", "/api/v2/runs/parsed", {
    projectKey: key,
    agentId,
    runId,
    summary: { total: 3, passed: 3, failed: 0, pending: 0, duration_ms: 9 },
    tree: [{ name: "suite", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 9 }] }],
  });
  expect(parsed.status).toBe(200);
}

/** This codebase's one relative-age convention: "just now" under 10s, else `Ns/Nm/Nh/Nd ago`. */
const AGE_TAIL = "(just now|\\d+[smhd] ago)";

// ── the real SPA, reading the real server ───────────────────────────────────

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"),
  "utf8",
);
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");
let cacheBust = 0;

/** Mounts the production shell on the project's roadmap, every read it makes
 *  forwarded to the real server. */
async function mountAgainst(handle: ServerHandle, pathname: string): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  Object.assign(globalThis, BUN_FETCH_GLOBALS);
  document.body.innerHTML = '<div id="app"></div>';
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((input: string, init?: RequestInit) =>
    REAL_FETCH(`${base(handle)}${String(input)}`, init)) as typeof fetch;
  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?agentIdleLineCyclePlace=${cacheBust}`);
  (0, eval)(APP_JS_SRC);
  await settleDom({ ticks: 8 });
}

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settleDom({ ticks: 2, stepMs: 25 });
  }
}

function agentRowText(agentId: string): string | undefined {
  const row = Array.from(document.querySelectorAll('[data-testid="agent-row"]')).find((el) =>
    (el.textContent ?? "").includes(agentId),
  );
  const msg = row?.querySelector(".app-agent-msg");
  const text = (msg?.textContent ?? "").trim();
  return text.startsWith("idle ·") ? text : undefined;
}

function laneBadgeText(cr: string): string | undefined {
  const row = document.querySelector(`[data-testid="roadmap-row"][data-cr="${cr}"]`);
  const badge = row?.querySelector('[data-testid="roadmap-lane-badge"]');
  const text = (badge?.textContent ?? "").trim();
  return text.length > 0 ? text : undefined;
}

describe("the idle badge names the bound cycle's place in its plan", () => {
  test("the agents read composes `idle · <role> · <CR> · cycle 2/5 · …` for an agent bound to the second of five cycles — never the board-wide id", async () => {
    const handle = boot();
    const board = await seedBoard(handle);
    const boundId = board.subjectCycleIds[1]!;
    // The seeding did what it claims: the board-wide id is not the place.
    expect(boundId).toBe(9);
    await registerBound(handle, board.key, "green-badge", "GREEN", boundId);

    const agent = await agentById(handle, board.key, "green-badge");
    expect(agent.boundCycleId).toBe(boundId);
    expect(agent.idleLine).toBe(`idle · GREEN · ${SUBJECT_CR} · cycle 2/5 · seen just now`);
    expect(agent.idleLine).not.toMatch(new RegExp(`cycle ${boundId}\\b`));
    expect(agent.idleLine).not.toContain(`#${boundId}`);
    expect(agent.idleLine).not.toContain(NEIGHBOUR_CR);
  });

  test("two agents bound to cycles of different plans each read their OWN plan's CR and place", async () => {
    const handle = boot();
    const board = await seedBoard(handle);
    await setCycle(handle, board.key, board.neighbourPlanId, board.neighbourCycleIds[0]!, "active");
    await registerBound(handle, board.key, "green-badge", "GREEN", board.subjectCycleIds[1]!);
    await registerBound(handle, board.key, "red-neighbour", "RED", board.neighbourCycleIds[0]!);

    expect((await agentById(handle, board.key, "green-badge")).idleLine).toBe(
      `idle · GREEN · ${SUBJECT_CR} · cycle 2/5 · seen just now`,
    );
    expect((await agentById(handle, board.key, "red-neighbour")).idleLine).toBe(
      `idle · RED · ${NEIGHBOUR_CR} · cycle 1/7 · seen just now`,
    );
  });

  test("the place holds whatever the bound cycle's status: once it is done and the next is active, the bound agent still reads `cycle 2/5`", async () => {
    const handle = boot();
    const board = await seedBoard(handle);
    await registerBound(handle, board.key, "green-badge", "GREEN", board.subjectCycleIds[1]!);
    await ingestPassingRun(handle, board.key, "green-badge");
    await setCycle(handle, board.key, board.subjectPlanId, board.subjectCycleIds[1]!, "done");
    await setCycle(handle, board.key, board.subjectPlanId, board.subjectCycleIds[2]!, "active");

    const agent = await agentById(handle, board.key, "green-badge");
    expect(agent.boundCycleId).toBe(board.subjectCycleIds[1]!);
    expect(agent.idleLine).toMatch(
      new RegExp(`^idle · GREEN · ${SUBJECT_CR} · cycle 2/5 · last run 3 ✓ 0 ✗ · ingested, ${AGE_TAIL}$`),
    );
    // NEGATIVE — not the plan's now-active place, not the board-wide id.
    expect(agent.idleLine).not.toContain("cycle 3/5");
    expect(agent.idleLine).not.toMatch(new RegExp(`cycle ${board.subjectCycleIds[1]!}\\b`));
  });

  test(
    "in the DOM the bound agent's row reads `idle · GREEN · <CR> · cycle 2/5 · last run …` — the same 2/5 the roadmap lane shows — and the unbound orchestrator's row reads `no cycle bound`",
    async () => {
      const handle = boot();
      const board = await seedBoard(handle);
      const boundId = board.subjectCycleIds[1]!;
      await registerBound(handle, board.key, "green-badge", "GREEN", boundId);
      await ingestPassingRun(handle, board.key, "green-badge");

      await mountAgainst(handle, `/p/${board.key}/roadmap`);

      const lane = await waitFor("the subject's roadmap lane badge", () => laneBadgeText(SUBJECT_CR));
      const row = await waitFor("the bound agent's idle row", () => agentRowText("green-badge"));
      const orchRow = await waitFor("the orchestrator's idle row", () => agentRowText(ORCH));

      // The lane names the active cycle's place.
      expect(lane).toContain("track-1");
      expect(lane).toContain("cycle 2/5");
      // POSITIVE — the row reads the server's new line, exactly.
      expect(row).toMatch(
        new RegExp(`^idle · GREEN · ${SUBJECT_CR} · cycle 2/5 · last run 3 ✓ 0 ✗ · ingested, ${AGE_TAIL}$`),
      );
      // The badge and the lane agree on the place.
      expect(row.match(/cycle (\d+\/\d+)/)?.[1]).toBe(lane.match(/cycle (\d+\/\d+)/)?.[1]);
      // NEGATIVE — never the board-wide id.
      expect(row).not.toMatch(new RegExp(`cycle ${boundId}\\b`));
      expect(row).not.toContain(`#${boundId}`);
      // An unbound agent still reads `no cycle bound`, and no CR.
      expect(orchRow).toBe("idle · ORCHESTRATOR · no cycle bound · seen just now");
      expect(orchRow).not.toContain(SUBJECT_CR);
    },
    20_000,
  );
});
