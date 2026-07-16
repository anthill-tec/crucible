// CR-CRU-004 §S1+§S5 — clean v2 API surface: orientation, health parity,
// project rollups (PRD §4.2), agent lifecycle verbs (PRD §4.3). Every write
// response carries `changed: true|false` (§S5). Shares the ONE store instance
// with the v1 shim — src/server.ts wires handleV2 into its dispatcher.
import { codecs, parseRunBody } from "./codecs/index.ts";
import { parseCompile } from "./codecs/compile.ts";
import type { CompileReport } from "./codecs/compile.ts";
import { hints } from "./hints.ts";
import { Store, UUID_RE } from "./store.ts";
import { toToon } from "./toon.ts";
import type { RecordEventMeta, TouchAgentOpts } from "./store.ts";
import type {
  AgentIdentity,
  Coverage,
  CycleKind,
  CycleStatus,
  Project,
  RunContext,
  RunEvent,
  RunSchema,
  RunSummary,
  SuiteNode,
  Tier,
} from "./types.ts";

export interface V2Deps {
  version: string;
  /** Builds the exact same payload as GET /api/health (same store instance). */
  healthPayload: () => unknown;
}

interface V2Body {
  key?: unknown;
  name?: unknown;
  type?: unknown;
  sutRoot?: unknown;
  projectKey?: unknown;
  agentId?: unknown;
  status?: unknown;
  message?: unknown;
  identity?: unknown;
  // §S1 runs endpoints
  codec?: unknown;
  data?: unknown;
  dataPath?: unknown;
  summary?: unknown;
  tree?: unknown;
  coverage?: unknown;
  errors?: unknown;
  format?: unknown;
  // §S2 run context (graceful)
  tier?: unknown;
  stack?: unknown;
  context?: unknown;
  // CR-CRU-011 §S0 — cycle-plan routes
  cr?: unknown;
  // CR-CRU-021 §S6.11 — optional CR title captured at plan filing
  title?: unknown;
  // CR-CRU-021 §S6 re-baseline (cycle 19) — optional orchestrator identity
  orchestrator?: unknown;
  wave?: unknown;
  track?: unknown;
  cycles?: unknown;
  label?: unknown;
  kind?: unknown;
  merge?: unknown;
}

// §S3 — all help[] wording lives in src/hints.ts (one reviewable module).

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}

// ── §S2+§S4 (CR-CRU-005) — content negotiation + TOON truncation ────────────

const TOON_MAX_BYTES = 64 * 1024;

/** §S2 — `?fmt=toon` OR an Accept header containing `toon` selects TOON. */
function wantsToon(req: Request, url: URL): boolean {
  if (url.searchParams.get("fmt") === "toon") return true;
  return (req.headers.get("accept") ?? "").includes("toon");
}

/** §S4 — pointer to the untruncated JSON variant of the same call. */
function jsonVariantUrl(url: URL): string {
  const variant = new URL(url);
  variant.searchParams.set("fmt", "json");
  return `${variant.pathname}?${variant.searchParams.toString()}`;
}

/**
 * §S4 — shrink the payload's largest top-level array (keeping head items,
 * halving until the TOON body fits 64 KB), marked with a `truncated: true`
 * scalar and a `full:` pointer at the JSON variant of the same URL.
 */
function truncatedToon(payload: Record<string, unknown>, url: URL): string {
  let largestKey: string | undefined;
  let largestLen = 0;
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value) && value.length > largestLen) {
      largestKey = key;
      largestLen = value.length;
    }
  }
  if (largestKey === undefined) {
    // Nothing shrinkable — emit oversize rather than drop data silently.
    return `${toToon(payload)}\n`;
  }
  const items = payload[largestKey] as unknown[];
  let keep = items.length;
  let text: string;
  do {
    keep = Math.floor(keep / 2);
    text = `${toToon({
      ...payload,
      [largestKey]: items.slice(0, keep),
      truncated: true,
      full: `GET ${jsonVariantUrl(url)}`,
    })}\n`;
  } while (Buffer.byteLength(text, "utf8") > TOON_MAX_BYTES && keep > 0);
  return text;
}

/**
 * §S2 — the shared response gate every v2 GET routes through: TOON when
 * negotiated (with §S4 truncation), JSON otherwise. JSON never truncates.
 */
