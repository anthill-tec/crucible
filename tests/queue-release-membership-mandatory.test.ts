// CR-CRU-118 §S1/§S2 — every live CR names a release: the mandate's two doors.
// C1 RED (cycle 415).
//
// ── §S1 IS A REGRESSION FILE, AND EVERY §S1 TEST BELOW PASSES ON ARRIVAL ───
//
// That is not an accident and it is not a weak test. §S1 was RESCOPED at gap
// analysis (2026-09-10) once the door was MEASURED: `handleCrPlan` already
// refuses an absent release (`400`, the shared `RELEASE_REQUIRED` sentence),
// `handleWaveSequence` already requires one, and the shared registrar already
// declares `--release` as ask-don't-guess. So the per-CR door has never let a
// membership-less CR through, and the only thing §S1 can honestly do is PIN
// that.
//
// It is pinned because §S3a is about to WIDEN the set of acceptable labels — a
// label naming a RECORDED release becomes plannable, so that 62 landed rows
// can be given their history back. A widening is exactly how a requiredness
// rule gets lost: the code that decides "is this label acceptable" grows a new
// branch, and the branch that decides "was a label declared AT ALL" is one
// `if` away from being folded into it. These tests are the thing that fails on
// that day.
//
// The ONE §S1 criterion that is genuinely RED today is the refusal's `help[]`:
// `handleCrPlan` answers `fail(400, RELEASE_REQUIRED)` with NO `help[]` at all,
// while the sibling refusal one field lower (a label holding no live proposal)
// carries `roadmapHints.unproposedRelease`. A refusal that names the field but
// not the move that fixes it is the bare 400 §S5 forbids.
//
// ── §S2 IS THE HALF WITH TEETH, AND IT IS RED ──────────────────────────────
//
// The bulk `POST …/queue` is the only writer that accepts a release-less
// entry, and both measured incidents came through it. §S2 splits it by what
// the write actually DOES:
//
//   • an entry the route would INSERT with no release is REFUSED — a new CR
//     arriving membership-less, the `CR-CRU-117` case;
//   • an entry that ALREADY EXISTS with no release keeps `replaceQueue`'s
//     carry-forward and raises a fifth `QueueWarning` code naming those crs —
//     a migration list that shrinks to zero, not a wall.
//
// ── WHY THIS FILE ASSERTS FIVE IN ONE PLACE AND FOUR IN ANOTHER ────────────
//
// DO NOT RECONCILE THESE TWO NUMBERS. They answer different questions and an
// implementer who makes them agree has broken one of them:
//
//   • §S2's warning reports what the bulk route INHERITED — every release-less
//     row it did not insert. A VOID CR still carries no release, so the voided
//     one is IN it. On the live board that set is FIVE.
//   • §S1's census reports what is still LIVE and release-less. The voided one
//     is disposed of, so it is OUT. On the live board that set is FOUR.
//
// The census must therefore read BOTH fields. A queue entry's `status` is
// DERIVED (`deriveQueueStatus` answers from plans) and its `lifecycle.state`
// is STORED, and the two are independent and can disagree: the disposed CR in
// the dated snapshot below reads `status: PENDING` with `lifecycle.state:
// VOID`. A census keyed on `status` alone counts it as live and reports five —
// which is why the two-field rule is itself under test here (the second census
// test), rather than merely used by the first.
//
// ── WHAT IS SYNTHETIC AND WHAT IS LIVE, AND WHY ────────────────────────────
//
// Every fixture board is synthetic and in-memory: booted on an OS-assigned
// port against an mkdtempSync scratch db, with ids in this suite's own
// `CR-118-*` shape (the sibling convention — `CR-104-HELD`, `CR-104-GHOST` —
// which carries no project's namespace). The live data/crucible.db and port
// 3849 are never WRITTEN by anything in this file.
//
// The census is the one exception the AC names, and it is a READ: a board
// invariant asserted against a synthetic board would be an invariant about a
// fixture. It reads the live board the way tests/roadmap-visual-grammar.ts
// does — the project named by the repo root's `.env`, reached at
// `$CRUCIBLE_URL` (the fleet's own default, clients/bun-crucible.py:91) — over
// GET only, and STATES its reason and returns when the board cannot be read,
// because off this workstation `.env` is gitignored and the store it serves is
// never committed. Every census failure message names WHAT IT MEASURED, so a
// drifting board reports a number and a list of ids rather than a bare false.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import type { QueueEntryInput } from "../src/store.ts";
import type { QueueLifecycle } from "../src/types.ts";

