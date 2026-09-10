// CR-CRU-118 §S3a — historical membership is a DERIVATION, not a plan.
// C2 RED (cycle 416).
//
// ── WHAT THIS FILE IS ABOUT ────────────────────────────────────────────────
//
// `declareMembership` accepts a label only where it holds a LIVE proposal, so
// a landed CR cannot be told which SHIPPED release it belonged to: `cr-plan
// --release 0.1.0` answers `404 … no live proposal — it is not a plannable
// target`, by design, because a shipped release's proposal is CONSUMED by its
// own insert. Measured on the live board 2026-09-10: 62 landed queue rows
// carry no release, and no gated verb can give them one — so the mandate §S1
// states is unreachable for every one of them.
//
// §S3a opens ONE narrow door: a declared label naming a RECORDED release is
// accepted only where THAT release's own `crs` set already names the CR. A
// derivation from settled fact, and self-checking — it cannot add scope to a
// closed release, because the release must already claim the CR itself, and it
// cannot admit a genuinely new CR, because a shipped release claims none.
//
// ── THE ONE DERIVATION, NAMED ──────────────────────────────────────────────
//
// The check is `recordedReleaseClaiming(store, key)` (src/v2.ts), landed by
// §S2 in cycle 415 and CURRIED so the milestone-table scan happens once per
// request rather than once per entry. It answers the CLAIMING LABEL, so a
// caller can name the release it derived membership from.
//
// TWO doors read it and they must be ONE rule: §S2's bulk-insert rung (a
// wiped-board restore admitting the 62 landed rows) and §S3a's `cr-plan` door
// (the backfill giving those rows their history back). Two independent copies
// of this rule would drift, and the drift would be SILENT — a restore would
// admit a row the backfill refuses, or the reverse. Cycle 415 pinned the rung
// against a NARROWED release record from §S2's side
// (tests/queue-release-membership-mandatory.test.ts, "the derivation is the
// SAME settled-history check §S3a will use"); the anti-drift test at the foot
// of this file puts the DOOR inside the same pin, driving both against one
// narrowed record on one board and requiring both answers to move together.
//
// ── WHERE THE ENVELOPE NAMES THE LABEL ─────────────────────────────────────
//
// The door matches the DECLARED label against the claiming one, so an accepted
// call's claiming label IS the label the caller declared, and the place the
// envelope says it is the stored row's own `release` — asserted below by
// re-reading the queue. `cr-plan`'s answer carries no separate
// derivation-provenance field today and this file INVENTS none; what it does
// assert is that a cr claimed by a DIFFERENT recorded release is refused for
// the label it did not ship in, which is the only observable the claiming
// label decides.
//
// ── WHAT IS SYNTHETIC AND WHAT IS LIVE ─────────────────────────────────────
//
// Every fixture board is synthetic and in-memory: booted on an OS-assigned
// port against an mkdtempSync scratch db, with ids in this suite's own
// `CR-118H-*` shape, which belongs to no project. The live data/crucible.db
// and port 3849 are never WRITTEN by anything in this file.
//
// The derivability census is the one exception the AC names, and it is a READ:
// "all 62 are derivable" is a claim about THIS board, and asserting it against
// a fixture would make it a claim about the fixture. It reads the live board
// the sibling suite's way — the project named by the repo root's `.env`,
// reached at `$CRUCIBLE_URL` — over GET only, and STATES its reason and
// returns when the board cannot be read, because off this workstation `.env`
// is gitignored and the store it serves is never committed.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import type { QueueEntryInput } from "../src/store.ts";

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
  [key: string]: unknown;
}

interface ReleaseWire {
  version?: string;
  commit?: string;
  crs?: string[];
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
  releases?: ReleaseWire[];
  warnings?: Array<{ code: string; message: string; crs?: string[] }>;
  [key: string]: unknown;
}

const ORCH = "orchestrator-1";

/** The label already SHIPPED: its proposal is consumed, its provenance lives
 *  on the release record's own `crs` set. The door §S3a opens. */
const SHIPPED = "0.1.0";

/** A SECOND shipped label, so "a recorded release claims this cr" can be told
 *  apart from "the recorded release the caller DECLARED claims this cr". */
const ALSO_SHIPPED = "0.1.2";

/** The label still in flight: a live proposal, planned into as it is today. */
const IN_FLIGHT = "0.2.0";