function reply(req: Request, url: URL, payload: Record<string, unknown>, status = 200): Response {
  if (req.method === "GET" && wantsToon(req, url)) {
    let text = `${toToon(payload)}\n`;
    if (Buffer.byteLength(text, "utf8") > TOON_MAX_BYTES) {
      text = truncatedToon(payload, url);
    }
    return new Response(text, {
      status,
      headers: { "content-type": "text/toon; charset=utf-8" },
    });
  }
  return json(payload, status);
}

function fail(status: number, error: string, extra?: Record<string, unknown>): Response {
  return json({ ok: false, error, ...extra }, status);
}

async function readBody(req: Request): Promise<V2Body | null> {
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as V2Body;
  } catch {
    return null;
  }
}

/** §S1 — projectKey validation: UUID shape (400) then existence (404 + help). */
function requireProject(store: Store, key: unknown): { key: string } | { fail: Response } {
  if (typeof key !== "string" || !UUID_RE.test(key)) {
    return { fail: fail(400, "projectKey must be a UUID", { help: hints.unknownProject }) };
  }
  if (store.getProject(key) === null) {
    return { fail: fail(404, `unknown project: ${key}`, { help: hints.unknownProject }) };
  }
  return { key };
}

function handleOrientation(store: Store, deps: V2Deps, req: Request, url: URL): Response {
  return reply(req, url, {
    ok: true,
    service: "crucible",
    version: deps.version,
    projects: store.listProjects(),
    help: hints.orientation,
  });
}

async function handleProjectCreate(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");

  let key: string;
  if (body.key !== undefined) {
    if (typeof body.key !== "string" || !UUID_RE.test(body.key)) {
      return fail(400, "key must be a UUID");
    }
    key = body.key;
    const existing = store.getProject(key);
    if (existing !== null) {
      // §S1 — duplicate key → 200 {ok:true, changed:false} (NOT 400, unlike the shim).
      return json({ ok: true, changed: false, project: existing });
    }
  } else {
    key = Bun.randomUUIDv7();
  }

  if (typeof body.name !== "string" || body.name.length === 0) {
    return fail(400, "name is required");
  }
  const type: Project["type"] = body.type === "frontend" ? "frontend" : "backend";
  const sutRoot = typeof body.sutRoot === "string" ? body.sutRoot : "";
  const project = store.addProject({ key, name: body.name, type, sutRoot });
  return json({ ok: true, changed: true, project });
}

// CR-CRU-007 §S5.1 — system-wide project-inactive timeout (ms), env-configurable.
const DEFAULT_PROJECT_INACTIVE_MS = 3_600_000;

function projectInactiveMs(): number {
  const raw = Number(process.env.CRUCIBLE_PROJECT_INACTIVE_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROJECT_INACTIVE_MS;
}

/** PRD §4.2 — project rollups. */
function handleProjectsList(store: Store, req: Request, url: URL): Response {
  const inactiveMs = projectInactiveMs();
  const now = Date.now();
  const projects = store.listProjects().map((project) => {
    const agents = store.listAgents(project.key);
    const events = store.listEvents(project.key, Number.MAX_SAFE_INTEGER);
    const last = events[0];
    // §S4 (CR-CRU-001) discards coverage on failed runs, so any stored
    // coverage belongs to a green run — newest one wins.
    const greenCovered = events.find((e) => e.coverage !== undefined);
    // §S5.1 (CR-CRU-007) activity rule (user-locked round 13): active while
    // ≥1 live (online/stale) agent; with none left, inactive once
    // now − lastActivity EXCEEDS the timeout. lastActivity = max(last event
    // timestamp, agents' last-seen).
    const lastActivity = Math.max(
      last?.timestamp ?? 0,
      ...agents.map((a) => a.lastSeen),
      0,
    );
    // Age is second-floored: `lastActivity` and `now` come from different
    // Date.now() calls, and sub-second scheduling jitter must never flip a
    // project sitting exactly AT its timeout — only EXCEEDING it flips.
    // Any live (online/stale) agent's last-seen feeds lastActivity above,
    // so liveness keeps a project active throughout the grace window.
    const ageMs = Math.floor((now - lastActivity) / 1000) * 1000;
    const active = ageMs <= inactiveMs;
    return {
      ...project,
      agentsOnline: agents.filter((a) => a.liveness === "online").length,
      agentsTotal: agents.length,
      // §S0 (CR-CRU-006) — same flattened brief shape as the events list.
      lastEvent: last !== undefined ? eventBrief(last) : null,
      latestGreenCoverage: greenCovered?.coverage ?? null,
      // CR-CRU-007 integration AC (§nav table) — the id of that SAME green
      // coverage event, so the client's coverage meter can open its drill-in.
      // Key ABSENT (not null) when no green-coverage run exists.
      ...(greenCovered !== undefined ? { latestCoverageEventId: greenCovered.id } : {}),
      // §S5.1 (CR-CRU-007) — additive activity fields.
      active,
      lastActivity,
    };
  });
  // §S5.1 ordering — most-recently-active first, inactive last.
  projects.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.lastActivity - a.lastActivity;
  });
  return reply(req, url, { ok: true, projects });
}