const REPO_ROOT = join(import.meta.dir, "..");

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

/** The label the fixture boards run 0.2.0-style: a proposal that is LIVE and
 *  already has planned waves, which is the mode a CR can be BORN into. */
const IN_FLIGHT = "0.2.0";

/** The label the fixture boards have already SHIPPED — the 0.1.0-era history
 *  whose rows carry no release and whose provenance lives on the release
 *  record's own `crs` set. */
const SHIPPED = "0.1.0";

/** A label nobody proposed and no release recorded: §S1's untouched refusal. */
const UNKNOWN_LABEL = "9.9.9";

/** CR-CRU-091 §S8's requiredness sentence, shared verbatim by `handleCrPlan`
 *  and the membership gate (`RELEASE_REQUIRED`, src/v2.ts). Pinned ONCE here
 *  so the bulk door's new refusal answers this MEANING rather than a third
 *  wording of it — §S1's whole reason for existing as a regression. */
const RELEASE_REQUIRED = "`release` is required — the release this cr targets";

/** CR-CRU-091 §S8's refusal for a label holding no live proposal, as shipped. */
function unproposedSentence(release: string): string {
  return `release ${release} has no live proposal — it is not a plannable target`;
}

/** `roadmapHints.unproposedRelease` (src/hints.ts) — the shipped help[], whose
 *  SHAPE §S1 requires the missing-release refusal to match. */
function unproposedHelp(release: string): string[] {
  return [
    `release-propose --label ${release} — the super container must exist before a CR can target it`,
    `GET /api/v2/projects/<key>/release-proposals — the live proposals a CR can be planned into`,
    `a release that has already SHIPPED is settled history and is no longer a plannable target for ${release}`,
  ];
}

/** The one label-free line of that help[] — the `release-proposals` ROUTE. A
 *  refusal for an ABSENT release has no label to interpolate, so this is the
 *  line the two refusals must literally share. */
const RELEASE_PROPOSALS_ROUTE_HELP =
  `GET /api/v2/projects/<key>/release-proposals — the live proposals a CR can be planned into`;

/** The `QueueWarning` code union as it stands BEFORE this CR — four codes, in
 *  declaration order. §S2 adds a FIFTH and may move none of these. */
const SHIPPED_QUEUE_WARNING_CODES = [
  "out-of-order",
  "cross-wave-backwards",
  "defaulted-seq",
  "unsequenced-members",
] as const;

/**
 * The `QueueWarning.code` union, read off `src/v2.ts` itself.
 *
 * A TYPE union is not observable on the wire — a route emits ONE code per
 * finding, so no amount of driving the server can prove the other four are
 * unchanged. The declaration is the only place the whole vocabulary exists,
 * and five clients RENDER it, so it is a published contract rather than an
 * implementation detail. Read as text for the same reason the namespace
 * tripwire reads source as text: there is no runtime value to interrogate.
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

// ── the dated board snapshot §S1's census is measured against ───────────────
//
// THE ONE NAMED, DATED CONSTANT in this file that holds real project CR ids,
// and the only place they may appear (the namespace tripwire's AC5 mechanism —
// registered in `EXEMPT_CONSTANTS` in tests/project-namespace-tripwire.test.ts
// with its reason). Every assertion below reads the ids FROM here; none spells
// one inline.
//
// A CEILING, NOT A TARGET, exactly like `PRE_CR_ASSERTION_RESIDUE`: the
// allowlist may SHRINK freely and may never GROW. A name leaves it when that CR
// is migrated into a release; a FIFTH release-less live entry appearing fails
// the census in the cycle that introduced it. That is the invariant with teeth
// — "no NEW membership-less CR" — and it is why the census PASSES on arrival,
// which it must: migrating these four into 0.3.0 is a DATA step deferred past
// 0.2.0 by user ruling, so an absolute census would be red from close-out until
// that migration ran.
//
// Measured 2026-09-10 against the live board (115 entries, 67 release-less: 62
// landed, 5 not).
const RELEASE_LESS_BOARD_SNAPSHOT_2026_09_10 = {
  /** Release-less AND live by both fields. The shrinking allowlist. */
  allowlist: ["CR-CRU-015", "CR-CRU-018", "CR-CRU-022", "CR-CRU-098"],
  /**
   * Release-less and NOT landed, yet absent from the allowlist — excluded by
   * DISPOSITION, not by migration. Its VOID lifecycle was re-recorded
   * 2026-09-10 (user-ruled). Its derived `status` still reads PENDING, because
   * `deriveQueueStatus` answers from plans and knows nothing of a disposition:
   * this row IS the reason the census reads two fields.
   */
  disposed: { cr: "CR-CRU-082", status: "PENDING", lifecycleState: "VOID" },
} as const;

