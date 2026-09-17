// CR-CRU-140 §S1 — the route that answers "what did this cycle record" is
// FINDABLE from the product's own output.
//
// THE DEFECT THIS FILE HOLDS SHUT (measured 2026-09-17). The cycle-evidence
// read has existed since CR-CRU-032 §S1, and every ingest has answered with
// the `event: <id>` of what it stored. An orchestrator still could not find
// either: it hand-queried the database, read `runs` (which holds the OPEN
// streaming row, not the ingested result), and published a false accusation
// against an agent that had filed correctly. Nothing was missing from the
// API. The DISCOVERABLE surface simply never named it — the v2 root's help[]
// listed four routes and this was not one of them, and `cycleId=` appeared
// in no document and no client hint.
//
// NOTHING HERE RETYPES A PATH THE CODE DECLARES. The CR's own Risk says a
// hint that drifts is worse than no hint, so every expectation below is READ
// OUT OF `src/v2.ts` at test time:
//
//   the dispatch table       every `req.method === "<M>" && pathname ===
//                            "<p>"` guard in `handleV2`, paired with the
//                            handler it returns;
//   the cycle-evidence       the ONE GET route in that table whose handler
//   route                    branches on a `searchParams.get("…")` key
//                            spelled with "cycle". Its PATH and its QUERY
//                            KEYS both come back from the source, so a
//                            renamed route moves the expectation with it and
//                            a stale hint fails HERE rather than in a
//                            filer's hands.
//
// `handleV2` is an if-chain, not a data structure, so there is no runtime
// route table to enumerate and no registry to import: the chain IS the route
// table. Parsing it — over `jsUncommented`, so a commented-out route can
// never count — is the strongest derivation available. If the dispatch ever
// becomes a real table, `dispatchTable()` is the one thing to replace.
//
// SAFETY. Every server here is `startServer({ port: 0, dbPath: ":memory:" })`
// — an ephemeral process-local instance on an OS-assigned port. The live
// board is never contacted, and `data/crucible.db` is never opened.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { REPO_ROOT, jsUncommented } from "./helpers/source-scan.ts";

// ── the route table, read off the chain that declares it ──────────────────

const V2_CODE = jsUncommented(readFileSync(join(REPO_ROOT, "src", "v2.ts"), "utf8"));
const RUNBOOK = readFileSync(join(REPO_ROOT, "docs", "RUNBOOK.md"), "utf8");

interface DispatchRoute {
  method: string;
  path: string;
  handler: string;
}

/** Every exact-pathname guard in `handleV2`, with the handler it dispatches. */
function dispatchTable(): DispatchRoute[] {
  const re =
    /req\.method === "([A-Z]+)"\s*&&\s*pathname === "(\/api\/v2[^"]*)"\s*\)\s*\{\s*return\s+(\w+)\(/g;
  return [...V2_CODE.matchAll(re)].map((m) => ({
    method: m[1]!,
    path: m[2]!,
    handler: m[3]!,
  }));
}

/** The PREFIX guards (`pathname.startsWith("…")`) — sub-trees, not leaves. */
function dispatchPrefixes(): string[] {
  const re = /pathname\.startsWith\("(\/api\/v2[^"]*)"\)/g;
  return [...new Set([...V2_CODE.matchAll(re)].map((m) => m[1]!))];
}