/** §S1 — register and heartbeat share these semantics (upsert via touchAgent). */
async function handleAgentTouch(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const pk = requireProject(store, body.projectKey);
  if ("fail" in pk) return pk.fail;
  const agentId = body.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) {
    return fail(400, "agentId is required");
  }

  const existed = store.hasAgent(pk.key, agentId);
  const opts: TouchAgentOpts = {};
  if (body.status === "busy" || body.status === "online") {
    opts.status = body.status;
  }
  if (typeof body.message === "string") {
    opts.message = body.message;
  }
  if (typeof body.identity === "object" && body.identity !== null) {
    opts.identity = body.identity as AgentIdentity;
  }
  store.touchAgent(pk.key, agentId, opts);
  // CR-CRU-011 §S1 — a REAL registration (row created) appends a lifecycle
  // event; a heartbeat on an existing agent never does.
  if (!existed) {
    store.recordLifecycleEvent(pk.key, agentId, "registered");
  }
  return json({ ok: true, changed: !existed, help: hints.registered });
}

async function handleAgentUnregister(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const pk = requireProject(store, body.projectKey);
  if ("fail" in pk) return pk.fail;
  const agentId = body.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) {
    return fail(400, "agentId is required");
  }
  // CR-CRU-011 §S1 — snapshot firstSeen BEFORE removeAgent hard-deletes the
  // row (the round-11 audit's gap: the final runtime must survive deletion).
  const agent = store.getAgent(pk.key, agentId);
  store.removeAgent(pk.key, agentId);
  if (agent !== null) {
    store.recordLifecycleEvent(pk.key, agentId, "unregistered", agent.firstSeen);
  }
  return json({ ok: true, changed: agent !== null });
}

/**
 * §S1 — each agent carries computed liveness; `?project=` filters.
 * CR-CRU-011 §S2 — plus a server-computed `runtime_ms`: still live →
 * `now − firstSeen` (ticking); tombstoned (never unregistered) →
 * `lastRunTimestamp − firstSeen` (sealed; lastSeen fallback when the agent
 * never ingested a run). Unregistered agents live on the lifecycle event.
 */
function handleAgentsList(store: Store, req: Request, url: URL): Response {
  const project = url.searchParams.get("project") ?? undefined;
  const now = Date.now();
  const agents = store.listAgents(project, now).map((agent) => ({
    ...agent,
    runtime_ms:
      agent.liveness === "tombstoned"
        ? (store.lastRunTimestamp(agent.projectKey, agent.agentId) ?? agent.lastSeen) -
          agent.firstSeen
        : now - agent.firstSeen,
  }));
  return reply(req, url, { ok: true, agents });
}

// ── §S1+§S2 — runs: raw codec ingest, parsed ingest, compile ingest ─────────

export const TIERS: ReadonlySet<string> = new Set<Tier>([
  "unit",
  "module",
  "integration",
  "e2e",
  "regression",
  "bdd",
]);

/** §S2 — pull the optional {tier, stack, context} trio verbatim, never fabricated. */
function runMeta(body: V2Body): Pick<RecordEventMeta, "tier" | "stack" | "context"> {
  return {
    ...(typeof body.tier === "string" && TIERS.has(body.tier) ? { tier: body.tier as Tier } : {}),
    ...(typeof body.stack === "string" ? { stack: body.stack } : {}),
    ...(typeof body.context === "object" && body.context !== null
      ? { context: body.context as RunContext }
      : {}),
  };
}

