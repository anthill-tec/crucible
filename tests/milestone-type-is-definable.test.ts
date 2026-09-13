// CR-CRU-130 §S4 — a milestone type is DEFINABLE, and exactly two are RESERVED.
//
// ── What is broken today ──────────────────────────────────────────────────
//
// `MILESTONE_TYPES` (src/v2.ts:1168) is a closed `Set` literal and
// `POST /api/v2/milestones` refuses anything outside it (src/v2.ts:1289).
// Six types, chosen by whoever last edited that file. `custom` is the escape
// hatch and it collapses every project-defined milestone into ONE label, so a
// project recording two different kinds of dated goal cannot tell them apart,
// filter for one, or render them differently.
//
// The store is ALREADY open — CR-CRU-129 §S1 gave `milestones.type` an
// unconstrained `TEXT` column with no `CHECK`, and C1's RED proved a
// runtime-invented type round-trips through it. Only the ROUTE is closed.
//
// ── The contract this suite is written against ────────────────────────────
//
//   PATCH /api/v2/projects/<key> {milestoneTypes: ["…", …]}
//        -> the project DECLARES its own milestone vocabulary.
//
// SHAPE CHOICE, STATED SO GREEN MAY OVERRULE IT. `PATCH …/projects/<key>` is
// already THE project-configuration surface (src/v2.ts:3383, `PATCHABLE_FIELDS`
// at :3354, `ProjectPatch` at src/store.ts:35), and §S4 calls a declared type
// "configuration" in those words. `milestoneTypes` is the camelCase spelling
// every other wire field on that route already uses (`sutRoot`,
// `allowRunDeletion`). Both decisions are isolated in `DECLARATION_FIELD` and
// `projectPath()` below: a different spelling costs GREEN two constants, not
// the suite, because every assertion here is about BEHAVIOUR — what is
// accepted, what is refused, what reads back, and what the server still
// derives.
//
// The accepted set a project may post is READ OFF THE SERVER'S OWN REFUSAL
// (`type must be one of: …`), which is how `tests/milestone-records-survive-
// retention.test.ts:147` and `tests/milestone-dates-are-first-class.test.ts:167`
// already read it, and is the "way to SEE the live list" §S5 requires. No test
// in this file holds a copy of the vocabulary.
//
// ── How each case fails if GREEN does nothing ─────────────────────────────
//
//   1. RESERVED. `PATCH …/projects/<key> {milestoneTypes:[…]}` is an unknown
//      field today, so the route answers `400 unknown field: milestoneTypes`
//      for EVERY declaration — including the two that must be refused for
//      being reserved. A refusal that does not NAME the reserved type and say
//      why fails, so "it 400s" is not enough to pass. Each reserved case
//      asserts the server's DERIVATION first, on a live fixture, so it cannot
//      pass on a build that derives nothing.
//   2. DECLARED. A project-declared type is refused by the route today
//      (`type must be one of: …`), so the round-trip never happens. The two
//      declared types are read back INDEPENDENTLY, each by its own `?type=`,
//      so "distinguishable" is proved by identity and not by a count.
//   3. UNDECLARED. A typo is refused today too, but the refusal names a closed
//      list and nothing else — it cannot say how to declare, because there is
//      nothing to declare with. The assertion is on the REMEDY, not on the 400.
//   4. SEEDED. `gap-analysis`, `design-review` and `stage-flip` are server
//      constants today; after §S4 they are seeded CONFIGURATION. The case is
//      driven by this project's REAL population, read off a `sqlite3 -readonly`
//      replica rather than pinned, because it grows daily.
//
// ── Safety ────────────────────────────────────────────────────────────────
// Every store here is `:memory:` and every server binds port 0; the dog-food
// port 3849 is never touched. The live `data/crucible.db` is opened ONLY by
// `sqlite3 -readonly … .backup` (the idiom `tests/milestone-dates-migration
// .test.ts:78` established), into an mkdtemp replica, and the case measures
// the live file's size and mtime before and after and fails if either moved.
// Fixture cr ids come from the REGISTERED synthetic namespaces the
// project-namespace tripwire allows (`CR-SHIPPED-*`, `CR-AUTH-*`).
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, migrateMilestoneRecords } from "../src/store.ts";
import { startServer, type ServerHandle } from "../src/server.ts";