/** A label nobody proposed and no release recorded — the refusal this CR may
 *  not widen. */
const UNKNOWN_LABEL = "9.9.9";

/** CR-CRU-091 §S8's refusal for a label holding no live proposal, as shipped
 *  (`declareMembership`, src/v2.ts). §S3a adds a door and widens no existing
 *  refusal, so this sentence is asserted VERBATIM. */
function unproposedSentence(release: string): string {
  return `release ${release} has no live proposal — it is not a plannable target`;
}

/** `roadmapHints.unproposedRelease` (src/hints.ts) — the shipped help[]. */
function unproposedHelp(release: string): string[] {
  return [
    `release-propose --label ${release} — the super container must exist before a CR can target it`,
    `GET /api/v2/projects/<key>/release-proposals — the live proposals a CR can be planned into`,
    `a release that has already SHIPPED is settled history and is no longer a plannable target for ${release}`,
  ];
}

/** CR-CRU-091 §S8's requiredness sentence (`RELEASE_REQUIRED`, src/v2.ts) —
 *  the bulk rung's refusal for a row nothing claims. */
const RELEASE_REQUIRED = "`release` is required — the release this cr targets";

/** The commit that IDENTIFIES a shipped release: a release is (type, label,
 *  commit), and CR-CRU-081 §S3's one correction path matches on that identity.
 *  The anti-drift pin narrows a record through it. */
const SHIPPED_COMMIT = "0f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f";
const ALSO_SHIPPED_COMMIT = "0e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e";

// ── the live board, read for the derivability census ───────────────────────

/** How long a live-board READ may take before it counts as "no board", and
 *  how long the census TEST may take. Generous against a measured ~2.3s read:
 *  the number being defended is a board fact and a slow answer is still an
 *  answer; only silence is a skip. */
const LIVE_BOARD_READ_BUDGET = 20_000;
const CENSUS_TEST_BUDGET = 45_000;

function liveProjectKey(): { key: string } | { skip: string } {
  try {
    const env = readFileSync(join(REPO_ROOT, ".env"), "utf8");
    const key = /^CRUCIBLE_PROJECT_KEY=(.+)$/m.exec(env)?.[1]?.trim() ?? "";
    if (key === "") return { skip: "the repo root's .env declares no CRUCIBLE_PROJECT_KEY" };
    return { key };
  } catch (failure) {
    const said = failure instanceof Error ? failure.message : String(failure);
    return { skip: `the repo root has no readable .env to name the live project (${said})` };
  }
}

/**
 * The live board's queue AND its recorded releases, or the reason neither
 * could be read. GET ONLY — nothing in this file writes to the live board.
 */
async function liveBoard(): Promise<
  { entries: QueueEntryWire[]; releases: ReleaseWire[]; at: string } | { skip: string }
> {
  const named = liveProjectKey();
  if ("skip" in named) return named;
  const base = process.env.CRUCIBLE_URL ?? "http://localhost:3849";
  try {
    // BOUNDED, for the sibling suite's reason: an unbounded read turns a busy
    // board into a test TIMEOUT, which reads as a failed invariant rather than
    // as a board that did not answer. An abort lands in the same STATED skip.
    const signal = AbortSignal.timeout(LIVE_BOARD_READ_BUDGET);
    const [queue, releases] = await Promise.all([
      fetch(`${base}/api/v2/projects/${named.key}/queue`, { signal }),
      fetch(`${base}/api/v2/projects/${named.key}/releases`, { signal }),
    ]);
    if (!queue.ok) throw new Error(`queue answered HTTP ${queue.status}`);
    if (!releases.ok) throw new Error(`releases answered HTTP ${releases.status}`);
    const queueBody = (await queue.json()) as { entries?: QueueEntryWire[] };
    const releaseBody = (await releases.json()) as { releases?: ReleaseWire[] };
    return { entries: queueBody.entries ?? [], releases: releaseBody.releases ?? [], at: base };
  } catch (failure) {
    const said = failure instanceof Error ? failure.message : String(failure);
    return { skip: `no live board answered at ${base} (${said}), and its store is never committed` };
  }
}

function releaseLess(entry: QueueEntryWire): boolean {
  return entry.release === undefined || entry.release === null || entry.release === "";
}

/** LANDED work: history, whose provenance lives on a release record's `crs`
 *  set rather than on the queue row. */