/** §S1 — one-line run verdict: RED when failed>0, GREEN otherwise. */
function runVerdict(summary: RunSummary): string {
  return summary.failed > 0
    ? `RED — ${summary.failed} failing of ${summary.total}`
    : `GREEN — ${summary.passed}/${summary.total} passed`;
}

function runResponse(eventId: string, summary: RunSummary, help?: string[]): Response {
  return json({
    ok: true,
    changed: true,
    event: eventId,
    run: summary,
    verdict: runVerdict(summary),
    ...(help !== undefined ? { help } : {}),
  });
}

async function handleRuns(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const pk = requireProject(store, body.projectKey);
  if ("fail" in pk) return pk.fail;

  const codecName = typeof body.codec === "string" ? body.codec : "junit";
  const codec = codecs.get(codecName);
  if (codec === undefined) return fail(400, `unknown codec: ${codecName}`);

  const parsed = await parseRunBody(codec, body, codecName);
  if ("error" in parsed) return fail(400, parsed.error);
  const { run } = parsed;

  const agentId = typeof body.agentId === "string" ? body.agentId : "unknown";
  const event = store.recordTestEvent(pk.key, agentId, run, {
    codec: codecName,
    ...runMeta(body),
  });
  // §S3 — a RED ingest carries the transition hint.
  return runResponse(event.id, run.summary, run.summary.failed > 0 ? hints.afterRed : undefined);
}

async function handleRunsParsed(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const pk = requireProject(store, body.projectKey);
  if ("fail" in pk) return pk.fail;

  if (typeof body.summary !== "object" || body.summary === null) {
    return fail(400, "summary is required");
  }
  if (!Array.isArray(body.tree)) {
    return fail(400, "tree is required");
  }

  const summary = body.summary as RunSummary;
  const hasCoverage = typeof body.coverage === "object" && body.coverage !== null;
  const run: RunSchema = {
    summary,
    tree: body.tree as SuiteNode[],
    // §S4 (CR-CRU-001) discard-on-fail is applied by the store; pass coverage through.
    ...(hasCoverage ? { coverage: body.coverage as Coverage } : {}),
  };

  const agentId = typeof body.agentId === "string" ? body.agentId : "unknown";
  const event = store.recordTestEvent(pk.key, agentId, run, {
    codec: "parsed",
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...runMeta(body),
  });
  // §S3 — RED transition hint; coverage arrived but the store dropped it
  // (failing run) — say so in help too.
  const dropped = hasCoverage && event.coverage === undefined;
  const help = [
    ...(summary.failed > 0 ? hints.afterRed : []),
    ...(dropped ? hints.coverageDropped : []),
  ];
  return runResponse(event.id, summary, help.length > 0 ? help : undefined);
}

async function handleRunsCompile(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const pk = requireProject(store, body.projectKey);
  if ("fail" in pk) return pk.fail;

  if (typeof body.errors !== "string" || body.errors.length === 0) {
    return fail(400, "errors must be a non-empty string");
  }

  const format = typeof body.format === "string" ? body.format : undefined;
  const report = parseCompile(body.errors, format);
  const agentId = typeof body.agentId === "string" ? body.agentId : "unknown";
  const event = store.recordCompileEvent(pk.key, agentId, report, {
    codec: report.format,
    ...runMeta(body),
  });
  const verdict =
    report.errorCount > 0
      ? `COMPILE FAILED — ${report.errorCount} errors, ${report.warningCount} warnings`
      : `COMPILE OK — ${report.warningCount} warnings`;
  return json({
    ok: true,
    changed: true,
    event: event.id,
    errors: report.errorCount,
    warnings: report.warningCount,
    verdict,
    // §S3 — panel-routing reminder after a compile ingest.
    help: hints.afterCompile,
  });
}

// ── CR-CRU-011 §S0 — cycle-plan routes (plans are NOT events) ───────────────

const CYCLE_KINDS: ReadonlySet<string> = new Set<CycleKind>(["red-green", "verify", "fix"]);

const CYCLE_STATUSES: ReadonlySet<string> = new Set<CycleStatus>([
  "pending",
  "active",
  "done",
  "skipped",
  "failed",
]);