// ── the census rule, written ONCE and applied to whatever board is read ─────

function releaseLess(entry: QueueEntryWire): boolean {
  return entry.release === undefined || entry.release === null || entry.release === "";
}

/** The `status` half of the census — LANDED work is history, and its
 *  provenance lives on a release record's own `crs` set rather than on the
 *  queue row. On its own this half is WRONG (it counts a voided CR as live);
 *  it is named separately so the census test can measure the difference. */
function notLandedByStatus(entry: QueueEntryWire): boolean {
  return entry.status !== "COMPLETED" && entry.status !== "COMPLETED_UNTRACKED";
}

/** The `lifecycle` half — an independent, STORED axis. */
function notDisposed(entry: QueueEntryWire): boolean {
  const state = entry.lifecycle?.state;
  return state !== "VOID" && state !== "SUPERSEDED";
}

/** LIVE, as §S1 defines it: BOTH halves, never one. */
function live(entry: QueueEntryWire): boolean {
  return notLandedByStatus(entry) && notDisposed(entry);
}

/** How long a live-board READ may take before it counts as "no board", and how
 *  long a census TEST may take. Both are generous against a measured ~2.3s
 *  read, because the number being defended is a board invariant and a slow
 *  answer is still an answer; only silence is a skip. */
const LIVE_BOARD_READ_BUDGET = 20_000;
const CENSUS_TEST_BUDGET = 45_000;

/**
 * The live board's queue, or the reason it could not be read.
 *
 * GET ONLY. Nothing in this file writes to the live board, and the project is
 * named the way every client names it rather than by a literal in a test.
 */
async function liveBoardQueue(): Promise<{ entries: QueueEntryWire[]; at: string } | { skip: string }> {
  let key = "";
  try {
    const env = readFileSync(join(REPO_ROOT, ".env"), "utf8");
    key = /^CRUCIBLE_PROJECT_KEY=(.+)$/m.exec(env)?.[1]?.trim() ?? "";
  } catch (failure) {
    const said = failure instanceof Error ? failure.message : String(failure);
    return { skip: `the repo root has no readable .env to name the live project (${said})` };
  }
  if (key === "") {
    return { skip: "the repo root's .env declares no CRUCIBLE_PROJECT_KEY" };
  }
  const base = process.env.CRUCIBLE_URL ?? "http://localhost:3849";
  try {
    // BOUNDED. The live board is a real server doing real work — measured
    // 2026-09-10 at ~2.3s for this read while a sibling suite was spawning the
    // client fleet — so an unbounded read turns a busy board into a test
    // TIMEOUT, which reads as a failed invariant rather than as a board that
    // did not answer. An abort lands in the same STATED skip as a refused
    // connection, because both mean the same thing: nothing was censused.
    const answer = await fetch(`${base}/api/v2/projects/${key}/queue`, {
      signal: AbortSignal.timeout(LIVE_BOARD_READ_BUDGET),
    });
    if (!answer.ok) throw new Error(`queue answered HTTP ${answer.status}`);
    const body = (await answer.json()) as { entries?: QueueEntryWire[] };
    return { entries: body.entries ?? [], at: base };
  } catch (failure) {
    const said = failure instanceof Error ? failure.message : String(failure);
    return { skip: `no live board answered at ${base} (${said}), and its store is never committed` };
  }
}

// ── the synthetic board's rows ─────────────────────────────────────────────

interface Row {
  cr: string;
  title: string;
  wave: string;
  release?: string;
  lifecycle?: QueueLifecycle;
}

