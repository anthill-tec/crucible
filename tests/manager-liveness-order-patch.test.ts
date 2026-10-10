// CR-CRU-174 §S3 — the server refuses a liveness PATCH whose EFFECTIVE
// thresholds (the patch merged over the project's existing override, merged
// over the board defaults — exactly Store#updateProject's own merge order:
// `{...existing.liveness, ...patch.liveness}`, read back through
// `livenessConfig`'s `{...DEFAULT_LIVENESS, ...project?.liveness}`) are not
// STRICTLY increasing (stale < tombstoned < removed). Today (verified,
// `handleProjectPatch` in src/v2.ts ~4093-4111) each liveness.* field is
// validated only in isolation (`typeof value !== "number" || value <= 0`) —
// there is no cross-field order check and no awareness of the project's
// existing override at all, so every test below is expected to FAIL against
// the current server: the two "refused" PATCHes both currently succeed
// (200 {ok:true, changed:true}) and their values land in storage.
//
// RED does not pin the exact wording of the 400's error string (the spec
// says only "naming the order" — no literal sentence is given in the CR or
// its approved frame, unlike the page-wording ACs). Pinned instead: status
// 400, `ok:false`, and the error text names which two thresholds collided by
// substring (e.g. mentions "stale" and "tombstone" when T1/T2 collide) —
// loose enough to accept any GREEN wording that actually names the order,
// strict enough that a generic "invalid liveness" message (which never
// NAMES which pair is out of order) still fails this file.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";

type ServerHandle = ReturnType<typeof startServer>;

interface OkResponse {
  ok: true;
  changed?: boolean;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error: string;
  [key: string]: unknown;
}

interface ProjectBrief {
  key: string;
  liveness?: { staleAfterMs?: number; tombstoneAfterMs?: number; pruneAfterMs?: number };
  [key: string]: unknown;
}

interface ProjectsListResponse extends OkResponse {
  projects: ProjectBrief[];
}

describe("PATCH /api/v2/projects/<key> — liveness order validation (CR-CRU-174 §S3)", () => {
  let handle: ServerHandle | undefined;

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

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  async function findProject(key: string): Promise<ProjectBrief | undefined> {
    const list = (await (await getJson("/api/v2/projects")).json()) as ProjectsListResponse;
    return list.projects.find((p) => p.key === key);
  }

  function patchPath(key: string): string {
    return `/api/v2/projects/${key}`;
  }

  test(
    "a PATCH whose OWN liveness thresholds are not strictly increasing (t1 300s >= t2 120s) " +
      "is refused 400 naming stale and tombstone, and nothing is stored",
    async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("Order Guard Direct Co");

      const res = await patchJson(patchPath(key), {
        liveness: { t1_ms: 300_000, t2_ms: 120_000 },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error.toLowerCase()).toMatch(/stale/);
      expect(body.error.toLowerCase()).toMatch(/tombstone/);

      const project = await findProject(key);
      // Nothing stored at all — the project still carries no liveness
      // override (the omit-when-unset contract, src/types.ts).
      expect(project?.liveness).toBeUndefined();
    },
  );

  test(
    "a PATCH that is fine taken alone but becomes non-increasing ONLY once merged with the " +
      "project's existing override (stored t1=200s + new t3=250s leaves the DEFAULT t2=300s " +
      "stranded above it) is refused 400 naming tombstone and removed, and the new field is not stored",
    async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("Order Guard Merge Co");

      // First PATCH: t1=200s alone is valid against the defaults
      // (200s < 300s default tombstone < 3600s default removed).
      const first = await patchJson(patchPath(key), { liveness: { t1_ms: 200_000 } });
      expect(first.status).toBe(200);
      const afterFirst = await findProject(key);
      expect(afterFirst?.liveness?.staleAfterMs).toBe(200_000);
      expect(afterFirst?.liveness?.tombstoneAfterMs).toBeUndefined();

      // Second PATCH: t3=250s alone looks fine in isolation, but merged
      // with the STORED t1=200s override and the untouched DEFAULT
      // tombstone (300s), the effective order is stale(200s) <
      // tombstone(300s, default) > removed(250s) — not increasing.
      const second = await patchJson(patchPath(key), { liveness: { t3_ms: 250_000 } });
      expect(second.status).toBe(400);
      const body = (await second.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error.toLowerCase()).toMatch(/tombstone/);
      expect(body.error.toLowerCase()).toMatch(/remov/);

      const afterSecond = await findProject(key);
      // The refused field never lands — still exactly the first PATCH's
      // stored state, no pruneAfterMs override at all.
      expect(afterSecond?.liveness?.staleAfterMs).toBe(200_000);
      expect(afterSecond?.liveness?.pruneAfterMs).toBeUndefined();
    },
  );

  test(
    "a PATCH whose effective thresholds ARE strictly increasing after the merge is accepted and stored",
    async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("Order Guard Good Co");

      const res = await patchJson(patchPath(key), {
        liveness: { t1_ms: 100_000, t2_ms: 200_000, t3_ms: 300_000 },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);
      expect(body.changed).toBe(true);

      const project = await findProject(key);
      expect(project?.liveness).toEqual({
        staleAfterMs: 100_000,
        tombstoneAfterMs: 200_000,
        pruneAfterMs: 300_000,
      });
    },
  );

  test(
    "effective thresholds that are EQUAL (not strictly increasing) are also refused 400 naming the order",
    async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("Order Guard Equal Co");

      const res = await patchJson(patchPath(key), {
        liveness: { t1_ms: 60_000, t2_ms: 60_000 },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error.toLowerCase()).toMatch(/stale/);
      expect(body.error.toLowerCase()).toMatch(/tombstone/);

      const project = await findProject(key);
      expect(project?.liveness).toBeUndefined();
    },
  );
});