/** Plan/cycle path ids are numeric; anything else can never exist → 404 path. */
function numericId(raw: string): number | null {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

interface CycleInput {
  label: string;
  kind: CycleKind;
}

/** §S0 — one {label, kind?} cycle body; the error names the offending field. */
function parseCycleInput(raw: unknown): CycleInput | { error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: "cycles entries must be objects with a label" };
  }
  const { label, kind } = raw as { label?: unknown; kind?: unknown };
  if (typeof label !== "string" || label.length === 0) {
    return { error: "label is required" };
  }
  if (kind === undefined) {
    // §S0 — omitted kind defaults to red-green.
    return { label, kind: "red-green" };
  }
  if (typeof kind !== "string" || !CYCLE_KINDS.has(kind)) {
    return { error: `invalid kind: ${String(kind)} (expected red-green | verify | fix)` };
  }
  return { label, kind: kind as CycleKind };
}

/** POST …/plans — file the cycle plan. 201; one OPEN plan per cr → 400. */
async function handlePlanFile(store: Store, key: string, req: Request): Promise<Response> {
  const pk = requireProject(store, key);
  if ("fail" in pk) return pk.fail;
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  if (typeof body.cr !== "string" || body.cr.length === 0) {
    return fail(400, "cr is required");
  }
  if (!Array.isArray(body.cycles) || body.cycles.length === 0) {
    return fail(400, "cycles must be a non-empty array");
  }
  const cycles: CycleInput[] = [];
  for (const raw of body.cycles) {
    const parsed = parseCycleInput(raw);
    if ("error" in parsed) return fail(400, parsed.error);
    cycles.push(parsed);
  }
  // CR-CRU-021 §S6.11 — additive optional title: stored verbatim when a
  // string, 400 naming the field on any other present type.
  if (body.title !== undefined && typeof body.title !== "string") {
    return fail(400, "title must be a string");
  }
  const title = typeof body.title === "string" ? body.title : undefined;
  // §S6 re-baseline (cycle 19) — additive optional orchestrator identity:
  // stored verbatim when a string, 400 naming the field on any other
  // present type (same contract as title).
  if (body.orchestrator !== undefined && typeof body.orchestrator !== "string") {
    return fail(400, "orchestrator must be a string");
  }
  const orchestrator =
    typeof body.orchestrator === "string" ? body.orchestrator : undefined;
  // Cycle 13 gap 3 — a numeric wave is coerced to its decimal string; any
  // other non-string present type → 400 naming the field.
  if (body.wave !== undefined && typeof body.wave !== "string" && typeof body.wave !== "number") {
    return fail(400, "wave must be a string");
  }
  const wave =
    typeof body.wave === "string"
      ? body.wave
      : typeof body.wave === "number"
        ? String(body.wave)
        : undefined;
  const track = typeof body.track === "string" ? body.track : undefined;
  const plan = store.filePlan(pk.key, {
    cr: body.cr,
    ...(title !== undefined ? { title } : {}),
    ...(orchestrator !== undefined ? { orchestrator } : {}),
    ...(wave !== undefined ? { wave } : {}),
    ...(track !== undefined ? { track } : {}),
    cycles,
  });
  if ("error" in plan) return fail(400, plan.error);
  return json(
    {
      ok: true,
      changed: true,
      planId: plan.planId,
      cr: plan.cr,
      status: plan.status,
      ...(plan.title !== undefined ? { title: plan.title } : {}),
      ...(plan.orchestrator !== undefined ? { orchestrator: plan.orchestrator } : {}),
      ...(plan.wave !== undefined ? { wave: plan.wave } : {}),
      ...(plan.track !== undefined ? { track: plan.track } : {}),
      cycles: plan.cycles,
    },
    201,
  );
}

/** POST …/plans/<planId>/cycles — append a cycle to an OPEN plan. */
async function handleCycleAppend(
  store: Store,
  key: string,
  planIdRaw: string,
  req: Request,
): Promise<Response> {
  const pk = requireProject(store, key);
  if ("fail" in pk) return pk.fail;
  const planId = numericId(planIdRaw);
  if (planId === null) return fail(404, `plan not found: ${planIdRaw}`);
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const parsed = parseCycleInput(body);
  if ("error" in parsed) return fail(400, parsed.error);
  const cycle = store.appendCycle(pk.key, planId, parsed);
  if ("error" in cycle) return fail(cycle.notFound === true ? 404 : 400, cycle.error);
  return json({ ok: true, changed: true, ...cycle }, 201);
}

