// CR-CRU-104 §S1/§S2 — release membership has ONE rule, reached from two
// entry points. C1 RED.
//
// THE APPROVED DESIGN. `.lavish/crucible-workflow-flowchart.html` §12's call
// chain is PER-CR: `register` → `release-propose` → `cr-plan` →
// `wave-sequence` → … There is no bulk queue post in it. `cr-plan --release`
// is the declaring verb; the bulk `POST …/queue` is the MIGRATION door, kept
// because it moves an existing README-table roadmap onto the board. A
// migration that stores membership `cr-plan` would have REFUSED is a migration
// that corrupts the board — which is this CR's whole subject.
//
// ── WHAT IS BROKEN TODAY (measured 2026-09-04, fresh project, no proposal) ──
//
//   BULK POST   status: 200
//   BULK POST   stored: {"cr":"CR-GHOST",…,"seq":5001,"release":"0.9.0"}
//   CR-PLAN     status: 404
//   CR-PLAN     error : "release 0.9.0 has no live proposal — it is not a
//                        plannable target"
//
// `requireLiveProposal` (src/v2.ts) is called by `handleCrPlan` and
// `handleWaveSequence` and NEVER by `handleQueuePost`, so the same
// orchestrator, on the same board, can store membership in a release nobody
// proposed through one door and be refused through the other. CR-CRU-091 §S8's
// rule — a CR may only target a release somebody proposed — holds on one route
// and not the other.
//
// ── The seam GREEN must expose ─────────────────────────────────────────────
//
// ONE decision function both handlers pass through, carrying the live-proposal
// requirement, track normalisation and its refusal, and the slot/scale rules
// that decide `seq` and whether a `defaulted-seq` warning is earned. Each route
// keeps its own SHAPE — the bulk post refuses by field name AND index, the
// per-CR verbs by field. What must not differ is the ANSWER.
//
// §S2 — the parity table below drives the SAME declaration through BOTH wire
// routes on the same board and requires the same answer. CR-CRU-099's
// convergence probe lived in /tmp and was thrown away; this one is in the
// suite, so adding an invariant to one path and not the other FAILS (AC4).
//
// Every server here is booted on an OS-assigned port against an mkdtempSync
// scratch db. The live data/crucible.db and port 3849 are never touched.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";

// ── wire shapes this suite PINS ────────────────────────────────────────────

interface QueueEntryWire {
  cr: string;
  title?: string;
  wave: string;
  dependsOn: string[];
  status: string;
  seq: number;
  release?: string;
  track?: string;
  lifecycle?: { state: string; by?: string; reason?: string; at: number };
  [key: string]: unknown;
}

interface WarningWire {
  code: string;
  message: string;
  crs?: string[];
  containers?: string[];
  [key: string]: unknown;
}

interface AnyBody {
  ok: boolean;
  error?: string;
  help?: string[];
  converged?: boolean;
  project?: { key: string };
  entry?: QueueEntryWire;
  entries?: QueueEntryWire[];
  warnings?: WarningWire[];
  unknownDependencies?: string[];
  [key: string]: unknown;
}

const ORCH = "orchestrator-1";

/** CR-CRU-091 §S8's refusal sentence, as `cr-plan` has answered it since that
 *  CR shipped. Pinned ONCE here: AC5 requires the second route to answer this
 *  meaning rather than a third wording of it. */
function unproposedSentence(release: string): string {
  return `release ${release} has no live proposal — it is not a plannable target`;
}

/** `roadmapHints.unproposedRelease` (src/hints.ts) — the help[] that names what
 *  to do instead, which AC1 requires the bulk refusal to carry too. */
function unproposedHelp(release: string): string[] {
  return [
    `release-propose --label ${release} — the super container must exist before a CR can target it`,
    `GET /api/v2/projects/<key>/release-proposals — the live proposals a CR can be planned into`,
    `a release that has already SHIPPED is settled history and is no longer a plannable target for ${release}`,
  ];
}

/** CR-CRU-091 §S8's TYPE refusal, as `cr-plan` has answered it since that CR
 *  shipped: one sentence for a missing, non-string or empty `release`. Pinned
 *  ONCE here because AC3/AC5 require the migration door — which coerced a
 *  non-string with `String()` and stored the result — to answer this meaning
 *  in its own field+index shape rather than a third wording of it. */
const RELEASE_REQUIRED = "`release` is required — the release this cr targets";