/** A top-level handler's body, bounded by the next top-level function. */
function handlerBody(name: string): string {
  const start = V2_CODE.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return "";
  const rest = V2_CODE.slice(start + 1);
  const next = rest.search(/\n(?:async\s+)?function\s+\w+\s*\(/);
  return next < 0 ? rest : rest.slice(0, next);
}

interface CycleEvidenceRoute {
  /** The served path, as the dispatch chain spells it. */
  path: string;
  /** The query key that anchors the fetch to one cycle, as the code spells it. */
  cycleKey: string;
  /** Every query key the anchored branch needs — cycle AND project scope. */
  queryKeys: string[];
}

/**
 * The route that answers "what did this cycle record", DERIVED: the GET route
 * whose handler branches on a cycle-spelled search parameter. Exactly one may
 * match — two would make "the" route a lie, and none means the read the whole
 * CR is about has been removed or renamed out from under its own hints.
 */
function cycleEvidenceRoute(): CycleEvidenceRoute {
  const found: CycleEvidenceRoute[] = [];
  for (const route of dispatchTable()) {
    if (route.method !== "GET") continue;
    const keys = [
      ...new Set(
        [...handlerBody(route.handler).matchAll(/searchParams\.get\("([^"]+)"\)/g)].map(
          (m) => m[1]!,
        ),
      ),
    ];
    const cycleKey = keys.find((k) => /cycle/i.test(k));
    if (cycleKey === undefined) continue;
    found.push({
      path: route.path,
      cycleKey,
      queryKeys: keys.filter((k) => /cycle/i.test(k) || /project/i.test(k)),
    });
  }
  expect(found.map((f) => f.path)).toHaveLength(1);
  return found[0]!;
}

/**
 * Does this line of prose name THIS route — the route itself, not one of its
 * children? A plain `includes` is wrong here and was measured wrong: the
 * RED-ingest help already says `GET /api/v2/events/<id> — full failure
 * detail`, and `"/api/v2/events/<id>".includes("/api/v2/events")` is true, so
 * a substring test would count the single-event DETAIL route as the
 * cycle-evidence FEED and report a hint that is not there. The path must end
 * where the path ends: the next character may not continue it.
 */
function namesRoute(text: string, path: string): boolean {
  return new RegExp(`${path.replaceAll("/", "\\/")}(?![A-Za-z0-9_\\-\\/])`).test(text);
}

/** The `/api/v2…` paths a block of prose names, query strings stripped. */
function pathsNamedIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\/api\/v2[A-Za-z0-9_\-<>\/]*/g)].map((m) => m[0]))];
}

/** Does the dispatch chain actually serve this path (leaf or sub-tree)? */
function isServed(path: string): boolean {
  const normalized = path.replace(/\/$/, "");
  return (
    dispatchTable().some((r) => r.path === normalized) ||
    dispatchPrefixes().some((prefix) => path.startsWith(prefix))
  );
}

// ── fixtures ──────────────────────────────────────────────────────────────

const JUNIT_ONE_FAIL = [
  '<testsuite name="Suite1" tests="2">',
  '<testcase name="t1" time="0.01"/>',
  '<testcase name="t2" time="0.02"><failure message="boom">trace</failure></testcase>',
  "</testsuite>",
].join("\n");

interface JsonBody {
  [key: string]: unknown;
}