/** PATCH …/plans/<planId>/cycles/<id> — §S0 transitions (legal table in the store). */
async function handleCycleTransition(
  store: Store,
  key: string,
  planIdRaw: string,
  cycleIdRaw: string,
  req: Request,
): Promise<Response> {
  const pk = requireProject(store, key);
  if ("fail" in pk) return pk.fail;
  const planId = numericId(planIdRaw);
  if (planId === null) return fail(404, `plan not found: ${planIdRaw}`);
  const cycleId = numericId(cycleIdRaw);
  if (cycleId === null) return fail(404, `cycle not found: ${cycleIdRaw}`);
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  if (typeof body.status !== "string" || !CYCLE_STATUSES.has(body.status)) {
    return fail(
      400,
      `invalid status: ${String(body.status)} (expected pending | active | done | skipped | failed)`,
    );
  }
  const cycle = store.transitionCycle(pk.key, planId, cycleId, body.status as CycleStatus);
  if ("error" in cycle) return fail(cycle.notFound === true ? 404 : 400, cycle.error);
  return json({ ok: true, changed: true, cycle });
}

/** PATCH …/plans/<planId> — the CR close (feature merge). */
async function handlePlanClose(
  store: Store,
  key: string,
  planIdRaw: string,
  req: Request,
): Promise<Response> {
  const pk = requireProject(store, key);
  if ("fail" in pk) return pk.fail;
  const planId = numericId(planIdRaw);
  if (planId === null) return fail(404, `plan not found: ${planIdRaw}`);
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  // §S6 re-baseline (cycle 19) — one-field orchestrator backfill: a PATCH
  // body carrying `orchestrator` with NO `status` stamps an OPEN plan (the
  // executing plan); closed plans → 400, mirroring the close validation.
  if (body.status === undefined && body.orchestrator !== undefined) {
    if (typeof body.orchestrator !== "string") {
      return fail(400, "orchestrator must be a string");
    }
    const stamped = store.stampOrchestrator(pk.key, planId, body.orchestrator);
    if ("error" in stamped) {
      return fail(stamped.notFound === true ? 404 : 400, stamped.error);
    }
    return json({ ok: true, changed: true, plan: stamped });
  }
  if (body.status !== "closed") {
    return fail(400, `status must be "closed" to close a plan`);
  }
  let merge: { commit: string } | undefined;
  if (body.merge !== undefined) {
    const commit =
      typeof body.merge === "object" && body.merge !== null
        ? (body.merge as { commit?: unknown }).commit
        : undefined;
    if (typeof commit !== "string" || commit.length === 0) {
      return fail(400, "merge.commit must be a non-empty string");
    }
    merge = { commit };
  }
  const plan = store.closePlan(pk.key, planId, merge);
  if ("error" in plan) {
    return fail(
      plan.notFound === true ? 404 : 400,
      plan.error,
      plan.openCycleIds !== undefined ? { openCycles: plan.openCycleIds } : undefined,
    );
  }
  return json({ ok: true, changed: true, plan });
}

/** GET …/plans (+?cr=&track=) — closed plans carry the derived commitBoundary. */
function handlePlansList(store: Store, key: string, req: Request, url: URL): Response {
  const pk = requireProject(store, key);
  if ("fail" in pk) return pk.fail;
  const cr = url.searchParams.get("cr") ?? undefined;
  const track = url.searchParams.get("track") ?? undefined;
  const plans = store.listPlans(pk.key, {
    ...(cr !== undefined ? { cr } : {}),
    ...(track !== undefined ? { track } : {}),
  });
  return reply(req, url, { ok: true, plans });
}

/**
 * Dispatch …/projects/<key>/plans[…] paths; null when the shape/method is
 * not a plans route (caller falls through to its catch-all).
 */
