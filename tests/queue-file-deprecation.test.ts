// CR-CRU-118 §S3 — the bulk queue route announces that it is DEPRECATED.
// C2 RED (cycle 416). The ROUTE half; the fleet half is
// tests/client/test_queue_file_deprecation_fleet.py.
//
// ── WHAT THIS FILE IS ABOUT ────────────────────────────────────────────────
//
// `queue-file` is a TRANSITIONAL door being retired (DN D4's fallout §1): it
// posts the whole README table, drops the release qualifier that table prints,
// and is the route both measured membership incidents arrived through. §S3 was
// RESCOPED (2026-09-10, user-agreed) away from teaching it to parse membership
// — that would make a corpse comfortable rather than force its replacement to
// exist — to making it SAY what it is: every call raises a deprecation warning
// naming the per-CR verbs that replace it (`cr-plan`, `cr-depends`,
// `wave-sequence`).
//
// Four properties, and each is a separate way the notice could be useless:
//
//   • STRUCTURED, not prose. The same `{code, message}` shape as every other
//     finding, because five clients RENDER findings and decide nothing (§S9),
//     and the three verbs are carried MACHINE-READABLY — a client that had to
//     regex an English sentence for them would be deciding something. The
//     assertions below therefore read the fields, never the message text.
//   • On a SUCCEEDING call, not only a failing one. A notice only the failure
//     path emits is invisible exactly when the route is being used as intended.
//   • ADDITIVE, never a replacement. It co-occurs with §S2's
//     `inherited-release-less` and with `defaulted-seq` on the same call: a
//     warning that displaced the others would HIDE findings, which is strictly
//     worse than no notice at all.
//   • DEPRECATED IS NOT REMOVED. The route still writes, and today's whole
//     table still bootstraps.
//
// ── THE CONTRACT THIS FILE PINS, AND WHERE IT COMES FROM ───────────────────
//
// The CR names the three replacement verbs and the `{code, message}` shape; it
// does not spell the code or the field the verbs ride in, so RED chooses them
// ONCE, here, and GREEN implements what is written below:
//
//   code:    "deprecated-route"  — a finding about the ROUTE, named the way
//                                  the shipped five name theirs.
//   verbs:   ["cr-plan", "cr-depends", "wave-sequence"] — the machine-readable
//            half, beside `crs`/`containers`, in the CR's own order.
//
// ── BLAST RADIUS, STATED ───────────────────────────────────────────────────
//
// A sixth `QueueWarning` code arriving on EVERY call breaks any fixture that
// pins `warnings[]` by exact set, by length, or POSITIONALLY. Measured
// 2026-09-10 and reported to GREEN rather than migrated here: the sibling
// tests/queue-release-membership-mandatory.test.ts pins the union at FIVE and
// reads §S2's finding as `union[union.length - 1]`, and both idioms move when
// this lands.
//
// Every fixture board is synthetic and in-memory — an OS-assigned port, an
// mkdtempSync scratch db, ids in this suite's own `CR-118D-*` shape. The live
// board is never touched.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import type { QueueEntryInput } from "../src/store.ts";

const REPO_ROOT = join(import.meta.dir, "..");

interface WarningWire {
  code: string;
  message: string;
  crs?: string[];
  containers?: string[];
  verbs?: string[];
  [key: string]: unknown;
}

interface QueueEntryWire {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: string;
  seq: number;
  release?: string;
  [key: string]: unknown;
}

interface AnyBody {
  ok: boolean;
  error?: string;
  help?: string[];
  project?: { key: string };
  entries?: QueueEntryWire[];
  warnings?: WarningWire[];
  [key: string]: unknown;
}

const ORCH = "orchestrator-1";
const IN_FLIGHT = "0.2.0";

/** §S3's finding, as this CR pins it. */
const DEPRECATION_CODE = "deprecated-route";

/** The three per-CR verbs that replace the bulk door, in the CR's own order —
 *  carried machine-readably so no client parses prose to find them. */
const REPLACEMENT_VERBS = ["cr-plan", "cr-depends", "wave-sequence"];

/** The `QueueWarning` code union as it stands after cycle 415 — FIVE codes, in
 *  declaration order. §S3 adds a SIXTH and may move none of these. */
const SHIPPED_QUEUE_WARNING_CODES = [
  "out-of-order",
  "cross-wave-backwards",
  "defaulted-seq",
  "unsequenced-members",
  "inherited-release-less",
];

const INHERITED_CODE = "inherited-release-less";
const DEFAULTED_SEQ_CODE = "defaulted-seq";

/** CR-CRU-091 §S8's requiredness sentence (`RELEASE_REQUIRED`, src/v2.ts). */
const RELEASE_REQUIRED = "`release` is required — the release this cr targets";

