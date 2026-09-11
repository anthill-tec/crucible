// CR-CRU-119 — a PRESERVED position is not a DEFAULTED one. C1 RED.
//
// ── The defect, in one sentence ────────────────────────────────────────────
//
// `defaultedSeqWarnings` (src/v2.ts) builds ONE hard-coded sentence — "seq was
// defaulted for <crs> …" — for a trigger that fires on TWO different facts
// (src/store.ts, `upsertQueueEntry`): `(moved || !scale) && <a sibling on the
// other scale>`.
//
//   a. `moved` — a new entry, or one whose wave changed. This write CHOSE the
//      position, so "seq was defaulted" is TRUE. §S1 keeps that sentence
//      verbatim, and the first test below pins it so this CR cannot regress
//      the case that was already right.
//   b. `!scale` alone — the entry KEPT the seq it already held (`const seq =
//      moved ? nextFreeSlot(…) : held!.seq`), which happens to sit outside its
//      wave's block while a sibling sits inside it. Nothing was defaulted, and
//      the sentence says one was. THAT is the whole defect, and it cost an
//      afternoon plus a wrongly-premised CR (see the spec's Context).
//
// ── Why this is a NEW file and not an edit of CR-CRU-095's ─────────────────
//
// The finding's existing coverage lives in tests/queue-defaulted-seq-scope.ts
// (the widening CR's own suite, shipped and not edited — the same ruling
// tests/queue-registration.test.ts recorded when it faced this choice), in
// tests/queue-default-into-wave-block.test.ts and in
// tests/queue-membership-one-rule.test.ts's parity table. Those three CONSUME
// the wording as a guard. This CR CHANGES what one of the two causes says and
// adds the machine discriminator, so it brings its own file, named for the
// behaviour (the CAUSE a seq finding names) and not for the CR, so it does not
// orphan when the CR merges.
//
// ── What is RED here, and what is a pin ────────────────────────────────────
//
// RED (fails today): §S1's AC2 (the preserved cause's sentence), AC3 (the
// machine discriminator — today both causes emit an IDENTICAL `code` and an
// identical `crs[]`, so nothing tells them apart), AC5 (the real-shape
// reproduction must raise the PRESERVED cause) and the Integration AC (both
// causes must reach all five clients in one shape — there is only one cause to
// reach them today).
//
// PIN (passes today, and must keep passing): §S1's AC1 and AC4, and the whole
// of §S2 — the trigger set, CR-CRU-095 §S2/AC11a's deliberate silence, and the
// seq preservation this CR was mistakenly filed against. §S3's non-mutation.
//
// ── The board this drives ──────────────────────────────────────────────────
//
// The real shape, reproduced SYNTHETICALLY: the live board's CR-CRU-090 holds
// wave 5 at seq 81 — outside wave 5's block, which runs (5000, 6000) —
// alongside CR-CRU-091 at 5019, inside it. Those two ids appear in this file
// in PROSE only: every fixture id below is invented, every store is a scratch
// db under mkdtempSync, and every server boots on an OS-assigned port. The
// live data/crucible.db and port 3849 are NEVER touched, so no test here can
// re-author wave 5 (§S3).
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";

// ── wire shapes (the queue suites', narrowed to what this file reads) ───────

interface QueueEntryWire {
  cr: string;
  wave: string;
  seq: number;
  title?: string | null;
  release?: string | null;
  [key: string]: unknown;
}

interface WarningWire {
  code: string;
  message: string;
  crs?: string[];
  [key: string]: unknown;
}

interface AnyBody {
  ok: boolean;
  error?: string;
  project?: { key: string };
  entry?: QueueEntryWire;
  entries?: QueueEntryWire[];
  warnings?: WarningWire[];
  [key: string]: unknown;
}

const ORCH = "orchestrator-1";

/** The release and wave the reproduction runs in — the live board's shape,
 *  with invented members. */
const RELEASE = "0.1.3";
const WAVE = 5;

/** OUTSIDE wave 5's block: `inWaveBlock` is `seq > 5000 && seq < 6000`, and a
 *  legacy positional value is the bulk post's old array index. */
const LEGACY_SEQ = 81;
/** INSIDE it — an authored wave-block position, the sibling that makes the
 *  board a two-scale one. */
const IN_BLOCK_SEQ = 5019;

