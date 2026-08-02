// CR-CRU-004 §S1+§S5 — clean v2 API surface: orientation, health parity,
// project rollups (PRD §4.2), agent lifecycle verbs (PRD §4.3). Every write
// response carries `changed: true|false` (§S5). Shares the ONE store instance
// with the v1 shim — src/server.ts wires handleV2 into its dispatcher.
import { codecs, parseRunBody } from "./codecs/index.ts";
import { parseCompile } from "./codecs/compile.ts";
import type { CompileReport } from "./codecs/compile.ts";
import { authHints, hints, cycleHints } from "./hints.ts";
import { Store, UUID_RE } from "./store.ts";
import { toToon } from "./toon.ts";
import { AGENT_ROLES } from "./types.ts";
import type { ProjectPatch, RecordEventMeta, TouchAgentOpts } from "./store.ts";
import type {
  AgentIdentity,
  AgentRole,
  Coverage,
  CycleKind,
  CycleStatus,
  LivenessConfig,
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
  /** CR-CRU-044 §S1 — declared role (required on register). */
  role?: unknown;
  /** CR-CRU-056 §S1 — optional explicit cycle binding on register. */
  cycleId?: unknown;
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
  // CR-CRU-038 §S2b — optional run-level captured raw output.
  raw?: unknown;
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
  // CR-CRU-013 §S1 (gate object) + §S4b/§S4c (milestone commit)
  gate?: unknown;
  commit?: unknown;
  // CR-CRU-008 §S4 — silent unregister + guarded run deletion
  silent?: unknown;
  userApproved?: unknown;
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

/**
 * §S1 — projectKey validation: UUID shape (400) then existence (404 + help).
 * CR-CRU-012 §S1b — an ARCHIVED project also 404s (help[] names the archived
 * state); the rejected call must never mutate, so registration/ingest can
 * never resurrect an archived project.
 */
function requireProject(store: Store, key: unknown): { key: string } | { fail: Response } {
  if (typeof key !== "string" || !UUID_RE.test(key)) {
    return { fail: fail(400, "projectKey must be a UUID", { help: hints.unknownProject }) };
  }
  if (store.getProject(key) === null) {
    return { fail: fail(404, `unknown project: ${key}`, { help: hints.unknownProject }) };
  }
  if (store.isArchived(key)) {
    return { fail: fail(404, `project is archived: ${key}`, { help: hints.archivedProject }) };
  }
  return { key };
}

/**
 * CR-CRU-056 §S2b/§S3b — the single caller-auth seam. Every mutating
 * workflow verb and every ingest surface routes its posted `agentId` through
 * here: the caller must be a LIVE registered agent (lazy-prune semantics —
 * a row past its prune window, or one removed by unregister, is absent).
 * Returns the authenticated agentId, or the shared 409 refusal (ok:false,
 * state-derived help[] naming registration as the next step) — the caller
 * returns it BEFORE mutating or storing anything.
 */
function requireRegisteredCaller(
  store: Store,
  projectKey: string,
  body: V2Body,
): { agentId: string } | { fail: Response } {
  const agentId =
    typeof body.agentId === "string" && body.agentId.length > 0 ? body.agentId : undefined;
  if (agentId !== undefined && store.hasAgent(projectKey, agentId)) {
    return { agentId };
  }
  const error =
    agentId === undefined
      ? "a registered caller is required — this request carried no agentId"
      : `agent ${agentId} is not registered with this project — refused`;
  return { fail: fail(409, error, { help: authHints.unregisteredCaller(agentId) }) };
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

/**
 * PRD §4.2 — project rollups.
 * CR-CRU-012 §S1b — the default listing excludes archived projects;
 * `?archived=true` is the manager-only view listing ONLY archived ones.
 */
function handleProjectsList(store: Store, req: Request, url: URL): Response {
  const archived = url.searchParams.get("archived") === "true";
  const inactiveMs = projectInactiveMs();
  const now = Date.now();
  const projects = store.listProjects(archived).map((project) => {
    const agents = store.listAgents(project.key);
    const events = store.listEvents(project.key, Number.MAX_SAFE_INTEGER);
    const last = events[0];
    // §S4 (CR-CRU-001) discards coverage on failed runs, so any stored
    // coverage belongs to a green run — newest one wins.
    const greenCovered = events.find((e) => e.coverage !== undefined);
    // CR-CRU-033 §S2 (DN-crucible-coverage-trend.md §6) — date-keyed
    // coverage-trend series: a MERGE, per UTC day, of the DURABLE rollup
    // buckets (old days that survived retention pruning) PLUS the
    // within-retention coverage-bearing events (recent days). Legacy
    // wave-keyed rollup buckets (non-`YYYY-MM-DD`) contribute nothing; a
    // day present in both halves yields ONE point with the LIVE value
    // (last-of-day event) winning over the rollup's older value. Failing
    // runs never contribute: recordTestEvent discards coverage on failed
    // runs (§S4), so no rollup lastCoverage — and no live coverage — can
    // come from one.
    const byDay = new Map<string, number>();
    // Rollup day-points (durable): only YYYY-MM-DD buckets carrying coverage.
    for (const r of store.listRollups(project.key)) {
      if (r.lastCoverage !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(r.bucket)) {
        byDay.set(r.bucket, r.lastCoverage.lines.percent);
      }
    }
    // Live day-points (within retention): group coverage-bearing events by
    // UTC day, last-of-day wins. `events` is newest-first, so the FIRST
    // event seen for a day is its last-of-day; live overwrites any rollup.
    const liveSeen = new Set<string>();
    for (const e of events) {
      if (e.coverage === undefined) continue;
      const day = new Date(e.timestamp).toISOString().slice(0, 10);
      if (liveSeen.has(day)) continue;
      liveSeen.add(day);
      byDay.set(day, e.coverage.lines.percent);
    }
    const coverageTrend = Array.from(byDay.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([day, percent]) => ({ day, percent }));
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
      agentsOnline: agents.filter((a) => a.liveness !== "tombstoned").length,
      agentsTotal: agents.length,
      // §S0 (CR-CRU-006) — same flattened brief shape as the events list.
      lastEvent: last !== undefined ? eventBrief(last) : null,
      latestGreenCoverage: greenCovered?.coverage ?? null,
      // CR-CRU-007 integration AC (§nav table) — the id of that SAME green
      // coverage event, so the client's coverage meter can open its drill-in.
      // Key ABSENT (not null) when no green-coverage run exists.
      ...(greenCovered !== undefined ? { latestCoverageEventId: greenCovered.id } : {}),
      // CR-CRU-033 §S2 (DN §6) — date-keyed coverage-trend series
      // ({ day, percent }[], oldest→newest) merged from durable day-rollups
      // + within-retention coverage-bearing events (live wins on same-day
      // overlap). Key ABSENT (not null/empty) when no day carries coverage
      // — mirrors the latestCoverageEventId convention above.
      ...(coverageTrend.length > 0 ? { coverageTrend } : {}),
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

/**
 * §S1 — register and heartbeat share these semantics (upsert via touchAgent),
 * differing in ONE respect: CR-CRU-044 §S1(a) makes `role` REQUIRED on
 * register (`requireRole`) but leaves it optional on heartbeat, which stays
 * the idle-time liveness ping hints.ts documents — never a re-declaration of
 * something the agent already declared when it registered.
 */
/**
 * CR-CRU-056 §S1 — validate an explicit register-time cycle binding against
 * stored plan state BEFORE any agent write. The binding is legal only when
 * the cycle exists in THIS project's plans, its plan is OPEN, and the cycle
 * is ACTIVE. Every refusal is a 409 definitive error naming the ACTUAL state
 * found (unknown / closed-plan / pending / done…), with state-derived help[]
 * (CR-CRU-024 help-quality convention). Returns `{}` on the happy path.
 */
function validateCycleBinding(
  store: Store,
  projectKey: string,
  cycleId: number,
): { fail?: Response } {
  const found = store.findCycle(projectKey, cycleId);
  if (found === null) {
    const summary = store.openPlanCycleSummary(projectKey);
    const help =
      summary !== null
        ? cycleHints.unknownCycle(summary.cr, summary.cycleIds)
        : hints.unknownCycleNoPlan;
    return {
      fail: fail(409, `unknown cycleId: ${cycleId} — no such cycle in this project's plans`, {
        help,
      }),
    };
  }
  const plan = store.listPlans(projectKey).find((p) => p.planId === found.planId);
  if (plan !== undefined && plan.status !== "open") {
    return {
      fail: fail(
        409,
        `cycle ${cycleId} belongs to plan ${plan.cr} (id ${plan.planId}), which is ${plan.status} — bindings require an OPEN plan`,
        { help: cycleHints.bindClosedPlan(plan.cr, plan.planId, plan.status) },
      ),
    };
  }
  if (found.status !== "active") {
    const help =
      found.status === "pending"
        ? cycleHints.bindPendingCycle(cycleId, found.planId)
        : cycleHints.bindTerminalCycle(cycleId, found.status);
    return {
      fail: fail(
        409,
        `cycle ${cycleId} is ${found.status} — bindings require an ACTIVE cycle`,
        { help },
      ),
    };
  }
  return {};
}

/** CR-CRU-056 §S2 — the roles that MUST register bound (ORCHESTRATOR/report are exempt). */
const TDD_ROLES: ReadonlySet<string> = new Set(["RED", "GREEN", "FIX", "VERIFY"]);

/**
 * CR-CRU-056 §S2 — every ACTIVE cycle across the project's OPEN plans, so an
 * unbound-registration refusal can name the concrete binding(s) available.
 */
function activeCycleIds(store: Store, projectKey: string): number[] {
  return store
    .listPlans(projectKey)
    .filter((plan) => plan.status === "open")
    .flatMap((plan) => plan.cycles.filter((c) => c.status === "active").map((c) => c.id));
}

async function handleAgentTouch(
  store: Store,
  req: Request,
  requireRole: boolean,
): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const pk = requireProject(store, body.projectKey);
  if ("fail" in pk) return pk.fail;
  const agentId = body.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) {
    return fail(400, "agentId is required");
  }
  // CR-CRU-044 §S1(b) — validated at the ROUTE boundary, before any write, so
  // a rejected registration never leaves a partial agent row behind.
  const role = body.role;
  const roleValid = typeof role === "string" && (AGENT_ROLES as readonly string[]).includes(role);
  if (requireRole && !roleValid) {
    return fail(
      400,
      `role is required and must be one of ${AGENT_ROLES.join(" | ")} (got ${
        role === undefined ? "no role field" : JSON.stringify(role)
      })`,
      { help: hints.roleRequired },
    );
  }
  // CR-CRU-056 §S2 — TDD roles MUST register bound: a RED/GREEN/FIX/VERIFY
  // registration with no `cycleId` is refused at the ROUTE boundary, before
  // any write (an implementation agent with no workflow home). The refusal
  // help is STATE-derived: it names this project's actual ACTIVE cycle id(s)
  // when any exist. ORCHESTRATOR/report stay exempt; the heartbeat path
  // (`requireRole === false`) is untouched.
  if (
    requireRole &&
    typeof role === "string" &&
    TDD_ROLES.has(role) &&
    body.cycleId === undefined
  ) {
    return fail(
      409,
      `role ${role} requires a cycle binding — register with --cycle <cycleId>`,
      { help: cycleHints.unboundTddRole(role, activeCycleIds(store, pk.key)) },
    );
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
  // CR-CRU-044 §S1(c) — only a declared role is passed through; omitting the
  // option is what makes the store PRESERVE the stored value.
  if (roleValid) {
    opts.role = role as AgentRole;
  }
  // CR-CRU-056 §S1 — an explicit cycle binding is VALIDATED before any write:
  // a refused binding returns 409 with no agent row created and no stored
  // binding mutated. Omitting the field entirely leaves a stored binding
  // untouched (the touch-never-blanks contract) — the heartbeat path flows
  // through here unchanged.
  if (body.cycleId !== undefined) {
    if (typeof body.cycleId !== "number" || !Number.isInteger(body.cycleId)) {
      return fail(400, `cycleId must be an integer cycle id (got ${JSON.stringify(body.cycleId)})`);
    }
    const binding = validateCycleBinding(store, pk.key, body.cycleId);
    if (binding.fail !== undefined) return binding.fail;
    opts.boundCycleId = body.cycleId;
  }
  store.touchAgent(pk.key, agentId, opts);
  // CR-CRU-011 §S1 — a REAL registration (row created) appends a lifecycle
  // event; a heartbeat on an existing agent never does.
  // CR-CRU-057 §S1 — the journal entry carries the DECLARED role (the very
  // value just validated at this boundary), so a finished agent's registration
  // stays classifiable after its row is deleted.
  if (!existed) {
    store.recordLifecycleEvent(pk.key, agentId, "registered", undefined, opts.role);
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
  // CR-CRU-008 §S4 precondition 4 — {silent:true} removes the agent WITHOUT
  // journaling the lifecycle event (the clients' anti-ghost cleanup path);
  // any other value keeps the non-silent journaling byte-unchanged.
  // CR-CRU-057 §S1 — role joins firstSeen in the pre-deletion snapshot above:
  // the final journal entry names the role the agent actually declared, read
  // from the row while it still existed.
  if (agent !== null && body.silent !== true) {
    store.recordLifecycleEvent(pk.key, agentId, "unregistered", agent.firstSeen, agent.role);
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

/**
 * CR-CRU-024 §S7 — validate a run ingest's `context.cycleId` against stored
 * plan state (Crucible is the source of truth, not the client). Returns:
 *  - `{ fail }` when the id matches NO cycle in any of the project's plans —
 *    a 400 whose error names the unknown id and help[] lists the open plan's
 *    cycle ids; the caller returns it and stores NOTHING;
 *  - `{ staleHelp }` when the id references a TERMINAL cycle — the ingest is
 *    accepted (late ingests are legal) but flagged as a stale reference;
 *  - `{}` when there is no `context.cycleId`, or it references an
 *    active/pending cycle (happy path — no added help).
 * `context.cycle` (the free-form label) is never validated.
 */
function validateCycleRef(
  store: Store,
  projectKey: string,
  body: V2Body,
): { fail?: Response; staleHelp?: string[] } {
  const context = body.context;
  if (typeof context !== "object" || context === null) return {};
  const cycleId = (context as { cycleId?: unknown }).cycleId;
  if (typeof cycleId !== "number") return {};
  const found = store.findCycle(projectKey, cycleId);
  if (found === null) {
    const summary = store.openPlanCycleSummary(projectKey);
    const help =
      summary !== null
        ? cycleHints.unknownCycle(summary.cr, summary.cycleIds)
        : hints.unknownCycleNoPlan;
    return {
      fail: fail(400, `unknown cycleId: ${cycleId} — no such cycle in this project's plans`, {
        help,
      }),
    };
  }
  if (found.terminal) {
    return { staleHelp: cycleHints.staleCycle(cycleId) };
  }
  return {};
}

/**
 * CR-CRU-056 §S3 — the ONE attach/validation seam every stamped ingest
 * surface routes through, sitting exactly where CR-CRU-024 §S7 validation
 * ran. Resolves the POSTING agent's stored binding:
 *  - BOUND, no explicit context.cycleId → re-validate the binding LIVE and
 *    STAMP it into the stored context (the client sends no resolved cycle);
 *  - BOUND, explicit id equal to the binding → belt-and-braces, accepted;
 *  - BOUND, explicit id differing → 409 naming BOTH ids, nothing stored;
 *  - BOUND but the cycle is no longer active (done / plan closed) → 409,
 *    nothing stored — a stale binding never spills into a sibling cycle;
 *  - UNBOUND (or unknown poster) → behavior unchanged: §S7 explicit-context
 *    validation where the surface already ran it (`validateUnbound: true` —
 *    the run routes), verbatim pass-through otherwise (gates).
 *
 * CR-CRU-057 §S1 — the SAME seam (and the SAME single `getAgent` read) also
 * carries the poster's DECLARED role out to the caller, so every stamped
 * surface persists it onto the event row and classification survives the
 * agents-row deletion at unregister. It is read straight off the registration
 * row — never derived from the agentId's shape — and CR-CRU-056 §S3b makes
 * that row's existence structural (an unregistered ingest never reaches here).
 */
function resolveIngestAttach(
  store: Store,
  projectKey: string,
  agentId: string,
  body: V2Body,
  validateUnbound: boolean,
): { fail?: Response; staleHelp?: string[]; context?: RunContext; role?: AgentRole } {
  const agent = store.getAgent(projectKey, agentId);
  const roleAttach: { role?: AgentRole } =
    agent?.role !== undefined ? { role: agent.role } : {};
  const bound = agent?.boundCycleId;
  if (bound === undefined) {
    return {
      ...roleAttach,
      ...(validateUnbound ? validateCycleRef(store, projectKey, body) : {}),
    };
  }
  const context =
    typeof body.context === "object" && body.context !== null ? (body.context as RunContext) : {};
  const explicit = (context as { cycleId?: unknown }).cycleId;
  if (typeof explicit === "number" && explicit !== bound) {
    return {
      fail: fail(
        409,
        `context.cycleId ${explicit} conflicts with agent ${agentId}'s registered binding to cycle ${bound} — run NOT stored`,
        { help: cycleHints.bindingConflict(bound, explicit) },
      ),
    };
  }
  // Re-validated LIVE: the binding was active at registration, but the cycle
  // may since have transitioned or its plan closed.
  const found = store.findCycle(projectKey, bound);
  const plan =
    found === null ? undefined : store.listPlans(projectKey).find((p) => p.planId === found.planId);
  const planClosed = plan !== undefined && plan.status !== "open";
  if (found === null || found.status !== "active" || planClosed) {
    const state =
      found === null
        ? "unknown"
        : planClosed
          ? `in ${plan.status} plan ${plan.cr}`
          : found.status;
    return {
      fail: fail(409, `bound cycle ${bound} is ${state} — ingest refused, run NOT stored`, {
        help: cycleHints.staleBinding(bound, state),
      }),
    };
  }
  return { ...roleAttach, context: { ...context, cycleId: bound } };
}

/** §S1 — one-line run verdict: RED when failed>0, GREEN otherwise. */
function runVerdict(summary: RunSummary): string {
  return summary.failed > 0
    ? `RED — ${summary.failed} failing of ${summary.total}`
    : `GREEN — ${summary.passed}/${summary.total} passed`;
}

/**
 * CR-CRU-056 §S3 (C5) — ECHO the attachment the server actually applied, read
 * straight back off the STORED event so the response can never disagree with
 * what landed in the feed. Since C2 moved cycle attachment server-side, the
 * poster no longer knows which cycle absorbed its evidence; without this echo
 * an agent has to issue a second `GET /api/v2/events` to find out (an
 * observability regression against the pre-CR client-resolved echo).
 *
 * Shape: `context: { cycleId }` — the SAME path the read side already serves
 * (`eventBrief.context.cycleId` on GET /api/v2/events), so the echo is a
 * drop-in for the follow-up GET rather than a second vocabulary, and it maps
 * 1:1 onto the clients' envelope `context` block. Additive: existing consumers
 * read `ok`/`event`/`run`/`verdict`/`help` unchanged.
 *
 * A cycle-less event yields NO `context` key at all — absence is never
 * fabricated into a null or a guess (the `runMeta`/`axi_context` convention).
 *
 * CR-CRU-057 §S1 — the same read-back also reports the ROLE the server
 * stamped, so an agent sees how its own evidence was classified without a
 * follow-up GET. `role` sits top-level alongside `context`, mirroring the
 * Agent shape (where role is a sibling of the run context, not part of it);
 * a role-less event yields no `role` key, same absence rule as above.
 */
function attachEcho(event: RunEvent): { context?: { cycleId: number }; role?: AgentRole } {
  const cycleId = event.context?.cycleId;
  return {
    ...(typeof cycleId === "number" ? { context: { cycleId } } : {}),
    ...(event.role !== undefined ? { role: event.role } : {}),
  };
}

function runResponse(event: RunEvent, summary: RunSummary, help?: string[]): Response {
  return json({
    ok: true,
    changed: true,
    event: event.id,
    run: summary,
    verdict: runVerdict(summary),
    ...attachEcho(event),
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

  // CR-CRU-056 §S3b — ingest ONLY from a live registered caller (refused
  // BEFORE any touchAgent/record — no agent row is created or resurrected);
  // §S3 — then the single attach/validation seam: a BOUND agent's run
  // is server-stamped from its row (or refused, 409, nothing stored); an
  // UNBOUND agent keeps CR-CRU-024 §S7's explicit-context validation.
  const caller = requireRegisteredCaller(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  const { agentId } = caller;
  const attach = resolveIngestAttach(store, pk.key, agentId, body, true);
  if (attach.fail !== undefined) return attach.fail;

  const event = store.recordTestEvent(pk.key, agentId, run, {
    codec: codecName,
    ...runMeta(body),
    ...(attach.context !== undefined ? { context: attach.context } : {}),
    // CR-CRU-057 §S1 — the declared role off the same seam read.
    ...(attach.role !== undefined ? { role: attach.role } : {}),
  });
  // §S3 — a RED ingest carries the transition hint; §S7 adds the stale note.
  const help = [
    ...(run.summary.failed > 0 ? hints.afterRed : []),
    ...(attach.staleHelp ?? []),
  ];
  return runResponse(event, run.summary, help.length > 0 ? help : undefined);
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
    // CR-CRU-038 §S2b — run-level raw output; retained even on a failing ingest.
    ...(typeof body.raw === "string" ? { raw: body.raw } : {}),
  };

  // CR-CRU-056 §S3b — ingest ONLY from a live registered caller (refused
  // BEFORE any touchAgent/record — no agent row is created or resurrected);
  // §S3 — then the single attach/validation seam: a BOUND agent's run
  // is server-stamped from its row (or refused, 409, nothing stored); an
  // UNBOUND agent keeps CR-CRU-024 §S7's explicit-context validation.
  const caller = requireRegisteredCaller(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  const { agentId } = caller;
  const attach = resolveIngestAttach(store, pk.key, agentId, body, true);
  if (attach.fail !== undefined) return attach.fail;

  const event = store.recordTestEvent(pk.key, agentId, run, {
    codec: "parsed",
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...runMeta(body),
    ...(attach.context !== undefined ? { context: attach.context } : {}),
    // CR-CRU-057 §S1 — the declared role off the same seam read.
    ...(attach.role !== undefined ? { role: attach.role } : {}),
  });
  // §S3 — RED transition hint; coverage arrived but the store dropped it
  // (failing run) — say so in help too. §S7 adds the stale-cycle note.
  const dropped = hasCoverage && event.coverage === undefined;
  const help = [
    ...(summary.failed > 0 ? hints.afterRed : []),
    ...(dropped ? hints.coverageDropped : []),
    ...(attach.staleHelp ?? []),
  ];
  return runResponse(event, summary, help.length > 0 ? help : undefined);
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
  // CR-CRU-056 §S3b — ingest ONLY from a live registered caller (refused
  // BEFORE recordCompileEvent's touchAgent — no row created or resurrected).
  const caller = requireRegisteredCaller(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  const { agentId } = caller;
  // CR-CRU-057 §S1 — compile evidence is stamped on the SAME footing as run and
  // gate evidence: the one CR-CRU-056 attach seam resolves the poster's row
  // once and yields both its declared role and its bound cycle (gates parity —
  // this route never ran §S7 explicit-context validation either, so
  // validateUnbound stays false).
  const attach = resolveIngestAttach(store, pk.key, agentId, body, false);
  if (attach.fail !== undefined) return attach.fail;
  const event = store.recordCompileEvent(pk.key, agentId, report, {
    codec: report.format,
    ...runMeta(body),
    ...(attach.context !== undefined ? { context: attach.context } : {}),
    ...(attach.role !== undefined ? { role: attach.role } : {}),
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

// ── CR-CRU-013 §S1+§S4b — gate/milestone event routes ───────────────────────

/** §S1 — accepted no-mistakes gate outcomes (TIERS precedent). */
const GATE_OUTCOMES: ReadonlySet<string> = new Set([
  "checks-passed",
  "passed",
  "failed",
  "cancelled",
]);

/** §S4b/§S4c — accepted milestone types ('cr-merged' joins the set). */
const MILESTONE_TYPES: ReadonlySet<string> = new Set([
  "gap-analysis",
  "design-review",
  "stage-flip",
  "custom",
  "cr-merged",
]);

/** §S2 — the optional graceful context, cast verbatim (runMeta convention). */
function eventContext(body: V2Body): { context?: RunContext } {
  return typeof body.context === "object" && body.context !== null
    ? { context: body.context as RunContext }
    : {};
}

/** §S1 — POST /api/v2/gates: a no-mistakes gate outcome → a gate event. */
async function handleGates(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const pk = requireProject(store, body.projectKey);
  if ("fail" in pk) return pk.fail;

  const gate = body.gate;
  if (typeof gate !== "object" || gate === null) {
    return fail(400, "gate is required", { help: hints.gateFields });
  }
  const g = gate as Record<string, unknown>;
  if (typeof g.intent !== "string" || g.intent.length === 0) {
    return fail(400, "gate.intent is required", { help: hints.gateFields });
  }
  if (typeof g.outcome !== "string" || g.outcome.length === 0) {
    return fail(400, "gate.outcome is required", { help: hints.gateOutcomes });
  }
  if (!Array.isArray(g.steps)) {
    return fail(400, "gate.steps is required", { help: hints.gateFields });
  }
  if (!GATE_OUTCOMES.has(g.outcome)) {
    return fail(400, `gate.outcome must be one of: ${[...GATE_OUTCOMES].join(", ")}`, {
      help: hints.gateOutcomes,
    });
  }
  // CR-CRU-056 §S2b/§S3b — gates are BOTH a workflow verb and an ingest
  // surface: a live registered caller is required (refused BEFORE any
  // touchAgent/record — no row created or resurrected).
  const caller = requireRegisteredCaller(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  const { agentId } = caller;
  // CR-CRU-056 §S3 — gate snapshots are the second stamped surface: a BOUND
  // agent's gate is server-stamped from its row (or refused, 409, nothing
  // stored); an UNBOUND poster keeps today's verbatim context pass-through
  // (this route never ran §S7 validation — validateUnbound stays false).
  const attach = resolveIngestAttach(store, pk.key, agentId, body, false);
  if (attach.fail !== undefined) return attach.fail;
  const event = store.recordGateEvent(pk.key, agentId, gate, {
    ...(attach.context !== undefined ? { context: attach.context } : eventContext(body)),
    // CR-CRU-057 §S1 — the declared role off the same seam read.
    ...(attach.role !== undefined ? { role: attach.role } : {}),
  });
  // CR-CRU-056 §S3 (C5) — the second stamped surface echoes its attachment on
  // exactly the same `context.cycleId` path as the run-ingest response.
  return json({ ok: true, changed: true, event: event.id, ...attachEcho(event) }, 201);
}

/** §S4b/§S4c — POST /api/v2/milestones: a workflow marker → a milestone event. */
async function handleMilestones(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const pk = requireProject(store, body.projectKey);
  if ("fail" in pk) return pk.fail;

  if (typeof body.type !== "string" || body.type.length === 0) {
    return fail(400, "type is required", { help: hints.milestoneTypes });
  }
  if (!MILESTONE_TYPES.has(body.type)) {
    return fail(400, `type must be one of: ${[...MILESTONE_TYPES].join(", ")}`, {
      help: hints.milestoneTypes,
    });
  }
  // CR-CRU-056 §S2b — milestones are a workflow verb: a live registered
  // caller is required (refused BEFORE the event is recorded).
  const caller = requireRegisteredCaller(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  const { agentId } = caller;
  const event = store.recordMilestoneEvent(pk.key, agentId, body.type, {
    ...(typeof body.label === "string" ? { label: body.label } : {}),
    ...(typeof body.commit === "string" ? { commit: body.commit } : {}),
    ...eventContext(body),
  });
  return json({ ok: true, changed: true, event: event.id }, 201);
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
  if (body === null) return fail(400, "malformed JSON body", { help: hints.malformedBody });
  // CR-CRU-056 §S2b — workflow verbs require a live registered caller.
  const caller = requireRegisteredCaller(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  if (typeof body.cr !== "string" || body.cr.length === 0) {
    return fail(400, "cr is required", { help: hints.planFileInput });
  }
  if (!Array.isArray(body.cycles) || body.cycles.length === 0) {
    return fail(400, "cycles must be a non-empty array", { help: hints.planFileInput });
  }
  const cycles: CycleInput[] = [];
  for (const raw of body.cycles) {
    const parsed = parseCycleInput(raw);
    if ("error" in parsed) return fail(400, parsed.error, { help: hints.cycleInput });
    cycles.push(parsed);
  }
  // CR-CRU-021 §S6.11 — additive optional title: stored verbatim when a
  // string, 400 naming the field on any other present type.
  if (body.title !== undefined && typeof body.title !== "string") {
    return fail(400, "title must be a string", { help: hints.planFileInput });
  }
  const title = typeof body.title === "string" ? body.title : undefined;
  // §S6 re-baseline (cycle 19) — additive optional orchestrator identity:
  // stored verbatim when a string, 400 naming the field on any other
  // present type (same contract as title).
  if (body.orchestrator !== undefined && typeof body.orchestrator !== "string") {
    return fail(400, "orchestrator must be a string", { help: hints.planFileInput });
  }
  const orchestrator =
    typeof body.orchestrator === "string" ? body.orchestrator : undefined;
  // Cycle 13 gap 3 — a numeric wave is coerced to its decimal string; any
  // other non-string present type → 400 naming the field.
  if (body.wave !== undefined && typeof body.wave !== "string" && typeof body.wave !== "number") {
    return fail(400, "wave must be a string", { help: hints.planFileInput });
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
  if ("error" in plan) return fail(400, plan.error, { help: hints.duplicateOpenPlan });
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
  if (planId === null) {
    return fail(404, `plan not found: ${planIdRaw}`, { help: hints.planCycleNotFound });
  }
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body", { help: hints.malformedBody });
  // CR-CRU-056 §S2b — workflow verbs require a live registered caller.
  const caller = requireRegisteredCaller(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  const parsed = parseCycleInput(body);
  if ("error" in parsed) return fail(400, parsed.error, { help: hints.cycleInput });
  // CR-CRU-024 §S3.1 — optional `before: <cycleId>` inserts the new cycle
  // immediately before that sibling; omitted → plain append (unchanged).
  const beforeRaw = (body as { before?: unknown }).before;
  let before: number | undefined;
  if (beforeRaw !== undefined) {
    if (typeof beforeRaw !== "number" || !Number.isInteger(beforeRaw)) {
      return fail(400, `invalid before: ${String(beforeRaw)} (expected a cycle id)`, {
        help: hints.cycleInput,
      });
    }
    before = beforeRaw;
  }
  const cycle = store.appendCycle(pk.key, planId, parsed, before);
  if ("error" in cycle) {
    const help =
      cycle.code === "insert-before-active"
        ? cycleHints.insertBeforeActive(cycle.cycleRef!)
        : cycle.notFound === true
          ? hints.planCycleNotFound
          : hints.closedPlan;
    return fail(cycle.notFound === true ? 404 : 400, cycle.error, { help });
  }
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
  if (planId === null) {
    return fail(404, `plan not found: ${planIdRaw}`, { help: hints.planCycleNotFound });
  }
  const cycleId = numericId(cycleIdRaw);
  if (cycleId === null) {
    return fail(404, `cycle not found: ${cycleIdRaw}`, { help: hints.planCycleNotFound });
  }
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body", { help: hints.malformedBody });
  // CR-CRU-056 §S2b — workflow verbs require a live registered caller.
  const caller = requireRegisteredCaller(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  // CR-CRU-024 §S3.2 — the PATCH carries EITHER {status} (transition) or {label}
  // (rename), never both: one mutation per call.
  const hasStatus = body.status !== undefined;
  const hasLabel = body.label !== undefined;
  if (hasStatus && hasLabel) {
    return fail(400, "one mutation per call: send either {status} or {label}, not both", {
      help: hints.cycleOneMutation,
    });
  }
  if (hasLabel) {
    if (typeof body.label !== "string" || body.label.length === 0) {
      return fail(400, "label must be a non-empty string", { help: hints.cycleInput });
    }
    const edited = store.editCycleLabel(pk.key, planId, cycleId, body.label);
    if ("error" in edited) {
      const help =
        edited.code === "locked"
          ? hints.cycleLocked
          : edited.code === "immutable-history"
            ? hints.cycleImmutable
            : hints.planCycleNotFound;
      return fail(edited.notFound === true ? 404 : 400, edited.error, { help });
    }
    return json({ ok: true, changed: true, cycle: edited });
  }
  if (typeof body.status !== "string" || !CYCLE_STATUSES.has(body.status)) {
    return fail(
      400,
      `invalid status: ${String(body.status)} (expected pending | active | done | skipped | failed)`,
      { help: hints.cycleStatus },
    );
  }
  const cycle = store.transitionCycle(pk.key, planId, cycleId, body.status as CycleStatus);
  if ("error" in cycle) {
    // CR-CRU-024 §S4 — attach the help[] matching the store's refusal code.
    const help =
      cycle.code === "out-of-order"
        ? cycleHints.outOfOrder(cycle.cycleRef!)
        : cycle.code === "already-active"
          ? cycleHints.alreadyActive(cycle.cycleRef!)
          : cycle.code === "illegal-transition"
            ? hints.illegalCycleTransition
            : hints.planCycleNotFound;
    return fail(cycle.notFound === true ? 404 : 400, cycle.error, { help });
  }
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
  if (planId === null) {
    return fail(404, `plan not found: ${planIdRaw}`, { help: hints.planCycleNotFound });
  }
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body", { help: hints.malformedBody });
  // CR-CRU-056 §S2b — close AND backfill require a live registered caller.
  const caller = requireRegisteredCaller(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  // §S6 re-baseline (cycle 19) — one-field orchestrator backfill: a PATCH
  // body carrying `orchestrator` with NO `status` stamps an OPEN plan (the
  // executing plan); closed plans → 400, mirroring the close validation.
  if (body.status === undefined && body.orchestrator !== undefined) {
    if (typeof body.orchestrator !== "string") {
      return fail(400, "orchestrator must be a string", { help: hints.planFileInput });
    }
    const stamped = store.stampOrchestrator(pk.key, planId, body.orchestrator);
    if ("error" in stamped) {
      return fail(stamped.notFound === true ? 404 : 400, stamped.error, {
        help: stamped.notFound === true ? hints.planCycleNotFound : hints.closedPlan,
      });
    }
    return json({ ok: true, changed: true, plan: stamped });
  }
  // CR-CRU-031 §S1 — one-field `wave` backfill: a PATCH body carrying `wave`
  // with NO `status` stamps the wave on OPEN and CLOSED plans alike (waves are
  // assigned retroactively). A numeric wave coerces to its decimal string,
  // matching the POST /plans path; a non-string-non-number → 400 naming wave.
  if (body.status === undefined && body.wave !== undefined) {
    if (typeof body.wave !== "string" && typeof body.wave !== "number") {
      return fail(400, "wave must be a string", { help: hints.planFileInput });
    }
    const wave = typeof body.wave === "string" ? body.wave : String(body.wave);
    const stamped = store.stampWave(pk.key, planId, wave);
    if ("error" in stamped) {
      return fail(stamped.notFound === true ? 404 : 400, stamped.error, {
        help: hints.planCycleNotFound,
      });
    }
    return json({ ok: true, changed: true, plan: stamped });
  }
  if (body.status !== "closed") {
    return fail(400, `status must be "closed" to close a plan`, { help: hints.closedPlan });
  }
  let merge: { commit: string } | undefined;
  if (body.merge !== undefined) {
    const commit =
      typeof body.merge === "object" && body.merge !== null
        ? (body.merge as { commit?: unknown }).commit
        : undefined;
    if (typeof commit !== "string" || commit.length === 0) {
      return fail(400, "merge.commit must be a non-empty string", { help: hints.closedPlan });
    }
    merge = { commit };
  }
  const plan = store.closePlan(pk.key, planId, merge);
  if ("error" in plan) {
    return fail(
      plan.notFound === true ? 404 : 400,
      plan.error,
      plan.notFound === true
        ? { help: hints.planCycleNotFound }
        : plan.openCycleIds !== undefined
          ? {
              openCycles: plan.openCycleIds,
              // CR-CRU-048 §S2 — additive labelled form; `openCycles` stays the
              // id-only list existing callers read.
              blockingCycles: plan.openCycleRefs ?? [],
              help: hints.nonTerminalCycles,
            }
          : { help: hints.closedPlan },
    );
  }
  return json({ ok: true, changed: true, plan });
}

/**
 * CR-CRU-024 §S5.1 — POST …/plans/<planId>/checkpoint — fold the plan's
 * ACTIVE cycle's epoch NOW (one durable write, no cadence-window loss) and
 * re-anchor. 200 {ok:true, changed:true} with an active cycle, {changed:false}
 * with none; an unknown plan → 404 + help[].
 */
async function handlePlanCheckpoint(
  store: Store,
  key: string,
  planIdRaw: string,
  req: Request,
): Promise<Response> {
  const pk = requireProject(store, key);
  if ("fail" in pk) return pk.fail;
  // CR-CRU-056 §S2b — checkpoint requires a live registered caller (any
  // role — a bound TDD agent checkpoints its own plan too, not just the
  // orchestrator). An absent/unparseable body carries no agentId → refused.
  const body = (await readBody(req)) ?? {};
  const caller = requireRegisteredCaller(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  const planId = numericId(planIdRaw);
  if (planId === null) {
    return fail(404, `plan not found: ${planIdRaw}`, { help: hints.planCycleNotFound });
  }
  const result = store.checkpointPlan(pk.key, planId);
  if ("error" in result) {
    return fail(404, result.error, { help: hints.planCycleNotFound });
  }
  return json({ ok: true, changed: result.changed });
}

/**
 * CR-CRU-024 §S6 — POST …/plans/<planId>/abort — user-approval-gated workflow
 * abort. The approval gate is the FIRST refusal on this route (checked BEFORE
 * plan existence): a body without `userApproved: true` → 409 + discouraging
 * help[], even for an unknown plan (an unapproved abort never leaks past the
 * gate as a 404/500). WITH `userApproved: true` the abort executes: the active
 * cycle → failed (timer sealed), pending cycles → skipped, plan → aborted; an
 * unknown plan then → 404 + help[] (approval alone doesn't skip existence).
 */
async function handlePlanAbort(
  store: Store,
  key: string,
  planIdRaw: string,
  req: Request,
): Promise<Response> {
  const pk = requireProject(store, key);
  if ("fail" in pk) return pk.fail;
  const body = (await readBody(req)) ?? {};
  // CR-CRU-056 §S2b — caller auth precedes even the approval gate: an
  // unregistered caller is refused with the registration help[] regardless
  // of userApproved (no anonymous verbs, approved or not).
  const caller = requireRegisteredCaller(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  // Approval gate next — mirrors the guarded-run-deletion 409 convention
  // (still checked BEFORE plan existence).
  if (body.userApproved !== true) {
    return fail(
      409,
      "aborting discards a declared workflow — explicit user approval is required; refused",
      { help: hints.abortNeedsApproval },
    );
  }
  const planId = numericId(planIdRaw);
  if (planId === null) {
    return fail(404, `plan not found: ${planIdRaw}`, { help: hints.planCycleNotFound });
  }
  const plan = store.abortPlan(pk.key, planId);
  if ("error" in plan) {
    return fail(plan.notFound === true ? 404 : 400, plan.error, {
      help: plan.notFound === true ? hints.planCycleNotFound : hints.closedPlan,
    });
  }
  return json({ ok: true, changed: true, plan });
}

/**
 * CR-CRU-024 §S5.3 — POST …/projects/<key>/stop — checkpoint every active
 * cycle's timer across the project's open plans. Returns {ok, checkpointed}.
 */
async function handleProjectStop(store: Store, key: string, req: Request): Promise<Response> {
  const pk = requireProject(store, key);
  if ("fail" in pk) return pk.fail;
  // CR-CRU-056 §S2b — project stop requires a live registered caller.
  const body = (await readBody(req)) ?? {};
  const caller = requireRegisteredCaller(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  const checkpointed = store.stopProject(pk.key);
  return json({ ok: true, checkpointed });
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
 * CR-CRU-026 §S3.2 — GET /api/v2/plans: ALL non-archived projects' plans in
 * one additive global read (the home timeline's plan feed). Item shape is
 * IDENTICAL to the project-scoped list — both derive from store.listPlans()
 * (toPlan() already stamps projectKey) — and reply() gives the same
 * ?fmt=toon negotiation. GET-only: any other method falls through handleV2
 * to the server's generic 404 catch-all. store.listProjects() excludes
 * archived projects by default, which IS the exclusion rule here.
 */
function handlePlansGlobalList(store: Store, req: Request, url: URL): Response {
  const plans = store.listProjects().flatMap((project) => store.listPlans(project.key));
  return reply(req, url, { ok: true, plans });
}

/**
 * CR-CRU-012 §S1b — POST …/projects/<key>/archive | /unarchive. Validates
 * UUID shape + existence ONLY (an archived project must stay addressable so
 * unarchive can restore it — requireProject's archived gate does not apply
 * here). Idempotent: repeats → 200 {ok:true, changed:false}, matching the
 * codebase's changed:boolean write convention.
 */
function handleProjectArchive(store: Store, key: string, archive: boolean): Response {
  if (!UUID_RE.test(key)) {
    return fail(400, "projectKey must be a UUID", { help: hints.unknownProject });
  }
  if (store.getProject(key) === null) {
    return fail(404, `unknown project: ${key}`, { help: hints.unknownProject });
  }
  const changed = archive ? store.archiveProject(key) : store.unarchiveProject(key);
  return json({ ok: true, changed });
}

// CR-CRU-012 §S1 — the PATCHable field set; anything else 400s by name.
const PATCHABLE_FIELDS = new Set([
  "name",
  "type",
  "sutRoot",
  "liveness",
  "retention",
  "allowRunDeletion",
]);

// CR-CRU-012 §S1 — wire liveness fields (spec's T1/T2/T3 thresholds, ms) →
// the store's internal Partial<LivenessConfig> keys.
const LIVENESS_WIRE_KEYS = {
  t1_ms: "staleAfterMs",
  t2_ms: "tombstoneAfterMs",
  t3_ms: "pruneAfterMs",
} as const;

/**
 * CR-CRU-012 §S1 — PATCH …/projects/<key>. Editable: name, type
 * (backend|frontend), sutRoot (camelCase, matching POST's wire contract),
 * liveness {t1_ms,t2_ms,t3_ms} (translated to the store's partial override
 * and MERGED with any existing one — updateProject owns the merge), and
 * retention (takes effect on the NEXT ingest, never retroactively).
 * projectKey is immutable → 400; unknown fields → 400 naming the field, and
 * EVERYTHING validates before anything writes (no partial apply). An empty
 * body is the codebase's standard 200 {ok:true, changed:false} no-op.
 * Unknown/archived keys → 404 via requireProject (archived hint included).
 * A real change emits the projects SSE frame (via store.updateProject).
 */
async function handleProjectPatch(store: Store, key: string, req: Request): Promise<Response> {
  const pk = requireProject(store, key);
  if ("fail" in pk) return pk.fail;
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const raw = body as Record<string, unknown>;

  if (raw.projectKey !== undefined) {
    return fail(400, "projectKey is immutable");
  }
  for (const field of Object.keys(raw)) {
    if (!PATCHABLE_FIELDS.has(field)) {
      return fail(400, `unknown field: ${field}`);
    }
  }

  const patch: ProjectPatch = {};
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      return fail(400, "name must be a non-empty string");
    }
    patch.name = raw.name;
  }
  if (raw.type !== undefined) {
    if (raw.type !== "backend" && raw.type !== "frontend") {
      return fail(400, `type must be "backend" or "frontend"`);
    }
    patch.type = raw.type;
  }
  if (raw.sutRoot !== undefined) {
    if (typeof raw.sutRoot !== "string") {
      return fail(400, "sutRoot must be a string");
    }
    patch.sutRoot = raw.sutRoot;
  }
  if (raw.liveness !== undefined) {
    if (typeof raw.liveness !== "object" || raw.liveness === null || Array.isArray(raw.liveness)) {
      return fail(400, "liveness must be an object of {t1_ms, t2_ms, t3_ms}");
    }
    const liveness: Partial<LivenessConfig> = {};
    for (const [wire, value] of Object.entries(raw.liveness)) {
      const internal = LIVENESS_WIRE_KEYS[wire as keyof typeof LIVENESS_WIRE_KEYS];
      if (internal === undefined) {
        return fail(400, `unknown liveness field: ${wire}`);
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return fail(400, `liveness.${wire} must be a positive number of milliseconds`);
      }
      liveness[internal] = value;
    }
    if (Object.keys(liveness).length > 0) {
      patch.liveness = liveness;
    }
  }
  if (raw.retention !== undefined) {
    if (
      typeof raw.retention !== "number" ||
      !Number.isInteger(raw.retention) ||
      raw.retention < 1
    ) {
      return fail(400, "retention must be a positive integer");
    }
    patch.retention = raw.retention;
  }
  if (raw.allowRunDeletion !== undefined) {
    // CR-CRU-008 §S4 — the guarded-deletion config gate is a plain boolean.
    if (typeof raw.allowRunDeletion !== "boolean") {
      return fail(400, "allowRunDeletion must be a boolean");
    }
    patch.allowRunDeletion = raw.allowRunDeletion;
  }

  if (Object.keys(patch).length === 0) {
    // Empty body names no field to reject and changes nothing — the
    // codebase's uniform "nothing changed" answer, not a 400.
    return json({ ok: true, changed: false });
  }
  const changed = store.updateProject(pk.key, patch);
  return json({ ok: true, changed });
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
  if (segments.length === 4 && segments[3] === "checkpoint" && req.method === "POST") {
    return handlePlanCheckpoint(store, key, segments[2]!, req);
  }
  if (segments.length === 4 && segments[3] === "abort" && req.method === "POST") {
    return handlePlanAbort(store, key, segments[2]!, req);
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
    // CR-CRU-057 §S1 (additive) — the stamped declared role and its
    // provenance; both keys ABSENT on events that carry no stored role, so
    // history renders unclassified rather than guessed.
    ...(event.role !== undefined
      ? { role: event.role, roleInferred: event.roleInferred === true }
      : {}),
    // CR-CRU-013 §S1+§S4b (additive) — gate/milestone carrying fields, keys
    // ABSENT on every other kind.
    ...(event.gate !== undefined ? { gate: event.gate } : {}),
    ...(event.type !== undefined ? { type: event.type } : {}),
    ...(event.label !== undefined ? { label: event.label } : {}),
    ...(event.commit !== undefined ? { commit: event.commit } : {}),
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
  // CR-CRU-032 §S1 — anchored fetch: when a cycleId is supplied, return exactly
  // that cycle's linked runs plus its declared "Cycle done" boundary as an
  // additive top-level `cycle` field. Additive: the recent-N feed below is
  // byte-unchanged when no cycleId is present.
  const rawCycleId = url.searchParams.get("cycleId");
  if (rawCycleId !== null && project !== undefined) {
    const cycleId = Number(rawCycleId);
    if (Number.isFinite(cycleId)) {
      const events = store.listEventsForCycle(project, cycleId).map(eventBrief);
      const cycle = store.findCyclePlanEntry(project, cycleId);
      // Unknown cycleId → 200 with an empty set and NO `cycle` field.
      return reply(req, url, {
        ok: true,
        events,
        ...(cycle !== null ? { cycle } : {}),
      });
    }
  }
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

/**
 * CR-CRU-008 §S4 — DOUBLE-GATED single-run deletion (no bulk clear; the run
 * journal is an immutable audit log by default):
 * 1. config gate — the project's `allowRunDeletion` must be true (403 + help
 *    naming the manager setting otherwise);
 * 2. approval gate — the body must carry `userApproved: true` (409 + the
 *    CR-024 §S6-style discouraging help otherwise).
 * Only with BOTH gates open does the existing delete run (the deleted event
 * never folds into later retention-prune rollups — store semantics).
 */
async function handleEventDelete(
  store: Store,
  id: string,
  req: Request,
  url: URL,
): Promise<Response> {
  const pk = requireProject(store, url.searchParams.get("project") ?? undefined);
  if ("fail" in pk) return pk.fail;
  const project = store.getProject(pk.key);
  if (project?.allowRunDeletion !== true) {
    return fail(403, `run deletion is disabled for project ${pk.key}`, {
      help: hints.deletionDisabled,
    });
  }
  const body = (await readBody(req)) ?? {};
  if (body.userApproved !== true) {
    return fail(409, "explicit user approval is required to delete a run — refused", {
      help: hints.deletionNeedsApproval,
    });
  }
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
  // CR-CRU-026 §S3.2 — the global (non-archived) plans read, GET-only.
  if (req.method === "GET" && pathname === "/api/v2/plans") {
    return handlePlansGlobalList(store, req, url);
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
    // CR-CRU-012 §S1b — archive / unarchive verbs.
    if (
      req.method === "POST" &&
      segments.length === 2 &&
      (segments[1] === "archive" || segments[1] === "unarchive")
    ) {
      return handleProjectArchive(store, segments[0]!, segments[1] === "archive");
    }
    // CR-CRU-024 §S5.3 — project stop: checkpoint every active cycle's timer.
    if (req.method === "POST" && segments.length === 2 && segments[1] === "stop") {
      return handleProjectStop(store, segments[0]!, req);
    }
    // CR-CRU-012 §S1 — PATCH project parameters (v2-only; the v1 shim has
    // no equivalent route).
    if (req.method === "PATCH" && segments.length === 1) {
      return handleProjectPatch(store, segments[0]!, req);
    }
  }
  // CR-CRU-044 §S1(a) — the two routes SPLIT on one flag: register must
  // declare a role, heartbeat must not be forced to re-declare it.
  if (req.method === "POST" && pathname === "/api/v2/agents/register") {
    return handleAgentTouch(store, req, true);
  }
  if (req.method === "POST" && pathname === "/api/v2/agents/heartbeat") {
    return handleAgentTouch(store, req, false);
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
  // CR-CRU-013 §S1+§S4b — flat top-level gate/milestone routes (next to
  // /runs, NOT under /projects/).
  if (req.method === "POST" && pathname === "/api/v2/gates") {
    return handleGates(store, req);
  }
  if (req.method === "POST" && pathname === "/api/v2/milestones") {
    return handleMilestones(store, req);
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
        return handleEventDelete(store, id, req, url);
      }
    }
  }
  if (req.method === "GET" && pathname === "/api/v2/status") {
    return handleStatus(store, req, url);
  }
  return null;
}