/**
 * The `QueueWarning.code` union, read off `src/v2.ts` itself.
 *
 * A TYPE union is not observable on the wire — a route emits ONE code per
 * finding, so no amount of driving the server can prove the other five are
 * unchanged. The declaration is the only place the whole vocabulary exists and
 * five clients RENDER it, so it is a published contract rather than an
 * implementation detail; the sibling §S1/§S2 suite reads it the same way.
 */
function queueWarningCodeUnion(): string[] {
  const source = readFileSync(join(REPO_ROOT, "src", "v2.ts"), "utf8");
  const declaration = /interface QueueWarning \{[^}]*?\bcode\s*:\s*([^;]+);/.exec(source);
  if (declaration === null) {
    throw new Error(
      "src/v2.ts declares no `interface QueueWarning` carrying a `code:` union — the " +
        "published warning vocabulary this suite reads has moved or been renamed",
    );
  }
  return [...declaration[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

interface Row {
  cr: string;
  title: string;
  wave: string;
  release?: string;
  seq?: number;
}

/** The rows of the release in flight — declared membership, nothing inherited. */
const ACTIVE: Row[] = [
  { cr: "CR-118D-A1", title: "in the release being cut", wave: "5", release: IN_FLIGHT },
  { cr: "CR-118D-A2", title: "in the release being cut", wave: "5", release: IN_FLIGHT },
];

/** The rows the route INHERITS release-less: §S2's migration list. */
const INHERITED: Row[] = [
  { cr: "CR-118D-I1", title: "deferred, never given a release", wave: "7" },
  { cr: "CR-118D-I2", title: "deferred, never given a release", wave: "7" },
];

function toInput(row: Row): QueueEntryInput {
  return {
    cr: row.cr,
    title: row.title,
    wave: row.wave,
    dependsOn: [],
    ...(row.release !== undefined ? { release: row.release } : {}),
    ...(row.seq !== undefined ? { seq: row.seq } : {}),
  };
}

/** What `parse_queue_table` actually posts: `{cr, title, wave, dependsOn}` and
 *  NOTHING else — no release, no seq. This shape IS the bootstrap. */
function bootstrapTable(rows: Row[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({ cr: row.cr, title: row.title, wave: row.wave, dependsOn: [] }));
}

describe("CR-CRU-118 §S3 — the bulk queue route announces that it is deprecated", () => {
  let handle: ServerHandle | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  function boot(): ServerHandle {
    const dir = mkdtempSync(join(tmpdir(), "cru118-deprecation-"));
    scratchDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
    return handle;
  }

  function base(): string {
    return `http://localhost:${handle!.server.port}`;
  }

  async function post(path: string, body: unknown): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`${base()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  async function get(path: string): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`${base()}${path}`);
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  function queuePath(key: string): string {
    return `/api/v2/projects/${key}/queue`;
  }

  async function seed(name: string): Promise<string> {
    const created = await post("/api/v2/projects", { name });
    const key = created.body.project!.key;
    const registered = await post("/api/v2/agents/register", {
      projectKey: key,
      agentId: ORCH,
      role: "ORCHESTRATOR",
    });
    expect(registered.status).toBe(200);
    return key;
  }

  /** CR-CRU-118 §S4 — a release proposal declares the date it is aiming at.
   *  Nothing in this suite is ABOUT that date; the fixtures need a live
   *  proposal to exist, so one plausible target serves all of them. */
  const FIXTURE_TARGET_AT = 1_788_220_800; // 2026-09-01T00:00:00Z

  async function propose(key: string, label: string): Promise<void> {
    const res = await post(`/api/v2/projects/${key}/release-proposals`, {
      agentId: ORCH,
      label,
      targetAt: FIXTURE_TARGET_AT,
    });
    expect(res.status).toBe(200);
  }

  async function entries(key: string): Promise<QueueEntryWire[]> {
    const res = await get(queuePath(key));
    expect(res.status).toBe(200);
    return res.body.entries!;
  }

  /** The board AS HISTORY LEFT IT, written through the STORE: after §S2 the
   *  route refuses to INSERT a release-less row, so the rows a re-post
   *  inherits must already be there. */
  function seedHistory(key: string, rows: Row[]): void {
    handle!.store.replaceQueue(key, rows.map(toInput));
  }

  function raised(body: AnyBody, code: string): WarningWire[] {
    return (body.warnings ?? []).filter((warning) => warning.code === code);
  }

  function codesOf(body: AnyBody): string[] {
    return (body.warnings ?? []).map((warning) => warning.code);
  }

  /** The one place the notice's whole SHAPE is asserted, so every call site
   *  below reads as "and this call raised it too". */
  function expectTheNotice(body: AnyBody, occasion: string): WarningWire {
    const notices = raised(body, DEPRECATION_CODE);
    expect(
      notices,
      `${occasion} raised ${JSON.stringify(codesOf(body))} — exactly one of them must be the ` +
        `${DEPRECATION_CODE} notice §S3 requires on EVERY call`,
    ).toHaveLength(1);
    const notice = notices[0]!;
    // MACHINE-READABLE, and asserted as the field rather than by fishing the
    // verbs out of the sentence: a client that had to parse prose would be
    // deciding something, which §S9 forbids it to do.
    expect(
      notice.verbs,
      `${occasion}: the notice must carry the three replacement verbs machine-readably beside ` +
        `its printable message; got ${JSON.stringify(notice)}`,
    ).toEqual(REPLACEMENT_VERBS);
    // STRUCTURED LIKE EVERY OTHER FINDING: a ready-to-print line for the five
    // clients beside the machine half.
    expect(typeof notice.message).toBe("string");
    expect(notice.message.length).toBeGreaterThan(0);
    for (const verb of REPLACEMENT_VERBS) expect(notice.message).toContain(verb);
    return notice;
  }

  test(
    "a SUCCEEDING bulk post raises the deprecation notice exactly once, naming the three " +
      "replacement verbs machine-readably — the call where the route is being used as intended",
    async () => {
      boot();
      const key = await seed("cru118-s3-success");
      await propose(key, IN_FLIGHT);
      seedHistory(key, ACTIVE);

      // A post with nothing whatever wrong with it: every row already held,
      // every row carrying a release. No other finding is earned here, which
      // is what makes this the bare "every call" case.
      const posted = await post(queuePath(key), {
        agentId: ORCH,
        entries: bootstrapTable(ACTIVE),
      });

      expect(
        posted.body.ok,
        `the post answered ${posted.status}: ${posted.body.error ?? "(no error)"}`,
      ).toBe(true);
      expect([200, 202]).toContain(posted.status);
      expectTheNotice(posted.body, "a clean, succeeding bulk post");

      // DEPRECATED IS NOT REMOVED: the write still landed, read back from the
      // store rather than trusted off the answer.
      const after = await entries(key);
      expect(after.map((entry) => entry.cr).sort()).toEqual(ACTIVE.map((row) => row.cr).sort());
      for (const entry of after) expect(entry.release).toBe(IN_FLIGHT);
      // NEGATIVE — a clean post earns no OTHER finding, so the notice cannot
      // be passing here by riding some unrelated warning the fixture provoked.
      expect(codesOf(posted.body)).toEqual([DEPRECATION_CODE]);
    },
  );

  test(
    "a REFUSED bulk post raises the notice too, beside its own error and help — a notice only " +
      "the success path emits is invisible exactly when the route is being used",
    async () => {
      boot();
      const key = await seed("cru118-s3-refusal");
      await propose(key, IN_FLIGHT);
      seedHistory(key, ACTIVE);
      const before = await entries(key);

      // §S2's refusal: a cr the board does not hold, arriving with no release.
      const refused = await post(queuePath(key), {
        agentId: ORCH,
        entries: [
          ...bootstrapTable(ACTIVE),
          { cr: "CR-118D-GHOST", title: "a CR arriving unauthored", wave: "6", dependsOn: [] },
        ],
      });

      expect(refused.status).toBe(400);
      expect(refused.body.ok).toBe(false);
      expectTheNotice(refused.body, "a REFUSED bulk post");
      // ADDITIVE on this path too: the refusal still says what it refused and
      // what fixes it. A notice that cost the caller its error would be a
      // regression dressed as a feature.
      expect(refused.body.error).toContain("CR-118D-GHOST");
      expect(refused.body.error).toContain(RELEASE_REQUIRED);
      expect(
        Array.isArray(refused.body.help) && refused.body.help.length > 0,
        `the refusal answered help=${JSON.stringify(refused.body.help)}`,
      ).toBe(true);
      // …and the refusal still refuses: nothing written.
      expect(JSON.stringify(await entries(key))).toBe(JSON.stringify(before));
    },
  );

  test(
    "the notice is ADDITIVE, never a replacement: one call raises it BESIDE §S2's " +
      "inherited-release-less finding, whose crs are unchanged, and the route still WRITES",
    async () => {
      boot();
      const key = await seed("cru118-s3-additive-inherited");
      await propose(key, IN_FLIGHT);
      seedHistory(key, [...INHERITED, ...ACTIVE]);
      const before = await entries(key);

      // Today's whole table, re-posted: the bootstrap the board is restored
      // from, which must still succeed with §S2's warning for what it inherits.
      const posted = await post(queuePath(key), {
        agentId: ORCH,
        entries: bootstrapTable([...INHERITED, ...ACTIVE]),
      });

      expect([200, 202]).toContain(posted.status);
      expect(posted.body.ok).toBe(true);
      expectTheNotice(posted.body, "a post carrying inherited release-less rows");

      // §S2's finding, UNCHANGED — same code, same crs, same ready-to-print
      // line. A notice that swallowed or rewrote it would hide the migration
      // list, which is the only thing that tells the board what is left to do.
      const inherited = raised(posted.body, INHERITED_CODE);
      expect(
        inherited,
        `the post raised ${JSON.stringify(codesOf(posted.body))} — §S2's finding must still be ` +
          `among them, exactly once`,
      ).toHaveLength(1);
      expect([...(inherited[0]!.crs ?? [])].sort()).toEqual(INHERITED.map((row) => row.cr).sort());
      for (const row of ACTIVE) expect(inherited[0]!.crs ?? []).not.toContain(row.cr);

      // BOTH, on ONE call — stated as the set, so a call that raised only one
      // of them fails here whichever one it dropped.
      expect([...codesOf(posted.body)].sort()).toEqual([DEPRECATION_CODE, INHERITED_CODE].sort());

      // THE ROUTE STILL WORKS: the write landed and rewrote nothing.
      expect(JSON.stringify(await entries(key))).toBe(JSON.stringify(before));
    },
  );

  test(
    "the notice is ADDITIVE beside defaulted-seq too: one call raises both, and the seq " +
      "finding still names exactly the row whose position this write invented",
    async () => {
      boot();
      const key = await seed("cru118-s3-additive-defaulted");
      await propose(key, IN_FLIGHT);
      // The two scales in one wave: a POSITIONAL seq the board carries (12, a
      // value outside wave 5's block) beside a row this post MOVES into wave 5
      // — a moved row holds no valid position in its new wave, so the write
      // slots it and names it (CR-CRU-095 §S3).
      seedHistory(key, [
        { cr: "CR-118D-POS", title: "a legacy positional row", wave: "5", release: IN_FLIGHT, seq: 12 },
        { cr: "CR-118D-MOVED", title: "a row whose wave moves", wave: "6", release: IN_FLIGHT },
      ]);

      const posted = await post(queuePath(key), {
        agentId: ORCH,
        entries: [
          { cr: "CR-118D-POS", title: "a legacy positional row", wave: "5", dependsOn: [] },
          { cr: "CR-118D-MOVED", title: "a row whose wave moves", wave: "5", dependsOn: [] },
        ],
      });

      expect([200, 202]).toContain(posted.status);
      // THE FIXTURE'S OWN PRECONDITION, asserted first and separately: without
      // a real defaulted-seq finding the co-occurrence below would be vacuous.
      const defaulted = raised(posted.body, DEFAULTED_SEQ_CODE);
      expect(
        defaulted,
        `this fixture exists to provoke a ${DEFAULTED_SEQ_CODE} finding and the post raised ` +
          `${JSON.stringify(codesOf(posted.body))} — the mixture of scales it builds has stopped ` +
          `earning one, which is a fixture fault, not a §S3 finding`,
      ).toHaveLength(1);
      expect(defaulted[0]!.crs).toEqual(["CR-118D-MOVED"]);

      expectTheNotice(posted.body, "a post that also defaulted a seq");
      expect([...codesOf(posted.body)].sort()).toEqual(
        [DEPRECATION_CODE, DEFAULTED_SEQ_CODE].sort(),
      );
    },
  );

  test(
    "the deprecation code joins the QueueWarning union as a SIXTH member, and the five shipped " +
      "codes are unchanged by order and by value",
    async () => {
      boot();
      const key = await seed("cru118-s3-union");
      await propose(key, IN_FLIGHT);
      seedHistory(key, ACTIVE);

      const union = queueWarningCodeUnion();
      // BY LENGTH — a sixth code, and only a sixth.
      expect(
        union,
        `src/v2.ts declares the QueueWarning codes as ${JSON.stringify(union)}`,
      ).toHaveLength(SHIPPED_QUEUE_WARNING_CODES.length + 1);
      // BY VALUE, in order — a rename or a reorder of the shipped five fails
      // here rather than silently reaching five rendering clients.
      expect(union.slice(0, SHIPPED_QUEUE_WARNING_CODES.length)).toEqual(
        SHIPPED_QUEUE_WARNING_CODES,
      );
      expect(union).toContain(DEPRECATION_CODE);
      expect(new Set(union).size).toBe(union.length);

      // …and the sixth member is the code the route actually EMITS. A union
      // member nothing raises would be vocabulary, not a finding.
      const posted = await post(queuePath(key), {
        agentId: ORCH,
        entries: bootstrapTable(ACTIVE),
      });
      expect(codesOf(posted.body)).toContain(DEPRECATION_CODE);
    },
  );
});