/**
 * §S1/AC1 — TODAY'S SENTENCE, verbatim from src/v2.ts's
 * `defaultedSeqWarnings`. For the INVENTED cause it was always correct, so
 * this CR must not touch it. Pinned as a literal here rather than imported:
 * an import would track whatever GREEN writes and assert nothing.
 */
function defaultedSeqMessage(crs: string[]): string {
  return (
    `seq was defaulted for ${crs.join(", ")} while a sibling in the same wave or release carries ` +
    `one on a DIFFERENT SCALE — the two interleave in an order nobody authored; run ` +
    `wave-sequence --release <v> --wave <n> --crs <the whole ordered list> to author it`
  );
}

/**
 * Every `QueueWarning` code that is NOT the seq-mixture finding (src/v2.ts's
 * union, minus `defaulted-seq`). The seq finding is identified by EXCLUSION on
 * purpose: §S1 may keep one code or mint a second, and a test that named the
 * code it expects would decide that question for GREEN and would report a
 * renamed-but-still-raised finding as a NARROWING, which is exactly the
 * failure §S2 exists to catch.
 */
const NON_SEQ_CODES = new Set([
  "out-of-order",
  "cross-wave-backwards",
  "unsequenced-members",
  "inherited-release-less",
  "deprecated-route",
]);

function seqFindings(body: AnyBody): WarningWire[] {
  return (body.warnings ?? []).filter((warning) => !NON_SEQ_CODES.has(warning.code));
}

/** The ONE seq finding a write raised — bounded at one, so a runaway second
 *  finding fails here rather than being silently picked over. */
