// CR-CRU-004 §S1+§S5 — clean v2 API surface: orientation, health parity,
// project rollups (PRD §4.2), agent lifecycle verbs (PRD §4.3). Every write
// response carries `changed: true|false` (§S5). Shares the ONE store instance
// with the v1 shim — src/server.ts wires handleV2 into its dispatcher.
import { codecs, parseRunBody } from "./codecs/index.ts";
import { parseCompile } from "./codecs/compile.ts";
import type { CompileReport } from "./codecs/compile.ts";
import {
  authHints,
  hints,
  cycleHints,
  identityHints,
  projectDeleteHints,
  roadmapHints,
  waveHints,
} from "./hints.ts";
import {
  compareContainers,
  declaredTracks,
  normalizeTrack,
  QueueWaveOverflowError,
  Store,
  TRACK_LANE_RULE,
  UUID_RE,
  WAVE_SEQ_STRIDE,
  waveNumber,
  waveOverflowMessage,
  waveSeqBase,
} from "./store.ts";
import { toToon } from "./toon.ts";
import { AGENT_ROLES, IDENTITY_SOURCES } from "./types.ts";
import type {
  PlanOpError,
  ProjectPatch,
  QueueEntryInput,
  QueuePlanInput,
  QueueSeqReport,
  RecordEventMeta,
  RunRecord,
  TouchAgentOpts,
} from "./store.ts";
import type {
  AgentIdentity,
  AgentRole,
  Coverage,
  CycleKind,
  CycleStatus,
  LivenessConfig,
  PackageRef,
  Plan,
  Project,
  QueueEntry,
  QueueLifecycle,
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
  // CR-CRU-073 §S1 — optional top-level release version the gate gated.
  version?: unknown;
  commit?: unknown;
  // CR-CRU-080 §S4 — a release milestone's provenance, computed by the
  // ceremony: the tag's commit date (epoch seconds) and the CR ids it shipped.
  releasedAt?: unknown;
  crs?: unknown;
  // CR-CRU-084 §S1 — the packages that release delivered, declared by the
  // ceremony (registry + name + version per artifact).
  packages?: unknown;
  // CR-CRU-081 §S3 — the opt-in that lets a re-post CORRECT an already-held
  // release's provenance instead of replaying it.
  repairProvenance?: unknown;
  // CR-CRU-008 §S4 — silent unregister + guarded run deletion
  silent?: unknown;
  userApproved?: unknown;
  // CR-CRU-017 §S1 — the OPEN run this ingest closes (optional: no runId is
  // the unchanged single-shot path).
  runId?: unknown;
  // CR-CRU-014 §S1 — the queue full-replace payload.
  entries?: unknown;
  // CR-CRU-091 §S8 — the roadmap-registration verb bodies. `cr`, `title`,
  // `wave`, `track`, `label` and `crs` are already declared above; these are
  // the four fields only the new routes read.
  release?: unknown;
  targetAt?: unknown;
  by?: unknown;
  reason?: unknown;
  // CR-CRU-106 §S1 — `cr-depends`' whole payload: the complete dependency
  // set. `cr` is already declared above.
  dependsOn?: unknown;
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

// CR-CRU-091 §S3 — the role roadmap registration requires. There is no
// MAINLINE role in AGENT_ROLES and a track orchestrator registers as
// ORCHESTRATOR exactly as the mainline one does, so this gate stops
// RED/GREEN/FIX/VERIFY/report and unregistered callers, and that is the whole
// of its reach. "Only mainline re-plans the roadmap" stays a workflow
// convention; enforcing it needs a new stored role and is a separate CR.
const ROADMAP_ROLE: AgentRole = "ORCHESTRATOR";

/**
 * CR-CRU-091 §S3 — the caller-auth seam, plus the role the five roadmap verbs
 * require. `requireRegisteredCaller` first (its 409 and its state-derived
 * help[] are unchanged), then the stored `Agent.role`.
 *
 * A row carrying NO role is REFUSED, never assumed: pre-CR-044 rows carry
 * none and a role is never fabricated (`src/types.ts:65-69`), so treating an
 * absent declaration as an orchestrator would hand the roadmap to whatever
 * registered before roles existed. Both refusals return BEFORE anything is
 * read for the write, so nothing is stored on either.
 */
function requireOrchestrator(
  store: Store,
  projectKey: string,
  body: V2Body,
): { agentId: string } | { fail: Response } {
  const caller = requireRegisteredCaller(store, projectKey, body);
  if ("fail" in caller) return caller;
  const role = store.getAgent(projectKey, caller.agentId)?.role;
  if (role === ROADMAP_ROLE) return caller;
  const found = role === undefined ? "no declared role" : `role ${role}`;
  return {
    fail: fail(
      409,
      `agent ${caller.agentId} carries ${found} — roadmap registration requires ${ROADMAP_ROLE}`,
      { help: roadmapHints.notOrchestrator(caller.agentId, role, ROADMAP_ROLE) },
    ),
  };
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

  // CR-CRU-059 §S1 — `identity.source` is validated at the SAME route boundary
  // as `role`, before any write, on BOTH paths (register AND heartbeat — they
  // share this seam): a DECLARED value outside IDENTITY_SOURCES is refused with
  // a 409 and nothing is stored, so a rejected heartbeat never clobbers the
  // previously stored value. An ABSENT source stays legal — this rejects wrong
  // values, it does not make the field required. `displayName`/`repoPath` are
  // untouched by the check.
  const identity =
    typeof body.identity === "object" && body.identity !== null
      ? (body.identity as Record<string, unknown>)
      : undefined;
  if (identity !== undefined && identity.source !== undefined) {
    const source = identity.source;
    if (typeof source !== "string" || !(IDENTITY_SOURCES as readonly string[]).includes(source)) {
      return fail(
        409,
        `identity.source must be one of ${IDENTITY_SOURCES.join(" | ")} (got ${JSON.stringify(source)})`,
        { help: identityHints.invalidSource(source, IDENTITY_SOURCES) },
      );
    }
  }

  const existed = store.hasAgent(pk.key, agentId);
  const opts: TouchAgentOpts = {};
  if (body.status === "busy" || body.status === "online") {
    opts.status = body.status;
  }
  if (typeof body.message === "string") {
    opts.message = body.message;
  }
  if (identity !== undefined) {
    opts.identity = identity as AgentIdentity;
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
    // CR-CRU-094 §S2 — and the cycle binding validated one statement above,
    // so an agent that registers bound is attributable from its registration
    // alone — before any run, and after its row is pruned for silence.
    store.recordLifecycleEvent(
      pk.key,
      agentId,
      "registered",
      undefined,
      opts.role,
      opts.boundCycleId,
    );
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
    // CR-CRU-094 §S2 — the cycle binding joins firstSeen/role in that SAME
    // pre-deletion snapshot: the closing entry names the cycle the agent was
    // bound to while the row still said so.
    store.recordLifecycleEvent(
      pk.key,
      agentId,
      "unregistered",
      agent.firstSeen,
      agent.role,
      agent.boundCycleId,
    );
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
  // CR-CRU-017 §S1 — the auto-abort sweep rides CR-011's liveness, so it runs
  // exactly where liveness is computed: an open run whose agent has tombstoned
  // (or which has outlived CRUCIBLE_RUN_ABANDON_MS) is aborted here, before the
  // dashboard reads a dead agent with a run still "running".
  store.sweepOpenRuns(now);
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

/**
 * CR-CRU-017 §S1 — POST /api/v2/runs/start: open a run and answer 202
 * {runId, startedAt}. No run event is stored — a start is not an end — and the
 * open run is PERSISTED in SQLite (the CR's Risk: it must survive a restart).
 * Same caller/attach boundary as every ingest: an unregistered poster is
 * refused, and a bound agent's cycle is resolved server-side once, here, so
 * the run carries the attachment it was opened under.
 */
async function handleRunStart(store: Store, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (body === null) return fail(400, "malformed JSON body");
  const pk = requireProject(store, body.projectKey);
  if ("fail" in pk) return pk.fail;
  const caller = requireRegisteredCaller(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  const { agentId } = caller;
  const attach = resolveIngestAttach(store, pk.key, agentId, body, true);
  if (attach.fail !== undefined) return attach.fail;

  const run = store.startRun(pk.key, agentId, {
    ...runMeta(body),
    ...(attach.context !== undefined ? { context: attach.context } : {}),
  });
  return json(
    {
      ok: true,
      changed: true,
      runId: run.runId,
      startedAt: run.startedAt,
      ...(attach.staleHelp !== undefined ? { help: attach.staleHelp } : {}),
    },
    202,
  );
}

/**
 * CR-CRU-017 §S1 — the OPTIONAL `runId` seam every ingest route shares.
 *
 * No `runId` → `{}`: the single-shot path is untouched, stores no lifecycle
 * field and writes NULL in all three §S0 columns (graceful degradation).
 * With one, the run is resolved and the server's own clock closes it:
 *  - never issued / another project's / another agent's → 400, nothing stored;
 *  - already ended or aborted → 409, nothing stored (the CR's end/end and
 *    end-after-abort races);
 *  - open → the lifecycle stamp for the ONE event about to be written.
 */
function resolveRunClose(
  store: Store,
  projectKey: string,
  agentId: string,
  body: V2Body,
): {
  fail?: Response;
  runId?: string;
  lifecycle?: { startedAt: number; runtimeMs: number };
} {
  if (body.runId === undefined || body.runId === null) return {};
  if (typeof body.runId !== "string" || body.runId.length === 0) {
    return { fail: fail(400, "runId must be a non-empty string — run NOT stored") };
  }
  const runId = body.runId;
  const run = store.getRun(runId);
  if (run === null) {
    return {
      fail: fail(
        400,
        `unknown runId: ${runId} — no run was started under it (POST /api/v2/runs/start first); run NOT stored`,
      ),
    };
  }
  if (run.projectKey !== projectKey || run.agentId !== agentId) {
    return {
      fail: fail(
        400,
        `runId ${runId} belongs to agent ${run.agentId} in another run context — run NOT stored`,
      ),
    };
  }
  if (run.state !== "open") {
    return {
      fail: fail(
        409,
        `run ${runId} is already ${run.state} — a settled run cannot be closed twice; run NOT stored`,
      ),
    };
  }
  const endedAt = Date.now();
  return { runId, lifecycle: { startedAt: run.startedAt, runtimeMs: endedAt - run.startedAt } };
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
  // CR-CRU-017 §S1 — the optional run this ingest CLOSES, resolved before any
  // write so a refused close (400/409) stores nothing.
  const close = resolveRunClose(store, pk.key, agentId, body);
  if (close.fail !== undefined) return close.fail;

  const event = store.recordTestEvent(pk.key, agentId, run, {
    codec: codecName,
    ...runMeta(body),
    ...(attach.context !== undefined ? { context: attach.context } : {}),
    // CR-CRU-057 §S1 — the declared role off the same seam read.
    ...(attach.role !== undefined ? { role: attach.role } : {}),
    ...(close.lifecycle !== undefined ? { lifecycle: close.lifecycle } : {}),
  });
  // The run is settled by the event that closed it — recorded after the write,
  // so a failed ingest leaves the run OPEN (and sweepable) rather than lost.
  if (close.runId !== undefined && close.lifecycle !== undefined) {
    store.endRun(close.runId, event.id, close.lifecycle.startedAt + close.lifecycle.runtimeMs);
  }
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
  // CR-CRU-017 §S1 — the optional run this ingest CLOSES, resolved before any
  // write so a refused close (400/409) stores nothing.
  const close = resolveRunClose(store, pk.key, agentId, body);
  if (close.fail !== undefined) return close.fail;

  const event = store.recordTestEvent(pk.key, agentId, run, {
    codec: "parsed",
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...runMeta(body),
    ...(attach.context !== undefined ? { context: attach.context } : {}),
    // CR-CRU-057 §S1 — the declared role off the same seam read.
    ...(attach.role !== undefined ? { role: attach.role } : {}),
    ...(close.lifecycle !== undefined ? { lifecycle: close.lifecycle } : {}),
  });
  if (close.runId !== undefined && close.lifecycle !== undefined) {
    store.endRun(close.runId, event.id, close.lifecycle.startedAt + close.lifecycle.runtimeMs);
  }
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
  // CR-CRU-017 §S1 — the optional run this compile ingest CLOSES.
  const close = resolveRunClose(store, pk.key, agentId, body);
  if (close.fail !== undefined) return close.fail;
  const event = store.recordCompileEvent(pk.key, agentId, report, {
    codec: report.format,
    ...runMeta(body),
    ...(attach.context !== undefined ? { context: attach.context } : {}),
    ...(attach.role !== undefined ? { role: attach.role } : {}),
    ...(close.lifecycle !== undefined ? { lifecycle: close.lifecycle } : {}),
  });
  if (close.runId !== undefined && close.lifecycle !== undefined) {
    store.endRun(close.runId, event.id, close.lifecycle.startedAt + close.lifecycle.runtimeMs);
  }
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

/**
 * §S4b/§S4c — accepted milestone types ('cr-merged' joins the set).
 * CR-CRU-074 §S1 — 'release' joins it too: a shipped release is a recorded
 * event whose `label` is the version and `commit` the tagged sha. Purely
 * additive — every pre-existing type keeps its exact behaviour, and the
 * validation error still enumerates the whole accepted set.
 */
const MILESTONE_TYPES: ReadonlySet<string> = new Set([
  "gap-analysis",
  "design-review",
  "stage-flip",
  "custom",
  "cr-merged",
  "release",
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
  // CR-CRU-073 §S1 — an optional top-level `version` (SIBLING of `gate`, not
  // inside the gate object) names the release this gate gated; stored
  // first-class on the event. Ignored unless it is a non-empty string.
  const version =
    typeof body.version === "string" && body.version.length > 0 ? body.version : undefined;
  const event = store.recordGateEvent(pk.key, agentId, gate, {
    ...(attach.context !== undefined ? { context: attach.context } : eventContext(body)),
    // CR-CRU-057 §S1 — the declared role off the same seam read.
    ...(attach.role !== undefined ? { role: attach.role } : {}),
    ...(version !== undefined ? { version } : {}),
  });
  // CR-CRU-056 §S3 (C5) — the second stamped surface echoes its attachment on
  // exactly the same `context.cycleId` path as the run-ingest response.
  return json({ ok: true, changed: true, event: event.id, ...attachEcho(event) }, 201);
}

/**
 * CR-CRU-084 §S1 — a well-formed `packages` MEMBER: an object whose `registry`,
 * `name` and `version` are all non-empty strings. The same bar a `crs` member
 * has to clear (`typeof === "string" && length > 0`), applied to each of the
 * three coordinates, because a half-identified artifact identifies nothing.
 */
function isPackageRef(entry: unknown): entry is PackageRef {
  if (typeof entry !== "object" || entry === null) return false;
  const { registry, name, version } = entry as Record<string, unknown>;
  return (
    typeof registry === "string" &&
    registry.length > 0 &&
    typeof name === "string" &&
    name.length > 0 &&
    typeof version === "string" &&
    version.length > 0
  );
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
  // CR-CRU-080 §S4 — the two provenance fields only the ceremony can compute
  // (it stands in the repo with git): `releasedAt`, the tag's own commit date
  // in epoch SECONDS, and `crs`, the CR ids its tag range merged, already
  // intersected with the registered queue by the reporter (the client's
  // `release_crs`) — so this route carries them, verbatim, and re-derives
  // nothing. Validated the CR-CRU-073 §S1 way: carried only when well-formed,
  // never coerced — a finite positive number, and the non-empty strings of an
  // array. An EMPTY array is meaningful and kept: it says the reporter looked
  // and the queue held none of what the tag range merged.
  const releasedAt =
    typeof body.releasedAt === "number" && Number.isFinite(body.releasedAt) && body.releasedAt > 0
      ? body.releasedAt
      : undefined;
  const crs = Array.isArray(body.crs)
    ? body.crs.filter((cr: unknown): cr is string => typeof cr === "string" && cr.length > 0)
    : undefined;
  // CR-CRU-084 §S1 — and the packages the release DELIVERED, carried the same
  // way and for the same reason: only the ceremony knows what its publish jobs
  // put on a registry, and Crucible never verifies that a publish happened
  // (spec Non-goals) — so the route stores what it was given, verbatim.
  //
  // Never-coerce at BOTH granularities `crs` uses above: a value that is not
  // an ARRAY drops the whole FIELD (the record carries no key, never the empty
  // array AC4 makes mean "delivered nothing"), while an array drops its
  // ill-formed MEMBERS and keeps the well-formed ones — an entry being
  // well-formed exactly when `registry`, `name` and `version` are all
  // non-empty strings. Nothing is ever stringified or filled in, and nothing
  // is fatal: a published release must not be blocked by a reporting gap.
  const packages = Array.isArray(body.packages)
    ? body.packages.filter(isPackageRef)
    : undefined;
  // CR-CRU-080 §S3 — a replayed release (identical type/label/commit) is the
  // store's idempotent no-op, echoed as the codebase's uniform "nothing
  // changed" answer with the event already held, never a second row. Its
  // provenance is the FIRST recording's: a replay re-computes nothing.
  //
  // CR-CRU-081 §S3 — unless the caller asks, in this request, for the held
  // record's provenance to be RE-DERIVED. The opt-in is a literal `true` and
  // nothing else (the CR-CRU-073 §S1 never-coerce rule): a missing, absent or
  // merely truthy field is an ordinary post, so the replay is what an
  // accident gets. The route carries the flag; deciding what a repair means
  // stays in the store, next to the dedup it is the exception to.
  const repairProvenance = body.repairProvenance === true;
  const written = store.recordMilestoneEvent(pk.key, agentId, body.type, {
    ...(typeof body.label === "string" ? { label: body.label } : {}),
    ...(typeof body.commit === "string" ? { commit: body.commit } : {}),
    ...(releasedAt !== undefined ? { releasedAt } : {}),
    ...(crs !== undefined ? { crs } : {}),
    ...(packages !== undefined ? { packages } : {}),
    ...(repairProvenance ? { repairProvenance } : {}),
    ...eventContext(body),
  });
  // CR-CRU-129 §S4 — a REPLAY that would lose provenance the project already
  // holds is REFUSED, and the refusal is the answer: nothing was written, so
  // there is no event to echo. A client-class status, because the caller CAN
  // act on it — re-derive the missing landings, or say `--repair-provenance`
  // and take responsibility for the correction. The error NAMES the release
  // and every id that would have gone, since a count alone cannot be acted
  // on, and the `shrink` object beside it is the very one an applied repair
  // carries: one vocabulary for one finding, two verdicts.
  const { event, changed, shrink } = written;
  if (written.refused === true && shrink !== undefined) {
    return fail(
      409,
      `release ${String(body.label)} replay refused: it would drop ` +
        `${shrink.removed.length} recorded CR(s) — ${shrink.removed.join(", ")}`,
      { shrink },
    );
  }
  // CR-CRU-086 §S3 — a repair that SHRANK a stored `crs` carries what it
  // dropped back to the reporter, which is the only actor that can say it out
  // loud where a human will read it.
  return json(
    { ok: true, changed, event: event.id, ...(shrink !== undefined ? { shrink } : {}) },
    changed ? 201 : 200,
  );
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
  // CR-CRU-121 §S1 — the optional `release` that makes filing a plan a ROADMAP
  // declaration too. ABSENT, nothing below happens and this route is what it
  // was before this CR: no queue read beyond the wave scope, no queue write,
  // no new response keys (D4's "a CR can be born mid-release" stays possible).
  //
  // PRESENT, the request IS `cr-plan`'s declaration, so it is answered by
  // `cr-plan`'s OWN functions, in `cr-plan`'s order — the requiredness of a
  // wave and a title, then membership, then the dependency ring — and a second
  // wording of any of them is exactly the drift this CR exists to prevent.
  // Each check refuses the WHOLE request, all of them before any write.
  const release = body.release ?? undefined;
  let entry: QueuePlanInput | undefined;
  if (release !== undefined) {
    if (typeof release !== "string" || release.length === 0) {
      return fail(400, RELEASE_REQUIRED);
    }
    if (wave === undefined || wave.length === 0) {
      return fail(400, "`wave` is required — the wave within the release");
    }
    if (title === undefined || title.length === 0) {
      return fail(400, "`title` is required — the CR's brief");
    }
    const membership = declareMembership(
      liveProposalLabels(store, pk.key),
      { release, cr: body.cr },
      undefined,
      recordedReleaseClaiming(store, pk.key),
    );
    if ("fail" in membership) return membership.fail;
    const cycle = refuseDependencyCycle(store.listQueue(pk.key), [body.cr]);
    if (cycle !== null) return cycle;
    entry = { cr: body.cr, release, wave, title };
  }
  // CR-CRU-116 §S1/§S2/§S3 — the WAVE scope, asked BEFORE the write so a
  // refusal leaves nothing behind: one wave holds open work, and waves open in
  // ascending order. `already-active` before `out-of-order`, both read off the
  // QUEUE entry (never `body.wave`, which is the caller's snapshot), answered
  // in this route's existing 400 shape with the code the cycle scope declares.
  const waveScope = store.waveScopeRefusal(pk.key, body.cr);
  if (waveScope !== undefined) {
    return fail(400, waveScope.error, {
      code: waveScope.code,
      help:
        waveScope.code === "already-active"
          ? waveHints.alreadyActive(waveScope.waveRef, waveScope.crRef)
          : waveHints.outOfOrder(waveScope.waveRef, waveScope.crRef),
    });
  }
  const planInput = {
    cr: body.cr,
    ...(title !== undefined ? { title } : {}),
    ...(orchestrator !== undefined ? { orchestrator } : {}),
    ...(wave !== undefined ? { wave } : {}),
    ...(track !== undefined ? { track } : {}),
    cycles,
  };
  // CR-CRU-121 §S1 — when a release was declared, the queue row and the plan
  // land in ONE transaction: a refusal from EITHER half (and `filePlan`'s
  // duplicate-open-plan refusal is the reachable one) leaves NEITHER behind,
  // so the board never holds a registration for a plan that was refused.
  let registration: QueueSeqReport & { changed: boolean } | undefined;
  let plan: Plan | PlanOpError;
  if (entry === undefined) {
    plan = store.filePlan(pk.key, planInput);
  } else {
    // `cr-plan`'s own catch: a wave whose seq block is full refuses in
    // `wave-sequence`'s envelope, with nothing written.
    let written: ReturnType<Store["filePlanRegistering"]>;
    try {
      written = store.filePlanRegistering(pk.key, entry, planInput);
    } catch (error) {
      if (error instanceof QueueWaveOverflowError) return waveOverflow(error);
      throw error;
    }
    if ("error" in written) {
      plan = written;
    } else {
      registration = written.report;
      plan = written.plan;
    }
  }
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
      // CR-CRU-121 §S1 — the union of both routes' answers, present EXACTLY
      // when a release was declared: `converged` is `cr-plan`'s word for "this
      // call wrote nothing new" (§S7), and `entry` is the queue row the board
      // now holds, read back rather than echoed.
      ...(registration !== undefined
        ? {
            converged: !registration.changed,
            entry: store.listQueue(pk.key).find((row) => row.cr === plan.cr),
          }
        : {}),
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

/**
 * CR-CRU-074 §S3 — the wire shape of a recorded release: the version (the
 * milestone's `label`), the sha its tag points at, and when it was recorded.
 * Deliberately NOT an event brief (openRunBrief's precedent): a release is a
 * shipped VERSION, not a run, and these keys are exactly what CR-CRU-014's
 * boundary rows and CR-CRU-022's forecast band read. Each carrying field is
 * spread only when the stored event has it — a release whose version or commit
 * was never recorded is reported as missing, never as an invented value (AC6).
 *
 * CR-CRU-080 §S4/AC9 — plus the provenance the ceremony computed: `releasedAt`
 * (the tag's own commit date, epoch SECONDS — when the release actually
 * SHIPPED, as opposed to `timestamp`, which is when it was RECORDED) and `crs`
 * (the CR ids it shipped). Both follow the same absence rule: a release
 * recorded before §S4 reports neither, rather than a fabricated date or an
 * empty set that would claim the release shipped nothing.
 *
 * CR-CRU-084 §S2 — and `packages`, the artifacts the release DELIVERED, on the
 * same absence rule for the same reason: a release recorded before CR-CRU-084
 * carries no key at all, which is a different fact from the EMPTY array a
 * ceremony that looked and delivered none records (AC4), so the two must stay
 * distinguishable here on the wire.
 */
function releaseBrief(event: RunEvent) {
  return {
    ...(event.label !== undefined ? { version: event.label } : {}),
    ...(event.commit !== undefined ? { commit: event.commit } : {}),
    ...(event.releasedAt !== undefined ? { releasedAt: event.releasedAt } : {}),
    ...(event.crs !== undefined ? { crs: event.crs } : {}),
    ...(event.packages !== undefined ? { packages: event.packages } : {}),
    timestamp: event.timestamp,
  };
}

/**
 * CR-CRU-074 §S3 — GET …/projects/<key>/releases. Existence is validated the
 * way handleProjectArchive validates it (UUID shape, then the row) and NOT
 * through requireProject: an archived project still exists and must answer,
 * and the archived exclusion belongs to the store's NOT_ARCHIVED subquery,
 * which yields an empty list rather than an error. A project with no releases
 * is a 200 with an empty array — "none yet" is an answer, not a missing
 * resource.
 */
function handleProjectReleases(store: Store, key: string, req: Request, url: URL): Response {
  if (!UUID_RE.test(key)) {
    return fail(400, "projectKey must be a UUID", { help: hints.unknownProject });
  }
  if (store.getProject(key) === null) {
    return fail(404, `unknown project: ${key}`, { help: hints.unknownProject });
  }
  return reply(req, url, { ok: true, releases: store.listReleases(key).map(releaseBrief) });
}

/**
 * CR-CRU-129 §S3 — GET …/projects/<key>/milestones?type=<type>: the project's
 * milestone RECORDS of one type, newest-first.
 *
 * Declared exactly as `releases`, `queue` and `release-proposals` are —
 * `segments.length === 2` plus the collection name, existence validated the
 * handleProjectReleases way (UUID shape, then the row), an archived project
 * answering 200 with an empty list through the store's NOT_ARCHIVED exclusion.
 * `milestones` is the collection these rows now live in, so that is what they
 * are served under.
 *
 * THE TYPE IS A PARAMETER, NOT A PATH SEGMENT AND NOT A CLOSED LIST. It is
 * required — this route answers "the records of THIS type", and a call that
 * names none is asking a different question (the whole timeline), which is
 * what `GET /api/v2/events` is for. It is never checked against the types the
 * server happens to know: the store's `type` column is unconstrained TEXT and
 * CR-CRU-130 makes the vocabulary project-definable, so a type this build has
 * never heard of must answer with its records rather than a refusal, and a
 * type nobody has recorded is an EMPTY answer rather than a 404 — "none yet"
 * is an answer, not a missing resource (the `releases` precedent).
 *
 * WHOLE, NOT WINDOWED. There is no `limit` here and there must not be one.
 * This route exists because `cr_merged_crs` had to scan the newest N events
 * and filter client-side, and a bound is what made that read lose records
 * silently as telemetry grew; a bounded answer here would reintroduce the
 * defect one layer down.
 *
 * The rows are served as `getEvent` serves them — no per-type brief. A brief
 * would have to enumerate the payload fields of every type that exists
 * (`crs`, `releasedAt`, `targetAt`, …) and would therefore be lossy for the
 * first type it did not anticipate, which is precisely the type this route
 * promises to serve.
 */
function handleProjectMilestones(store: Store, key: string, req: Request, url: URL): Response {
  if (!UUID_RE.test(key)) {
    return fail(400, "projectKey must be a UUID", { help: hints.unknownProject });
  }
  if (store.getProject(key) === null) {
    return fail(404, `unknown project: ${key}`, { help: hints.unknownProject });
  }
  const type = url.searchParams.get("type");
  if (type === null || type.length === 0) {
    return fail(400, "`type` is required — the milestone type to read, e.g. `cr-merged`");
  }
  const milestones = store.listMilestonesByType(key, type);
  return reply(req, url, { ok: true, milestones, totalCount: milestones.length });
}

/**
 * CR-CRU-014 §S1 — GET …/projects/<key>/queue. Existence is validated the
 * handleProjectReleases way (UUID shape, then the row); an archived project
 * still answers 200 but the store's NOT_ARCHIVED exclusion yields an empty
 * list. Each entry carries its DERIVED status + plan link.
 *
 * CR-CRU-108 §S1/AC1 — the reply also STATES the project's declared tracks
 * beside its entries, by `declaredTracks` (`src/store.ts`) — the store's own
 * lane rule, never a second copy of it here. Derived from the entries this
 * read returned, so it is always present (a trackless queue states `[]`) and
 * always consistent with them, and no row is rewritten to produce it.
 */
function handleQueueGet(store: Store, key: string, req: Request, url: URL): Response {
  if (!UUID_RE.test(key)) {
    return fail(400, "projectKey must be a UUID", { help: hints.unknownProject });
  }
  if (store.getProject(key) === null) {
    return fail(404, `unknown project: ${key}`, { help: hints.unknownProject });
  }
  const entries = store.listQueue(key);
  return reply(req, url, { ok: true, entries, tracks: declaredTracks(entries) });
}

/**
 * CR-CRU-014 §S1 — POST …/projects/<key>/queue: FULL-REPLACE the queue.
 * Validation 400s name the offending field AND index. Unknown dependsOn
 * targets (forward refs to CRs not in the posted set) are ACCEPTED and
 * flagged in `unknownDependencies`, never rejected.
 *
 * CR-CRU-099 §S3/AC9 — the caller gate is FIELD-CONDITIONAL. A post that
 * declares `release`, `track` or `lifecycle` is roadmap registration and
 * takes the same `requireOrchestrator` the five roadmap verbs take
 * (`handleCrPlan`, `handleWaveSequence`, `handleCrLifecycle` and their
 * siblings) — one authorization rule, one refusal wording. A post declaring
 * none of them is queue BOOTSTRAP and stays open, because the only real
 * caller of this route is `queue-file` (`cmd_queue_file` in
 * `clients/_crucible_axi.py`), whose payload is `{"entries": …}` with no
 * `agentId` at all: a route-wide gate would refuse the orchestrator's own
 * roadmap import.
 *
 * CR-CRU-104 §S1 — this route is the MIGRATION door, not a co-equal declaring
 * path: the approved API declares membership per-CR through `cr-plan`
 * (`.lavish/crucible-workflow-flowchart.html` §12), and this one exists to
 * move an existing README-table roadmap onto the board. It must therefore
 * answer a membership declaration exactly as `cr-plan` does — a migration
 * that stores membership the per-CR verb would have refused is a migration
 * that corrupts the board — which it does by passing every declared
 * `release`/`track` through `declareMembership`, the ONE decision both routes
 * reach. The one deliberate asymmetry that STAYS: a dependency CYCLE is
 * accepted here (`src/hints.ts`'s cycle help names re-posting the queue as
 * the remedy, so this door is the documented escape hatch) and refused by
 * `cr-plan`/`wave-sequence`, pending a user ruling.
 *
 * CR-CRU-118 §S3 — and the door is DEPRECATED. It is transitional and will be
 * REMOVED, so it says so itself: every answer it gives carries the
 * `deprecated-route` `QueueWarning` (`DEPRECATED_ROUTE_NOTICE`) — on the
 * SUCCESS path beside `defaulted-seq`/`inherited-release-less`, on its own
 * refusals through the local `refuse` helper, and on the refusals shared
 * helpers built, through `deprecateRefusal`. The notice names the three verbs
 * that replace it: `cr-plan` (membership), `cr-depends` (dependencies) and
 * `wave-sequence` (order). DEPRECATED IS NOT REMOVED — this route still
 * writes and today's whole table still bootstraps through it — but nothing
 * new should be built on it.
 */
async function handleQueuePost(store: Store, key: string, req: Request): Promise<Response> {
  // CR-CRU-118 §S3 — EVERY answer this door gives says that the door is
  // deprecated, so its own refusals are built through one local helper rather
  // than ten hand-spread `warnings` fields. `fail`'s signature exactly, so the
  // wordings and help[] below are untouched by the notice riding beside them.
  const refuse = (status: number, error: string, extra?: Record<string, unknown>): Response =>
    fail(status, error, { ...extra, warnings: DEPRECATED_ROUTE_NOTICE });
  if (!UUID_RE.test(key)) {
    return refuse(400, "projectKey must be a UUID", { help: hints.unknownProject });
  }
  if (store.getProject(key) === null) {
    return refuse(404, `unknown project: ${key}`, { help: hints.unknownProject });
  }
  const body = (await readBody(req)) ?? {};
  const rawEntries = body.entries;
  if (!Array.isArray(rawEntries)) {
    return refuse(400, "queue body must carry an `entries` array");
  }
  // §S3/AC9 — "declares" means exactly what the forwarding spreads below
  // treat as declared: a value that is neither absent nor null. A post whose
  // membership fields would write nothing declares nothing, so it is
  // bootstrap and stays open. The scan reads the POSTED entries and lives
  // here in the handler, before any per-entry validation, so authorization
  // precedes body shape exactly as it does on the five roadmap routes.
  const declaresMembership = rawEntries.some((entry: unknown) => {
    if (entry === null || typeof entry !== "object") return false;
    const posted = entry as Record<string, unknown>;
    return (
      (posted.release ?? null) !== null ||
      (posted.track ?? null) !== null ||
      (posted.lifecycle ?? null) !== null
    );
  });
  if (declaresMembership) {
    const caller = requireOrchestrator(store, key, body);
    if ("fail" in caller) return deprecateRefusal(caller.fail);
  }
  // CR-CRU-104 §S1 — the live proposals every DECLARED release below is
  // measured against, read ONCE: a hundred-row migration must not re-scan the
  // project's milestones a hundred times. A post that declares nothing is
  // asked nothing, so it reads nothing either.
  const proposed = declaresMembership
    ? liveProposalLabels(store, key)
    : new Set<string>();
  // …and SETTLED HISTORY, read once on the same terms: the derivation is one
  // scan of the milestone table, never one per entry. BOTH rungs this route
  // owns ask it — the membership gate below (CR-CRU-118 §S3a: a declared label
  // naming the RECORDED release that shipped this cr) and the insert rung
  // further down (§S2: a release-less row settled history already accounts
  // for) — so it is resolved here, above them both, and there is exactly one
  // of it.
  const claimingRelease = recordedReleaseClaiming(store, key);
  const entries: QueueEntryInput[] = [];
  for (let index = 0; index < rawEntries.length; index++) {
    const raw: unknown = rawEntries[index];
    if (raw === null || typeof raw !== "object") {
      return refuse(400, `entry at index ${index} is not an object`);
    }
    // Narrowed to a plain object at the JSON boundary; each field is validated
    // individually below before use.
    const fields = raw as Record<string, unknown>;
    if (typeof fields.cr !== "string" || fields.cr.length === 0) {
      return refuse(400, `entry at index ${index} is missing required field \`cr\``);
    }
    if (fields.wave === undefined || fields.wave === null) {
      return refuse(400, `entry at index ${index} is missing required field \`wave\``);
    }
    if (fields.dependsOn !== undefined && !Array.isArray(fields.dependsOn)) {
      return refuse(400, `entry at index ${index} has a non-array \`dependsOn\``);
    }
    const dependsOn = Array.isArray(fields.dependsOn)
      ? fields.dependsOn.map((dep) => String(dep))
      : [];
    // CR-CRU-091 §S2 — an EXPLICIT seq may ride the bulk post: `replaceQueue`
    // has carried one since C1, and an authored order must survive the
    // bootstrap that re-posts the table it came from. Never coerced: a
    // non-integer is refused by name and index rather than rounded into a
    // position nobody chose.
    if (fields.seq !== undefined && fields.seq !== null && !Number.isInteger(fields.seq)) {
      return refuse(400, `entry at index ${index} has a non-integer \`seq\``);
    }
    // CR-CRU-104 §S1 — the membership this entry DECLARES, AS RECEIVED, put
    // through the ONE membership decision `cr-plan` and `wave-sequence` also
    // pass through: the SHAPE of a declared label or lane, the live-proposal
    // requirement — the rule this route did not have, so a migration could
    // store membership in a release nobody proposed — and the lane refusal
    // CR-CRU-099 §S1/AC4a added here because `replaceQueue`'s own
    // `normalizeTrack` guard throws a plain `Error` this handler does not
    // catch, which would answer authored input 500. Refused by field name AND
    // index, this route's own shape.
    //
    // Nothing is COERCED on the way in. This route used to hand the gate
    // `String(fields.release)`, which turned a JSON number into the label
    // `"2"` and stored it while `cr-plan` type-refused the same input: a
    // migration storing membership the per-CR verb would have refused, which
    // is this CR's own thesis one field lower down. What the gate returns is
    // what may be stored — the declared label, and the NORMALISED lane.
    const membership = declareMembership(
      proposed,
      { release: fields.release, track: fields.track, cr: fields.cr },
      index,
      claimingRelease,
    );
    if ("fail" in membership) return deprecateRefusal(membership.fail);
    const release = membership.release;
    const track = membership.track;
    // §S1 — `lifecycle` is the one declared field that is a STRUCTURE, so its
    // SHAPE is refused by name and index exactly as a non-array `dependsOn`
    // is. `replaceQueue` stringifies it verbatim into `lifecycle_json` (its
    // INSERT's `lifecycle` binding) and `listQueue` publishes it back as a
    // `QueueLifecycle` (its `JSON.parse(row.lifecycle_json)` projection), so
    // anything else is a value no reader of that type can trust. What is
    // asserted is exactly what `QueueLifecycle` declares (`src/types.ts`) — no
    // further rule about the disposition itself, which is
    // `handleCrLifecycle`'s business (`cr-supersede` / `cr-void`).
    const declared =
      typeof fields.lifecycle === "object" &&
      fields.lifecycle !== null &&
      !Array.isArray(fields.lifecycle)
        ? (fields.lifecycle as Record<string, unknown>)
        : undefined;
    const state = declared?.state;
    const at = declared?.at;
    let lifecycle: QueueLifecycle | undefined;
    if (fields.lifecycle !== undefined && fields.lifecycle !== null) {
      if ((state !== "SUPERSEDED" && state !== "VOID") || typeof at !== "number") {
        return refuse(
          400,
          `entry at index ${index} has a \`lifecycle\` that is not one: a lifecycle carries ` +
            `{state: "SUPERSEDED" | "VOID", by?, reason?, at: epoch ms}`,
        );
      }
      lifecycle = {
        state,
        ...(typeof declared?.by === "string" ? { by: declared.by } : {}),
        ...(typeof declared?.reason === "string" ? { reason: declared.reason } : {}),
        at,
      };
    }
    entries.push({
      cr: fields.cr,
      ...(fields.title !== undefined && fields.title !== null
        ? { title: String(fields.title) }
        : {}),
      wave: String(fields.wave),
      dependsOn,
      ...(fields.size !== undefined && fields.size !== null
        ? { size: String(fields.size) }
        : {}),
      ...(typeof fields.seq === "number" ? { seq: fields.seq } : {}),
      // CR-CRU-099 §S1 — the three fields the `QueueEntryInput` interface
      // DECLARES, on the same footing as the six above: read
      // when the caller sends one, ABSENT when undeclared — never defaulted,
      // because an absent declaration is a fact — and left to `replaceQueue`'s
      // carry-forward, which already depends on all three. Until this CR the
      // route accepted them and read none, so a declared release was answered
      // `200` and stored as nothing (CR-CRU-091 §S8's five-verb boundary,
      // moved here because CR-CRU-078's e2e scenario declares through THIS
      // route). `release` and `track` are the values the membership gate
      // VETTED and returned; a property one literal deeper than these would
      // store nothing under its name at all, which the AC11 half of
      // tests/queue-accepted-field-guard.test.ts now fires on.
      ...(release !== undefined ? { release } : {}),
      ...(track !== undefined ? { track } : {}),
      ...(lifecycle !== undefined ? { lifecycle } : {}),
    });
  }
  // CR-CRU-118 §S2 — the membership split, and it runs on the WHOLE batch
  // before a single row is written: this route is a full replace, so a
  // refusal raised half way through a write would leave a board nobody
  // authored. What the write would INVENT is refused; what it INHERITS is
  // warned about.
  //
  // The board AS HELD, read once — the same snapshot `replaceQueue`'s
  // carry-forward reads, so "the release this write will store" is decided
  // here exactly as it is decided there (`entry.release ?? snapshot.release`).
  // Nothing below re-implements the carry-forward; it only ASKS what the
  // carry-forward will leave.
  const held = new Map(store.listQueue(key).map((entry) => [entry.cr, entry]));
  // Settled history is `claimingRelease`, resolved once above the entry loop
  // because the membership gate reads the very same derivation (§S3a).
  const inheritedReleaseLess: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.release !== undefined) continue;
    const snapshot = held.get(entry.cr);
    if (snapshot === undefined) {
      // INVENTED: a cr the board has never seen, arriving with no membership
      // — the CR-CRU-117 incident, and the only thing this route refuses that
      // it used to accept. Refused by field, cr AND index (this route's own
      // shape), carrying the ONE requiredness sentence rather than a third
      // wording of it, and the help[] §S5 requires.
      //
      // UNLESS a recorded release's own `crs` set already NAMES it (user
      // ruling, 2026-09-10): then the write is not inventing membership, it is
      // carrying a row settled history already accounts for. On an EMPTY board
      // every entry is an insert, so without this rung a wiped-board restore —
      // which has actually happened here, 2026-08-29 — was refused at its
      // first landed row, one row per attempt. The question asked is a
      // property of the ROW and never of the board's size, so clearing the
      // board buys nothing: a shipped release cannot claim a CR that did not
      // exist when it shipped.
      if (claimingRelease(entry.cr) === undefined) {
        return refuse(
          400,
          `entry at index ${index} (${entry.cr}): ${RELEASE_REQUIRED}`,
          { help: roadmapHints.missingRelease },
        );
      }
      // Admitted — and named, because it IS a release-less row this write
      // carried, which is exactly what the warning below reports.
      inheritedReleaseLess.push(entry.cr);
      continue;
    }
    // INHERITED. A row the carry-forward will hand its held release back to
    // is not release-less at all, and LANDED work is history whose provenance
    // lives on a release record's own `crs` set (§S3a) — neither belongs on a
    // migration list. Everything else does, INCLUDING a disposed row: a VOID
    // cr carries no release either, which is why this set is larger than
    // §S1's live census and must not be reconciled with it.
    if (snapshot.release !== undefined) continue;
    if (snapshot.status === "COMPLETED" || snapshot.status === "COMPLETED_UNTRACKED") continue;
    inheritedReleaseLess.push(entry.cr);
  }
  // CR-CRU-095 §S3/AC12c, AC12i — a post whose defaults would leave a wave's
  // block is refused in `wave-sequence`'s own envelope (message AND help[]);
  // the store wrote nothing.
  let report: QueueSeqReport;
  try {
    report = store.replaceQueue(key, entries);
  } catch (error) {
    if (error instanceof QueueWaveOverflowError) return deprecateRefusal(waveOverflow(error));
    throw error;
  }
  const known = new Set(entries.map((entry) => entry.cr));
  const unknownDependencies = [
    ...new Set(
      entries.flatMap((entry) => entry.dependsOn).filter((dep) => !known.has(dep)),
    ),
  ];
  return json({
    ok: true,
    entries: store.listQueue(key),
    unknownDependencies,
    // CR-CRU-091 §S2/AC23 — warn-and-write: the post landed, and the crs whose
    // position this write invented are named rather than left to read as
    // authored ones. CR-CRU-118 §S2 adds the membership half of the same rung,
    // ADDITIVELY: a post can invent a position and inherit a release-less row
    // in the same call, so both findings arrive.
    // CR-CRU-118 §S3 — the route-level notice leads, because it is a finding
    // about the DOOR rather than about any row this call carried, and the
    // per-row findings follow it unchanged.
    warnings: [
      ...DEPRECATED_ROUTE_NOTICE,
      ...seqScaleWarnings(report),
      ...inheritedReleaseLessWarnings(inheritedReleaseLess),
    ],
  });
}

// ── CR-CRU-091 §S3-§S8 — roadmap registration: the five verbs ──────────────

/**
 * §S5 — one non-fatal finding on a declaration. STRUCTURED rather than prose
 * because five clients RENDER these (§S9: the client holds no business rule),
 * and a client parsing an English sentence to find the crs would be deciding
 * something. `message` is the ready-to-print line; `crs` / `containers` carry
 * the same facts machine-readably.
 */
interface QueueWarning {
  code:
    | "out-of-order"
    | "cross-wave-backwards"
    | "defaulted-seq"
    | "unsequenced-members"
    | "inherited-release-less"
    | "deprecated-route";
  message: string;
  crs?: string[];
  containers?: string[];
  /** CR-CRU-118 §S3 — the machine half of the deprecation notice: the per-CR
   *  verbs that replace the door that raised it, beside `crs`/`containers` and
   *  for the same reason. A client that had to regex an English sentence for
   *  them would be deciding something (§S9). */
  verbs?: string[];
  /** CR-CRU-119 §S1 — the machine half of the seq finding's CAUSE, on
   *  `defaulted-seq` alone: `invented` is a position this write chose (a new
   *  entry, or one whose wave moved), `preserved` is one the entry already held
   *  whose scale collides with a sibling's. The two read identically on `crs`,
   *  so without this field a client would have to regex the prose to tell a
   *  defaulting from a collision — deciding something (§S9). */
  seqCause?: "invented" | "preserved";
}

/**
 * §S2/AC23 — the warn-and-write rung, shared by the queue post and cr-plan.
 *
 * CR-CRU-119 §S1 — ONE trigger, TWO causes, and the single sentence this used
 * to build was FALSE for one of them. A cr whose position the write INVENTED
 * (a new entry, or one whose wave moved) keeps that sentence to the byte,
 * because for that cause it was always correct. A cr that KEPT the position it
 * already held gets one that says what actually happened: nothing was
 * defaulted, and the held value's scale collides with a sibling's. `seqCause`
 * carries the same split machine-readably (§S9 — the fleet renders findings
 * and decides nothing, so telling the causes apart may not require parsing
 * prose), and the `code` stays ONE: the cause is a property OF this finding,
 * not a second finding, and the published vocabulary five clients render does
 * not grow a member for it.
 *
 * The trigger set is untouched (§S2): every cr the store names still earns a
 * finding, in the same call, naming the same crs.
 */
function seqScaleWarnings({ defaultedSeq, preservedSeq }: QueueSeqReport): QueueWarning[] {
  const held = new Set(preservedSeq);
  const invented = defaultedSeq.filter((cr) => !held.has(cr));
  const preserved = defaultedSeq.filter((cr) => held.has(cr));
  const warnings: QueueWarning[] = [];
  if (invented.length > 0) {
    warnings.push({
      code: "defaulted-seq",
      message:
        `seq was defaulted for ${invented.join(", ")} while a sibling in the same wave or release carries ` +
        `one on a DIFFERENT SCALE — the two interleave in an order nobody authored; run ` +
        `wave-sequence --release <v> --wave <n> --crs <the whole ordered list> to author it`,
      crs: invented,
      seqCause: "invented",
    });
  }
  if (preserved.length > 0) {
    warnings.push({
      code: "defaulted-seq",
      message:
        `${preserved.join(", ")} kept the seq it already holds, and that position sits on a ` +
        `DIFFERENT SCALE from a sibling in the same wave or release — this write chose nothing, ` +
        `and the two scales interleave in an order nobody authored; run ` +
        `wave-sequence --release <v> --wave <n> --crs <the whole ordered list> to author it`,
      crs: preserved,
      seqCause: "preserved",
    });
  }
  return warnings;
}

/**
 * CR-CRU-118 §S2 — the warn half of the bulk route's split: the crs the write
 * INHERITED release-less. Shaped like `defaultedSeq` because it is the same
 * rung — the post LANDED, and the rows it could not give a membership are
 * named rather than left to read as authored ones. `crs` is the migration
 * list, and it shrinks to zero as those crs are planned into a release; the
 * `message` is the ready-to-print line, so no client parses prose (§S9).
 */
function inheritedReleaseLessWarnings(crs: string[]): QueueWarning[] {
  if (crs.length === 0) return [];
  return [
    {
      code: "inherited-release-less",
      message:
        `${crs.join(", ")} were kept as they stand and still name no release — this post inherited ` +
        `them release-less and invented nothing, but every live CR names the release it targets; ` +
        `run cr-plan --cr <cr> --release <v> --wave <n> --title <brief> for each to empty this list`,
      crs,
    },
  ];
}

/**
 * CR-CRU-118 §S3 — the per-CR verbs that replace the bulk door, in the CR's
 * own order. `queue-file` is a TRANSITIONAL door being retired (DN D4's
 * fallout §1): it posts the whole README table, drops the release qualifier
 * that table prints, and is the route both measured membership incidents
 * arrived through. Rather than teach it to parse membership — which would make
 * a corpse comfortable instead of forcing its replacement to exist — the route
 * SAYS what it is.
 */
const QUEUE_ROUTE_REPLACEMENT_VERBS = ["cr-plan", "cr-depends", "wave-sequence"];

/**
 * §S3 — the notice itself, raised on EVERY answer the bulk door gives.
 *
 * CONSTANT, so it is built once and shared: it carries no per-call fact, and
 * a fresh object per request would allocate for nothing.
 *
 * ADDITIVE and never a replacement — it rides BESIDE `defaulted-seq` and
 * `inherited-release-less` on the same call, because a notice that displaced
 * another finding would HIDE it, which is strictly worse than no notice. On a
 * SUCCEEDING call as well as a refused one: a warning only the failure path
 * emits is invisible exactly when the route is being used as intended. And
 * DEPRECATED IS NOT REMOVED — the route still writes, and today's whole table
 * still bootstraps.
 *
 * `message` is the ready-to-print line the five clients render; `verbs` is the
 * same fact machine-readably, so no client parses prose to find it (§S9).
 */
const DEPRECATED_ROUTE_NOTICE: readonly QueueWarning[] = [
  {
    code: "deprecated-route",
    message:
      `the bulk queue post is DEPRECATED and will be removed: declare membership per CR with ` +
      `${QUEUE_ROUTE_REPLACEMENT_VERBS[0]}, dependencies with ${QUEUE_ROUTE_REPLACEMENT_VERBS[1]}, ` +
      `and order with ${QUEUE_ROUTE_REPLACEMENT_VERBS[2]}`,
    verbs: QUEUE_ROUTE_REPLACEMENT_VERBS,
  },
];

/**
 * §S3 — the notice riding a refusal a SHARED helper built: the membership
 * gate's 400/404, the wave-overflow envelope, the caller-auth seam's 409. By
 * the time this route sees those they are already Responses, and inventing a
 * second wording of each refusal here is exactly what CR-CRU-104 §S1 forbids —
 * so the finding is merged into the answer instead, ahead of whatever that
 * answer already raised. Refusals only: the success path builds its own
 * `warnings` array and pays no round trip.
 */
async function deprecateRefusal(res: Response): Promise<Response> {
  const body = (await res.json()) as Record<string, unknown>;
  const raised = Array.isArray(body.warnings) ? (body.warnings as QueueWarning[]) : [];
  return json({ ...body, warnings: [...DEPRECATED_ROUTE_NOTICE, ...raised] }, res.status);
}

/** §S5 — a cr's container, as the warnings name it: `release/wave`. */
function containerLabel(entry: Pick<QueueEntry, "release" | "wave">): string {
  return `${entry.release ?? "-"}/${entry.wave}`;
}

/**
 * CR-CRU-095 §S3/AC12f, AC12i — the ONE overflow envelope, as the bulk post
 * and `cr-plan` answer the store's refusal: `wave-sequence`'s message (already
 * on the error) and `wave-sequence`'s `help[]`, for the offending row's
 * container and the seq that would leave the block.
 */
function waveOverflow(error: QueueWaveOverflowError): Response {
  return fail(400, error.message, {
    help: roadmapHints.waveOverflow(containerLabel(error), error.seq),
  });
}

/**
 * §S5 — the ONE finding that refuses: a dependency cycle THROUGH `start`.
 * Returns the members in order, `start` closing the ring, or null. Scoped to
 * the crs the call names, so an unrelated cycle elsewhere in the backlog does
 * not block a declaration that has nothing to do with it.
 */
function findDependencyCycle(graph: Map<string, string[]>, start: string): string[] | null {
  const path: string[] = [];
  const explored = new Set<string>([start]);
  const walk = (node: string): boolean => {
    path.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (dep === start) {
        path.push(start);
        return true;
      }
      if (explored.has(dep)) continue;
      explored.add(dep);
      if (walk(dep)) return true;
    }
    path.pop();
    return false;
  };
  return walk(start) ? path : null;
}

/**
 * §S5 — the cycle check every write verb runs BEFORE writing: refusing here
 * means nothing was written, which is the whole point.
 *
 * `entries` is the graph the write would LEAVE BEHIND, and the CALLER owes
 * that. CR-CRU-106 §S2 — this used to read "neither verb edits `dependsOn`,
 * so the stored graph IS that graph", and that precondition is gone:
 * `cr-depends` edits exactly that column, so for it the stored rows are
 * precisely not the post-write graph and it hands the PROSPECTIVE ones — the
 * stored rows with the subject's set replaced by the declared one. Every ring
 * a declaration could close is invisible to a stored-graph read, because the
 * closing edge is still in the request body; a guard reading `listQueue` for
 * that verb would pass the cycle and then write it.
 */
function refuseDependencyCycle(entries: QueueEntry[], touched: string[]): Response | null {
  const known = new Set(entries.map((entry) => entry.cr));
  const graph = new Map(
    entries.map((entry) => [entry.cr, entry.dependsOn.filter((dep) => known.has(dep))]),
  );
  for (const cr of touched) {
    const cycle = findDependencyCycle(graph, cr);
    if (cycle !== null) {
      return fail(409, `dependency cycle refused: ${cycle.join(" → ")} — nothing was written`, {
        help: roadmapHints.dependencyCycle(cycle),
      });
    }
  }
  return null;
}

/**
 * §S5 — the two findings that WARN. The sequence stands exactly as authored;
 * Crucible never substitutes an order of its own. Scoped to the crs the call
 * touched, as dependant or as dependency, so a verb reports what it affected
 * rather than the whole backlog's history.
 */
function dependencyWarnings(entries: QueueEntry[], touched: Set<string>): QueueWarning[] {
  const byCr = new Map(entries.map((entry) => [entry.cr, entry]));
  const warnings: QueueWarning[] = [];
  for (const entry of entries) {
    for (const dep of entry.dependsOn) {
      const dependency = byCr.get(dep);
      if (dependency === undefined) continue;
      if (!touched.has(entry.cr) && !touched.has(dep)) continue;
      const order = compareContainers(entry, dependency);
      if (order === 0) {
        if (entry.seq < dependency.seq) {
          warnings.push({
            code: "out-of-order",
            message: `${entry.cr} precedes its own dependency ${dep} — stored as authored`,
            crs: [entry.cr, dep],
          });
        }
      } else if (order < 0) {
        const containers = [containerLabel(entry), containerLabel(dependency)];
        warnings.push({
          code: "cross-wave-backwards",
          message: `${containers[0]!} depends backwards on ${containers[1]!} — stored as authored`,
          containers,
        });
      }
    }
  }
  return warnings;
}

/** §S5 — deps naming no known cr: FLAGGED, never rejected (AC9). */
function unknownDependencies(entries: QueueEntry[], touched: Set<string>): string[] {
  const known = new Set(entries.map((entry) => entry.cr));
  return [
    ...new Set(
      entries
        .filter((entry) => touched.has(entry.cr))
        .flatMap((entry) => entry.dependsOn)
        .filter((dep) => !known.has(dep)),
    ),
  ];
}

/** CR-CRU-104 §S1 — what a caller DECLARES about a cr's release membership,
 *  AS RECEIVED. Each field is `unknown` because the SHAPE of a declaration is
 *  itself one of the rules the gate below owns: the migration door coerced a
 *  non-string with `String()` and stored the label the coercion produced —
 *  membership `cr-plan` type-refuses — so a parameter typed `string` would put
 *  the type check outside the one decision and let the two doors part again. A
 *  field is UNDECLARED when it is absent or null, which is a fact and never a
 *  default (CR-CRU-099 §S1). */
interface MembershipDeclaration {
  release?: unknown;
  track?: unknown;
  /** CR-CRU-118 §S3a — the cr whose SETTLED HISTORY may admit a label holding
   *  no live proposal. A declaration that names no cr (`wave-sequence` carries
   *  a whole ordered list, not one row) reaches only the live-proposal door,
   *  which is exactly today's rule. */
  cr?: string;
}

/**
 * CR-CRU-091 §S8's TYPE refusal of a declared release, as `cr-plan` has
 * answered it since that CR shipped, hoisted to ONE string in CR-CRU-104's
 * VERIFY round: the migration door now answers the same meaning for the same
 * input (a non-string or empty label) in its own field+index shape, and a
 * second wording of it is exactly what §S1 forbids. `handleCrPlan` states the
 * REQUIREDNESS — its whole declaration is a release — and the gate states the
 * SHAPE; both cite this sentence.
 */
const RELEASE_REQUIRED = "`release` is required — the release this cr targets";

/**
 * CR-CRU-104 §S1 — the LIVE proposals a declaration may target, resolved ONCE
 * per request. The bulk post asks per entry, so the labels are read here
 * rather than inside the gate: a 100-row migration must not re-scan the
 * project's milestones 100 times.
 */
function liveProposalLabels(store: Store, key: string): ReadonlySet<string> {
  return new Set(
    store
      .listReleaseProposals(key)
      .flatMap((proposal) => (proposal.label !== undefined ? [proposal.label] : [])),
  );
}

/**
 * CR-CRU-118 §S2 — THE derivation, and the ONE place it is written: does
 * settled history already claim this cr? It answers with the RECORDED release
 * whose own `crs` set names it, or `undefined` when none does.
 *
 * A derivation from settled fact, and self-checking: it cannot admit a
 * genuinely new CR, because a shipped release cannot claim one, and it cannot
 * add scope to a closed release, because the release must already name the cr
 * itself. It is emphatically NOT a test of whether the board is empty — that
 * would be a licence ("clear the board, then post anything"); what makes a row
 * admissible is a property of the ROW.
 *
 * Two doors read it. The bulk post's insert rung (§S2) asks it for the 62
 * landed 0.1.x rows a wiped-board restore carries, which name no release
 * because none was tracked when they shipped; `cr-plan --release 0.1.0` (§S3a)
 * asks it for the same rows when their history is given back to them. Two
 * independent copies of this rule would drift, and the drift would be silent.
 *
 * Resolved ONCE per request and returned as a lookup, the `liveProposalLabels`
 * precedent: `listReleases` re-queries and re-JSON-parses the whole milestone
 * table, and the bulk route asks per entry — a 115-row restore must not scan
 * settled history 115 times. A release recorded without a label still CLAIMS,
 * so it answers in the wording `handleCrLifecycle` already uses for one.
 */
function recordedReleaseClaiming(store: Store, key: string): (cr: string) => string | undefined {
  const claiming = new Map<string, string>();
  for (const release of store.listReleases(key)) {
    const label = release.label ?? "an unlabelled release";
    for (const cr of release.crs ?? []) {
      if (!claiming.has(cr)) claiming.set(cr, label);
    }
  }
  return (cr) => claiming.get(cr);
}

/**
 * CR-CRU-104 §S1 — the ONE membership-declaration decision, and the only
 * place the rules of declaring release membership are written: the
 * live-proposal requirement (CR-CRU-091 §S1/§S3 — the super container exists
 * before a CR can target it, and a label whose proposal a real release has
 * CONSUMED is settled history) and track normalisation with its refusal
 * (CR-CRU-091 §S2/AC17, CR-CRU-099 §S1/AC4a). The slot/scale rules that
 * decide `seq` and whether a `defaulted-seq` warning is earned are the other
 * half, and are already one rule reached from both writers — `nextFreeSlot` /
 * `inWaveBlock` in the store, rendered by `seqScaleWarnings` here.
 *
 * Reached from EVERY route that declares membership: the bulk `POST …/queue`
 * (the MIGRATION door, per entry), `cr-plan` and `wave-sequence`. Until this
 * CR the live-proposal requirement lived on the per-CR verbs alone, so a
 * migration could store membership in a release nobody proposed — the write
 * `cr-plan` answers 404 for. A migration that stores membership the per-CR
 * verb would have refused is a migration that corrupts the board.
 *
 * `at` is the offending `entries[]` INDEX, and is the one thing that differs
 * between the two shapes: the bulk post refuses by field name AND index, the
 * per-CR verbs by field. The ANSWER — status, meaning, `help[]` — is the same
 * either way. Returns the values that may be STORED: the validated release and
 * the NORMALISED track.
 */
function declareMembership(
  proposed: ReadonlySet<string>,
  declared: MembershipDeclaration,
  at?: number,
  claimingRelease?: (cr: string) => string | undefined,
): { release: string | undefined; track: string | undefined } | { fail: Response } {
  // CR-CRU-104 §S1 — the SHAPE of a declaration, refused before its meaning
  // is judged: you cannot ask whether a label holds a live proposal, or which
  // lane a value names, until it is a label at all. The migration door used
  // to coerce here (`String(fields.release)`), which stored `2` as `"2"` and
  // `cr-plan` type-refuses the same input — the divergence this CR is about,
  // one field lower down. `cr-plan`'s own sentence is answered rather than a
  // second wording of it; on the bulk door it answers a value that WAS
  // declared and carries no label, in that route's field+index shape.
  if (
    declared.release !== undefined &&
    declared.release !== null &&
    (typeof declared.release !== "string" || declared.release.length === 0)
  ) {
    return {
      fail: fail(
        400,
        at === undefined ? RELEASE_REQUIRED : `entry at index ${at}: ${RELEASE_REQUIRED}`,
      ),
    };
  }
  if (
    declared.track !== undefined &&
    declared.track !== null &&
    typeof declared.track !== "string"
  ) {
    const sentence = `\`track\` must be declared as a string — ${TRACK_LANE_RULE}`;
    return {
      fail: fail(400, at === undefined ? sentence : `entry at index ${at}: ${sentence}`),
    };
  }
  const release = typeof declared.release === "string" ? declared.release : undefined;
  let track: string | undefined;
  if (typeof declared.track === "string") {
    const normalized = normalizeTrack(declared.track);
    if (normalized === null) {
      // The two SHIPPED wordings, verbatim — one names the field and the
      // index, the other the field. The lane rule they cite is one string.
      return {
        fail: fail(
          400,
          at === undefined
            ? `\`track\` "${declared.track}" carries no lane number — ${TRACK_LANE_RULE}`
            : `entry at index ${at} has a \`track\` carrying no lane number: ` +
              `"${declared.track}" — ${TRACK_LANE_RULE}`,
        ),
      };
    }
    track = normalized;
  }
  if (release !== undefined && !proposed.has(release)) {
    // CR-CRU-118 §S3a — the SECOND door, and the only one this CR opens: a
    // label naming a RECORDED release is accepted where that release's own
    // `crs` set already names the cr. A derivation from settled fact, so it
    // cannot add scope to a closed release (the release must already claim the
    // cr) and cannot admit a genuinely new one (a shipped release claims none).
    //
    // ORDER IS THE RULE. A LIVE proposal wins above and asks for no `crs`
    // membership at all — an in-flight release has shipped nothing yet — and a
    // recorded release admits only what IT claims, so being historical buys a
    // cr no label but its own. Anything else keeps CR-CRU-091 §S8's refusal
    // VERBATIM, message and help alike: this CR adds a door and widens none.
    //
    // ONE derivation, read through `recordedReleaseClaiming` — the same lookup
    // §S2's bulk-insert rung asks. A second copy of this rule would drift, and
    // the drift would be silent: a restore admitting a row the backfill
    // refused, or the reverse.
    const claimedBy =
      declared.cr === undefined ? undefined : claimingRelease?.(declared.cr);
    if (claimedBy !== release) {
      const sentence = `release ${release} has no live proposal — it is not a plannable target`;
      return {
        fail: fail(404, at === undefined ? sentence : `entry at index ${at}: ${sentence}`, {
          help: roadmapHints.unproposedRelease(release),
        }),
      };
    }
  }
  return { release, track };
}

/** §S8 — the wire shape of one proposal: the candidate list §S6 asks from. */
function proposalBrief(event: RunEvent, queue: QueueEntry[]) {
  const label = event.label ?? "";
  return {
    label,
    ...(event.targetAt !== undefined ? { targetAt: event.targetAt } : {}),
    timestamp: event.timestamp,
    // §S6 P7 — the waves already planned against this release. Joined HERE so
    // five clients cannot each join it differently; the ASKING stays theirs.
    waves: [
      ...new Set(queue.filter((entry) => entry.release === label).map((entry) => entry.wave)),
    ].sort((a, b) => waveNumber(a) - waveNumber(b)),
  };
}

/**
 * CR-CRU-091 §S8 — GET …/projects/<key>/release-proposals: the LIVE proposals,
 * ascending by version. `listReleases` is NOT repurposed (§S1): settled
 * history and a plan are different kinds, and one query returning both would
 * render the pair §S1 forbids. Existence is validated the handleQueueGet way
 * (UUID shape, then the row) — an archived project answers 200 with an empty
 * list through the store's NOT_ARCHIVED exclusion.
 */
function handleReleaseProposalsGet(
  store: Store,
  key: string,
  req: Request,
  url: URL,
): Response {
  if (!UUID_RE.test(key)) {
    return fail(400, "projectKey must be a UUID", { help: hints.unknownProject });
  }
  if (store.getProject(key) === null) {
    return fail(404, `unknown project: ${key}`, { help: hints.unknownProject });
  }
  const queue = store.listQueue(key);
  const proposals = store.listReleaseProposals(key).map((event) => proposalBrief(event, queue));
  return reply(req, url, { ok: true, proposals, totalCount: proposals.length });
}

/**
 * CR-CRU-091 §S8 — POST …/projects/<key>/release-proposals: `release-propose`.
 * Records or REVISES the live proposal for one label (§S1/AC21 — a revision
 * retires its predecessor in one transaction, never an in-place edit).
 */
async function handleReleasePropose(store: Store, key: string, req: Request): Promise<Response> {
  const pk = requireProject(store, key);
  if ("fail" in pk) return pk.fail;
  const body = (await readBody(req)) ?? {};
  const caller = requireOrchestrator(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  if (typeof body.label !== "string" || body.label.length === 0) {
    return fail(400, "`label` is required — the version this release proposes to ship");
  }
  // §S1 — `targetAt` is epoch SECONDS, the unit `releasedAt` uses. Refused
  // rather than dropped when malformed: a declared target that silently
  // vanished would read back as "no target was ever declared".
  //
  // CR-CRU-118 §S4 — and ABSENCE is refused too, HERE, at the door: the rule
  // lives server-side rather than only in the five clients' argparse, because
  // a rule that lives only in a flag is one any other caller walks past.
  //
  // THE ORDER MATTERS, AND THIS IS THE ORDER. Absence is decided before
  // `recordReleaseProposal` is reached — therefore before its convergence
  // check `live.targetAt === meta.targetAt` is ever consulted. A re-proposal
  // that DROPS the target would otherwise compare a held number against
  // `undefined`, MISS convergence, fall through to the revision branch, and
  // retire the live row in favour of one carrying no target at all: a
  // declared date destroyed by a call that mentioned no date. Refused at the
  // door, the held target survives untouched, and downstream the comparison
  // only ever weighs two numbers.
  //
  // The two findings keep SEPARATE sentences: a caller who typed nothing and
  // a caller who typed "yesterday" need different next moves, so absence is
  // not collapsed into the shape complaint below.
  if (body.targetAt === undefined || body.targetAt === null) {
    return fail(
      400,
      "`targetAt` is required — the date this release is aiming at, in epoch SECONDS",
      { help: roadmapHints.missingTarget },
    );
  }
  if (typeof body.targetAt !== "number" || !Number.isFinite(body.targetAt) || body.targetAt <= 0) {
    return fail(400, "`targetAt` must be a positive number of epoch SECONDS");
  }
  const targetAt: number = body.targetAt;
  const { event, changed } = store.recordReleaseProposal(pk.key, caller.agentId, {
    label: body.label,
    targetAt,
    ...eventContext(body),
  });
  return json({
    ok: true,
    converged: !changed,
    proposal: {
      label: event.label ?? body.label,
      ...(event.targetAt !== undefined ? { targetAt: event.targetAt } : {}),
    },
  });
}

/**
 * CR-CRU-091 §S8 — POST …/projects/<key>/queue/plan: `cr-plan`. The per-CR
 * upsert of one declaration; re-running with different values is a legitimate
 * re-plan (§S3), and re-running with the SAME values writes nothing (§S7).
 */
async function handleCrPlan(store: Store, key: string, req: Request): Promise<Response> {
  const pk = requireProject(store, key);
  if ("fail" in pk) return pk.fail;
  const body = (await readBody(req)) ?? {};
  const caller = requireOrchestrator(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  if (typeof body.cr !== "string" || body.cr.length === 0) {
    return fail(400, "`cr` is required — the CR this plan declares");
  }
  // The REQUIREDNESS is this verb's own — its whole declaration is a release
  // — and the sentence is the one the gate answers for a declared value that
  // carries no label, so the two doors cannot fork it.
  //
  // CR-CRU-118 §S1/§S5 — ABSENCE carries the move that fixes it. The two
  // branches answer ONE sentence and differ only in `help[]`, deliberately: a
  // field that was never sent is answered with the route that lists the live
  // proposals (the sibling refusal one field lower names the same route), while
  // a value that WAS declared and carries no label is a SHAPE complaint whose
  // remedy is the caller's own input — and whose help-less envelope is pinned
  // as parity with the bulk door's identical refusal
  // (tests/queue-membership-one-rule.test.ts, CR-CRU-104 §S2/AC3).
  if (body.release === undefined || body.release === null) {
    return fail(400, RELEASE_REQUIRED, { help: roadmapHints.missingRelease });
  }
  if (typeof body.release !== "string" || body.release.length === 0) {
    return fail(400, RELEASE_REQUIRED);
  }
  if (body.wave === undefined || body.wave === null || String(body.wave).length === 0) {
    return fail(400, "`wave` is required — the wave within the release");
  }
  if (typeof body.title !== "string" || body.title.length === 0) {
    return fail(400, "`title` is required — the CR's brief");
  }
  // CR-CRU-104 §S1 — the ONE membership rule, the same decision the migration
  // door passes through. `cr-plan` declares no track, so `release` is its
  // whole declaration.
  //
  // CR-CRU-118 §S3a — and the cr it declares for, because a label holding no
  // live proposal is still admissible where the RECORDED release that shipped
  // that cr already names it. The derivation is handed in rather than re-asked
  // inside the gate, the `liveProposalLabels` precedent: one scan of settled
  // history per request, and the same one §S2's insert rung reads.
  const membership = declareMembership(
    liveProposalLabels(store, pk.key),
    { release: body.release, cr: body.cr },
    undefined,
    recordedReleaseClaiming(store, pk.key),
  );
  if ("fail" in membership) return membership.fail;
  // §S5 — the cycle refusal runs BEFORE the write. THIS verb edits no
  // `dependsOn`, so the stored graph already is the graph the write leaves
  // (CR-CRU-106 §S2 — a verb that does edit it owes the prospective graph
  // instead, and `handleCrDepends` builds one).
  const cycle = refuseDependencyCycle(store.listQueue(pk.key), [body.cr]);
  if (cycle !== null) return cycle;

  // CR-CRU-095 §S3/AC12f — a full block refuses the plan, in `wave-sequence`'s
  // envelope, and nothing is written.
  let report: QueueSeqReport & { changed: boolean };
  try {
    report = store.upsertQueueEntry(pk.key, {
      cr: body.cr,
      release: body.release,
      wave: String(body.wave),
      title: body.title,
    });
  } catch (error) {
    if (error instanceof QueueWaveOverflowError) return waveOverflow(error);
    throw error;
  }
  const { changed } = report;
  const entries = store.listQueue(pk.key);
  const touched = new Set([body.cr]);
  return json({
    ok: true,
    converged: !changed,
    entry: entries.find((entry) => entry.cr === body.cr),
    // §S7 — a converged call emits no warning it did not earn.
    warnings: changed
      ? [...dependencyWarnings(entries, touched), ...seqScaleWarnings(report)]
      : [],
    unknownDependencies: unknownDependencies(entries, touched),
  });
}

/**
 * CR-CRU-091 §S8 — POST …/projects/<key>/queue/sequence: `wave-sequence`. ONE
 * call carrying the WHOLE ordered list, because the order IS the payload
 * (§S4) — sending crs one at a time would make their sequence an accident of
 * arrival. Insert and reorder are the same call: re-send the list.
 */
async function handleWaveSequence(store: Store, key: string, req: Request): Promise<Response> {
  const pk = requireProject(store, key);
  if ("fail" in pk) return pk.fail;
  const body = (await readBody(req)) ?? {};
  const caller = requireOrchestrator(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  if (typeof body.release !== "string" || body.release.length === 0) {
    return fail(400, "`release` is required — the release whose wave is being sequenced");
  }
  if (body.wave === undefined || body.wave === null || String(body.wave).length === 0) {
    return fail(400, "`wave` is required — the wave whose order this call authors");
  }
  if (!Array.isArray(body.crs) || body.crs.length === 0) {
    return fail(400, "`crs` is required — the whole ordered list of the wave's crs");
  }
  // handleQueuePost's precedent: the offending field AND its index.
  const crs: string[] = [];
  for (let index = 0; index < body.crs.length; index++) {
    const cr: unknown = body.crs[index];
    if (typeof cr !== "string" || cr.length === 0) {
      return fail(400, `\`crs\` entry at index ${index} is not a non-empty cr id`);
    }
    if (crs.includes(cr)) {
      return fail(400, `\`crs\` names ${cr} twice — at index ${index}; one cr, one position`);
    }
    crs.push(cr);
  }
  // CR-CRU-104 §S1 — the ONE membership rule: a declared lane is a string
  // (nothing is coerced here either) and is normalised — a value carrying no
  // lane number refused BY NAME, §S2/AC17 — before anything is stored, and
  // the release must hold a live proposal: the same decision, in the same
  // order, the migration door passes through.
  const membership = declareMembership(liveProposalLabels(store, pk.key), {
    release: body.release,
    track: body.track,
  });
  if ("fail" in membership) return membership.fail;
  const { track } = membership;

  // §S4 — sequencing never PLANS: every named cr must already hold a row in
  // exactly this container, and one that does not refuses the whole call.
  const wave = String(body.wave);
  const container = `${body.release}/${wave}`;
  const entries = store.listQueue(pk.key);
  const byCr = new Map(entries.map((entry) => [entry.cr, entry]));
  // §S4 — the wave's seq block is `WAVE_SEQ_STRIDE` positions wide, so the
  // thousandth member would take the NEXT wave's base. Refused BY NAME rather
  // than written as a silent collision, and refused before the per-cr lookups
  // because it is a property of the call, not of any one cr.
  const members = new Set([
    ...crs,
    ...entries
      .filter((entry) => entry.release === body.release && entry.wave === wave)
      .map((entry) => entry.cr),
  ]);
  if (members.size >= WAVE_SEQ_STRIDE) {
    // The seq the thousandth member would take: the next wave's base.
    const overflowing = waveSeqBase(wave) + members.size;
    return fail(400, waveOverflowMessage(wave, overflowing), {
      help: roadmapHints.waveOverflow(container, overflowing),
    });
  }
  for (const cr of crs) {
    const held = byCr.get(cr);
    if (held === undefined) {
      return fail(404, `cr ${cr} has no queue row — ${container} does not hold it`, {
        help: roadmapHints.unsequenceableCr(cr, undefined, container),
      });
    }
    if (held.release !== body.release || held.wave !== wave) {
      const planned = containerLabel(held);
      return fail(404, `cr ${cr} is planned into ${planned}, not ${container}`, {
        help: roadmapHints.unsequenceableCr(cr, planned, container),
      });
    }
  }
  // §S5 — the same rule, same reason: THIS verb writes `seq` and `track`, not
  // `dependsOn`, so the rows it already read ARE the post-write graph
  // (CR-CRU-106 §S2 corrected the guard's own precondition; this call is
  // unaffected because the premise still holds here).
  const cycle = refuseDependencyCycle(entries, crs);
  if (cycle !== null) return cycle;

  const { changed, omitted } = store.sequenceQueueWave(pk.key, {
    release: body.release,
    wave,
    crs,
    ...(track !== undefined ? { track } : {}),
  });
  const sequenced = store.listQueue(pk.key);
  const touched = new Set([...crs, ...omitted]);
  const warnings = changed ? dependencyWarnings(sequenced, touched) : [];
  if (changed && omitted.length > 0) {
    // The list is the wave's WHOLE order; a member it left out keeps its
    // relative position after the authored block, and says so.
    warnings.push({
      code: "unsequenced-members",
      message:
        `${omitted.join(", ")} sits in wave ${wave} but the posted list did not carry it — ` +
        `appended after the authored block; re-send --crs with the whole order`,
      crs: omitted,
    });
  }
  return json({
    ok: true,
    converged: !changed,
    entries: sequenced.filter((entry) => touched.has(entry.cr)),
    warnings,
    unknownDependencies: unknownDependencies(sequenced, touched),
  });
}

/**
 * CR-CRU-106 §S1/§S2/§S2a — POST …/projects/<key>/queue/depends:
 * `cr-depends`. The DEPENDENCY axis, declared by its own verb.
 *
 * The WHOLE set is the payload and re-sending REPLACES it — the design's own
 * step-3 argument ("the order is the payload") applied to a second axis: a
 * dependency dropped from a re-sent set is a declaration, not an accident of
 * arrival. An EMPTY array is therefore a legitimate declaration that a cr
 * depends on nothing, never a missing field.
 *
 * §S3's asymmetry, stated rather than inherited: an unknown TARGET is
 * ACCEPTED and flagged in `unknownDependencies`, matching the migration
 * door's CR-CRU-014 §S1 behaviour, while `cr-plan` REFUSES an unproposed
 * release. The two precedents disagree on purpose, and AC5 rules this one —
 * the cycle check already filters to known crs so an unknown target cannot
 * hide a ring, and refusing would make declaration ORDER-DEPENDENT.
 */
async function handleCrDepends(store: Store, key: string, req: Request): Promise<Response> {
  const pk = requireProject(store, key);
  if ("fail" in pk) return pk.fail;
  const body = (await readBody(req)) ?? {};
  const caller = requireOrchestrator(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  if (typeof body.cr !== "string" || body.cr.length === 0) {
    return fail(400, "`cr` is required — the cr whose dependency set this declares");
  }
  // An ABSENT `dependsOn` is a malformed call and an EMPTY one is a
  // declaration, so the two cannot collapse into a falsiness test.
  if (!Array.isArray(body.dependsOn)) {
    return fail(400, "`dependsOn` is required — the WHOLE set; `[]` declares that this cr depends on nothing");
  }
  // handleQueuePost's precedent: the offending field AND its index.
  const dependsOn: string[] = [];
  for (let index = 0; index < body.dependsOn.length; index++) {
    const dep: unknown = body.dependsOn[index];
    if (typeof dep !== "string" || dep.length === 0) {
      return fail(400, `\`dependsOn\` entry at index ${index} is not a non-empty cr id`);
    }
    if (dependsOn.includes(dep)) {
      return fail(400, `\`dependsOn\` names ${dep} twice — at index ${index}; one dependency, one declaration`);
    }
    dependsOn.push(dep);
  }
  // §S2 — the cycle refusal runs over the PROSPECTIVE graph: the stored rows
  // with the SUBJECT's set replaced by the declared one. Handing the stored
  // rows here would refuse only a ring the board already holds, and accept —
  // then write — every ring a declaration closes, because the closing edge is
  // the one still in this body. Measured: with `store.listQueue(pk.key)` in
  // this call, `1 → 2 → 3` plus a declaration of `3 → 1` answers
  // `ok:true` and the store comes back holding the ring.
  //
  // A subject holding NO row contributes no node, so this can never fire
  // ahead of the §S2a refusal below; the order of the two is a matter of
  // which fact is worth reading first, not of reachability.
  const cycle = refuseDependencyCycle(
    store
      .listQueue(pk.key)
      .map((entry) => (entry.cr === body.cr ? { ...entry, dependsOn } : entry)),
    [body.cr],
  );
  if (cycle !== null) return cycle;

  // §S2a — the writer's own read of the row is the registration fact, so the
  // route asks the question once: `null` is "this cr holds no queue row", and
  // nothing was written on the way to the refusal.
  const written = store.declareQueueDependencies(pk.key, body.cr, dependsOn);
  if (written === null) {
    return fail(404, `cr ${body.cr} is not registered in this project's queue`, {
      help: roadmapHints.unregisteredCr(body.cr),
    });
  }
  const declared = store.listQueue(pk.key);
  // AC9 — the same reporting envelope `cr-plan` answers with, scoped to the
  // ONE cr this call touched: `dependencyWarnings` names a pair only when it
  // involves a touched cr, so a verb that forgot to name its subject here
  // would go silent on the very finding it just created. §S7 — a converged
  // call wrote nothing and earns no warning, even while the finding stands.
  const touched = new Set([body.cr]);
  return json({
    ok: true,
    converged: !written.changed,
    entry: declared.find((entry) => entry.cr === body.cr),
    warnings: written.changed ? dependencyWarnings(declared, touched) : [],
    unknownDependencies: unknownDependencies(declared, touched),
  });
}

/**
 * CR-CRU-091 §S8 — POST …/projects/<key>/queue/<cr>/supersede and /void: the
 * SECOND AXIS write. Neither deletes a row — the cr stays visible carrying its
 * declaration — and both are refused, naming the release, when a cut release
 * already shipped the cr (AC14: settled fact is immutable).
 *
 * AC15 — the two answers are deliberately different, never one "removed"
 * response: supersede reports the dependants RESOLVING through the successor
 * (the work still happens, elsewhere), void reports them BROKEN (it does not).
 */
async function handleCrLifecycle(
  store: Store,
  key: string,
  cr: string,
  verb: "supersede" | "void",
  req: Request,
): Promise<Response> {
  const pk = requireProject(store, key);
  if ("fail" in pk) return pk.fail;
  const body = (await readBody(req)) ?? {};
  const caller = requireOrchestrator(store, pk.key, body);
  if ("fail" in caller) return caller.fail;
  const by = verb === "supersede" && typeof body.by === "string" ? body.by : undefined;
  const reason = verb === "void" && typeof body.reason === "string" ? body.reason : undefined;
  if (verb === "supersede" && (by === undefined || by.length === 0)) {
    return fail(400, "`by` is required — the successor cr the work moves to");
  }
  if (verb === "void" && (reason === undefined || reason.length === 0)) {
    return fail(400, "`reason` is required — why the work is not happening");
  }
  const entries = store.listQueue(pk.key);
  if (!entries.some((entry) => entry.cr === cr)) {
    return fail(404, `cr ${cr} is not registered in this project's queue`, {
      help: roadmapHints.unregisteredCr(cr),
    });
  }
  const shipped = store.listReleases(pk.key).find((release) => (release.crs ?? []).includes(cr));
  if (shipped !== undefined) {
    const label = shipped.label ?? "an unlabelled release";
    return fail(409, `cr ${cr} was shipped by release ${label} — settled fact is immutable`, {
      help: roadmapHints.shippedCr(cr, label),
    });
  }
  const result = store.setQueueLifecycle(pk.key, cr, {
    state: verb === "supersede" ? "SUPERSEDED" : "VOID",
    ...(by !== undefined ? { by } : {}),
    ...(reason !== undefined ? { reason } : {}),
  });
  if (result === null) {
    return fail(404, `cr ${cr} is not registered in this project's queue`, {
      help: roadmapHints.unregisteredCr(cr),
    });
  }
  const dependants = entries
    .filter((entry) => entry.dependsOn.includes(cr))
    .map((entry) => entry.cr);
  return json({
    ok: true,
    converged: !result.changed,
    entry: store.listQueue(pk.key).find((entry) => entry.cr === cr),
    ...(verb === "supersede"
      ? { resolvedDependants: dependants }
      : { brokenDependants: dependants }),
  });
}

/**
 * CR-CRU-052 §S1 — DELETE …/projects/<key>: the project row plus every row
 * keyed to it, in one transaction. The most destructive route in the system,
 * so it carries the SAME double gate as CR-CRU-032's lesser single-event
 * delete (handleEventDelete), in this order:
 * 1. existence — an unknown key is a definitive 404 (`unknown project: …`,
 *    handleProjectArchive's wording), checked FIRST so a missing key can
 *    never be reported as a gate refusal. It cannot route through
 *    requireProject, which 404s ARCHIVED projects — and archived is exactly
 *    the state this route requires;
 * 2. state gate — the project must be ARCHIVED (CR-CRU-012 §S1b's existing
 *    state, no new flag) → else 403;
 * 3. approval gate — `userApproved: true` on the body → else 409, mirroring
 *    CR-032's field name so the fleet learns ONE confirmation idiom.
 * Both refusals leave the project and every cascaded row untouched. A throw
 * from the cascade is rolled back whole by the store's transaction; it is
 * reported as a 500 naming the failure rather than a partial success.
 */
async function handleProjectDelete(store: Store, key: string, req: Request): Promise<Response> {
  const project = store.getProject(key);
  if (project === null) {
    return fail(404, `unknown project: ${key}`, { help: hints.unknownProject });
  }
  if (!store.isArchived(key)) {
    return fail(403, `project is not archived — deletion refused: ${key}`, {
      help: projectDeleteHints.notArchived(key, project.name),
    });
  }
  const body = (await readBody(req)) ?? {};
  if (body.userApproved !== true) {
    return fail(409, `explicit user approval is required to delete a project — refused: ${key}`, {
      help: projectDeleteHints.needsApproval(key, project.name),
    });
  }
  let deleted;
  try {
    deleted = store.deleteProjectCascade(key);
  } catch (error) {
    return fail(500, `project deletion failed and was rolled back whole: ${String(error)}`);
  }
  return json({ ok: true, changed: true, deleted });
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
    // CR-CRU-094 §S1 (additive) — the run's cycle binding, top-level, so a
    // reader tells a bound run from an unbound one without unpacking the
    // blob. Key ABSENT (never null, never 0) when the run carries no cycle;
    // `context` is untouched beside it — §S1 keeps it authoritative for the
    // frontend consumers that already read `context.cycleId`.
    ...(event.cycleId !== undefined ? { cycleId: event.cycleId } : {}),
    // CR-CRU-057 §S1 (additive) — the stamped declared role and its
    // provenance; both keys ABSENT on events that carry no stored role, so
    // history renders unclassified rather than guessed.
    ...(event.role !== undefined
      ? { role: event.role, roleInferred: event.roleInferred === true }
      : {}),
    // CR-CRU-013 §S1+§S4b (additive) — gate/milestone carrying fields, keys
    // ABSENT on every other kind.
    ...(event.gate !== undefined ? { gate: event.gate } : {}),
    // CR-CRU-073 §S1 (additive) — the gated release version (first-class on
    // the event, never inside the gate object) and the retirement marker;
    // both keys ABSENT when unset.
    ...(event.version !== undefined ? { version: event.version } : {}),
    ...(event.retiredAt !== undefined ? { retiredAt: event.retiredAt } : {}),
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
    // CR-CRU-017 §S1/§S3 (additive) — the RUN lifecycle, FORWARDED from the
    // stored row exactly as `toEvent` served it, never recomputed here (one
    // source of truth for runtime_ms). Each key is ABSENT — not null — on an
    // event ingested without a runId, which is the §S1 graceful-degradation
    // guard the brief must not weaken. `status` is the RUN's terminal state
    // (`"aborted"` = ended for non-test reasons), unrelated to `Plan.status`.
    ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
    ...(event.runtimeMs !== undefined ? { runtime_ms: event.runtimeMs } : {}),
    ...(event.status !== undefined ? { status: event.status } : {}),
    ...(event.abortReason !== undefined ? { abortReason: event.abortReason } : {}),
  };
}

/**
 * CR-CRU-017 §S3 — the wire shape of an OPEN run: identity, who is running it,
 * and the `startedAt` the dashboard's elapsed timer counts from. Deliberately
 * NOT an event brief — an open run has no counts, no duration and no id in the
 * events table, and fabricating those keys is exactly what would let a running
 * card be mistaken for a finished one. `state` is omitted for the same reason
 * it cannot vary: everything here is open by construction.
 */
function openRunBrief(run: RunRecord) {
  return {
    runId: run.runId,
    projectKey: run.projectKey,
    agentId: run.agentId,
    startedAt: run.startedAt,
    ...(run.tier !== undefined ? { tier: run.tier } : {}),
    ...(run.stack !== undefined ? { stack: run.stack } : {}),
    ...(run.context !== undefined ? { context: run.context } : {}),
  };
}

function handleEventsList(store: Store, req: Request, url: URL): Response {
  const project = url.searchParams.get("project") ?? undefined;
  // CR-CRU-017 §S1 — settle dead open runs before the timeline is served, so a
  // hung run resolves into its aborted card instead of pulsing forever.
  store.sweepOpenRuns();
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
  //
  // CR-CRU-017 §S3 (additive) — `openRuns`: the runs opened through
  // /runs/start that have not yet settled, so the timeline can paint each as a
  // live "running…" card. Additive and never a replacement: `events` is
  // untouched (an open run has NO event yet — a start is not an end), so every
  // existing consumer reads the same feed it always did, and a caller that
  // ignores `openRuns` simply sees the pre-017 timeline. Served AFTER the
  // sweep above, so a dead run is already aborted and appears as its aborted
  // EVENT rather than as a run still pulsing here. The anchored `cycleId`
  // branch above stays byte-unchanged: it answers "which runs does this cycle
  // own", a settled-history question.
  return reply(req, url, {
    ok: true,
    events: store.listEvents(project, limit).map(eventBrief),
    openRuns: store.listOpenRuns(project).map(openRunBrief),
  });
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
    // CR-CRU-074 §S3 — the project's recorded releases, newest-first.
    if (req.method === "GET" && segments.length === 2 && segments[1] === "releases") {
      return handleProjectReleases(store, segments[0]!, req, url);
    }
    // CR-CRU-129 §S3 — the project's milestone RECORDS of one type. Beside
    // `releases` because it is the same read generalised: `releases` answers
    // the `release` type, this one answers whichever type the caller names.
    if (req.method === "GET" && segments.length === 2 && segments[1] === "milestones") {
      return handleProjectMilestones(store, segments[0]!, req, url);
    }
    // CR-CRU-014 §S1 — the project's CR execution queue (roadmap).
    if (segments.length === 2 && segments[1] === "queue") {
      if (req.method === "GET") {
        return handleQueueGet(store, segments[0]!, req, url);
      }
      if (req.method === "POST") {
        return handleQueuePost(store, segments[0]!, req);
      }
    }
    // CR-CRU-091 §S8 — roadmap registration, matched on segments.length +
    // segments[1] + method exactly as the four blocks above are. The verb
    // NAME is never a path segment: `queue/plan`, not `queue/cr-plan`, so a
    // guessed shape 404s through the catch-all instead of half-working.
    if (segments.length === 2 && segments[1] === "release-proposals") {
      if (req.method === "GET") {
        return handleReleaseProposalsGet(store, segments[0]!, req, url);
      }
      if (req.method === "POST") {
        return handleReleasePropose(store, segments[0]!, req);
      }
    }
    if (req.method === "POST" && segments.length === 3 && segments[1] === "queue") {
      if (segments[2] === "plan") {
        return handleCrPlan(store, segments[0]!, req);
      }
      if (segments[2] === "sequence") {
        return handleWaveSequence(store, segments[0]!, req);
      }
      // CR-CRU-106 §S1 — the dependency axis joins the same block, under the
      // same rule: `queue/depends`, never `queue/cr-depends`.
      if (segments[2] === "depends") {
        return handleCrDepends(store, segments[0]!, req);
      }
    }
    if (
      req.method === "POST" &&
      segments.length === 4 &&
      segments[1] === "queue" &&
      (segments[3] === "supersede" || segments[3] === "void")
    ) {
      return handleCrLifecycle(store, segments[0]!, segments[2]!, segments[3], req);
    }
    // CR-CRU-012 §S1 — PATCH project parameters (v2-only; the v1 shim has
    // no equivalent route).
    if (req.method === "PATCH" && segments.length === 1) {
      return handleProjectPatch(store, segments[0]!, req);
    }
    // CR-CRU-052 §S1 — double-gated cascading project teardown.
    if (req.method === "DELETE" && segments.length === 1) {
      return handleProjectDelete(store, segments[0]!, req);
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
  // CR-CRU-017 §S1 — the run LIFECYCLE's opening verb, next to the ingests it
  // wraps (the three routes below all take its runId, optionally).
  if (req.method === "POST" && pathname === "/api/v2/runs/start") {
    return handleRunStart(store, req);
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