/** CR-CRU-099 §S1/AC4a — the lane rule's tail, shared verbatim by the bulk
 *  post's indexed refusal, `wave-sequence`'s field refusal and
 *  `replaceQueue`'s own guard. The PREFIXES differ (§S1: each route keeps its
 *  own shape); this sentence is the rule, and it may not fork. */
const LANE_RULE =
  `tracks are numbered lanes (wire format track-<n>), so declare e.g. 2, track-2 or "Track 2"`;

/** CR-CRU-091 §S2/AC23 as widened by CR-CRU-095 §S2 — the ONE `defaulted-seq`
 *  wording, so the parity table compares the shipped message and not a
 *  paraphrase. */
function defaultedSeqMessage(crs: string[]): string {
  return (
    `seq was defaulted for ${crs.join(", ")} while a sibling in the same wave or release carries ` +
    `one on a DIFFERENT SCALE — the two interleave in an order nobody authored; run ` +
    `wave-sequence --release <v> --wave <n> --crs <the whole ordered list> to author it`
  );
}

describe("CR-CRU-104 §S1/§S2 — one membership rule, two entry points", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "cru104-membership-"));
    scratchDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
    return handle;
  }

  function base(): string {
    return `http://localhost:${handle!.server.port}`;
  }

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${base()}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  }

  async function post(path: string, body: unknown): Promise<{ status: number; body: AnyBody }> {
    const res = await send("POST", path, body);
    // The server's own JSON envelope; `AnyBody` is this suite's boundary type.
    const parsed: AnyBody = await res.json();
    return { status: res.status, body: parsed };
  }

  async function get(path: string): Promise<{ status: number; body: AnyBody }> {
    const res = await send("GET", path);
    const parsed: AnyBody = await res.json();
    return { status: res.status, body: parsed };
  }

  function queuePath(key: string): string {
    return `/api/v2/projects/${key}/queue`;
  }

  function planPath(key: string): string {
    return `/api/v2/projects/${key}/queue/plan`;
  }

  function sequencePath(key: string): string {
    return `/api/v2/projects/${key}/queue/sequence`;
  }

  /** A project with the orchestrator every declaring route requires
   *  (CR-CRU-099 §S3/AC9, CR-CRU-091 §S3) and NO release proposal — the
   *  configuration AC1 is about. */
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

  async function propose(key: string, label: string): Promise<void> {
    const res = await post(`/api/v2/projects/${key}/release-proposals`, { agentId: ORCH, label });
    expect(res.status).toBe(200);
  }

  async function bulk(
    key: string,
    entries: Array<Record<string, unknown>>,
    agentId: string | undefined = ORCH,
  ): Promise<{ status: number; body: AnyBody }> {
    return post(queuePath(key), agentId === undefined ? { entries } : { agentId, entries });
  }

  async function entries(key: string): Promise<QueueEntryWire[]> {
    const res = await get(queuePath(key));
    expect(res.status).toBe(200);
    return res.body.entries!;
  }

  async function crs(key: string): Promise<string[]> {
    return (await entries(key)).map((entry) => entry.cr);
  }

  // ── AC1/AC2/AC13 — the gap, closed, and the two things that must not move ─

  describe("AC1 — a bulk post declaring an unproposed release is REFUSED", () => {
    test(
      "the bulk post answers CR-CRU-091 §S8's meaning — not a plannable target, plus the help[] " +
        "naming release-propose — with the 404 `cr-plan` already answers, and the full replace it " +
        "would have run never happens",
      async () => {
        boot();
        const key = await seed("cru104-ac1-refused");
        // The queue a refusal must leave EXACTLY as it stands: this route is a
        // FULL REPLACE, so a refusal that ran the write is visible here as a
        // lost row (CR-CRU-099 AC4a's technique).
        expect([200, 202]).toContain(
          (await bulk(key, [{ cr: "CR-104-HELD", wave: "5", dependsOn: [] }])).status,
        );

        const res = await bulk(key, [
          { cr: "CR-104-HELD", wave: "5", dependsOn: [] },
          { cr: "CR-104-GHOST", title: "membership in a release nobody proposed", wave: "5", dependsOn: [], release: "0.9.0" },
        ]);
        expect(res.status).toBe(404);
        expect(res.body.ok).toBe(false);
        // The route's OWN shape — the offending entry's INDEX — carrying the
        // rule's ONE sentence, so the two doors do not answer this case in two
        // wordings (AC5).
        expect(res.body.error).toBe(`entry at index 1: ${unproposedSentence("0.9.0")}`);
        expect(res.body.help).toEqual(unproposedHelp("0.9.0"));
        // NOTHING WRITTEN: the held row is still the whole queue, and the
        // ghost never landed.
        expect(await crs(key)).toEqual(["CR-104-HELD"]);
      },
    );

    test(
      "NON-VACUITY — the identical post lands the moment the release holds a live proposal, so the " +
        "refusal is a verdict on the PROPOSAL and not a blanket rejection of a declared release",
      async () => {
        boot();
        const key = await seed("cru104-ac1-nonvacuous");
        const declaration = [
          { cr: "CR-104-REAL", title: "a real target", wave: "5", dependsOn: [], release: "0.9.0" },
        ];
        expect((await bulk(key, declaration)).status).toBe(404);

        await propose(key, "0.9.0");
        const accepted = await bulk(key, declaration);
        expect([200, 202]).toContain(accepted.status);
        expect(accepted.body.entries!.find((e) => e.cr === "CR-104-REAL")!.release).toBe("0.9.0");
      },
    );

    test(
      "a SHIPPED label is refused the same way — `requireLiveProposal`'s second half, now reached " +
        "from the migration door too: a proposal a real release consumed is settled history",
      async () => {
        boot();
        const key = await seed("cru104-ac1-consumed");
        await propose(key, "0.1.0");
        // The release SHIPS — a `release` milestone, which consumes the
        // proposal it fulfils in the same transaction (CR-CRU-091 §S1).
        const shipped = await post("/api/v2/milestones", {
          projectKey: key,
          agentId: ORCH,
          type: "release",
          label: "0.1.0",
          crs: [],
        });
        expect([200, 201]).toContain(shipped.status);
        const proposals = await get(`/api/v2/projects/${key}/release-proposals`);
        expect(proposals.body.proposals).toEqual([]);

        const res = await bulk(key, [
          { cr: "CR-104-REOPEN", wave: "5", dependsOn: [], release: "0.1.0" },
        ]);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe(`entry at index 0: ${unproposedSentence("0.1.0")}`);
        expect(await crs(key)).toEqual([]);
      },
    );
  });

  describe("AC2/AC13 — what the gate must NOT touch", () => {
    test(
      "AC2 a declared release that DOES hold a live proposal is accepted exactly as today: the row " +
        "stores it, the fresh import warns about nothing, and `converged` semantics are untouched",
      async () => {
        boot();
        const key = await seed("cru104-ac2-proposed");
        await propose(key, "0.2.0");
        const res = await bulk(key, [
          { cr: "CR-104-A", title: "first", wave: "5", dependsOn: [], release: "0.2.0" },
          { cr: "CR-104-B", title: "second", wave: "5", dependsOn: [], release: "0.2.0" },
        ]);
        expect([200, 202]).toContain(res.status);
        expect(res.body.warnings ?? []).toEqual([]);
        const board = await entries(key);
        expect(board.map((e) => e.release)).toEqual(["0.2.0", "0.2.0"]);
        expect(board.map((e) => e.seq)).toEqual([5001, 5002]);
      },
    );

    test(
      "AC13 a post declaring NO release stays open to ANY caller — no identity field of any kind — " +
        "because identity is demanded only of a caller that DECLARES membership " +
        "(CR-CRU-099 §S3/AC9, field-conditional). The migration door's bootstrap half is unguarded",
      async () => {
        boot();
        const key = await seed("cru104-ac13-open");
        const res = await bulk(
          key,
          [
            { cr: "CR-104-QF1", title: "queue file row", wave: "5", dependsOn: [] },
            { cr: "CR-104-QF2", title: "another row", wave: "6", dependsOn: ["CR-104-QF1"] },
          ],
          undefined,
        );
        expect([200, 202]).toContain(res.status);
        const board = await entries(key);
        expect(board.map((e) => e.cr)).toEqual(["CR-104-QF1", "CR-104-QF2"]);
        // A row declaring no membership carries none — the open path
        // fabricates nothing, and the gate demanded nothing.
        for (const entry of board) {
          expect("release" in entry).toBe(false);
        }
      },
    );

    test(
      "AC13 a re-post that declares no release for a row already holding one is NOT re-gated: " +
        "carry-forward preserves the membership `cr-plan` vetted when it was declared, and the " +
        "gate keys on the DECLARATION, so re-importing a README that omits the release column works",
      async () => {
        boot();
        const key = await seed("cru104-ac13-carry-forward");
        await propose(key, "0.2.0");
        expect([200, 202]).toContain(
          (await bulk(key, [{ cr: "CR-104-CF", wave: "5", dependsOn: [], release: "0.2.0" }]))
            .status,
        );
        // The label SHIPS, consuming its proposal, so no live proposal
        // remains — yet a re-post that declares no release must still land:
        // nothing new is being declared.
        const shipped = await post("/api/v2/milestones", {
          projectKey: key,
          agentId: ORCH,
          type: "release",
          label: "0.2.0",
          crs: ["CR-104-CF"],
        });
        expect([200, 201]).toContain(shipped.status);
        const res = await bulk(key, [{ cr: "CR-104-CF", wave: "5", dependsOn: [] }]);
        expect([200, 202]).toContain(res.status);
        expect((await entries(key))[0]!.release).toBe("0.2.0");
      },
    );
  });

  // ── §S2/AC3 — the answer is PROVEN identical, not asserted identical ─────
  //
  // A declaration is driven through BOTH wire routes on two boards built the
  // same way, and the ANSWERS are compared as one object. What is compared:
  // the status, the refusal's MEANING (each route's own positional prefix
  // stripped — that prefix is the shape §S1 lets each door keep), the help[],
  // every warning, whether the door reported writing nothing, the
  // `unknownDependencies` it published, the row the write left, and EVERY row
  // of the board after it with its `seq`, `release` and `track` — not just
  // which crs survived, which is all this table compared until AC11: a door
  // that answered identically about the row under test while re-slotting or
  // re-labelling its neighbours passed.
  //
  // What it still does NOT compare, and why: the response BODY beyond those
  // fields (each door publishes its own shape — the bulk post returns the
  // whole `entries` list, `cr-plan` the single `entry`, and comparing the
  // envelopes would compare shapes §S1 lets them keep), the `status` string
  // and `dependsOn` of each row (no membership rule writes either), and
  // `lifecycle`, which only the bulk door can declare.
  //
  // Track and lifecycle are NOT in this table: `cr-plan` cannot express them,
  // so their parity is between the bulk post and `wave-sequence` and is
  // asserted in its own test below.

  /** One membership declaration, in the terms BOTH routes accept.
   *
   *  `release` is `unknown` rather than `string` because the TYPE of a
   *  declared label is itself a parity question: the migration door coerced
   *  with `String()` what `cr-plan` type-refuses, and a table typed `string`
   *  cannot express the input that measured the divergence. */
  interface Declaration {
    cr: string;
    release: unknown;
    wave: string;
    title: string;
  }

  /** One row of the board, as the comparison reads it: the cr AND the three
   *  values a declaration writes. The board used to be compared as a list of
   *  crs, which left every OTHER row's `seq`, `release` and `track` outside
   *  the comparison — a door that answered identically about the row under
   *  test while re-slotting or re-labelling its neighbours would have passed. */
  function rowOf(entry: QueueEntryWire): string {
    return `${entry.cr}|${entry.seq}|${entry.release ?? ""}|${entry.track ?? ""}`;
  }

  /** The comparable half of a route's reply, plus what it left on the board. */
  interface Answer {
    status: number;
    meaning: string | undefined;
    help: string[] | undefined;
    warnings: string[];
    /** The no-op fact: did the door report writing nothing? */
    converged: boolean;
    unknownDependencies: string[];
    stored: { release: string | null; seq: number; wave: string; title: string | null } | undefined;
    board: string[];
  }

  async function answerOf(
    key: string,
    cr: string,
    res: { status: number; body: AnyBody },
  ): Promise<Answer> {
    const board = await entries(key);
    const row = board.find((entry) => entry.cr === cr);
    return {
      status: res.status,
      // The bulk post's own shape is the offending `entries[]` INDEX; it is
      // stripped so the SENTENCE is what gets compared — one rule, one
      // wording, two shapes (§S1).
      meaning: res.body.error?.replace(/^entry at index \d+: /, ""),
      help: res.body.help,
      warnings: (res.body.warnings ?? [])
        .map((w) => `${w.code}|${w.message}|${(w.crs ?? []).join(",")}`)
        .sort(),
      // Compared as the BOOLEAN FACT, not as the field: `cr-plan` publishes
      // `converged` and the full-replace door has no per-CR convergence to
      // publish, so an absent one reads as "this door wrote". A scenario that
      // re-declared IDENTICAL values would part the two here, and that is the
      // upsert-vs-full-replace difference §S1 lets each door keep, not a
      // membership rule forking.
      converged: res.body.converged === true,
      unknownDependencies: [...(res.body.unknownDependencies ?? [])].sort(),
      stored:
        row === undefined
          ? undefined
          : {
              release: row.release ?? null,
              seq: row.seq,
              wave: row.wave,
              title: row.title ?? null,
            },
      board: board.map(rowOf).sort(),
    };
  }

  /** The MIGRATION door. This route declares by FULL REPLACE, so "the same
   *  declaration" is the board as it stands plus the new row — seq and release
   *  left to carry forward, which is what a README re-import does. */
  async function viaBulk(key: string, declaration: Declaration): Promise<Answer> {
    const held = (await entries(key))
      .filter((entry) => entry.cr !== declaration.cr)
      .map((entry) => ({
        cr: entry.cr,
        ...(entry.title !== undefined ? { title: entry.title } : {}),
        wave: entry.wave,
        dependsOn: entry.dependsOn,
        ...(entry.release !== undefined ? { release: entry.release } : {}),
      }));
    const res = await bulk(key, [
      ...held,
      {
        cr: declaration.cr,
        title: declaration.title,
        wave: declaration.wave,
        dependsOn: [],
        release: declaration.release,
      },
    ]);
    return answerOf(key, declaration.cr, res);
  }

  /** The approved per-CR verb. */
  async function viaCrPlan(key: string, declaration: Declaration): Promise<Answer> {
    const res = await post(planPath(key), {
      agentId: ORCH,
      cr: declaration.cr,
      release: declaration.release,
      wave: declaration.wave,
      title: declaration.title,
    });
    return answerOf(key, declaration.cr, res);
  }

  const ROUTES: Array<{ name: string; drive: (key: string, d: Declaration) => Promise<Answer> }> = [
    { name: "bulk POST …/queue", drive: viaBulk },
    { name: "cr-plan", drive: viaCrPlan },
  ];

  interface Scenario {
    name: string;
    /** Builds the board both routes are driven against. */
    board: (key: string) => Promise<void>;
    declaration: Declaration;
    /** What the ANSWER must be — asserted once, then required of every route. */
    expected: Answer;
  }

  const SCENARIOS: Scenario[] = [
    {
      name: "AC1/AC3 — a release nobody proposed: REFUSED by both, nothing written",
      board: async (key) => {
        expect([200, 202]).toContain(
          (await bulk(key, [{ cr: "CR-104-HELD", wave: "5", dependsOn: [] }])).status,
        );
      },
      declaration: { cr: "CR-104-NEW", release: "0.9.0", wave: "5", title: "into thin air" },
      expected: {
        status: 404,
        meaning: unproposedSentence("0.9.0"),
        help: unproposedHelp("0.9.0"),
        warnings: [],
        converged: false,
        unknownDependencies: [],
        stored: undefined,
        board: ["CR-104-HELD|5001||"],
      },
    },
    {
      name:
        "AC3/AC5 — a NON-STRING release: REFUSED 400 by both with `cr-plan`'s own sentence, and " +
        "nothing written. The migration door coerced it with `String()` and stored the label the " +
        "coercion produced — membership the per-CR verb type-refuses, which is this CR's thesis " +
        "in one line. The board even HOLDS a proposal for the coerced label, so the only thing " +
        "wrong with the declaration is its type",
      board: async (key) => {
        await propose(key, "2");
        expect([200, 202]).toContain(
          (await bulk(key, [{ cr: "CR-104-HELD", wave: "5", dependsOn: [] }])).status,
        );
      },
      declaration: { cr: "CR-104-NEW", release: 2, wave: "5", title: "a coerced label" },
      expected: {
        status: 400,
        meaning: RELEASE_REQUIRED,
        help: undefined,
        warnings: [],
        converged: false,
        unknownDependencies: [],
        stored: undefined,
        board: ["CR-104-HELD|5001||"],
      },
    },
    {
      name:
        "AC3/AC5 — an EMPTY release is the same refusal, not a 404 about a proposal nobody could " +
        "hold: `cr-plan` refuses the empty string by type, and the migration door used to carry it " +
        "as far as the live-proposal gate and answer 404 `release  has no live proposal`",
      board: async (key) => {
        expect([200, 202]).toContain(
          (await bulk(key, [{ cr: "CR-104-HELD", wave: "5", dependsOn: [] }])).status,
        );
      },
      declaration: { cr: "CR-104-NEW", release: "", wave: "5", title: "no label at all" },
      expected: {
        status: 400,
        meaning: RELEASE_REQUIRED,
        help: undefined,
        warnings: [],
        converged: false,
        unknownDependencies: [],
        stored: undefined,
        board: ["CR-104-HELD|5001||"],
      },
    },
    {
      name: "AC2/AC3 — a proposed release: ACCEPTED by both, same row, same silence",
      board: async (key) => {
        await propose(key, "0.2.0");
      },
      declaration: { cr: "CR-104-NEW", release: "0.2.0", wave: "5", title: "a real target" },
      expected: {
        status: 200,
        meaning: undefined,
        help: undefined,
        warnings: [],
        converged: false,
        unknownDependencies: [],
        stored: { release: "0.2.0", seq: 5001, wave: "5", title: "a real target" },
        board: ["CR-104-NEW|5001|0.2.0|"],
      },
    },
    {
      name:
        "AC3 — the RELEASE axis earns a `defaulted-seq` warning identically: another wave of the " +
        "SAME release holds a positional seq, so both doors name the new row, in the same code and " +
        "the same wording (the convergence CR-CRU-099's throwaway probe measured)",
      board: async (key) => {
        await propose(key, "0.2.0");
        expect([200, 202]).toContain(
          (
            await bulk(key, [
              { cr: "CR-104-AU", wave: "5", dependsOn: [], release: "0.2.0", seq: 5001 },
              { cr: "CR-104-W6", wave: "6", dependsOn: [], release: "0.2.0", seq: 2 },
            ])
          ).status,
        );
      },
      declaration: { cr: "CR-104-NEW", release: "0.2.0", wave: "5", title: "unauthored position" },
      expected: {
        status: 200,
        meaning: undefined,
        help: undefined,
        warnings: [`defaulted-seq|${defaultedSeqMessage(["CR-104-NEW"])}|CR-104-NEW`],
        converged: false,
        unknownDependencies: [],
        stored: { release: "0.2.0", seq: 5002, wave: "5", title: "unauthored position" },
        board: ["CR-104-AU|5001|0.2.0|", "CR-104-NEW|5002|0.2.0|", "CR-104-W6|2|0.2.0|"],
      },
    },
    {
      name:
        "AC3 — one scale is SILENT identically: both waves of the release authored in their own " +
        "blocks, so neither door warns about the row it defaults beside them",
      board: async (key) => {
        await propose(key, "0.2.0");
        expect([200, 202]).toContain(
          (
            await bulk(key, [
              { cr: "CR-104-S5", wave: "5", dependsOn: [], release: "0.2.0", seq: 5001 },
              { cr: "CR-104-S6", wave: "6", dependsOn: [], release: "0.2.0", seq: 6001 },
            ])
          ).status,
        );
      },
      declaration: { cr: "CR-104-NEW", release: "0.2.0", wave: "5", title: "in scale" },
      expected: {
        status: 200,
        meaning: undefined,
        help: undefined,
        warnings: [],
        converged: false,
        unknownDependencies: [],
        stored: { release: "0.2.0", seq: 5002, wave: "5", title: "in scale" },
        board: ["CR-104-NEW|5002|0.2.0|", "CR-104-S5|5001|0.2.0|", "CR-104-S6|6001|0.2.0|"],
      },
    },
    {
      name:
        "AC3 — the WAVE axis earns it identically: the row's own wave holds a HELD positional " +
        "sibling, so both doors name the row they defaulted and neither names the sibling",
      board: async (key) => {
        await propose(key, "0.2.0");
        expect([200, 202]).toContain(
          (
            await bulk(key, [
              { cr: "CR-104-P", wave: "5", dependsOn: [], release: "0.2.0", seq: 10 },
            ])
          ).status,
        );
      },
      declaration: { cr: "CR-104-NEW", release: "0.2.0", wave: "5", title: "beside a positional" },
      expected: {
        status: 200,
        meaning: undefined,
        help: undefined,
        warnings: [`defaulted-seq|${defaultedSeqMessage(["CR-104-NEW"])}|CR-104-NEW`],
        converged: false,
        unknownDependencies: [],
        stored: { release: "0.2.0", seq: 5001, wave: "5", title: "beside a positional" },
        board: ["CR-104-NEW|5001|0.2.0|", "CR-104-P|10|0.2.0|"],
      },
    },
  ];

  describe("§S2/AC3 — the same declaration through both wire routes", () => {
    for (const scenario of SCENARIOS) {
      test(scenario.name, async () => {
        boot();
        const answers: Array<{ route: string; answer: Answer }> = [];
        for (const route of ROUTES) {
          // A board per route, built the same way: parity is about the ANSWER,
          // so neither route may see the other's write.
          const key = await seed(`cru104-parity-${route.name.replace(/[^a-z0-9]+/gi, "-")}`);
          await scenario.board(key);
          answers.push({ route: route.name, answer: await route.drive(key, scenario.declaration) });
        }
        // Asserted against the EXPECTED answer first, so a scenario cannot
        // pass by both routes being wrong in the same way…
        for (const { route, answer } of answers) {
          expect({ route, ...answer }).toEqual({ route, ...scenario.expected });
        }
        // …and then against each other, which is the property this CR buys: an
        // invariant added to one door and not the other fails HERE.
        for (const { route, answer } of answers.slice(1)) {
          expect({ route, ...answer }).toEqual({ route, ...answers[0]!.answer });
        }
      });
    }
  });

  describe("§S2/AC3 — track: the bulk post and `wave-sequence`, the two doors that declare one", () => {
    test(
      "a `track` carrying no lane number is refused 400 by both, both cite the ONE lane rule, and " +
        "neither writes — the PREFIXES differ (field+index vs field), which is the shape §S1 lets " +
        "each door keep; the rule itself does not fork",
      async () => {
        boot();
        const key = await seed("cru104-track-parity");
        await propose(key, "0.2.0");
        expect([200, 202]).toContain(
          (
            await bulk(key, [
              { cr: "CR-104-T", wave: "5", dependsOn: [], release: "0.2.0", seq: 5001 },
            ])
          ).status,
        );

        const bulkRes = await bulk(key, [
          { cr: "CR-104-T", wave: "5", dependsOn: [], release: "0.2.0" },
          { cr: "CR-104-T2", wave: "5", dependsOn: [], track: "the fast lane" },
        ]);
        const seqRes = await post(sequencePath(key), {
          agentId: ORCH,
          release: "0.2.0",
          wave: "5",
          crs: ["CR-104-T"],
          track: "the fast lane",
        });
        for (const [name, res] of [
          ["bulk", bulkRes],
          ["wave-sequence", seqRes],
        ] as const) {
          expect(`${name}:${res.status}`).toBe(`${name}:400`);
          expect(res.body.error).toContain("track");
          expect(res.body.error!.endsWith(LANE_RULE)).toBe(true);
        }
        // The bulk door's own shape: the field AND the index.
        expect(bulkRes.body.error).toMatch(/index 1\b/);
        // Neither write ran: the seeded row still stands, alone and untracked.
        const board = await entries(key);
        expect(board.map((e) => e.cr)).toEqual(["CR-104-T"]);
        expect("track" in board[0]!).toBe(false);
      },
    );

    test(
      "and an ACCEPTED track stores the SAME normalised lane through both doors: `Track 2` reads " +
        "back `track-2` either way (`normalizeTrack`, one normaliser)",
      async () => {
        boot();
        const viaBulkKey = await seed("cru104-track-bulk");
        await propose(viaBulkKey, "0.2.0");
        expect([200, 202]).toContain(
          (
            await bulk(viaBulkKey, [
              { cr: "CR-104-TK", wave: "5", dependsOn: [], release: "0.2.0", track: "Track 2" },
            ])
          ).status,
        );

        const viaSeqKey = await seed("cru104-track-sequence");
        await propose(viaSeqKey, "0.2.0");
        expect(
          (
            await post(planPath(viaSeqKey), {
              agentId: ORCH,
              cr: "CR-104-TK",
              release: "0.2.0",
              wave: "5",
              title: "sequenced",
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await post(sequencePath(viaSeqKey), {
              agentId: ORCH,
              release: "0.2.0",
              wave: "5",
              crs: ["CR-104-TK"],
              track: "Track 2",
            })
          ).status,
        ).toBe(200);

        for (const key of [viaBulkKey, viaSeqKey]) {
          expect((await entries(key)).find((e) => e.cr === "CR-104-TK")!.track).toBe("track-2");
        }
      },
    );
  });

  // ── AC7 — the ONE asymmetry that STAYS, recorded rather than closed ───────
  //
  // The open ruling in CR-CRU-104's spec: `cr-plan` and `wave-sequence` refuse
  // a dependency CYCLE; the bulk post does not, and this CR does not change
  // that. `src/hints.ts`'s cycle help names *"re-post the queue with
  // `dependsOn` corrected"* as the remedy, which makes the bulk post the
  // deliberate ESCAPE HATCH — refusing cycles there could reject a legitimate
  // bootstrap re-post of a README that momentarily contains one, leaving no way
  // back. CR-CRU-014 §S1 is the precedent: unknown `dependsOn` targets are
  // ACCEPTED and flagged, never rejected.
  //
  // This test therefore asserts the asymmetry EXISTS and is deliberate. It is
  // the record, not the ruling: when the user rules, this test changes with
  // the behaviour, and until then nobody closes the gap by accident.
  test(
    "AC7 the dependency-cycle asymmetry is DELIBERATE and pending a user ruling: the bulk post " +
      "accepts a cycle it is the documented escape hatch from, while `cr-plan` refuses one on the " +
      "same board — a knowing difference, unlike the live-proposal gap AC1 closes",
    async () => {
      boot();
      const key = await seed("cru104-ac7-cycle-asymmetry");
      await propose(key, "0.2.0");
      // A ring, through the migration door: ACCEPTED, exactly as CR-CRU-014
      // §S1 accepts an unknown dependency.
      const posted = await bulk(key, [
        { cr: "CR-104-X", wave: "5", dependsOn: ["CR-104-Y"], release: "0.2.0" },
        { cr: "CR-104-Y", wave: "5", dependsOn: ["CR-104-X"], release: "0.2.0" },
      ]);
      expect([200, 202]).toContain(posted.status);
      expect(await crs(key)).toEqual(["CR-104-X", "CR-104-Y"]);

      // The same ring, through the approved per-CR verb: REFUSED 409.
      const planned = await post(planPath(key), {
        agentId: ORCH,
        cr: "CR-104-X",
        release: "0.2.0",
        wave: "5",
        title: "re-plan a ring member",
      });
      expect(planned.status).toBe(409);
      expect(planned.body.error).toContain("dependency cycle refused");
      // Still there — the refusal wrote nothing, and the migration door's
      // acceptance stands.
      expect(await crs(key)).toEqual(["CR-104-X", "CR-104-Y"]);
    },
  );

  // ── AC5 — the wordings a caller could already see ─────────────────────────

  test(
    "AC5 `cr-plan`'s and `wave-sequence`'s shipped refusals are unchanged: the unproposed-release " +
      "404 keeps CR-CRU-091 §S8's sentence and help[] byte-for-byte, `cr-plan`'s TYPE refusal of a " +
      "non-string release keeps its own — the sentence the migration door now answers too, so " +
      "closing that divergence moved the second door and not this one — and `wave-sequence`'s " +
      "track refusal keeps CR-CRU-091 §S2/AC17's field-shaped wording",
    async () => {
      boot();
      const key = await seed("cru104-ac5-wordings");
      const planned = await post(planPath(key), {
        agentId: ORCH,
        cr: "CR-104-W",
        release: "0.9.0",
        wave: "5",
        title: "unproposed",
      });
      expect(planned.status).toBe(404);
      expect(planned.body.error).toBe(unproposedSentence("0.9.0"));
      expect(planned.body.help).toEqual(unproposedHelp("0.9.0"));

      // The input P2-b measured: a JSON NUMBER where a label belongs.
      // `cr-plan` type-refuses it, help-less, and that answer does not move.
      const numeric = await post(planPath(key), {
        agentId: ORCH,
        cr: "CR-104-W",
        release: 2,
        wave: "5",
        title: "a coerced label",
      });
      expect(numeric.status).toBe(400);
      expect(numeric.body.error).toBe(RELEASE_REQUIRED);
      expect(numeric.body.help).toBeUndefined();

      await propose(key, "0.2.0");
      const sequenced = await post(sequencePath(key), {
        agentId: ORCH,
        release: "0.2.0",
        wave: "5",
        crs: ["CR-104-W"],
        track: "the fast lane",
      });
      expect(sequenced.status).toBe(400);
      expect(sequenced.body.error).toBe(
        `\`track\` "the fast lane" carries no lane number — ${LANE_RULE}`,
      );
    },
  );
});