function seqFinding(body: AnyBody): WarningWire {
  const found = seqFindings(body);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/**
 * §S1/AC3 — what a MACHINE can read off one finding: its `code` plus every
 * structured field beside `crs[]`, with the prose dropped. Whichever
 * discriminator §S1 chooses — a second code, or a field beside `crs` — lands
 * in here, and a client that must regex an English sentence to tell the causes
 * apart would be deciding something (§S9).
 *
 * `crs` is excluded deliberately: it is IDENTICAL in both causes by
 * construction below (one cr, driven both ways on one board), so leaving it in
 * would let the signature differ for a reason that is not a discriminator at
 * all.
 */
function causeSignature(warning: WarningWire): string {
  const rest: Record<string, unknown> = { ...warning };
  delete rest.message;
  delete rest.crs;
  return JSON.stringify(
    Object.keys(rest)
      .sort()
      .map((key) => [key, rest[key]]),
  );
}

/** §S1/AC4 — the remedy, in a form that can be RUN: the verb plus the two
 *  flags that name the container. Today's sentence carries `--release <v>
 *  --wave <n>`; an interpolated pair satisfies the same shape. */
const RUNNABLE_REMEDY = /wave-sequence --release \S+ --wave \S+/;

/** A value a client can RENDER without decoding anything (§S9). */
function renderable(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((item) => typeof item === "string");
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

interface HeldRow {
  cr: string;
  wave: number;
  seq: number;
  release?: string;
}

const CLIENTS_DIR = join(import.meta.dir, "..", "clients");

// ───────────────────────────────────────────────────────────────────────────

describe("CR-CRU-119 — the seq finding names the cause it actually found", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "cru119-seq-cause-"));
    scratchDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
    return handle;
  }

  async function post(path: string, body: unknown): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  async function get(path: string): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`http://localhost:${handle!.server.port}${path}`);
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  /** A project, the ORCHESTRATOR the roadmap verbs admit, and the live release
   *  proposal `cr-plan` requires. */
  async function seed(name: string): Promise<string> {
    const created = await post("/api/v2/projects", { name });
    const key = created.body.project!.key;
    const registered = await post("/api/v2/agents/register", {
      projectKey: key,
      agentId: ORCH,
      role: "ORCHESTRATOR",
    });
    expect(registered.status).toBe(200);
    const proposed = await post(`/api/v2/projects/${key}/release-proposals`, {
      agentId: ORCH,
      label: RELEASE,
      targetAt: 1_788_220_800, // 2026-09-01T00:00:00Z — a plausible target; no AC is about the date
    });
    expect(proposed.status).toBe(200);
    return key;
  }

  /**
   * The rows the board ALREADY HOLDS, planted through the writer the bulk
   * route itself delegates to. A legacy positional seq cannot be AUTHORED
   * through any live verb any more (`wave-sequence` writes in-block, `cr-plan`
   * appends in-block) — it is history, and history is what this CR is about.
   */
  function hold(key: string, rows: HeldRow[]): void {
    handle!.store.replaceQueue(
      key,
      rows.map((row) => ({
        cr: row.cr,
        wave: String(row.wave),
        dependsOn: [],
        seq: row.seq,
        ...(row.release === undefined ? {} : { release: row.release }),
      })),
    );
  }

  async function plan(
    key: string,
    cr: string,
    wave: number,
    title: string,
  ): Promise<{ status: number; body: AnyBody }> {
    return post(`/api/v2/projects/${key}/queue/plan`, {
      agentId: ORCH,
      cr,
      release: RELEASE,
      wave,
      title,
    });
  }

  async function board(key: string): Promise<Map<string, { wave: string; seq: number; release?: string | null }>> {
    const res = await get(`/api/v2/projects/${key}/queue`);
    expect(res.status).toBe(200);
    return new Map(
      res.body.entries!.map((entry) => [
        entry.cr,
        { wave: entry.wave, seq: entry.seq, release: entry.release },
      ]),
    );
  }

  /**
   * §S1/AC3's fixture: ONE cr, ONE board, driven through BOTH causes, so
   * `crs[]` is identical across the two findings and cannot itself be the
   * discriminator.
   *
   *   1. INVENTED — `CR-DUAL` is not on the board, so this write CHOOSES its
   *      position: the next free slot in wave 5's block, beside the legacy
   *      positional sibling that makes the wave two-scaled.
   *   2. PRESERVED — the same cr, now HOLDING the legacy positional seq beside
   *      the in-block sibling, re-planned at the SAME wave. `moved` is false,
   *      the held seq survives untouched, and nothing is defaulted.
   */
  async function bothCauses(key: string): Promise<{
    invented: WarningWire;
    preserved: WarningWire;
  }> {
    hold(key, [
      { cr: "CR-LEGACY", wave: WAVE, seq: LEGACY_SEQ, release: RELEASE },
      { cr: "CR-INBLOCK", wave: WAVE, seq: IN_BLOCK_SEQ, release: RELEASE },
    ]);
    const invented = await plan(key, "CR-DUAL", WAVE, "a position this write invented");
    expect(invented.status).toBe(200);
    expect(invented.body.ok).toBe(true);
    // The write CHOSE this: the next slot in the block, never the held value.
    expect(invented.body.entry!.seq).toBe(IN_BLOCK_SEQ + 1);

    hold(key, [
      { cr: "CR-INBLOCK", wave: WAVE, seq: IN_BLOCK_SEQ, release: RELEASE },
      { cr: "CR-DUAL", wave: WAVE, seq: LEGACY_SEQ, release: RELEASE },
    ]);
    const preserved = await plan(key, "CR-DUAL", WAVE, "a position the entry already held");
    expect(preserved.status).toBe(200);
    expect(preserved.body.ok).toBe(true);
    // Nothing was chosen: the held value came back out unchanged.
    expect(preserved.body.entry!.seq).toBe(LEGACY_SEQ);

    return { invented: seqFinding(invented.body), preserved: seqFinding(preserved.body) };
  }

  // ── §S1 — the message tells the truth ────────────────────────────────────

  test(
    "AC1 (PIN) — a write that INVENTED a position still says a seq was defaulted, in today's " +
      "sentence to the byte: the cause this warning was always right about does not regress",
    async () => {
      boot();
      const key = await seed("ac1-invented");
      const { invented } = await bothCauses(key);

      expect(invented.message).toBe(defaultedSeqMessage(["CR-DUAL"]));
      expect(invented.crs).toEqual(["CR-DUAL"]);
    },
  );

  test(
    "AC2 — a write that PRESERVED an out-of-block position beside an in-block sibling raises a " +
      "finding that does NOT claim a seq was defaulted, and states the scale collision it found",
    async () => {
      boot();
      const key = await seed("ac2-preserved");
      const { preserved } = await bothCauses(key);

      // The whole defect: this write defaulted nothing, so the finding may not
      // say it did — in any wording, which is why the word itself is barred
      // rather than one sentence being excluded.
      expect(preserved.message).not.toMatch(/defaulted/i);
      expect(preserved.message).not.toBe(defaultedSeqMessage(["CR-DUAL"]));
      // And it still reports the fact that IS true: two scales, side by side.
      expect(preserved.message).toMatch(/scale/i);
      expect(preserved.message).toContain("CR-DUAL");
      expect(preserved.crs).toEqual(["CR-DUAL"]);
    },
  );

  test(
    "AC3 — the two causes are distinguishable by a MACHINE from the envelope alone: one cr on " +
      "one board, driven both ways, answers the same crs[] and a DIFFERENT structured signature",
    async () => {
      boot();
      const key = await seed("ac3-discriminator");
      const { invented, preserved } = await bothCauses(key);

      // The precondition that makes the comparison mean anything: the machine
      // half a client already reads is identical, so `crs` is not the answer.
      expect(preserved.crs).toEqual(invented.crs!);

      expect(causeSignature(preserved)).not.toBe(causeSignature(invented));
      // Structured, not prose: whatever carries the difference is a value a
      // client renders, never a sentence it has to parse.
      const offenders = [invented, preserved].flatMap((finding) =>
        Object.entries(finding)
          .filter(([key]) => key !== "message")
          .filter(([, value]) => !renderable(value))
          .map(([key]) => `${finding.code}.${key}`),
      );
      expect(offenders).toEqual([]);
    },
  );

  test(
    "AC4 (PIN) — BOTH findings still name wave-sequence as the remedy, with the release and " +
      "wave flags that make the command runnable",
    async () => {
      boot();
      const key = await seed("ac4-remedy");
      const { invented, preserved } = await bothCauses(key);

      expect(invented.message).toMatch(RUNNABLE_REMEDY);
      expect(preserved.message).toMatch(RUNNABLE_REMEDY);
    },
  );

  test(
    "AC5 — the REAL SHAPE: an entry holding a legacy positional 81 in wave 5 beside a sibling " +
      "authored at 5019, re-planned at the SAME wave, raises the PRESERVED cause and not the " +
      "defaulted one — the write the orchestrator misread on the live board",
    async () => {
      boot();
      const key = await seed("ac5-real-shape");
      hold(key, [
        { cr: "CR-HELD-POSITIONAL", wave: WAVE, seq: LEGACY_SEQ, release: RELEASE },
        { cr: "CR-AUTHORED-SIBLING", wave: WAVE, seq: IN_BLOCK_SEQ, release: RELEASE },
      ]);

      const replanned = await plan(key, "CR-HELD-POSITIONAL", WAVE, "backfilled into the release");
      expect(replanned.status).toBe(200);
      expect(replanned.body.ok).toBe(true);

      const finding = seqFinding(replanned.body);
      expect(finding.crs).toEqual(["CR-HELD-POSITIONAL"]);
      expect(finding.message).not.toMatch(/defaulted/i);

      // "and not the defaulted one", structurally: the same board's INVENTED
      // cause is raised beside it and the two signatures must differ.
      const inventedOnTheSameBoard = await plan(key, "CR-NEW-ROW", WAVE, "a new row");
      expect(inventedOnTheSameBoard.status).toBe(200);
      const defaulted = seqFinding(inventedOnTheSameBoard.body);
      expect(defaulted.message).toBe(defaultedSeqMessage(["CR-NEW-ROW"]));
      expect(causeSignature(finding)).not.toBe(causeSignature(defaulted));

      // Warn-and-write, and the position is the one it already held.
      expect(replanned.body.entry!.seq).toBe(LEGACY_SEQ);
      expect(replanned.body.entry!.release).toBe(RELEASE);
    },
  );

  // ── §S2 — the trigger set does not move ──────────────────────────────────

  test(
    "AC6 (PIN) — every input that raises a seq finding today still raises one: the trigger's " +
      "four cases as a TABLE — a new entry, a wave move, a preserved out-of-block seq beside an " +
      "in-block sibling, and a release-axis sibling — so a narrowing fails here",
    async () => {
      boot();
      const cases: Array<{ name: string; rows: HeldRow[]; cr: string; wave: number }> = [
        {
          name: "a new entry — no held row at all, so the position is invented",
          rows: [{ cr: "CR-LEGACY", wave: WAVE, seq: LEGACY_SEQ, release: RELEASE }],
          cr: "CR-NEW",
          wave: WAVE,
        },
        {
          name: "a wave move — the entry is re-slotted in its new wave's block",
          rows: [
            { cr: "CR-LEGACY", wave: WAVE, seq: LEGACY_SEQ, release: RELEASE },
            { cr: "CR-MOVER", wave: 6, seq: 6001, release: RELEASE },
          ],
          cr: "CR-MOVER",
          wave: WAVE,
        },
        {
          name: "a PRESERVED out-of-block seq beside an in-block sibling (the wave axis)",
          rows: [
            { cr: "CR-INBLOCK", wave: WAVE, seq: IN_BLOCK_SEQ, release: RELEASE },
            { cr: "CR-HELD", wave: WAVE, seq: LEGACY_SEQ, release: RELEASE },
          ],
          cr: "CR-HELD",
          wave: WAVE,
        },
        {
          name: "a sibling in ANOTHER wave of the same release (the release axis)",
          rows: [
            { cr: "CR-OTHER-WAVE", wave: WAVE, seq: 5001, release: RELEASE },
            { cr: "CR-DEFERRED", wave: 6, seq: 2, release: RELEASE },
          ],
          cr: "CR-DEFERRED",
          wave: 6,
        },
      ];

      const measured: Array<{ name: string; findings: number; named: string[][] }> = [];
      for (const scenario of cases) {
        const key = await seed(`ac6-${scenario.cr.toLowerCase()}-${cases.indexOf(scenario)}`);
        hold(key, scenario.rows);
        const written = await plan(key, scenario.cr, scenario.wave, "a declaration");
        expect(written.status).toBe(200);
        const raised = seqFindings(written.body);
        measured.push({
          name: scenario.name,
          findings: raised.length,
          named: raised.map((warning) => warning.crs ?? []),
        });
      }

      // Exactly one finding per case, naming exactly the row that was written —
      // bounded on both sides, so neither a dropped case nor a runaway one
      // passes.
      expect(measured).toEqual(
        cases.map((scenario) => ({
          name: scenario.name,
          findings: 1,
          named: [[scenario.cr]],
        })),
      );
    },
  );

  test(
    "AC7 (PIN) — CR-CRU-095 §S2/AC11a's deliberate silence stays silent: a same-wave re-plan of " +
      "an entry whose seq is IN its wave's block raises NOTHING beside a positional sibling, and " +
      "its seq is unchanged — that mixture pre-exists and the positional row's own write named it",
    async () => {
      boot();
      const key = await seed("ac7-silent");
      hold(key, [
        { cr: "CR-INBLOCK", wave: WAVE, seq: IN_BLOCK_SEQ, release: RELEASE },
        { cr: "CR-POSITIONAL", wave: WAVE, seq: LEGACY_SEQ, release: RELEASE },
      ]);

      const replanned = await plan(key, "CR-INBLOCK", WAVE, "a retitle that changes nothing else");
      expect(replanned.status).toBe(200);
      expect(replanned.body.ok).toBe(true);
      // NOT vacuous: the write really happened (silence on a no-op write would
      // prove nothing), and it still said nothing.
      expect(replanned.body.entry!.title).toBe("a retitle that changes nothing else");
      expect(replanned.body.warnings).toEqual([]);
      expect(replanned.body.entry!.seq).toBe(IN_BLOCK_SEQ);
    },
  );

  test(
    "AC8 (PIN) — upsertQueueEntry's seq resolution is untouched: a same-wave re-plan PRESERVES " +
      "the held seq, read back off the board — the regression pin for the 'cr-plan clobbers " +
      "positions on re-plan' belief this CR was mistakenly filed against",
    async () => {
      boot();
      const key = await seed("ac8-preservation");
      hold(key, [
        { cr: "CR-HELD-POSITIONAL", wave: WAVE, seq: LEGACY_SEQ, release: RELEASE },
        { cr: "CR-AUTHORED-SIBLING", wave: WAVE, seq: IN_BLOCK_SEQ, release: RELEASE },
      ]);

      const replanned = await plan(key, "CR-HELD-POSITIONAL", WAVE, "re-planned at the same wave");
      expect(replanned.status).toBe(200);

      const after = await board(key);
      expect(after.get("CR-HELD-POSITIONAL")).toEqual({
        wave: String(WAVE),
        seq: LEGACY_SEQ,
        release: RELEASE,
      });
      // The sibling is not renumbered either: a re-plan that stays in its wave
      // moves nothing at all.
      expect(after.get("CR-AUTHORED-SIBLING")!.seq).toBe(IN_BLOCK_SEQ);
    },
  );

  // ── §S3 — the record ─────────────────────────────────────────────────────

  test(
    "AC9 (PIN) — no criterion here re-authors a wave: the whole board's positions are " +
      "byte-identical across the write that raises the PRESERVED finding, and the row holding " +
      "the legacy 81 still holds wave 5, seq 81 and its release afterwards",
    async () => {
      boot();
      const key = await seed("ac9-no-reauthoring");
      hold(key, [
        { cr: "CR-HELD-POSITIONAL", wave: WAVE, seq: LEGACY_SEQ, release: RELEASE },
        { cr: "CR-AUTHORED-SIBLING", wave: WAVE, seq: IN_BLOCK_SEQ, release: RELEASE },
        { cr: "CR-NEXT-WAVE", wave: 6, seq: 6001, release: RELEASE },
      ]);
      const before = await board(key);

      const replanned = await plan(key, "CR-HELD-POSITIONAL", WAVE, "the backfill's one row");
      expect(replanned.status).toBe(200);
      expect(seqFindings(replanned.body)).toHaveLength(1);

      const after = await board(key);
      expect([...after.entries()]).toEqual([...before.entries()]);
      expect(after.get("CR-HELD-POSITIONAL")).toEqual({
        wave: String(WAVE),
        seq: LEGACY_SEQ,
        release: RELEASE,
      });
    },
  );

  // ── Integration — the fleet renders the finding and decides nothing ──────

  test(
    "INTEGRATION — the second cause reaches all FIVE clients unchanged in shape: the client " +
      "count is five, every one of them forwards a cr-plan finding through the shared module " +
      "without naming a code, and both causes carry only values a client can render",
    async () => {
      const clients = readdirSync(CLIENTS_DIR)
        .filter((file) => file.endsWith("-crucible.py"))
        .sort();
      // The count itself, asserted: a sixth stack client (or a deleted one)
      // must fail here rather than quietly narrowing the parity claim below.
      expect(clients).toHaveLength(5);
      expect(clients).toEqual([
        "arduino-crucible.py",
        "bun-crucible.py",
        "mvn-crucible.py",
        "python-crucible.py",
        "rust-crucible.py",
      ]);

      const decidingClients: string[] = [];
      for (const client of clients) {
        const source = readFileSync(join(CLIENTS_DIR, client), "utf8");
        // Per client: `cr-plan` is delegated to the ONE shared implementation,
        // which forwards `resp.get("warnings") or []` verbatim.
        if (!source.includes("_axi().cmd_cr_plan(")) decidingClients.push(`${client}: own cr-plan`);
        // And no client knows this finding by name — so a second cause needs
        // it to learn nothing (§S9).
        if (source.includes("defaulted-seq")) decidingClients.push(`${client}: matches the code`);
        if (source.includes("seq was defaulted")) {
          decidingClients.push(`${client}: matches the prose`);
        }
      }
      expect(decidingClients).toEqual([]);
      expect(readFileSync(join(CLIENTS_DIR, "_crucible_axi.py"), "utf8")).toContain(
        'resp.get("warnings") or []',
      );

      boot();
      const key = await seed("integration-fleet-shape");
      const { invented, preserved } = await bothCauses(key);
      // THE FIXTURE'S OWN PRECONDITION, asserted first: with one cause there is
      // no second finding to carry to the fleet, and the shape parity below
      // would be one object compared with itself.
      expect(causeSignature(preserved)).not.toBe(causeSignature(invented));

      const unrenderable: string[] = [];
      for (const [cause, finding] of [
        ["invented", invented],
        ["preserved", preserved],
      ] as const) {
        // The SHAPE five clients already render: a printable line, a code, and
        // the machine-readable crs beside it.
        expect(typeof finding.code).toBe("string");
        expect(typeof finding.message).toBe("string");
        expect(finding.crs).toEqual(["CR-DUAL"]);
        for (const [field, value] of Object.entries(finding)) {
          if (!renderable(value)) unrenderable.push(`${cause}.${field}`);
        }
      }
      expect(unrenderable).toEqual([]);
    },
  );
});