function landed(entry: QueueEntryWire): boolean {
  return entry.status === "COMPLETED" || entry.status === "COMPLETED_UNTRACKED";
}

/** `recordedReleaseClaiming`'s rule, applied to whatever release records were
 *  read: the FIRST recorded release whose own `crs` names the cr. Written here
 *  as the census's own derivation so the census measures the RULE against the
 *  board rather than re-asking the server the question under test. */
function claimingLabels(releases: ReleaseWire[]): Map<string, string> {
  const claiming = new Map<string, string>();
  for (const release of releases) {
    const label = release.version ?? "an unlabelled release";
    for (const cr of release.crs ?? []) if (!claiming.has(cr)) claiming.set(cr, label);
  }
  return claiming;
}

// ── the synthetic board's rows ─────────────────────────────────────────────

interface Row {
  cr: string;
  title: string;
  wave: string;
  release?: string;
}

/** The landed 0.1.0-era rows, in the live board's shape: release-less on the
 *  row, named by the SHIPPED release's own `crs` set — which is what makes
 *  them read COMPLETED_UNTRACKED and what §S3a derives membership from. */
function landedHistory(): Row[] {
  return Array.from({ length: 8 }, (_unused, index) => ({
    cr: `CR-118H-L${String(index + 1).padStart(2, "0")}`,
    title: `0.1.0-era row ${index + 1}`,
    wave: String((index % 4) + 1),
  }));
}

/** The row a SECOND shipped release claims — the instrument that tells "some
 *  recorded release names this cr" apart from "the DECLARED one does". */
const OTHER_RELEASES_ROW: Row = {
  cr: "CR-118H-OTHER",
  title: "shipped by a different release",
  wave: "2",
};

/** A release-less row NO release record names: deferred work, not history. It
 *  is the door's self-check — settled fact does not claim it. */
const UNCLAIMED_ROW: Row = {
  cr: "CR-118H-UNCLAIMED",
  title: "deferred, never given a release, claimed by nothing",
  wave: "7",
};

/** The rows of the release currently IN FLIGHT. */
const ACTIVE: Row[] = [
  { cr: "CR-118H-A1", title: "in the release being cut", wave: "5", release: IN_FLIGHT },
  { cr: "CR-118H-A2", title: "in the release being cut", wave: "5", release: IN_FLIGHT },
];

function toInput(row: Row): QueueEntryInput {
  return {
    cr: row.cr,
    title: row.title,
    wave: row.wave,
    dependsOn: [],
    ...(row.release !== undefined ? { release: row.release } : {}),
  };
}

/** What a RESTORE posts: the board as it HELD it, so a row that carried a
 *  release carries it here too. On an EMPTY board nothing carries anything
 *  forward, so the derivation rung is the only thing standing between settled
 *  history and a refusal — which is what the anti-drift pin drives. */
function restoreTable(rows: Row[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    cr: row.cr,
    title: row.title,
    wave: row.wave,
    dependsOn: [],
    ...(row.release !== undefined ? { release: row.release } : {}),
  }));
}

