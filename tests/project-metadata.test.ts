// §S1–§S3 (AC1–AC4) — server-side project metadata: store, write route,
// read routes. RED phase: none of `PATCH …/metadata`, `GET …/metadata`
// exists yet in src/v2.ts's dispatch table, so every request below that
// targets those paths currently falls through to server.ts's generic
// catch-all (`err(404, "unknown route: <method> <path>")`) — every test
// fails on a genuine status/shape mismatch (expected 200/400/409, got 404
// "unknown route: …"), never a setup/typo error. Comments below say so at
// each block so a reader can tell "route missing" apart from "route wrong".
//
// Harness idioms are reused verbatim from the sibling PATCH/teardown/roadmap
// suites: `startServer({port:0, dbPath})`, fetch-based postJson/patchJson/
// getJson, and (for AC1's restart case) the `boot(dbPath)` — `handle.stop()`
// — `boot(dbPath)` again technique already proven for a simulated service
// restart on a file-backed store.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import * as storeModule from "../src/store.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error: string;
  help?: string[];
  [key: string]: unknown;
}

interface MetadataResponse extends OkResponse {
  metadata: Record<string, string>;
  changed?: boolean;
}

interface ProjectBrief {
  key: string;
  name: string;
  metadata?: Record<string, string>;
  [key: string]: unknown;
}

interface ProjectsListResponse extends OkResponse {
  projects: ProjectBrief[];
}

const ORCH = "orchestrator-1";
const OTHER_ROLE_AGENT = "reporter-1";
const ROLELESS_AGENT = "legacy-roleless";

const servers: ServerHandle[] = [];
const scratchDirs: string[] = [];

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop();
  }
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

/** A fresh, file-backed scratch db path (mkdtempSync) — AC1's restart case
 *  needs a REAL file, never `:memory:`, because a restart must survive the
 *  process boundary. */
function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "project-metadata-test-"));
  scratchDirs.push(dir);
  return join(dir, "crucible.db");
}

/** Boots (or "restarts", when reusing a real dbPath) a production server. */
function boot(dbPath = ":memory:"): ServerHandle {
  const handle = startServer({ port: 0, dbPath });
  servers.push(handle);
  return handle;
}