describe("CR-CRU-140 §S1 — the cycle-evidence route is discoverable", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function base(): string {
    return `http://localhost:${handle!.server.port}`;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${base()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function patchJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${base()}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function readJson(res: Response): Promise<JsonBody> {
    return (await res.json()) as JsonBody;
  }

  async function createProject(name: string): Promise<string> {
    const body = await readJson(await postJson("/api/v2/projects", { name }));
    return (body.project as { key: string }).key;
  }

  async function register(
    projectKey: string,
    agentId: string,
    extra: JsonBody = {},
  ): Promise<void> {
    const res = await postJson("/api/v2/agents/register", {
      projectKey,
      agentId,
      role: "ORCHESTRATOR",
      ...extra,
    });
    expect(res.status).toBe(200);
  }

  /** Files a one-cycle plan through the real routes and activates the cycle. */
  async function activeCycle(projectKey: string, cr: string): Promise<number> {
    const filed = await readJson(
      await postJson(`/api/v2/projects/${projectKey}/plans`, {
        agentId: "fixture-orch",
        cr,
        cycles: [{ label: "solo" }],
      }),
    );
    const planId = filed.planId as number;
    const cycleId = (filed.cycles as Array<{ id: number }>)[0]!.id;
    const activated = await patchJson(
      `/api/v2/projects/${projectKey}/plans/${planId}/cycles/${cycleId}`,
      { agentId: "fixture-orch", status: "active" },
    );
    expect(activated.status).toBe(200);
    return cycleId;
  }

  /**
   * The cycle-evidence read AS THIS REPLY NAMES IT — path and query keys read
   * out of the product's own words, never typed here. Of the hints an evidence
   * reply offers, the reader after "what has this CYCLE recorded" follows the
   * GET whose query speaks of a cycle; the same reply also offers
   * `GET …/events/<id>`, which answers the narrower "what was in THIS run".
   */
  function cycleHintTarget(reply: JsonBody): { path: string; queryKeys: string[] } {
    const help = (reply.help ?? []) as string[];
    const hint = help.find((entry) => /GET\s+\/api\/v2\/\S+\?\S*cycle/i.test(entry));
    expect(hint).toBeDefined();
    const named = /GET\s+(\/api\/v2\/[A-Za-z0-9_\-\/]+)(\?(\S+))?/.exec(hint!);
    expect(named).not.toBeNull();
    const queryKeys = (named![3] ?? "")
      .split("&")
      .filter((pair) => pair.length > 0)
      .map((pair) => pair.split("=")[0]!);
    expect(queryKeys.length).toBeGreaterThan(1);
    return { path: named![1]!, queryKeys };
  }

  /**
   * CR-CRU-140 §S3 — FOLLOW an evidence reply's own hint: call what it names,
   * filling each parameter it names from what the poster already holds. A
   * hint naming a parameter nobody can fill is not followable, and throws
   * here rather than quietly reading the wrong feed.
   */
  async function followCycleHint(
    reply: JsonBody,
    fill: { projectKey: string; cycleId: number },
  ): Promise<JsonBody> {
    const { path, queryKeys } = cycleHintTarget(reply);
    const filled = queryKeys.map((key) => {
      if (/cycle/i.test(key)) return `${key}=${fill.cycleId}`;
      if (/project/i.test(key)) return `${key}=${fill.projectKey}`;
      throw new Error(`the hint names a parameter the caller cannot fill: ${key}`);
    });
    const res = await fetch(`${base()}${path}?${filled.join("&")}`);
    expect(res.status).toBe(200);
    return readJson(res);
  }

  // ── AC1 ─────────────────────────────────────────────────────────────────

  test("GET /api/v2's help[] names the cycle-evidence route AND its cycle query, at the path the dispatch chain actually serves — and names no path the server does not serve", async () => {
    const route = cycleEvidenceRoute();
    // Control: the parser found a real chain, so a silent regex miss cannot
    // make this test pass by measuring nothing.
    expect(dispatchTable().length).toBeGreaterThan(9);
    expect(route.queryKeys.length).toBeGreaterThan(1);

    handle = startServer({ port: 0, dbPath: ":memory:" });
    const body = await readJson(await fetch(`${base()}/api/v2`));
    const help = body.help as string[];

    // POSITIVE — exactly ONE entry advertises the route, and it carries the
    // anchoring query; a path with no `cycleId` beside it sends the reader to
    // the recent-N feed, which is the wrong answer to this question.
    const naming = help.filter((entry) => namesRoute(entry, route.path));
    expect(naming).toHaveLength(1);
    for (const key of route.queryKeys) {
      expect(naming[0]!).toContain(key);
    }

    // NEGATIVE — no orientation entry may name a path this build does not
    // serve. A hint that drifts is worse than no hint (CR Risk).
    const unserved = pathsNamedIn(help.join("\n")).filter((path) => !isServed(path));
    expect(unserved).toEqual([]);
  });

  // ── AC2 ─────────────────────────────────────────────────────────────────
  //
  // Every route that hands back an `event: <id>` must, in the same reply, say
  // how to read that evidence back. The five below were MEASURED (2026-09-17)
  // as the flat POST routes whose success body carries `event`; the sixth
  // test in this block re-measures the whole flat POST surface so a new one
  // cannot appear unhinted and unnoticed.

  interface IngestFixture {
    path: string;
    body: (projectKey: string, agentId: string) => JsonBody;
  }

  const INGEST_ROUTES: IngestFixture[] = [
    {
      path: "/api/v2/runs",
      body: (projectKey, agentId) => ({
        projectKey,
        agentId,
        codec: "junit",
        data: JUNIT_ONE_FAIL,
      }),
    },
    {
      path: "/api/v2/runs/parsed",
      body: (projectKey, agentId) => ({
        projectKey,
        agentId,
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 },
        tree: [{ name: "s", status: "pass", children: [] }],
      }),
    },
    {
      path: "/api/v2/runs/compile",
      body: (projectKey, agentId) => ({
        projectKey,
        agentId,
        errors: "error[E0308]: mismatched types\n --> src/lib.rs:12:5",
      }),
    },
    {
      path: "/api/v2/gates",
      body: (projectKey, agentId) => ({
        projectKey,
        agentId,
        gate: { intent: "no-mistakes", outcome: "passed", steps: [] },
      }),
    },
    {
      path: "/api/v2/milestones",
      body: (projectKey, agentId) => ({
        projectKey,
        agentId,
        type: "gap-analysis",
        label: "CR-CRU-140",
      }),
    },
  ];

  for (const fixture of INGEST_ROUTES) {
    test(`POST ${fixture.path} answers with an event id AND a help[] entry naming the cycle-evidence route to read it back`, async () => {
      const route = cycleEvidenceRoute();
      // This route really is one the chain dispatches as a POST — the list
      // above is checked against the code, never trusted.
      expect(
        dispatchTable().some((r) => r.method === "POST" && r.path === fixture.path),
      ).toBe(true);

      handle = startServer({ port: 0, dbPath: ":memory:" });
      const projectKey = await createProject(`cr140-${fixture.path.replaceAll("/", "-")}`);
      const agentId = "evidence-poster";
      await register(projectKey, agentId);

      const res = await postJson(fixture.path, fixture.body(projectKey, agentId));
      const body = await readJson(res);

      // Precondition: this really is an evidence-returning route.
      expect(res.ok).toBe(true);
      expect(typeof body.event).toBe("string");

      // POSITIVE — the reply that hands back the id says how to read it back,
      // at the derived path, with the query that scopes it to one cycle.
      const help = (body.help ?? []) as string[];
      const naming = help.filter((entry) => namesRoute(entry, route.path));
      expect(naming).toHaveLength(1);
      for (const key of route.queryKeys) {
        expect(naming[0]!).toContain(key);
      }
    });
  }

  test("no OTHER flat POST route answers with an event id — the five hinted above are the whole evidence-returning surface", async () => {
    const hinted = new Set(INGEST_ROUTES.map((f) => f.path));
    const others = dispatchTable()
      .filter((r) => r.method === "POST" && !hinted.has(r.path))
      .map((r) => r.path);
    // Measured 2026-09-17: project create, and the three agent verbs, plus
    // the run-lifecycle opener. None stores evidence under an event id.
    expect(others.length).toBeGreaterThan(3);

    handle = startServer({ port: 0, dbPath: ":memory:" });
    const projectKey = await createProject("cr140-other-posts");

    const bodies: Record<string, JsonBody> = {
      "/api/v2/projects": { name: "cr140-second-project" },
      "/api/v2/agents/register": { projectKey, agentId: "other-post", role: "ORCHESTRATOR" },
      "/api/v2/agents/heartbeat": { projectKey, agentId: "other-post" },
      "/api/v2/runs/start": { projectKey, agentId: "other-post" },
      "/api/v2/agents/unregister": { projectKey, agentId: "other-post" },
    };
    // Every unhinted POST route must be exercised here, or a new one could
    // start returning evidence with nobody the wiser.
    expect([...others].sort()).toEqual(Object.keys(bodies).sort());

    const carryingEvent: string[] = [];
    for (const path of Object.keys(bodies)) {
      const res = await postJson(path, bodies[path]!);
      const body = await readJson(res);
      if (res.ok && typeof body.event === "string") carryingEvent.push(path);
    }
    expect(carryingEvent).toEqual([]);
  });

  // ── AC3 ─────────────────────────────────────────────────────────────────

  test("docs/RUNBOOK.md documents the cycle-evidence route at the path the server actually serves, with its cycle query — and names no /api/v2 path the server does not serve", () => {
    const route = cycleEvidenceRoute();

    // POSITIVE — a documented line names the DERIVED path and every query key
    // the anchored read needs. Derivation rule (CR-CRU-134): the document may
    // not retype what the code declares, so the expectation comes from the
    // dispatch chain and the doc is measured against it.
    const documenting = RUNBOOK.split("\n").filter(
      (line) =>
        namesRoute(line, route.path) && route.queryKeys.every((key) => line.includes(key)),
    );
    expect(documenting.length).toBeGreaterThan(0);

    // NEGATIVE — and nothing in the RUNBOOK sends an operator at a path this
    // build does not serve.
    const unserved = pathsNamedIn(RUNBOOK).filter((path) => !isServed(path));
    expect(unserved).toEqual([]);
  });

  // ── AC4 ─────────────────────────────────────────────────────────────────

  test("a reader following ONLY the ingest reply — its returned id, its echoed cycle and its own hint — reaches exactly that cycle's recorded runs", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const projectKey = await createProject("cr140-end-to-end");
    await register(projectKey, "fixture-orch");
    const cycleId = await activeCycle(projectKey, "CR-CRU-140-E2E");
    await register(projectKey, "e2e-red", { role: "RED", cycleId });

    // STEP 1 — ingest. Everything the reader gets is in this reply.
    const ingest = await readJson(
      await postJson("/api/v2/runs", {
        projectKey,
        agentId: "e2e-red",
        codec: "junit",
        data: JUNIT_ONE_FAIL,
      }),
    );
    const eventId = ingest.event as string;
    expect(typeof eventId).toBe("string");
    expect((ingest.context as { cycleId: number }).cycleId).toBe(cycleId);

    // STEP 2/3 — read the hint and call what it names, filling each parameter
    // it names from the SAME reply. Nothing below is typed by the test: the
    // path and the query keys come out of the product's own words, and the
    // cycle value out of the product's own echo — so a hint naming a
    // parameter this reply cannot supply is not followable, and fails here.
    const answer = await followCycleHint(ingest, {
      projectKey,
      cycleId: (ingest.context as { cycleId: number }).cycleId,
    });

    // STEP 4 — the id the ingest returned is IN the answer, exactly once, and
    // the answer is this cycle's evidence rather than the whole feed.
    expect(answer.ok).toBe(true);
    const events = answer.events as Array<{ id: string }>;
    expect(events.filter((e) => e.id === eventId)).toHaveLength(1);
    expect(events).toHaveLength(1);
    // The cycle's declared boundary rides along, so the reader can see WHICH
    // cycle answered.
    expect((answer.cycle as { id: number }).id).toBe(cycleId);
  });

  // ── §S3 — a route that advertises a read must be VISIBLE to it ───────────
  //
  // Found by VERIFY, not by design. §S1 makes all five event-id-returning
  // routes advertise the cycle-evidence read; for `/milestones` that
  // advertisement was FALSE in the ordinary case, because `handleMilestones`
  // took its context from `eventContext(body)` alone and never asked the seam
  // its two stamped siblings use. A milestone filed by a registered,
  // cycle-BOUND agent was therefore stored with no cycle and did not appear in
  // the read its own reply named — the reply told the reader where to look and
  // the answer was `events: []`. A hint that lies is the exact failure this CR
  // was filed to end.

  // ── §S3 / AC1 ───────────────────────────────────────────────────────────

  test("§S3 — a milestone filed by a cycle-BOUND agent with NO explicit context is returned by the read its own reply advertises", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const projectKey = await createProject("cr140-s3-bound-milestone");
    await register(projectKey, "fixture-orch");
    const cycleId = await activeCycle(projectKey, "CR-CRU-140-S3");
    // The ordinary filer: registered BOUND, exactly as every client registers
    // a TDD agent, and posting the body a client posts — no `context`, because
    // since CR-CRU-094 the SERVER stamps the binding it holds.
    await register(projectKey, "s3-verify", { role: "VERIFY", cycleId });

    const reply = await readJson(
      await postJson("/api/v2/milestones", {
        projectKey,
        agentId: "s3-verify",
        type: "gap-analysis",
        label: "CR-CRU-140",
      }),
    );
    const eventId = reply.event as string;
    expect(typeof eventId).toBe("string");

    // The reader follows the reply's OWN hint — and finds what it was told
    // would be there. This is the call that measured `events: []`.
    const answer = await followCycleHint(reply, { projectKey, cycleId });
    expect(answer.ok).toBe(true);
    const events = answer.events as Array<{ id: string }>;
    expect(events.filter((e) => e.id === eventId)).toHaveLength(1);
  });

  // ── §S3 / AC2 ───────────────────────────────────────────────────────────

  test("§S3 — an explicit body context still WINS on /milestones: its own fields survive the binding stamp, and the milestone lands in the cycle the caller stated", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const projectKey = await createProject("cr140-s3-explicit-context");
    await register(projectKey, "fixture-orch");
    const cycleId = await activeCycle(projectKey, "CR-CRU-140-S3-EXPLICIT");
    await register(projectKey, "s3-explicit", { role: "VERIFY", cycleId });

    const reply = await readJson(
      await postJson("/api/v2/milestones", {
        projectKey,
        agentId: "s3-explicit",
        type: "gap-analysis",
        label: "CR-CRU-140",
        // The caller states its own context, cycle included. The binding is a
        // FALLBACK; it may not flatten what the caller said.
        context: { cycleId, cr: "CR-CRU-140" },
      }),
    );
    const eventId = reply.event as string;
    expect(typeof eventId).toBe("string");

    const answer = await followCycleHint(reply, { projectKey, cycleId });
    const events = answer.events as Array<{ id: string; context?: { cycleId?: number; cr?: string } }>;
    const stored = events.filter((e) => e.id === eventId);
    expect(stored).toHaveLength(1);
    // Both halves of what the caller stated survived: the cycle it named, and
    // the field the binding knows nothing about.
    expect(stored[0]!.context?.cycleId).toBe(cycleId);
    expect(stored[0]!.context?.cr).toBe("CR-CRU-140");
  });

  for (const fixture of INGEST_ROUTES) {
    test(`§S3 — POST ${fixture.path} refuses a body context naming a DIFFERENT cycle than the poster's binding, storing nothing — the stated cycle is never silently re-stamped`, async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const projectKey = await createProject(`cr140-s3-conflict-${fixture.path.replaceAll("/", "-")}`);
      await register(projectKey, "fixture-orch");
      const cycleId = await activeCycle(projectKey, "CR-CRU-140-S3-CONFLICT");
      await register(projectKey, "s3-conflict", { role: "RED", cycleId });

      const before = (
        (await readJson(await fetch(`${base()}/api/v2/events?project=${projectKey}`)))
          .events as unknown[]
      ).length;

      const res = await postJson(fixture.path, {
        ...fixture.body(projectKey, "s3-conflict"),
        context: { cycleId: cycleId + 1000 },
      });
      // One answer for all five: the caller named a cycle, the server holds a
      // different binding, and guessing between them is not an option.
      expect(res.status).toBe(409);
      const body = await readJson(res);
      expect(body.ok).toBe(false);
      expect(body.event).toBeUndefined();

      const after = (
        (await readJson(await fetch(`${base()}/api/v2/events?project=${projectKey}`)))
          .events as unknown[]
      ).length;
      expect(after).toBe(before);
    });
  }

  // ── §S3 / AC3 ───────────────────────────────────────────────────────────

  test("§S3 — every stamped ingest surface resolves its attachment through the ONE `resolveIngestAttach` seam, and none reads the binding for itself", () => {
    // Read off `src/v2.ts`: the five evidence-returning POST routes this file
    // already exercises, matched to the handlers the dispatch chain names. A
    // second, parallel resolution path is a defect (§S3/AC3), so it fails HERE
    // rather than drifting out of step with its siblings later.
    const stamped = dispatchTable().filter(
      (r) => r.method === "POST" && INGEST_ROUTES.some((f) => f.path === r.path),
    );
    expect(stamped).toHaveLength(INGEST_ROUTES.length);
    for (const route of stamped) {
      const body = handlerBody(route.handler);
      // Control: the parser really found this handler's body.
      expect(body.length).toBeGreaterThan(0);
      expect(body).toContain("resolveIngestAttach(");
      // NEGATIVE — the agent row is read ONCE, inside the seam. A handler
      // reaching for the binding itself is the parallel path.
      expect(body).not.toContain("boundCycleId");
    }
  });

  // ── §S3 / AC4 ───────────────────────────────────────────────────────────

  for (const fixture of INGEST_ROUTES) {
    test(`§S3 — POST ${fixture.path} by a cycle-BOUND agent is VISIBLE in the read its own reply advertises`, async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const projectKey = await createProject(`cr140-s3-visible-${fixture.path.replaceAll("/", "-")}`);
      await register(projectKey, "fixture-orch");
      const cycleId = await activeCycle(projectKey, "CR-CRU-140-S3-VISIBLE");
      // Bound, and posting the ordinary client body — NO explicit context.
      await register(projectKey, "s3-poster", { role: "RED", cycleId });

      const res = await postJson(fixture.path, fixture.body(projectKey, "s3-poster"));
      expect(res.ok).toBe(true);
      const reply = await readJson(res);
      const eventId = reply.event as string;
      expect(typeof eventId).toBe("string");

      // ADVERTISED (AC2 of §S1) and VISIBLE (this AC) are one property, not
      // two: the route says how to read its evidence back, and the evidence is
      // there when the reader goes. Parameterised over the whole table so the
      // next route to hand back an `event` id cannot advertise a read it is
      // absent from.
      const answer = await followCycleHint(reply, { projectKey, cycleId });
      expect(answer.ok).toBe(true);
      const events = answer.events as Array<{ id: string }>;
      expect(events.filter((e) => e.id === eventId)).toHaveLength(1);
      expect((answer.cycle as { id: number }).id).toBe(cycleId);
    });
  }
});