function handlePlansRoute(
  store: Store,
  segments: string[],
  req: Request,
  url: URL,
): Promise<Response> | Response | null {
  const key = segments[0]!;
  if (segments.length === 2) {
    if (req.method === "POST") return handlePlanFile(store, key, req);
    if (req.method === "GET") return handlePlansList(store, key, req, url);
    return null;
  }
  if (segments.length === 3 && req.method === "PATCH") {
    return handlePlanClose(store, key, segments[2]!, req);
  }
  if (segments.length === 4 && segments[3] === "cycles" && req.method === "POST") {
    return handleCycleAppend(store, key, segments[2]!, req);
  }
  if (segments.length === 5 && segments[3] === "cycles" && req.method === "PATCH") {
    return handleCycleTransition(store, key, segments[2]!, segments[4]!, req);
  }
  return null;
}

// ── §S1 — events list/get/delete + status ───────────────────────────────────

/**
 * Brief of an event for lists, status, and rollups (full detail via
 * /events/:id). §S0 (CR-CRU-006) — run numbers hoisted to top-level scalars,
 * NO nested `summary`; compile events carry uniform numeric 0s so every brief
 * shares one all-scalar shape (TOON's uniform-table form applies).
 * CR-CRU-007 §S1 (additive) — optional `context` passthrough (verbatim when
 * stored, key ABSENT when not) + compile-event `errors`/`warnings` counts
 * (test-event briefs carry neither key).
 */
function eventBrief(event: RunEvent) {
  const compile = event.kind === "compile" ? (event.compile as CompileReport | undefined) : undefined;
  return {
    id: event.id,
    projectKey: event.projectKey,
    agentId: event.agentId,
    kind: event.kind,
    tier: event.tier,
    codec: event.codec,
    timestamp: event.timestamp,
    total: event.summary?.total ?? 0,
    passed: event.summary?.passed ?? 0,
    failed: event.summary?.failed ?? 0,
    pending: event.summary?.pending ?? 0,
    duration_ms: event.summary?.duration_ms ?? 0,
    hasCoverage: !!event.coverage,
    // CR-CRU-007 §S5.2 (F8 vitals, additive) — optional `coverageLines`
    // (the stored coverage's lines percent) on coverage-bearing events, so
    // the workspace coverage-trend card derives its bars from the
    // already-loaded timeline slice. Key ABSENT on events with no coverage.
    ...(typeof (event.coverage as Coverage | undefined)?.lines?.percent === "number"
      ? { coverageLines: (event.coverage as Coverage).lines.percent }
      : {}),
    // CR-CRU-011 §S1 (additive) — lifecycle-event fields, keys ABSENT on
    // test/compile briefs.
    ...(event.action !== undefined ? { action: event.action } : {}),
    ...(event.firstSeen !== undefined ? { firstSeen: event.firstSeen } : {}),
    ...(event.context !== undefined ? { context: event.context } : {}),
    ...(compile !== undefined
      ? {
          errors: compile.errorCount,
          warnings: compile.warningCount,
          // CR-CRU-007 §S1 (F5) — the first 2 diagnostics, exactly what the
          // compile card's inline preview renders; test briefs unaffected.
          diagnostics: compile.diagnostics.slice(0, 2),
        }
      : {}),
  };
}

function handleEventsList(store: Store, req: Request, url: URL): Response {
  const project = url.searchParams.get("project") ?? undefined;
  const rawLimit = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50;
  // store.listEvents is newest-first already.
  return reply(req, url, { ok: true, events: store.listEvents(project, limit).map(eventBrief) });
}