async function postJson(handle: ServerHandle, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchJson(handle: ServerHandle, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(handle: ServerHandle, urlPath: string): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`);
}

async function deleteJson(handle: ServerHandle, urlPath: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}${urlPath}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createProject(handle: ServerHandle, name: string): Promise<string> {
  const res = await postJson(handle, "/api/v2/projects", { name });
  const body = (await res.json()) as OkResponse & { project: { key: string } };
  return body.project.key;
}

async function registerAgent(
  handle: ServerHandle,
  key: string,
  agentId: string,
  role: string,
): Promise<Response> {
  return postJson(handle, "/api/v2/agents/register", { projectKey: key, agentId, role });
}

async function archiveProject(handle: ServerHandle, key: string): Promise<void> {
  const res = await postJson(handle, `/api/v2/projects/${key}/archive`, {});
  expect(res.status).toBe(200);
}

async function deleteProject(handle: ServerHandle, key: string): Promise<Response> {
  return deleteJson(handle, `/api/v2/projects/${key}`, { userApproved: true });
}

function metadataPath(key: string): string {
  return `/api/v2/projects/${key}/metadata`;
}

async function getMetadata(
  handle: ServerHandle,
  key: string,
): Promise<{ status: number; body: MetadataResponse | ErrResponse }> {
  const res = await getJson(handle, metadataPath(key));
  return { status: res.status, body: (await res.json()) as MetadataResponse | ErrResponse };
}

async function patchMetadata(
  handle: ServerHandle,
  key: string,
  body: unknown,
): Promise<{ status: number; body: MetadataResponse | ErrResponse }> {
  const res = await patchJson(handle, metadataPath(key), body);
  return { status: res.status, body: (await res.json()) as MetadataResponse | ErrResponse };
}

async function findProjectBrief(handle: ServerHandle, key: string): Promise<ProjectBrief | undefined> {
  const res = await getJson(handle, "/api/v2/projects");
  const body = (await res.json()) as ProjectsListResponse;
  return body.projects.find((p) => p.key === key);
}

// ── AC1 (§S1) — the store keeps a project's metadata ────────────────────────

describe("AC1 (§S1) — metadata persistence, deletion cascade, schema cost", () => {
  test("metadata written for a project survives a server restart on the SAME on-disk store", async () => {
    const dbPath = freshDbPath();
    const server1 = boot(dbPath);
    const key = await createProject(server1, "restart-survival");
    await registerAgent(server1, key, ORCH, "ORCHESTRATOR");

    const write = await patchMetadata(server1, key, {
      agentId: ORCH,
      set: { PROJECT_TOKEN: "acme" },
    });
    // Route absent today → 404 "unknown route", not 200. Fails here, for the
    // right reason (the write door does not exist), before any restart logic
    // is even reached.
    expect(write.status).toBe(200);
    expect(write.body.ok).toBe(true);

    // Simulated restart: stop the process, reopen the SAME db file.
    server1.stop();
    const server2 = boot(dbPath);

    const read = await getMetadata(server2, key);
    expect(read.status).toBe(200);
    expect(read.body.ok).toBe(true);
    expect((read.body as MetadataResponse).metadata).toEqual({ PROJECT_TOKEN: "acme" });
  });

  test("deleting a project removes its metadata; a project RE-CREATED with the same name starts with none", async () => {
    const handle = boot();
    const key = await createProject(handle, "delete-cascade-meta");
    await registerAgent(handle, key, ORCH, "ORCHESTRATOR");

    const write = await patchMetadata(handle, key, {
      agentId: ORCH,
      set: { PROJECT_TOKEN: "acme" },
    });
    expect(write.status).toBe(200);
    const before = await getMetadata(handle, key);
    expect((before.body as MetadataResponse).metadata).toEqual({ PROJECT_TOKEN: "acme" });

    await archiveProject(handle, key);
    const del = await deleteProject(handle, key);
    expect(del.status).toBe(200);
    expect(((await del.json()) as OkResponse).ok).toBe(true);

    // A DIFFERENT project, same name, reusing the store — its metadata must
    // be genuinely empty, not inherited from the deleted row.
    const reborn = await createProject(handle, "delete-cascade-meta");
    expect(reborn).not.toBe(key);
    const rebornMeta = await getMetadata(handle, reborn);
    expect(rebornMeta.status).toBe(200);
    expect((rebornMeta.body as MetadataResponse).metadata).toEqual({});
  });

  // Regression pin, stated honestly: this MAY ALREADY PASS today. §S1 places
  // the metadata table in the base schema pass (the CREATE TABLE IF NOT
  // EXISTS precedent `project_milestone_types` already uses), which by
  // design costs no migration step and no schema-version bump — so
  // reopening a same-build store today already leaves `schemaVersion`
  // unchanged and `migration` null. This test pins that the metadata work
  // must NOT regress that: it stays true after GREEN too.
  test("regression pin — reopening the same store (close, then reopen) never bumps schemaVersion and runs no migration", () => {
    const dbPath = freshDbPath();
    const server1 = boot(dbPath);
    const versionBefore = server1.store.schemaVersion;
    expect(versionBefore).toBe(storeModule.SCHEMA_VERSION);
    server1.stop();

    const server2 = boot(dbPath);
    expect(server2.store.schemaVersion).toBe(versionBefore);
    expect(server2.store.migration).toBeNull();
  });
});

// ── AC2 (§S2) — an ORCHESTRATOR's set/unset leaves exactly the expected map ─

describe("AC2 (§S2) — ORCHESTRATOR set/unset semantics", () => {
  test("set writes named keys; a later unset removes only the named key; an untouched key survives both writes", async () => {
    const handle = boot();
    const key = await createProject(handle, "set-unset-semantics");
    await registerAgent(handle, key, ORCH, "ORCHESTRATOR");

    const first = await patchMetadata(handle, key, {
      agentId: ORCH,
      set: { PROJECT_NAME: "acme", PROJECT_ACRONYM: "AC" },
    });
    expect(first.status).toBe(200);
    expect((first.body as MetadataResponse).changed).toBe(true);
    expect((first.body as MetadataResponse).metadata).toEqual({
      PROJECT_NAME: "acme",
      PROJECT_ACRONYM: "AC",
    });

    const second = await patchMetadata(handle, key, {
      agentId: ORCH,
      set: { SANDESH_PROJECT: "acme-sandesh" },
      unset: ["PROJECT_ACRONYM"],
    });
    expect(second.status).toBe(200);
    expect((second.body as MetadataResponse).changed).toBe(true);
    // PROJECT_ACRONYM gone, PROJECT_NAME untouched, SANDESH_PROJECT added —
    // exactly the expected map, nothing extra, nothing missing.
    expect((second.body as MetadataResponse).metadata).toEqual({
      PROJECT_NAME: "acme",
      SANDESH_PROJECT: "acme-sandesh",
    });

    const read = await getMetadata(handle, key);
    expect((read.body as MetadataResponse).metadata).toEqual({
      PROJECT_NAME: "acme",
      SANDESH_PROJECT: "acme-sandesh",
    });
  });

  test("an IDENTICAL write (same key, same value, already stored) answers changed:false and leaves the map exactly as it was", async () => {
    const handle = boot();
    const key = await createProject(handle, "identical-write-noop");
    await registerAgent(handle, key, ORCH, "ORCHESTRATOR");

    const first = await patchMetadata(handle, key, { agentId: ORCH, set: { PROJECT_NAME: "acme" } });
    expect(first.status).toBe(200);
    expect((first.body as MetadataResponse).changed).toBe(true);

    const repeat = await patchMetadata(handle, key, { agentId: ORCH, set: { PROJECT_NAME: "acme" } });
    expect(repeat.status).toBe(200);
    expect((repeat.body as MetadataResponse).changed).toBe(false);
    expect((repeat.body as MetadataResponse).metadata).toEqual({ PROJECT_NAME: "acme" });
  });

  test("unsetting a key that was never set is a no-op — 200, changed:false, metadata stays {}", async () => {
    const handle = boot();
    const key = await createProject(handle, "unset-absent-key-noop");
    await registerAgent(handle, key, ORCH, "ORCHESTRATOR");

    const res = await patchMetadata(handle, key, { agentId: ORCH, unset: ["NEVER_SET"] });
    expect(res.status).toBe(200);
    expect((res.body as MetadataResponse).changed).toBe(false);
    expect((res.body as MetadataResponse).metadata).toEqual({});
  });
});

// ── AC3 (§S2) — refused, with nothing written ────────────────────────────────

describe("AC3 (§S2) — refusals write nothing", () => {
  async function seedOrchestrated(handle: ServerHandle, name: string): Promise<string> {
    const key = await createProject(handle, name);
    await registerAgent(handle, key, ORCH, "ORCHESTRATOR");
    return key;
  }

  test("an UNREGISTERED caller → 409, nothing written", async () => {
    const handle = boot();
    const key = await seedOrchestrated(handle, "ac3-unregistered");

    const res = await patchMetadata(handle, key, { agentId: "ghost-agent", set: { FOO: "1" } });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect((res.body as ErrResponse).error).toContain("ghost-agent");

    const after = await getMetadata(handle, key);
    expect((after.body as MetadataResponse).metadata).toEqual({});
  });

  test("a registered caller of a NON-orchestrator role → 409 naming ORCHESTRATOR, nothing written", async () => {
    const handle = boot();
    const key = await seedOrchestrated(handle, "ac3-other-role");
    // "report" registers unbound (not a TDD role), so this needs no plan/cycle fixture.
    await registerAgent(handle, key, OTHER_ROLE_AGENT, "report");

    const res = await patchMetadata(handle, key, { agentId: OTHER_ROLE_AGENT, set: { FOO: "1" } });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect((res.body as ErrResponse).error).toContain("ORCHESTRATOR");

    const after = await getMetadata(handle, key);
    expect((after.body as MetadataResponse).metadata).toEqual({});
  });

  test("a registered caller carrying NO role → 409 naming ORCHESTRATOR, nothing written", async () => {
    const handle = boot();
    const key = await seedOrchestrated(handle, "ac3-no-role");
    // A pre-role-era row: live and registered, but role is never fabricated.
    handle.store.touchAgent(key, ROLELESS_AGENT);
    expect(handle.store.getAgent(key, ROLELESS_AGENT)?.role).toBeUndefined();

    const res = await patchMetadata(handle, key, { agentId: ROLELESS_AGENT, set: { FOO: "1" } });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect((res.body as ErrResponse).error).toContain("ORCHESTRATOR");

    const after = await getMetadata(handle, key);
    expect((after.body as MetadataResponse).metadata).toEqual({});
  });

  test("a body naming neither a non-empty set NOR a non-empty unset → 400, nothing written", async () => {
    const handle = boot();
    const key = await seedOrchestrated(handle, "ac3-empty-body");

    const res = await patchMetadata(handle, key, { agentId: ORCH });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const after = await getMetadata(handle, key);
    expect((after.body as MetadataResponse).metadata).toEqual({});
  });

  test("a non-environment-variable-shaped key in `set` (fails ^[A-Z][A-Z0-9_]*$) → 400, nothing written", async () => {
    const handle = boot();
    const key = await seedOrchestrated(handle, "ac3-bad-key-in-set");

    const res = await patchMetadata(handle, key, { agentId: ORCH, set: { "not-a-valid-key": "1" } });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const after = await getMetadata(handle, key);
    expect((after.body as MetadataResponse).metadata).toEqual({});
  });

  test("a non-environment-variable-shaped key in `unset` (fails ^[A-Z][A-Z0-9_]*$) → 400, nothing written", async () => {
    const handle = boot();
    const key = await seedOrchestrated(handle, "ac3-bad-key-in-unset");

    const res = await patchMetadata(handle, key, { agentId: ORCH, unset: ["not-a-valid-key"] });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const after = await getMetadata(handle, key);
    expect((after.body as MetadataResponse).metadata).toEqual({});
  });

  test("a `set` value that is not a string → 400, nothing written", async () => {
    const handle = boot();
    const key = await seedOrchestrated(handle, "ac3-non-string-value");

    const res = await patchMetadata(handle, key, { agentId: ORCH, set: { PROJECT_NAME: 12345 } });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const after = await getMetadata(handle, key);
    expect((after.body as MetadataResponse).metadata).toEqual({});
  });

  test("a key present in BOTH set and unset → 400, nothing written", async () => {
    const handle = boot();
    const key = await seedOrchestrated(handle, "ac3-key-in-both");

    const res = await patchMetadata(handle, key, {
      agentId: ORCH,
      set: { PROJECT_NAME: "acme" },
      unset: ["PROJECT_NAME"],
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const after = await getMetadata(handle, key);
    expect((after.body as MetadataResponse).metadata).toEqual({});
  });

  test("the key CRUCIBLE_PROJECT_KEY (identity stays local) → 400, nothing written", async () => {
    const handle = boot();
    const key = await seedOrchestrated(handle, "ac3-crucible-project-key");

    const res = await patchMetadata(handle, key, {
      agentId: ORCH,
      set: { CRUCIBLE_PROJECT_KEY: key },
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const after = await getMetadata(handle, key);
    expect((after.body as MetadataResponse).metadata).toEqual({});
  });
});

// ── AC4 (§S3) — reads are open ───────────────────────────────────────────────

describe("AC4 (§S3) — open reads: single-project metadata + the project list", () => {
  test("GET …/metadata on a project with none answers {ok:true, metadata:{}}", async () => {
    const handle = boot();
    const key = await createProject(handle, "empty-metadata-read");

    const res = await getMetadata(handle, key);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect((res.body as MetadataResponse).metadata).toEqual({});
  });

  test("GET …/metadata on an UNKNOWN project key answers the standard unknown-project refusal", async () => {
    const handle = boot();
    const missingKey = crypto.randomUUID();

    const res = await getMetadata(handle, missingKey);
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect((res.body as ErrResponse).error).toContain("unknown project");
  });

  test("GET /api/v2/projects carries `metadata` on a project that has some", async () => {
    const handle = boot();
    const key = await createProject(handle, "list-carries-metadata");
    await registerAgent(handle, key, ORCH, "ORCHESTRATOR");
    const write = await patchMetadata(handle, key, {
      agentId: ORCH,
      set: { PROJECT_NAME: "acme", REPO_OWNER: "acme-org" },
    });
    expect(write.status).toBe(200);

    const brief = await findProjectBrief(handle, key);
    expect(brief).toBeDefined();
    expect(brief?.metadata).toEqual({ PROJECT_NAME: "acme", REPO_OWNER: "acme-org" });
  });

  test("GET /api/v2/projects omits the `metadata` key entirely on a project that has none (matches the milestoneTypes convention)", async () => {
    const handle = boot();
    const key = await createProject(handle, "list-omits-metadata-key");

    const brief = await findProjectBrief(handle, key);
    expect(brief).toBeDefined();
    expect(brief && "metadata" in brief).toBe(false);
  });
});

// ── AC10 (§S6, VERIFY cycle 536) — a metadata refusal names its own verb ────
//
// A `report`-role and a role-less caller's write is refused today too (the
// shared `requireOrchestrator` gate already stops both), but with the WRONG
// words: "roadmap registration requires ORCHESTRATOR" and a help[] naming
// release-propose/cr-plan/wave-sequence/cr-supersede/cr-void — the generic
// roadmap wording `handleProjectMetadataPatch` borrows wholesale from
// `requireOrchestrator` (src/v2.ts). RED here on the WORDING alone;
// the 409 status and "nothing written" half already pass (and stay pinned).

describe("AC10 (§S6) — a metadata refusal names its own verb, never roadmap registration", () => {
  test("a `report`-role caller's PATCH …/metadata is refused 409, naming the metadata write and `project-meta`, never 'roadmap registration' or a roadmap verb", async () => {
    const handle = boot();
    const key = await createProject(handle, "ac10-report-role");
    await registerAgent(handle, key, OTHER_ROLE_AGENT, "report");

    const res = await patchMetadata(handle, key, { agentId: OTHER_ROLE_AGENT, set: { FOO: "1" } });
    expect(res.status).toBe(409);
    const body = res.body as ErrResponse;
    expect(body.ok).toBe(false);

    expect(body.error.toLowerCase()).not.toContain("roadmap registration");
    expect(body.error.toLowerCase()).toContain("metadata");

    const help = (body.help ?? []).join(" \n ");
    expect(help).not.toContain("roadmap registration");
    expect(help.toLowerCase()).toContain("project-meta");
    for (const roadmapVerb of ["release-propose", "cr-plan", "wave-sequence", "cr-supersede", "cr-void"]) {
      expect(help).not.toContain(roadmapVerb);
    }

    const after = await getMetadata(handle, key);
    expect((after.body as MetadataResponse).metadata).toEqual({});
  });

  test("a role-LESS caller's PATCH …/metadata is refused 409, naming the metadata write and `project-meta`, never 'roadmap registration' or a roadmap verb", async () => {
    const handle = boot();
    const key = await createProject(handle, "ac10-roleless");
    handle.store.touchAgent(key, ROLELESS_AGENT);
    expect(handle.store.getAgent(key, ROLELESS_AGENT)?.role).toBeUndefined();

    const res = await patchMetadata(handle, key, { agentId: ROLELESS_AGENT, set: { FOO: "1" } });
    expect(res.status).toBe(409);
    const body = res.body as ErrResponse;
    expect(body.ok).toBe(false);

    expect(body.error.toLowerCase()).not.toContain("roadmap registration");
    expect(body.error.toLowerCase()).toContain("metadata");

    const help = (body.help ?? []).join(" \n ");
    expect(help).not.toContain("roadmap registration");
    expect(help.toLowerCase()).toContain("project-meta");
    for (const roadmapVerb of ["release-propose", "cr-plan", "wave-sequence", "cr-supersede", "cr-void"]) {
      expect(help).not.toContain(roadmapVerb);
    }

    const after = await getMetadata(handle, key);
    expect((after.body as MetadataResponse).metadata).toEqual({});
  });

  // Regression pin — captured VERBATIM from `requireOrchestrator`/
  // `roadmapHints.notOrchestrator` as they read TODAY (both in src/v2.ts and
  // src/hints.ts respectively): a LITERAL string, never a re-derivation from the
  // live function, so a GREEN that narrows the metadata route's refusal by
  // reshaping the SHARED helper (rather than adding a metadata-specific one)
  // and accidentally reshapes the roadmap wording fails HERE, byte for byte.
  test("regression pin — a roadmap route's own refusal of a report-role caller is BYTE-IDENTICAL to today's", async () => {
    const handle = boot();
    const key = await createProject(handle, "ac10-roadmap-unchanged-report");
    await registerAgent(handle, key, OTHER_ROLE_AGENT, "report");

    const res = await postJson(handle, `/api/v2/projects/${key}/queue/plan`, {
      agentId: OTHER_ROLE_AGENT,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toBe(
      `agent ${OTHER_ROLE_AGENT} carries role report — roadmap registration requires ORCHESTRATOR`,
    );
    expect(body.help).toEqual([
      `re-register ${OTHER_ROLE_AGENT} with role ORCHESTRATOR: POST /api/v2/agents/register {projectKey, agentId, role: "ORCHESTRATOR"} — it currently holds report`,
      "roadmap registration is orchestrator work: release-propose, cr-plan, wave-sequence, cr-supersede and cr-void all require it",
      "an agent already exercising a TDD role should hand the call to its orchestrator rather than re-declaring its own role",
    ]);
  });

  test("regression pin — a roadmap route's own refusal of a role-less caller is BYTE-IDENTICAL to today's", async () => {
    const handle = boot();
    const key = await createProject(handle, "ac10-roadmap-unchanged-roleless");
    handle.store.touchAgent(key, ROLELESS_AGENT);

    const res = await postJson(handle, `/api/v2/projects/${key}/queue/plan`, {
      agentId: ROLELESS_AGENT,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toBe(
      `agent ${ROLELESS_AGENT} carries no declared role — roadmap registration requires ORCHESTRATOR`,
    );
    expect(body.help).toEqual([
      `POST /api/v2/agents/unregister {projectKey, agentId} then re-register ${ROLELESS_AGENT} with role ORCHESTRATOR — its row predates declared roles and carries none, and a role is never fabricated`,
      "roadmap registration is orchestrator work: release-propose, cr-plan, wave-sequence, cr-supersede and cr-void all require it",
      "an agent already exercising a TDD role should hand the call to its orchestrator rather than re-declaring its own role",
    ]);
  });
});

// ── TEST GAP (b), VERIFY cycle 536 — non-ASCII / long values round-trip ─────
//
// TEST-ONLY: these may already pass (the store's own column is a plain SQLite
// TEXT value; nothing in §S1's schema truncates or re-encodes it). Reported
// honestly either way rather than assumed.

describe("TEST GAP (b), VERIFY cycle 536 — non-ASCII and long metadata values round-trip exactly", () => {
  test("a non-ASCII value round-trips EXACTLY through PATCH then GET", async () => {
    const handle = boot();
    const key = await createProject(handle, "gap-b-non-ascii");
    await registerAgent(handle, key, ORCH, "ORCHESTRATOR");

    const value = "Café — 東京";
    const write = await patchMetadata(handle, key, { agentId: ORCH, set: { PROJECT_NAME: value } });
    expect(write.status).toBe(200);
    expect((write.body as MetadataResponse).metadata.PROJECT_NAME).toBe(value);

    const read = await getMetadata(handle, key);
    expect(read.status).toBe(200);
    expect((read.body as MetadataResponse).metadata.PROJECT_NAME).toBe(value);
  });

  test("a 10,000-character value round-trips EXACTLY through PATCH then GET", async () => {
    const handle = boot();
    const key = await createProject(handle, "gap-b-long-value");
    await registerAgent(handle, key, ORCH, "ORCHESTRATOR");

    const value = "x".repeat(10000);
    const write = await patchMetadata(handle, key, { agentId: ORCH, set: { PROJECT_TOKEN: value } });
    expect(write.status).toBe(200);
    expect((write.body as MetadataResponse).metadata.PROJECT_TOKEN.length).toBe(10000);
    expect((write.body as MetadataResponse).metadata.PROJECT_TOKEN).toBe(value);

    const read = await getMetadata(handle, key);
    expect(read.status).toBe(200);
    expect((read.body as MetadataResponse).metadata.PROJECT_TOKEN).toBe(value);
  });
});