const DISPOSED_AT = 1_780_000_000_000;

/** The 62 landed 0.1.0-era rows, in the live board's proportion: release-less
 *  on the row, named by the SHIPPED release's own `crs` set — which is what
 *  makes them read COMPLETED_UNTRACKED and what §S3a will later derive their
 *  membership from. */
function landedHistory(): Row[] {
  return Array.from({ length: 62 }, (_unused, index) => ({
    cr: `CR-118-L${String(index + 1).padStart(2, "0")}`,
    title: `0.1.0-era row ${index + 1}`,
    wave: String((index % 4) + 1),
  }));
}

/** The five release-less rows the bulk route INHERITS — four still live, one
 *  disposed. The disposed one is the whole reason §S2's warning names FIVE
 *  where §S1's census names FOUR: it carries no release either. */
const INHERITED: Row[] = [
  { cr: "CR-118-I1", title: "deferred, never given a release", wave: "7" },
  { cr: "CR-118-I2", title: "deferred, never given a release", wave: "7" },
  { cr: "CR-118-I3", title: "deferred, never given a release", wave: "7" },
  { cr: "CR-118-I4", title: "deferred, never given a release", wave: "7" },
  {
    cr: "CR-118-I5",
    title: "release-less AND disposed of",
    wave: "7",
    lifecycle: { state: "VOID", reason: "superseded by a different approach", at: DISPOSED_AT },
  },
];

/** The rows of the release currently IN FLIGHT. */
const ACTIVE: Row[] = [
  { cr: "CR-118-A1", title: "in the release being cut", wave: "5", release: IN_FLIGHT },
  { cr: "CR-118-A2", title: "in the release being cut", wave: "5", release: IN_FLIGHT },
  { cr: "CR-118-A3", title: "in the release being cut", wave: "5", release: IN_FLIGHT },
];

function toInput(row: Row): QueueEntryInput {
  return {
    cr: row.cr,
    title: row.title,
    wave: row.wave,
    dependsOn: [],
    ...(row.release !== undefined ? { release: row.release } : {}),
    ...(row.lifecycle !== undefined ? { lifecycle: row.lifecycle } : {}),
  };
}

/** What `parse_queue_table` actually posts: `{cr, title, wave, dependsOn}` and
 *  NOTHING else — no release, no lifecycle. This shape IS the bootstrap, and
 *  it is the shape both measured incidents arrived in. */
function bootstrapTable(rows: Row[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({ cr: row.cr, title: row.title, wave: row.wave, dependsOn: [] }));
}