/** §S4 — per-suite counts derived from leaf statuses (no leaves in the reply). */
function suiteCounts(node: SuiteNode): { passed: number; failed: number; pending: number } {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const leaf of node.children) {
    if (leaf.status === "pass") counts.passed += 1;
    else if (leaf.status === "fail") counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

/** §S1 — event-specific 404 (distinct from the server's route catch-all). */
/** §S4 — progressive detail: ?depth=suites (counts, no children) | ?suite=<name>. */
function handleEventGet(store: Store, id: string, req: Request, url: URL): Response {
  const event = store.getEvent(id);
  if (event === null) {
    return fail(404, `event not found: ${id}`);
  }
  const suite = url.searchParams.get("suite");
  if (suite !== null) {
    const match = (event.tree ?? []).find((node) => node.name === suite);
    if (match === undefined) {
      return fail(404, `suite not found in event ${id}: ${suite}`);
    }
    // Approved contract: tree becomes a single-element array — just the
    // requested suite, fully expanded (leaves incl. failure detail).
    return reply(req, url, { ok: true, event: { ...event, tree: [match] } });
  }
  if (url.searchParams.get("depth") === "suites" && event.tree !== undefined) {
    const tree = event.tree.map((node) => ({
      name: node.name,
      status: node.status,
      counts: suiteCounts(node),
    }));
    return reply(req, url, { ok: true, event: { ...event, tree } });
  }
  return reply(req, url, { ok: true, event });
}

function handleEventDelete(store: Store, id: string, url: URL): Response {
  const pk = requireProject(store, url.searchParams.get("project") ?? undefined);
  if ("fail" in pk) return pk.fail;
  if (!store.deleteEvent(id, pk.key)) {
    // §S1 — repeat delete / wrong project → 404, event-specific message.
    return fail(404, `event not found in project: ${id}`);
  }
  return json({ ok: true, changed: true });
}

function handleStatus(store: Store, req: Request, url: URL): Response {
  const project = url.searchParams.get("project");
  if (project === null) {
    return fail(400, "project query parameter is required");
  }
  const events = store.listEvents(project, Number.MAX_SAFE_INTEGER);
  const lastTest = events.find((e) => e.kind === "test");
  const lastCompile = events.find((e) => e.kind === "compile");
  return reply(req, url, {
    ok: true,
    status: {
      hasData: events.length > 0,
      lastTest: lastTest !== undefined ? eventBrief(lastTest) : null,
      lastCompile: lastCompile !== undefined ? eventBrief(lastCompile) : null,
    },
  });
}

/**
 * Dispatch a /api/v2/* request. Returns null when the path/method is not a
 * v2 route handled here (the caller falls through to its catch-all).
 */
export function handleV2(
  store: Store,
  req: Request,
  url: URL,
  deps: V2Deps,
): Promise<Response> | Response | null {
  const { pathname } = url;
  if (req.method === "GET" && pathname === "/api/v2") {
    return handleOrientation(store, deps, req, url);
  }
  if (req.method === "GET" && pathname === "/api/v2/health") {
    return reply(req, url, deps.healthPayload() as Record<string, unknown>);
  }
  if (req.method === "POST" && pathname === "/api/v2/projects") {
    return handleProjectCreate(store, req);
  }
  if (req.method === "GET" && pathname === "/api/v2/projects") {
    return handleProjectsList(store, req, url);
  }
  // CR-CRU-011 §S0 — project-scoped plans routes.
  if (pathname.startsWith("/api/v2/projects/")) {
    const segments = pathname
      .slice("/api/v2/projects/".length)
      .split("/")
      .filter((segment) => segment.length > 0);
    if (segments.length >= 2 && segments[1] === "plans") {
      const handled = handlePlansRoute(store, segments, req, url);
      if (handled !== null) return handled;
    }
  }
  if (
    req.method === "POST" &&
    (pathname === "/api/v2/agents/register" || pathname === "/api/v2/agents/heartbeat")
  ) {
    return handleAgentTouch(store, req);
  }
  if (req.method === "POST" && pathname === "/api/v2/agents/unregister") {
    return handleAgentUnregister(store, req);
  }
  if (req.method === "GET" && pathname === "/api/v2/agents") {
    return handleAgentsList(store, req, url);
  }
  if (req.method === "POST" && pathname === "/api/v2/runs") {
    return handleRuns(store, req);
  }
  if (req.method === "POST" && pathname === "/api/v2/runs/parsed") {
    return handleRunsParsed(store, req);
  }
  if (req.method === "POST" && pathname === "/api/v2/runs/compile") {
    return handleRunsCompile(store, req);
  }
  if (req.method === "GET" && pathname === "/api/v2/events") {
    return handleEventsList(store, req, url);
  }
  if (pathname.startsWith("/api/v2/events/")) {
    const id = pathname.slice("/api/v2/events/".length);
    if (id.length > 0 && !id.includes("/")) {
      if (req.method === "GET") {
        return handleEventGet(store, id, req, url);
      }
      if (req.method === "DELETE") {
        return handleEventDelete(store, id, url);
      }
    }
  }
  if (req.method === "GET" && pathname === "/api/v2/status") {
    return handleStatus(store, req, url);
  }
  return null;
}