describe("CR-CRU-118 §S3a — historical membership is a derivation, not a plan", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "cru118-historical-"));
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

  function rowFor(list: QueueEntryWire[], cr: string): QueueEntryWire | undefined {
    return list.find((entry) => entry.cr === cr);
  }

  /**
   * The board AS HISTORY LEFT IT, seeded through the STORE rather than the
   * route: after §S2 the bulk route REFUSES to insert a release-less row, so
   * the door that created these rows is the one being closed. Seeding them
   * through it would make the fixture unbuildable, and would prove nothing —
   * the whole point is that they are already there.
   */
  function seedHistory(key: string, rows: Row[]): void {
    handle!.store.replaceQueue(key, rows.map(toInput));
  }

  /** Record a SHIPPED release, naming the rows in its own `crs` set — which is
   *  what makes them read COMPLETED_UNTRACKED and what the door derives from. */
  async function ship(key: string, label: string, crs: string[], commit?: string): Promise<void> {
    await propose(key, label);
    const shipped = await post("/api/v2/milestones", {
      projectKey: key,
      agentId: ORCH,
      type: "release",
      label,
      crs,
      ...(commit !== undefined ? { commit } : {}),
    });
    expect([200, 201]).toContain(shipped.status);
  }

  /**
   * NARROW a recorded release's own `crs` — the ONE correction path through a
   * release's immutability (CR-CRU-081 §S3 `repairProvenance`, asked for
   * explicitly). The held record keeps its identity and only the provenance it
   * re-derived is written over, so this is settled history genuinely changing
   * its mind about what it shipped. What it dropped travels back on `shrink`
   * (CR-CRU-086 §S3), which is what proves the narrowing HAPPENED rather than
   * replaying as a no-op.
   */
  async function narrowRelease(
    key: string,
    label: string,
    commit: string,
    crs: string[],
  ): Promise<string[]> {
    const repaired = await post("/api/v2/milestones", {
      projectKey: key,
      agentId: ORCH,
      type: "release",
      label,
      commit,
      crs,
      repairProvenance: true,
    });
    expect([200, 201]).toContain(repaired.status);
    const shrink = repaired.body.shrink as { removed?: string[] } | undefined;
    return shrink?.removed ?? [];
  }

  /** `cr-plan`, at the shape the five clients post it: the backfill re-states
   *  the row's OWN wave and title, so the only thing the call changes is the
   *  membership it derives. */
  async function plan(
    key: string,
    row: { cr: string; title: string; wave: string },
    release: string,
  ): Promise<{ status: number; body: AnyBody }> {
    return post(planPath(key), {
      agentId: ORCH,
      cr: row.cr,
      release,
      wave: row.wave,
      title: row.title,
    });
  }

  // ══ the door ═════════════════════════════════════════════════════════════

  test(
    "a landed cr the SHIPPED release record NAMES in its crs is planned into that label, and " +
      "the queue row reads back CARRYING it — read from the store, never trusted off the answer",
    async () => {
      boot();
      const key = await seed("cru118-s3a-derived");
      const history = landedHistory();
      const target = history[0]!;
      seedHistory(key, [...history, ...ACTIVE]);
      await ship(key, SHIPPED, history.map((row) => row.cr));
      await propose(key, IN_FLIGHT);

      const before = await entries(key);
      expect(
        releaseLess(rowFor(before, target.cr)!),
        "the fixture must start where the live board is: the landed row carries NO release, " +
          "which is the whole reason this door exists",
      ).toBe(true);
      expect(rowFor(before, target.cr)!.status).toBe("COMPLETED_UNTRACKED");

      const derived = await plan(key, target, SHIPPED);

      expect(
        derived.status,
        `cr-plan --release ${SHIPPED} for a cr that release's own crs NAMES answered ` +
          `${derived.status}: ${derived.body.error ?? "(no error)"}`,
      ).toBe(200);
      expect(derived.body.ok).toBe(true);

      // THE STORE, not the response body. The label the door derived from is
      // the label the row now carries — that is where this envelope says it.
      const after = await entries(key);
      const row = rowFor(after, target.cr);
      expect(row).toBeDefined();
      expect(row!.release).toBe(SHIPPED);
      // The backfill gives history back its membership and changes NOTHING
      // else: same wave, same row, no duplicate.
      expect(row!.wave).toBe(target.wave);
      expect(after.filter((entry) => entry.cr === target.cr)).toHaveLength(1);
      expect(after).toHaveLength(before.length);
      // BOUND — exactly ONE row acquired the shipped label. A door that gave
      // every claimed row a release at once would pass a bare "it carries it".
      expect(after.filter((entry) => entry.release === SHIPPED).map((entry) => entry.cr)).toEqual([
        target.cr,
      ]);
      // …and every other row is byte-identical to what history left.
      for (const other of before) {
        if (other.cr === target.cr) continue;
        expect(JSON.stringify(rowFor(after, other.cr))).toBe(JSON.stringify(other));
      }
    },
  );

  test(
    "the same call for a cr the record does NOT name is refused and writes nothing — the " +
      "derivation's self-check, and the proof this door cannot add scope to a shipped release",
    async () => {
      boot();
      const key = await seed("cru118-s3a-self-check");
      const history = landedHistory();
      seedHistory(key, [...history, UNCLAIMED_ROW, ...ACTIVE]);
      // Settled history names the eight landed rows and NOT the unclaimed one.
      await ship(key, SHIPPED, history.map((row) => row.cr));
      await propose(key, IN_FLIGHT);
      const before = await entries(key);

      const refused = await plan(key, UNCLAIMED_ROW, SHIPPED);

      expect(
        refused.status,
        `a cr no recorded release claims was answered ${refused.status} for --release ` +
          `${SHIPPED}: ${JSON.stringify(refused.body)}`,
      ).toBe(404);
      expect(refused.body.ok).toBe(false);
      expect(refused.body.error).toContain(SHIPPED);
      // §S5 — no bare refusal: the envelope names the move that fixes it. The
      // CR gives this case no NEW sentence, so what is pinned is the refusal
      // and its silence on the store, never a wording GREEN was not handed.
      expect(
        Array.isArray(refused.body.help) && refused.body.help.length > 0,
        `the refusal answered help=${JSON.stringify(refused.body.help)} — §S5 forbids a bare ` +
          `refusal, and the sibling unproposed-release refusal carries roadmapHints`,
      ).toBe(true);
      // THE STORE, byte for byte: a closed release gained no scope.
      const after = await entries(key);
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
      expect(releaseLess(rowFor(after, UNCLAIMED_ROW.cr)!)).toBe(true);

      // NON-VACUITY, on the SAME board: the door is genuinely open, so this
      // refusal is the derivation's self-check and not the door being shut.
      const admitted = await plan(key, history[0]!, SHIPPED);
      expect(
        admitted.status,
        `the claimed cr must be admitted on the very board that refused the unclaimed one, or ` +
          `the refusal above proves nothing: ${admitted.body.error ?? "(no error)"}`,
      ).toBe(200);
    },
  );

  test(
    "a cr claimed by a DIFFERENT recorded release is refused for the label it did not ship in, " +
      "and accepted for the one that names it — membership is derived from THAT release's crs",
    async () => {
      boot();
      const key = await seed("cru118-s3a-wrong-label");
      const history = landedHistory();
      seedHistory(key, [...history, OTHER_RELEASES_ROW, ...ACTIVE]);
      await ship(key, SHIPPED, history.map((row) => row.cr), SHIPPED_COMMIT);
      await ship(key, ALSO_SHIPPED, [OTHER_RELEASES_ROW.cr], ALSO_SHIPPED_COMMIT);
      await propose(key, IN_FLIGHT);
      const before = await entries(key);

      // The cr IS historical, and A recorded release does claim it — but not
      // the one being declared. "Old enough" is not the rule; the DECLARED
      // release's own crs is.
      const wrong = await plan(key, OTHER_RELEASES_ROW, SHIPPED);
      expect(
        wrong.status,
        `a cr shipped by ${ALSO_SHIPPED} was answered ${wrong.status} for --release ${SHIPPED}: ` +
          `${JSON.stringify(wrong.body)} — that would add scope to a closed release`,
      ).toBe(404);
      expect(JSON.stringify(await entries(key))).toBe(JSON.stringify(before));

      const right = await plan(key, OTHER_RELEASES_ROW, ALSO_SHIPPED);
      expect(
        right.status,
        `the release whose crs NAMES the cr must admit it: ${right.body.error ?? "(no error)"}`,
      ).toBe(200);
      expect(rowFor(await entries(key), OTHER_RELEASES_ROW.cr)!.release).toBe(ALSO_SHIPPED);
    },
  );

  test(
    "a label that is neither a live proposal nor a recorded release keeps TODAY'S refusal " +
      "VERBATIM, for a landed cr too — this CR adds a door and widens no existing one",
    async () => {
      boot();
      const key = await seed("cru118-s3a-unknown-label");
      const history = landedHistory();
      seedHistory(key, [...history, ...ACTIVE]);
      await ship(key, SHIPPED, history.map((row) => row.cr));
      await propose(key, IN_FLIGHT);
      const before = await entries(key);

      // The SHARP case: the cr IS claimed by settled history, so the door is
      // reachable for it — and the label it declares is claimed by nothing at
      // all. Being historical must buy no label but its own.
      const refused = await plan(key, history[0]!, UNKNOWN_LABEL);

      expect(refused.status).toBe(404);
      expect(refused.body.error).toBe(unproposedSentence(UNKNOWN_LABEL));
      expect(refused.body.help).toEqual(unproposedHelp(UNKNOWN_LABEL));
      expect(JSON.stringify(await entries(key))).toBe(JSON.stringify(before));
    },
  );

  test(
    "a LIVE proposal still takes precedence unchanged: a cr no release record names is planned " +
      "into the in-flight label with no crs membership required",
    async () => {
      boot();
      const key = await seed("cru118-s3a-live-precedence");
      const history = landedHistory();
      seedHistory(key, [...history, ...ACTIVE]);
      await ship(key, SHIPPED, history.map((row) => row.cr));
      await propose(key, IN_FLIGHT);

      // An in-flight release has SHIPPED nothing, so no record claims this cr
      // — and it is planned in anyway. That is the untouched half of the rule.
      const born = { cr: "CR-118H-BORN", title: "born after the branch was cut", wave: "6" };
      const planned = await plan(key, born, IN_FLIGHT);

      expect(planned.status).toBe(200);
      expect(planned.body.ok).toBe(true);
      const row = rowFor(await entries(key), born.cr);
      expect(row).toBeDefined();
      expect(row!.release).toBe(IN_FLIGHT);
      expect(row!.wave).toBe("6");

      // NEGATIVE — the in-flight label really is claimed by NO release record,
      // so acceptance cannot have come through §S3a's door. If it had, this
      // test would be measuring the new rule instead of the old one.
      const recorded = await get(`/api/v2/projects/${key}/releases`);
      expect(recorded.status).toBe(200);
      expect((recorded.body.releases ?? []).map((release) => release.version)).not.toContain(
        IN_FLIGHT,
      );
      // …and a cr that settled history DOES claim is still free to be planned
      // into the live proposal: the derivation widens the acceptable labels,
      // it never narrows them to "the one that shipped you".
      const replanned = await plan(key, history[1]!, IN_FLIGHT);
      expect(replanned.status).toBe(200);
      expect(rowFor(await entries(key), history[1]!.cr)!.release).toBe(IN_FLIGHT);
    },
  );

  // ══ the anti-drift pin — ONE derivation, two doors ═══════════════════════

  test(
    "§S2's insert rung and §S3a's door are the SAME derivation (recordedReleaseClaiming): " +
      "NARROWING the release record's own crs flips BOTH answers together, for that cr and no other",
    async () => {
      boot();
      const key = await seed("cru118-s3a-one-derivation");
      const history = landedHistory();
      const dropped = history[0]!;
      const kept = history[1]!;
      const table = [...history, ...ACTIVE];
      // Recorded WITH a commit: a release is identified by (type, label,
      // commit), and the correction path this test drives matches on that.
      await ship(key, SHIPPED, history.map((row) => row.cr), SHIPPED_COMMIT);
      await propose(key, IN_FLIGHT);

      // ── WIDE: the record names every landed row ─────────────────────────
      //
      // DOOR ONE, §S2's rung, on the wiped board a restore actually meets:
      // every entry is an INSERT, and the release-less landed rows are
      // admitted because settled history claims them.
      expect(await entries(key)).toHaveLength(0);
      const restoredWide = await post(queuePath(key), {
        agentId: ORCH,
        entries: restoreTable(table),
      });
      expect(
        restoredWide.body.ok,
        `the wide restore answered ${restoredWide.status}: ` +
          `${restoredWide.body.error ?? "(no error)"}`,
      ).toBe(true);
      expect((await entries(key)).map((entry) => entry.cr)).toContain(dropped.cr);

      // DOOR TWO, §S3a's, on the board that restore just wrote: the same cr,
      // the same settled fact, the other verb.
      const plannedWide = await plan(key, dropped, SHIPPED);
      expect(
        plannedWide.status,
        `while the record still named ${dropped.cr}, cr-plan answered ${plannedWide.status}: ` +
          `${plannedWide.body.error ?? "(no error)"}`,
      ).toBe(200);
      expect(rowFor(await entries(key), dropped.cr)!.release).toBe(SHIPPED);

      // ── NARROW settled history itself ───────────────────────────────────
      const removed = await narrowRelease(
        key,
        SHIPPED,
        SHIPPED_COMMIT,
        history.slice(1).map((row) => row.cr),
      );
      expect(
        removed,
        "the repair must actually SHRINK the record — a replay that changed nothing would " +
          "leave this test asserting the wide answer twice",
      ).toEqual([dropped.cr]);

      // Back to the wiped board through the STORE: the rung decides INSERTS,
      // so it must meet the same empty board the wide half did. Re-posting
      // onto a written board would meet `replaceQueue`'s carry-forward instead
      // and would prove nothing about the derivation.
      seedHistory(key, []);
      expect(await entries(key)).toHaveLength(0);

      // DOOR ONE, again: the identical restore is now refused, by cr.
      const restoredNarrow = await post(queuePath(key), {
        agentId: ORCH,
        entries: restoreTable(table),
      });
      expect(
        restoredNarrow.status,
        `after the record dropped ${dropped.cr}, the identical restore answered ` +
          `${restoredNarrow.status}: ${restoredNarrow.body.error ?? "(no error)"}`,
      ).toBe(400);
      expect(restoredNarrow.body.error).toContain(dropped.cr);
      expect(restoredNarrow.body.error).toContain(RELEASE_REQUIRED);
      expect(await entries(key)).toHaveLength(0);

      // DOOR TWO, again, on a board rebuilt without the route: the SAME fact
      // moved, so the SAME answer must move. Two copies of this rule would
      // drift here — the rung refusing while the door still admitted.
      seedHistory(key, table);
      const plannedNarrow = await plan(key, dropped, SHIPPED);
      expect(
        plannedNarrow.status,
        `the rung refuses ${dropped.cr} and cr-plan answered ${plannedNarrow.status} for the ` +
          `same cr against the same record — the two doors must read ONE derivation`,
      ).toBe(404);
      expect(releaseLess(rowFor(await entries(key), dropped.cr)!)).toBe(true);

      // …and ONLY for the cr the record dropped. Both doors still admit a row
      // settled history still names, so what moved is the derivation's INPUT
      // and not the rule reading it.
      const plannedKept = await plan(key, kept, SHIPPED);
      expect(
        plannedKept.status,
        `the record still names ${kept.cr}: ${plannedKept.body.error ?? "(no error)"}`,
      ).toBe(200);
      expect(rowFor(await entries(key), kept.cr)!.release).toBe(SHIPPED);

      seedHistory(key, []);
      const restoredWithout = await post(queuePath(key), {
        agentId: ORCH,
        entries: restoreTable([...history.slice(1), ...ACTIVE]),
      });
      expect([200, 202]).toContain(restoredWithout.status);
      expect(await entries(key)).toHaveLength(table.length - 1);
    },
  );

  // ══ the migration's precondition, censused against the live board ════════

  test(
    "every landed release-less row on the LIVE board is derivable — the backfill's precondition " +
      "is a measured fact, not an assumption",
    async () => {
      const board = await liveBoard();
      if ("skip" in board) {
        console.log(`[CR-CRU-118] §S3a derivability census NOT RUN: ${board.skip}`);
        return;
      }
      // Non-vacuity: a census over an empty read would pass for the wrong
      // reason, and "all of them are derivable" is only a fact about a board
      // that HAS them.
      expect(
        board.entries.length,
        `the live board at ${board.at} answered with no queue entries at all — a census over an ` +
          `empty read measures nothing`,
      ).toBeGreaterThan(0);
      const backlog = board.entries.filter((entry) => releaseLess(entry) && landed(entry));
      expect(
        backlog.length,
        `the live board at ${board.at} holds no landed release-less rows — the migration §S3a ` +
          `exists for has nothing to migrate, which is not the measured state (62 on 2026-09-10)`,
      ).toBeGreaterThan(0);

      const claiming = claimingLabels(board.releases);
      const orphans = backlog.filter((entry) => !claiming.has(entry.cr));
      expect(
        orphans.map((entry) => entry.cr),
        `${orphans.length} of ${backlog.length} landed release-less rows on the board at ` +
          `${board.at} are named by NO recorded release, so §S3a's door cannot reach them and ` +
          `the backfill would leave the mandate unclosable for those ids`,
      ).toEqual([]);
      // …and the labels they derive from are labels a caller can DECLARE: a
      // claim by a release recorded without one is not a plannable answer.
      const unlabelled = backlog.filter(
        (entry) => claiming.get(entry.cr) === "an unlabelled release",
      );
      expect(
        unlabelled.map((entry) => entry.cr),
        `these landed rows are claimed only by a release recorded with NO label, so no ` +
          `cr-plan --release <label> can name it`,
      ).toEqual([]);
    },
    CENSUS_TEST_BUDGET,
  );
});