describe("CR-CRU-118 — every live CR names a release", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "cru118-membership-"));
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

  async function entries(key: string): Promise<QueueEntryWire[]> {
    const res = await get(queuePath(key));
    expect(res.status).toBe(200);
    return res.body.entries!;
  }

  /**
   * The board AS HISTORY LEFT IT, seeded through the STORE rather than the
   * route. Deliberate, and load-bearing for §S2: after this CR the route
   * REFUSES to insert a release-less row, so the door that created these rows
   * is the one being closed. Seeding them through it would make the fixture
   * unbuildable the moment GREEN lands, and would prove nothing about the
   * inheritance case anyway — the whole point is that they are already there.
   */
  function seedHistory(key: string, rows: Row[]): void {
    handle!.store.replaceQueue(key, rows.map(toInput));
  }

  /** Record the SHIPPED release, naming the landed rows in its own `crs` set —
   *  which is what makes them read COMPLETED_UNTRACKED. */
  async function ship(key: string, label: string, crs: string[]): Promise<void> {
    await propose(key, label);
    const shipped = await post("/api/v2/milestones", {
      projectKey: key,
      agentId: ORCH,
      type: "release",
      label,
      crs,
    });
    expect([200, 201]).toContain(shipped.status);
  }

  // ══ §S1 — the per-CR door, pinned as a regression ════════════════════════

  describe("§S1 — the per-CR door is already closed, and stays closed", () => {
    test(
      "cr-plan with NO release is refused server-side, and the store wrote nothing — proved by " +
        "re-reading the queue rather than by trusting the refusal",
      async () => {
        boot();
        const key = await seed("cru118-s1-required");
        await propose(key, IN_FLIGHT);
        seedHistory(key, ACTIVE);
        const before = await entries(key);

        const refused = await post(planPath(key), {
          agentId: ORCH,
          cr: "CR-118-BORN",
          wave: "6",
          title: "a CR arriving with no membership at all",
        });

        expect(refused.status).toBe(400);
        expect(refused.body.ok).toBe(false);
        expect(refused.body.error).toBe(RELEASE_REQUIRED);
        // THE STORE, not the response body: a full re-read, byte for byte.
        const after = await entries(key);
        expect(JSON.stringify(after)).toBe(JSON.stringify(before));
        // NEGATIVE, stated separately from the byte compare so a fixture that
        // somehow started empty cannot pass this: the CR is nowhere.
        expect(after.map((entry) => entry.cr)).not.toContain("CR-118-BORN");
        expect(after).toHaveLength(ACTIVE.length);
      },
    );

    test(
      "the missing-release refusal names the release-proposals ROUTE in help[], matching the " +
        "no-such-proposal refusal's shape — no bare 400 (§S5)",
      async () => {
        boot();
        const key = await seed("cru118-s1-help");
        await propose(key, IN_FLIGHT);

        const refused = await post(planPath(key), {
          agentId: ORCH,
          cr: "CR-118-BORN",
          wave: "6",
          title: "a CR arriving with no membership at all",
        });

        expect(refused.status).toBe(400);
        expect(refused.body.error).toBe(RELEASE_REQUIRED);
        // Asserted as a SHAPE first, because a refusal that carries no `help[]`
        // at all is precisely the bare 400 this criterion is about, and
        // `toContain` on an absent array reports a matcher's type complaint
        // rather than the contract that was missed.
        expect(
          Array.isArray(refused.body.help),
          `the refusal for an ABSENT release answered help=${JSON.stringify(refused.body.help)} ` +
            `— §S5 forbids a bare 400, and the sibling refusal one field lower carries ` +
            `roadmapHints.unproposedRelease`,
        ).toBe(true);
        // The label-free line the sibling refusal already carries: an ABSENT
        // release has no label to interpolate, so this is the line the two
        // refusals must literally share.
        expect(refused.body.help ?? []).toContain(RELEASE_PROPOSALS_ROUTE_HELP);
        // And the MOVE that fixes it, named the way the sibling names it.
        expect(
          (refused.body.help ?? []).some((line) => line.includes("release-propose")),
          "the refusal for an ABSENT release must name the verb that creates one, exactly as " +
            "the refusal for an UNPROPOSED one does",
        ).toBe(true);
      },
    );

    test(
      "a CR BORN mid-release is planned into the release already in flight — the mode 0.2.0 " +
        "itself ran in, where a whole second wave grew on the release branch",
      async () => {
        boot();
        const key = await seed("cru118-s1-midrelease");
        await propose(key, IN_FLIGHT);
        // The release is IN FLIGHT rather than merely proposed: it already has
        // planned waves, which is what "the branch was cut" looks like on the
        // board.
        seedHistory(key, ACTIVE);

        const planned = await post(planPath(key), {
          agentId: ORCH,
          cr: "CR-118-BORN",
          release: IN_FLIGHT,
          wave: "6",
          title: "born after the branch was cut",
        });

        expect(planned.status).toBe(200);
        expect(planned.body.ok).toBe(true);
        expect(planned.body.entry!.release).toBe(IN_FLIGHT);
        // Read back from the STORE, and it is a member — not merely accepted.
        const born = (await entries(key)).find((entry) => entry.cr === "CR-118-BORN");
        expect(born).toBeDefined();
        expect(born!.release).toBe(IN_FLIGHT);
        expect(born!.wave).toBe("6");
      },
    );

    test(
      "a label with neither a live proposal nor a recorded release keeps TODAY'S refusal, " +
        "verbatim — this CR narrows absence and widens no existing refusal",
      async () => {
        boot();
        const key = await seed("cru118-s1-unknown-label");
        await propose(key, IN_FLIGHT);
        seedHistory(key, ACTIVE);
        const before = await entries(key);

        const refused = await post(planPath(key), {
          agentId: ORCH,
          cr: "CR-118-BORN",
          release: UNKNOWN_LABEL,
          wave: "6",
          title: "targeting a label nobody proposed",
        });

        expect(refused.status).toBe(404);
        expect(refused.body.error).toBe(unproposedSentence(UNKNOWN_LABEL));
        expect(refused.body.help).toEqual(unproposedHelp(UNKNOWN_LABEL));
        expect(JSON.stringify(await entries(key))).toBe(JSON.stringify(before));
      },
    );
  });

  // ══ §S1 — the board invariant, as a dated census with a shrinking ceiling ═

  describe("§S1 — the board invariant, censused against the live board", () => {
    test(
      "no LIVE queue entry lacks a release except the four the dated allowlist names, and the " +
        "allowlist may only SHRINK",
      async () => {
        const board = await liveBoardQueue();
        if ("skip" in board) {
          console.log(`[CR-CRU-118] §S1 census NOT RUN: ${board.skip}`);
          return;
        }
        // Non-vacuity: a census over an empty read would pass for the wrong
        // reason, and an empty read is exactly what a wrong project key gives.
        expect(
          board.entries.length,
          `the live board at ${board.at} served an EMPTY queue, so nothing was censused`,
        ).toBeGreaterThan(0);

        const allowlist = RELEASE_LESS_BOARD_SNAPSHOT_2026_09_10.allowlist;
        const measured = board.entries.filter((entry) => releaseLess(entry) && live(entry));
        const measuredCrs = measured.map((entry) => entry.cr).sort();
        const unlisted = measuredCrs.filter((cr) => !allowlist.includes(cr as never));

        // THE CEILING. A name may leave the allowlist by being migrated; a name
        // may never JOIN it. `unlisted` is the set of live release-less entries
        // the snapshot does not sanction — a fifth one is a new membership-less
        // CR, and it fails here, in the cycle that introduced it.
        expect(
          unlisted,
          `the live board at ${board.at} holds ${measuredCrs.length} live release-less ` +
            `entries (${measuredCrs.join(", ") || "none"}), and ${unlisted.length} of them are ` +
            `outside the dated allowlist of ${allowlist.length}: ${unlisted.join(", ")}`,
        ).toEqual([]);
        // The ceiling as a NUMBER too, so a same-named-but-doubled row cannot
        // slip through the set comparison.
        expect(
          measuredCrs.length,
          `the live board at ${board.at} holds ${measuredCrs.length} live release-less ` +
            `entries against a ceiling of ${allowlist.length}`,
        ).toBeLessThanOrEqual(allowlist.length);
      },
      CENSUS_TEST_BUDGET,
    );

    test(
      "the census reads BOTH fields: the disposed CR is release-less and NOT landed by status, " +
        "so a status-only census counts it live — its LIFECYCLE is what excludes it",
      async () => {
        const board = await liveBoardQueue();
        if ("skip" in board) {
          console.log(`[CR-CRU-118] §S1 two-field census NOT RUN: ${board.skip}`);
          return;
        }
        const disposed = RELEASE_LESS_BOARD_SNAPSHOT_2026_09_10.disposed;
        const row = board.entries.find((entry) => entry.cr === disposed.cr);
        expect(
          row,
          `the live board at ${board.at} no longer holds ${disposed.cr}, which the ` +
            `2026-09-10 snapshot recorded as the row that makes the two fields disagree`,
        ).toBeDefined();

        // The three facts that make it the two-field rule's witness.
        expect(releaseLess(row!)).toBe(true);
        expect(row!.status).toBe(disposed.status);
        expect(row!.lifecycle?.state).toBe(disposed.lifecycleState);

        // A status-only census WOULD count it — stated as a measurement, not
        // as a claim about the code.
        const byStatusOnly = board.entries
          .filter((entry) => releaseLess(entry) && notLandedByStatus(entry))
          .map((entry) => entry.cr);
        const byBothFields = board.entries
          .filter((entry) => releaseLess(entry) && live(entry))
          .map((entry) => entry.cr);
        expect(
          byStatusOnly,
          `a status-only census of the live board at ${board.at} reports ` +
            `${byStatusOnly.length} release-less entries (${byStatusOnly.join(", ")})`,
        ).toContain(disposed.cr);
        expect(
          byBothFields,
          `the two-field census of the live board at ${board.at} reports ` +
            `${byBothFields.length} release-less entries (${byBothFields.join(", ")})`,
        ).not.toContain(disposed.cr);
        // The difference is exactly one row, and it is that row: a census that
        // read one field would report one MORE than the allowlist sanctions.
        expect(byStatusOnly.length - byBothFields.length).toBe(1);
      },
      CENSUS_TEST_BUDGET,
    );
  });

  // ══ §S2 — the bulk route ═════════════════════════════════════════════════

  describe("§S2 — the bulk route refuses what it would INVENT, warns about what it inherits", () => {
    test(
      "a bulk post INSERTING a cr the board does not hold, with no release, is refused by cr id " +
        "AND index — and the full replace it would have run never happens",
      async () => {
        boot();
        const key = await seed("cru118-s2-invented");
        await propose(key, IN_FLIGHT);
        seedHistory(key, ACTIVE);
        const before = await entries(key);

        // The BOOTSTRAP shape, verbatim: `parse_queue_table` posts no release
        // on any row, so the held rows keep theirs by carry-forward and the
        // ghost — a cr the store has never seen — would be INSERTED with none.
        // That is the CR-CRU-117 incident, reproduced.
        const refused = await post(queuePath(key), {
          agentId: ORCH,
          entries: [
            ...bootstrapTable(ACTIVE),
            { cr: "CR-118-GHOST", title: "a CR arriving unauthored", wave: "6", dependsOn: [] },
          ],
        });

        expect(refused.status).toBe(400);
        expect(refused.body.ok).toBe(false);
        // The route's OWN shape — the offending entry's INDEX — plus the cr id,
        // carrying the ONE requiredness sentence rather than a third wording.
        expect(refused.body.error).toContain(`index ${ACTIVE.length}`);
        expect(refused.body.error).toContain("CR-118-GHOST");
        expect(refused.body.error).toContain(RELEASE_REQUIRED);
        expect(refused.body.help ?? []).toContain(RELEASE_PROPOSALS_ROUTE_HELP);

        // NOTHING WRITTEN. This route is a FULL REPLACE, so a refusal that ran
        // the write is visible here as changed rows — asserted byte for byte,
        // then again as the negative the AC names.
        const after = await entries(key);
        expect(JSON.stringify(after)).toBe(JSON.stringify(before));
        expect(after.map((entry) => entry.cr)).not.toContain("CR-118-GHOST");
      },
    );

    test(
      "a bulk post whose release-less entries ALL already exist WRITES, and its warning names " +
        "exactly those crs — the disposed one included, because a VOID cr still carries no release",
      async () => {
        boot();
        const key = await seed("cru118-s2-inherited");
        await propose(key, IN_FLIGHT);
        seedHistory(key, [...INHERITED, ...ACTIVE]);
        const before = await entries(key);

        const posted = await post(queuePath(key), {
          agentId: ORCH,
          entries: bootstrapTable([...INHERITED, ...ACTIVE]),
        });

        expect([200, 202]).toContain(posted.status);
        expect(posted.body.ok).toBe(true);

        const union = queueWarningCodeUnion();
        const inheritedCode = union[union.length - 1]!;
        const raised = (posted.body.warnings ?? []).filter(
          (warning) => warning.code === inheritedCode,
        );
        expect(
          raised,
          `the post raised ${JSON.stringify((posted.body.warnings ?? []).map((w) => w.code))}, ` +
            `and exactly one of them must carry the inherited-release-less finding`,
        ).toHaveLength(1);

        // FIVE, not four. §S1's census reports FOUR on the live board because
        // the voided one is disposed of; this warning reports what the route
        // INHERITED, and a voided cr carries no release either. The two numbers
        // answer different questions and must not be reconciled.
        const named = raised[0]!.crs ?? [];
        expect(named).toHaveLength(INHERITED.length);
        expect([...named].sort()).toEqual(INHERITED.map((row) => row.cr).sort());
        // NEGATIVE — the rows that DO carry a release are not on a migration
        // list, so a warning that named every row would fail here.
        for (const row of ACTIVE) expect(named).not.toContain(row.cr);
        // Structured like `defaulted-seq`: a ready-to-print line for the five
        // clients beside the machine-readable crs.
        expect(typeof raised[0]!.message).toBe("string");
        for (const cr of named) expect(raised[0]!.message).toContain(cr);

        // WARN-AND-WRITE: the post landed and changed nothing it inherited.
        expect(JSON.stringify(await entries(key))).toBe(JSON.stringify(before));
      },
    );

    test(
      "the inherited-release-less code is the FIFTH member of the QueueWarning union, and the " +
        "other four are unchanged by length and by value",
      async () => {
        boot();
        const key = await seed("cru118-s2-union");
        await propose(key, IN_FLIGHT);
        seedHistory(key, [...INHERITED, ...ACTIVE]);

        const union = queueWarningCodeUnion();
        // BY LENGTH — a fifth code, and only a fifth.
        expect(
          union,
          `src/v2.ts declares the QueueWarning codes as ${JSON.stringify(union)}`,
        ).toHaveLength(SHIPPED_QUEUE_WARNING_CODES.length + 1);
        // BY VALUE, in order — a rename or a reorder of the shipped four fails
        // here rather than silently reaching five rendering clients.
        expect(union.slice(0, SHIPPED_QUEUE_WARNING_CODES.length)).toEqual([
          ...SHIPPED_QUEUE_WARNING_CODES,
        ]);
        expect(new Set(union).size).toBe(union.length);

        // And the fifth member is the code the route actually EMITS — a union
        // member nothing raises would be vocabulary, not a finding.
        const posted = await post(queuePath(key), {
          agentId: ORCH,
          entries: bootstrapTable([...INHERITED, ...ACTIVE]),
        });
        expect([200, 202]).toContain(posted.status);
        const codes = (posted.body.warnings ?? []).map((warning) => warning.code);
        expect(
          codes,
          `the inherited post raised ${JSON.stringify(codes)} against a declared union of ` +
            `${JSON.stringify(union)}`,
        ).toContain(union[union.length - 1]!);
      },
    );

    test(
      "the 62 landed 0.1.0-era rows produce the WARNING and never a refusal, and are not " +
        "rewritten — today's whole table still bootstraps",
      async () => {
        boot();
        const key = await seed("cru118-s2-bootstrap");
        const landed = landedHistory();
        seedHistory(key, [...landed, ...INHERITED, ...ACTIVE]);
        // Their provenance, exactly where the CR says it lives: the release
        // record's own `crs` set, which is also what makes them read
        // COMPLETED_UNTRACKED rather than PENDING.
        await ship(key, SHIPPED, landed.map((row) => row.cr));
        await propose(key, IN_FLIGHT);

        const before = await entries(key);
        const landedBefore = before.filter((entry) => entry.cr.startsWith("CR-118-L"));
        expect(landedBefore).toHaveLength(62);
        for (const entry of landedBefore) {
          expect(entry.status).toBe("COMPLETED_UNTRACKED");
          expect(releaseLess(entry)).toBe(true);
        }

        const posted = await post(queuePath(key), {
          agentId: ORCH,
          entries: bootstrapTable([...landed, ...INHERITED, ...ACTIVE]),
        });

        // NEVER A REFUSAL — stated positively and as the negative the risk
        // section names: a mistake here blocks the bootstrap the whole board is
        // restored from.
        expect([200, 202]).toContain(posted.status);
        expect(posted.body.ok).toBe(true);
        expect(posted.body.error).toBeUndefined();

        const union = queueWarningCodeUnion();
        const raised = (posted.body.warnings ?? []).filter(
          (warning) => warning.code === union[union.length - 1]!,
        );
        expect(raised).toHaveLength(1);
        // The migration list is the FIVE non-landed rows. The 62 are excluded
        // BY DESIGN: their membership is derivable from the release record that
        // already names them (§S3a), so listing them would make the list 67
        // long and unshrinkable, and the AC pins it at five.
        const named = raised[0]!.crs ?? [];
        expect(named).toHaveLength(INHERITED.length);
        for (const row of landed) expect(named).not.toContain(row.cr);

        // NOT REWRITTEN — every landed row byte-identical, release still
        // absent, status still derived from the release record.
        const landedAfter = (await entries(key)).filter((entry) =>
          entry.cr.startsWith("CR-118-L"),
        );
        expect(landedAfter).toHaveLength(62);
        expect(JSON.stringify(landedAfter)).toBe(JSON.stringify(landedBefore));
      },
    );
  });
});