const ORCH = "cru130-c3-definable";

/** THE ONE SPELLING DECISION, isolated — see the header. */
const DECLARATION_FIELD = "milestoneTypes";

/**
 * The two types the SERVER derives behaviour from, named here because §S4
 * names them and because a suite that read them off the server could not tell
 * a reserved type from a declared one. Every case below proves the derivation
 * BEFORE it asserts the reservation, so this pair is a subject, never a pin.
 */
const RESERVED = ["release", "cr-merged"] as const;

/** The three server constants §S4 turns into seeded configuration. */
const SEEDED = ["gap-analysis", "design-review", "stage-flip"] as const;

/** Epoch SECONDS — the unit `targetAt`/`deliveredAt`/`releasedAt` already use. */
const TARGET_AT = 1_789_171_200; // 2026-09-11
const DELIVERED_AT = 1_790_000_000;

interface MilestoneWire {
  id: string;
  type?: string;
  label?: string;
  targetAt?: number;
  deliveredAt?: number;
  [key: string]: unknown;
}

interface QueueEntryWire {
  cr: string;
  status?: string;
  [key: string]: unknown;
}

interface AnyBody {
  ok?: boolean;
  error?: string;
  help?: string[];
  changed?: boolean;
  project?: { key: string };
  event?: string;
  milestones?: MilestoneWire[];
  proposals?: Array<{ label: string; [key: string]: unknown }>;
  releases?: Array<{ version?: string; [key: string]: unknown }>;
  entries?: QueueEntryWire[];
  [key: string]: unknown;
}

/**
 * A READ-ONLY replica of the live store, or the STATED reason there is none —
 * the repo's live-subject idiom (`tests/milestone-dates-migration.test.ts:58`).
 * A clean checkout and CI have no live store and may have no `sqlite3`; a case
 * that THREW there would report a missing operator file as a broken invariant.
 */
function liveStoreReplica(
  dir: string,
): { live: string; replica: string; sizeBefore: number; mtimeBefore: number } | { skip: string } {
  const live = join(process.cwd(), "data", "crucible.db");
  if (!existsSync(live)) {
    return { skip: `there is no live store at ${live}, and its data is never committed` };
  }
  const replica = join(dir, "replica.db");
  const before = statSync(live);
  try {
    const backup = Bun.spawnSync(["sqlite3", "-readonly", live, `.backup '${replica}'`]);
    if (backup.exitCode !== 0) {
      return {
        skip:
          `sqlite3 could not take a read-only replica of ${live} — exit ` +
          `${String(backup.exitCode)}: ${backup.stderr.toString().trim()}`,
      };
    }
  } catch (failure) {
    const said = failure instanceof Error ? failure.message : String(failure);
    return { skip: `\`sqlite3\`, which takes the read-only replica, is not runnable here (${said})` };
  }
  return { live, replica, sizeBefore: before.size, mtimeBefore: before.mtimeMs };
}

describe("CR-CRU-130 §S4 — reserved types stay reserved; every other type is definable", () => {
  let handle: ServerHandle | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  function boot(): ServerHandle {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    return handle;
  }

  function base(): string {
    return `http://localhost:${String(handle!.server.port)}`;
  }

  function store(): Store {
    return handle!.store;
  }

  function rawDb(): Database {
    return (handle!.store as unknown as { db: Database }).db;
  }

  async function send(
    method: string,
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`${base()}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  async function post(path: string, body: unknown): Promise<{ status: number; body: AnyBody }> {
    return send("POST", path, body);
  }

  async function get(path: string): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`${base()}${path}`);
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  // ── the two route-shape decisions, isolated ──────────────────────────────

  function projectPath(key: string): string {
    return `/api/v2/projects/${key}`;
  }

  /** Declare this project's milestone vocabulary through its configuration. */
  async function declare(
    key: string,
    types: readonly string[],
  ): Promise<{ status: number; body: AnyBody }> {
    return send("PATCH", projectPath(key), { [DECLARATION_FIELD]: [...types] });
  }

  async function seedProject(name: string): Promise<string> {
    const created = await post("/api/v2/projects", { name });
    const key = created.body.project?.key;
    expect(typeof key).toBe("string");
    const registered = await post("/api/v2/agents/register", {
      projectKey: key,
      agentId: ORCH,
      role: "ORCHESTRATOR",
    });
    expect(registered.status).toBe(200);
    return key!;
  }

  /**
   * The accepted milestone vocabulary, READ OFF THE SERVER'S OWN REFUSAL — the
   * only channel that publishes it, and it publishes it verbatim. A test that
   * typed the list would go stale the day a project declares a seventh type.
   */
  async function acceptedTypes(key: string): Promise<string[]> {
    const refused = await post("/api/v2/milestones", {
      projectKey: key,
      agentId: ORCH,
      type: "__definitely-not-a-milestone-type__",
    });
    expect(refused.status).toBe(400);
    const message = String(refused.body.error ?? "");
    const match = /type must be one of:\s*(.+)$/.exec(message);
    if (match === null) {
      throw new Error(
        `CR-CRU-130 §S4: cannot read the accepted milestone vocabulary off the server's own ` +
          `refusal — POST /api/v2/milestones answered ${JSON.stringify(message)}. This suite ` +
          `reads the vocabulary rather than holding a copy of it; fix the read, never pin a list.`,
      );
    }
    return match[1]!
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  async function postMilestone(
    key: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: AnyBody }> {
    return post("/api/v2/milestones", { projectKey: key, agentId: ORCH, ...body });
  }

  async function recordsOfType(key: string, type: string): Promise<MilestoneWire[]> {
    const answered = await get(
      `${projectPath(key)}/milestones?type=${encodeURIComponent(type)}`,
    );
    expect(answered.status).toBe(200);
    return answered.body.milestones ?? [];
  }

  /** Everything the refusal and its `help[]` said, as one searchable string. */
  function said(answer: { body: AnyBody }): string {
    return [answer.body.error ?? "", ...(answer.body.help ?? [])].join("\n");
  }

  async function propose(key: string, label: string): Promise<void> {
    const res = await post(`${projectPath(key)}/release-proposals`, {
      agentId: ORCH,
      label,
      targetAt: TARGET_AT,
    });
    expect(res.status).toBe(200);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 1. RESERVED — the derivation first, the refusal second.
  // ────────────────────────────────────────────────────────────────────────

  test(
    "`release` KEEPS its derived behaviour — the proposals read, the releases read and the " +
      "queue's COMPLETED_UNTRACKED — and a project declaring it is refused, naming the type and why",
    async () => {
      boot();
      const key = await seedProject("cru130-reserved-release");
      store().replaceQueue(key, [
        { cr: "CR-SHIPPED-1", title: "landed in 9.9.0", wave: "5", dependsOn: [] },
      ]);

      // (a) THE DERIVATION FIRES, on a live fixture, BEFORE anything is
      // declared — so this case cannot pass on a server that derives nothing.
      await propose(key, "9.9.0");
      const outstanding = await get(`${projectPath(key)}/release-proposals`);
      expect((outstanding.body.proposals ?? []).map((p) => p.label)).toEqual(["9.9.0"]);

      const shipped = await postMilestone(key, {
        type: "release",
        label: "9.9.0",
        commit: "deadbee",
        crs: ["CR-SHIPPED-1"],
        releasedAt: DELIVERED_AT,
      });
      expect([200, 201]).toContain(shipped.status);

      const releases = await get(`${projectPath(key)}/releases`);
      expect((releases.body.releases ?? []).map((r) => r.version)).toEqual(["9.9.0"]);
      const queued = await get(`${projectPath(key)}/queue`);
      expect(
        (queued.body.entries ?? []).find((entry) => entry.cr === "CR-SHIPPED-1")?.status,
      ).toBe("COMPLETED_UNTRACKED");

      // (b) …and the name that carries all of it cannot be redeclared.
      const refused = await declare(key, ["release"]);
      expect(refused.status).toBe(400);
      expect(refused.body.ok).toBe(false);
      expect(said(refused)).toContain("release");
      expect(said(refused)).toMatch(/reserved/i);
      // The refusal says WHY, by naming what the server derives from it — a
      // refusal that only said "no" would leave the caller to guess whether
      // the name is taken or the value is malformed.
      expect(said(refused)).toMatch(/releases|proposals|crs|membership|queue/i);

      // (c) NOTHING was applied, and the derivation still fires afterwards.
      const stillReleases = await get(`${projectPath(key)}/releases`);
      expect((stillReleases.body.releases ?? []).map((r) => r.version)).toEqual(["9.9.0"]);
      const stillQueued = await get(`${projectPath(key)}/queue`);
      expect(
        (stillQueued.body.entries ?? []).find((entry) => entry.cr === "CR-SHIPPED-1")?.status,
      ).toBe("COMPLETED_UNTRACKED");
    },
  );

  test(
    "`cr-merged` KEEPS its derived behaviour — it is the landing evidence a release's own `crs` " +
      "is measured against, and a project-declared type cannot stand in for it — and declaring it is refused",
    async () => {
      boot();
      const key = await seedProject("cru130-reserved-cr-merged");

      // A release that says it landed two CRs; only ONE has its landing
      // evidence, and the OTHER's evidence is recorded under a
      // project-declared type instead of the reserved one.
      const declared = await declare(key, ["merge-note"]);
      expect(declared.status).toBe(200);
      await propose(key, "9.8.0");
      const shipped = await postMilestone(key, {
        type: "release",
        label: "9.8.0",
        commit: "cafe123",
        crs: ["CR-SHIPPED-1", "CR-AUTH-2"],
        releasedAt: DELIVERED_AT,
      });
      expect([200, 201]).toContain(shipped.status);
      expect([200, 201]).toContain(
        (await postMilestone(key, { type: "cr-merged", label: "CR-SHIPPED-1" })).status,
      );
      expect([200, 201]).toContain(
        (await postMilestone(key, { type: "merge-note", label: "CR-AUTH-2" })).status,
      );

      // (a) THE DERIVATION FIRES: the reserved record answers for its cr and
      // the declared one does not — which is what makes the name reserved.
      const measured = migrateMilestoneRecords(rawDb());
      expect(measured.unrecoverable.map((loss) => loss.id)).toEqual(["CR-AUTH-2"]);
      expect(measured.unrecoverable[0]!.what).toBe("cr-merged");
      expect(measured.unrecoverable.map((loss) => loss.id)).not.toContain("CR-SHIPPED-1");

      // (b) …so the name cannot be redeclared out from under that derivation.
      const refused = await declare(key, ["cr-merged"]);
      expect(refused.status).toBe(400);
      expect(refused.body.ok).toBe(false);
      expect(said(refused)).toContain("cr-merged");
      expect(said(refused)).toMatch(/reserved/i);
      expect(said(refused)).toMatch(/landing|evidence|provenance|release/i);

      // (c) and the measurement is unchanged by the attempt.
      expect(migrateMilestoneRecords(rawDb()).unrecoverable.map((loss) => loss.id)).toEqual([
        "CR-AUTH-2",
      ]);
    },
  );

  test(
    "a declaration cannot SHADOW or REMOVE a reserved type: a vocabulary that omits both leaves " +
      "both accepted, and one that names either beside its own types is refused whole",
    async () => {
      boot();
      const key = await seedProject("cru130-reserved-not-removable");

      // Omitting them is not removing them — they are the server's, not the
      // project's, so a project that never mentions them still records them.
      const narrowed = await declare(key, ["risk-review"]);
      expect(narrowed.status).toBe(200);
      for (const reserved of RESERVED) {
        expect(await acceptedTypes(key)).toContain(reserved);
      }
      await propose(key, "9.7.0");
      expect([200, 201]).toContain(
        (
          await postMilestone(key, {
            type: "release",
            label: "9.7.0",
            commit: "beefbee",
            crs: [],
            releasedAt: DELIVERED_AT,
          })
        ).status,
      );
      expect([200, 201]).toContain(
        (await postMilestone(key, { type: "cr-merged", label: "CR-SHIPPED-3" })).status,
      );

      // Shadowing: a reserved name smuggled in beside legitimate ones is
      // refused WHOLE — nothing in the list is applied, which is why
      // `risk-review` above is still the project's only declared type and
      // `sales-demo` below never becomes one.
      const shadowed = await declare(key, ["sales-demo", "cr-merged"]);
      expect(shadowed.status).toBe(400);
      expect(said(shadowed)).toContain("cr-merged");
      expect(said(shadowed)).toMatch(/reserved/i);
      const after = await acceptedTypes(key);
      expect(after).toContain("risk-review");
      expect(after).not.toContain("sales-demo");
      expect(
        (await postMilestone(key, { type: "sales-demo", label: "never-declared" })).status,
      ).toBe(400);
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // 2. A PROJECT-DECLARED TYPE IS FIRST-CLASS.
  // ────────────────────────────────────────────────────────────────────────

  test(
    "two project-declared types are recorded under their OWN names, carry both dates, and are " +
      "distinguishable after the fact: each reads back alone under its own `?type=`, and neither is `custom`",
    async () => {
      boot();
      const key = await seedProject("cru130-declared-first-class");

      const declared = await declare(key, ["risk-review", "field-trial"]);
      expect(declared.status).toBe(200);
      expect(declared.body.ok).toBe(true);
      expect(declared.body.changed).toBe(true);

      const risk = await postMilestone(key, {
        type: "risk-review",
        label: "payments-risk-review",
        targetAt: TARGET_AT,
        deliveredAt: DELIVERED_AT,
      });
      expect([200, 201]).toContain(risk.status);
      const trial = await postMilestone(key, {
        type: "field-trial",
        label: "pilot-site-north",
        targetAt: TARGET_AT,
      });
      expect([200, 201]).toContain(trial.status);

      // Read back INDEPENDENTLY — the thing `custom` cannot do. A server that
      // accepted both and stored them under one label would answer both reads
      // with both rows, and both length assertions would fail.
      const risks = await recordsOfType(key, "risk-review");
      expect(risks.length).toBe(1);
      expect(risks[0]!.type).toBe("risk-review");
      expect(risks[0]!.label).toBe("payments-risk-review");
      expect(risks[0]!.targetAt).toBe(TARGET_AT);
      expect(risks[0]!.deliveredAt).toBe(DELIVERED_AT);

      const trials = await recordsOfType(key, "field-trial");
      expect(trials.length).toBe(1);
      expect(trials[0]!.type).toBe("field-trial");
      expect(trials[0]!.label).toBe("pilot-site-north");
      expect(trials[0]!.targetAt).toBe(TARGET_AT);
      // Outstanding is a real state, for a declared type too.
      expect(trials[0]!.deliveredAt).toBeUndefined();

      // NEVER rewritten to `custom`: the escape hatch stays empty.
      expect(await recordsOfType(key, "custom")).toEqual([]);
      // …and neither read leaked the other's row.
      expect(risks.map((row) => row.label)).not.toContain("pilot-site-north");
      expect(trials.map((row) => row.label)).not.toContain("payments-risk-review");

      // The column, not a blob field, carries the name — the same seam
      // CR-CRU-129 §S1 established for `type`.
      const stored = rawDb()
        .query<{ type: string | null }, [string]>(
          `SELECT type FROM milestones WHERE project_key = ? ORDER BY rowid ASC`,
        )
        .all(key)
        .map((row) => row.type);
      expect(stored.sort()).toEqual(["field-trial", "risk-review"]);
    },
  );

  test(
    "the declared vocabulary is READABLE — the project resource carries it, so a caller can SEE " +
      "the live list instead of guessing at one, and the server's refusal publishes the same set",
    async () => {
      boot();
      const key = await seedProject("cru130-vocabulary-is-readable");
      expect((await declare(key, ["risk-review", "field-trial"])).status).toBe(200);

      const listed = await get("/api/v2/projects");
      expect(listed.status).toBe(200);
      const mine = (listed.body.projects as Array<Record<string, unknown>> | undefined)?.find(
        (entry) => entry.key === key,
      );
      expect(mine).toBeDefined();
      const declaredBack = mine![DECLARATION_FIELD] as string[] | undefined;
      expect(declaredBack?.slice().sort()).toEqual(["field-trial", "risk-review"]);
      // What the project DECLARED, not what it may POST: the reserved pair is
      // the server's and is not written into the project's own vocabulary.
      for (const reserved of RESERVED) {
        expect(declaredBack).not.toContain(reserved);
      }

      // …while the accepted set the refusal publishes is declared ∪ reserved ∪
      // seeded — which is what keeps the generic door's own tripwire
      // (`tests/roadmap-registration-routes.test.ts:1443`) reading a full list.
      const accepted = await acceptedTypes(key);
      for (const type of ["risk-review", "field-trial", ...RESERVED, ...SEEDED, "custom"]) {
        expect(accepted).toContain(type);
      }
    },
  );

  test(
    "a type one project declared is NOT accepted by another: the vocabulary is the project's, " +
      "not the server's",
    async () => {
      boot();
      const mine = await seedProject("cru130-declaring-project");
      const theirs = await seedProject("cru130-other-project");

      expect((await declare(mine, ["risk-review"])).status).toBe(200);
      expect([200, 201]).toContain(
        (await postMilestone(mine, { type: "risk-review", label: "mine" })).status,
      );

      const refused = await postMilestone(theirs, { type: "risk-review", label: "theirs" });
      expect(refused.status).toBe(400);
      expect(await acceptedTypes(theirs)).not.toContain("risk-review");
      expect(await recordsOfType(theirs, "risk-review")).toEqual([]);
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // 3. OPEN IS NOT UNVALIDATED.
  // ────────────────────────────────────────────────────────────────────────

  test(
    "an UNDECLARED type is refused and the refusal says HOW to declare it — naming the " +
      "configuration surface, so a typo cannot silently become a new category",
    async () => {
      boot();
      const key = await seedProject("cru130-typo-is-not-a-category");
      expect((await declare(key, ["risk-review"])).status).toBe(200);

      // One transposition away from a type this project really declared.
      const refused = await postMilestone(key, { type: "risk-reveiw", label: "oops" });

      expect(refused.status).toBe(400);
      expect(refused.body.ok).toBe(false);
      // The REMEDY, not merely the rejection: the field and the route that
      // declares it. Without these a caller's only move is to reach for
      // `custom`, which is the failure this CR exists to remove.
      expect(said(refused)).toContain(DECLARATION_FIELD);
      expect(said(refused)).toContain("/api/v2/projects");
      expect(said(refused)).toMatch(/PATCH/);

      // And nothing was written: a refused type is not a category.
      expect(await recordsOfType(key, "risk-reveiw")).toEqual([]);
      expect(await recordsOfType(key, "custom")).toEqual([]);
      expect(await acceptedTypes(key)).not.toContain("risk-reveiw");
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // 4. SEEDING PRESERVES TODAY'S VOCABULARY.
  // ────────────────────────────────────────────────────────────────────────

  test(
    "a project that declares NOTHING still records `gap-analysis`, `design-review`, `stage-flip` " +
      "and `custom`: the seed is configuration, so every caller recording them today keeps working",
    async () => {
      boot();
      const key = await seedProject("cru130-seeded-vocabulary");

      const accepted = await acceptedTypes(key);
      for (const type of [...SEEDED, "custom", ...RESERVED]) {
        expect(accepted).toContain(type);
      }
      for (const type of SEEDED) {
        const recorded = await postMilestone(key, { type, label: `${type}-goal` });
        expect([200, 201]).toContain(recorded.status);
        const back = await recordsOfType(key, type);
        expect(back.map((row) => row.label)).toEqual([`${type}-goal`]);
        expect(back[0]!.type).toBe(type);
      }
      // …and the seeded set is still a VOCABULARY, not an open door.
      expect((await postMilestone(key, { type: "gap-analsyis", label: "typo" })).status).toBe(400);
    },
  );

  test(
    "every non-reserved type this project's LIVE store actually holds is accepted by a project " +
      "that declared nothing — the seed is measured against the real population, not a list",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "cru130-c3-live-"));
      scratchDirs.push(dir);
      const taken = liveStoreReplica(dir);
      if ("skip" in taken) {
        console.warn(`live-population reach NOT RUN: ${taken.skip}`);
        expect(taken.skip.length).toBeGreaterThan(0);
        return;
      }

      const replica = new Database(taken.replica);
      let population: string[];
      try {
        population = replica
          .query<{ type: string | null }, []>(
            `SELECT DISTINCT type FROM milestones WHERE type IS NOT NULL`,
          )
          .all()
          .flatMap((row) => (row.type === null ? [] : [row.type]));
      } finally {
        replica.close();
      }

      // THE LIVE STORE WAS NEVER WRITTEN — measured, not asserted in prose.
      const liveAfter = statSync(taken.live);
      expect(liveAfter.size).toBe(taken.sizeBefore);
      expect(liveAfter.mtimeMs).toBe(taken.mtimeBefore);

      // Non-vacuity: the replica really holds a population. Measured
      // 2026-09-13 at 6 distinct types over 70 rows; a FLOOR, because it
      // grows daily and a pin would rot by tomorrow.
      expect(population.length).toBeGreaterThanOrEqual(4);

      // `release-proposal` is excluded because §S2 RETIRES it as a type: the
      // 2 rows carrying it are legacy rows the C2 migration rewrites into
      // undelivered `release` records, and
      // `tests/roadmap-registration-routes.test.ts:1443` is the standing
      // tripwire that the generic door must keep refusing it.
      const projectOwned = population.filter(
        (type) => !RESERVED.includes(type as (typeof RESERVED)[number]) && type !== "release-proposal",
      );
      expect(projectOwned.length).toBeGreaterThanOrEqual(2);

      // The proof: a fresh project, declaring NOTHING, accepts every one of
      // them — which is what "seeded from configuration so nothing that
      // records them today breaks" means when it is measured rather than
      // promised. Asked of the SERVER, through the channel that publishes the
      // accepted set, so the answer is the one a real client would get.
      boot();
      const key = await seedProject("cru130-live-population-reach");
      const seeded = await acceptedTypes(key);
      for (const type of projectOwned) {
        expect(seeded).toContain(type);
      }
      for (const reserved of RESERVED) {
        expect(seeded).toContain(reserved);
      }
      // …and each is genuinely RECORDABLE, not merely advertised.
      for (const type of projectOwned) {
        expect([200, 201]).toContain(
          (await postMilestone(key, { type, label: `${type}-from-the-live-population` })).status,
        );
      }
    },
  );
});
