// The release ceremony's provenance report reads the CR queue as JSON and does
// not report VOID or SUPERSEDED work as unplaceable (RED).
//
// `report_unplaceable_crs` (scripts/release.sh) — reached from `report_release`
// on `finish` and from `cmd_backfill_releases` — names the queued CRs Crucible
// holds no landing record for, in two classes: landing evidence EVICTED (a
// stored release record names the CR) and NEVER landed. A queue row whose
// `lifecycle` is VOID or SUPERSEDED is not queued work: the work is not
// happening, or it happens under its successor. Such a row belongs in neither
// list. The queue is read ONCE through the client's `queue --format json` and
// parsed as JSON — the way `plan_merge_map` parses `landings` — never by
// splitting the text envelope's table rows on commas, which misreads every
// field after a quoted title holding a comma.
//
// TECHNIQUE — the harness tests/release-reporting-live.test.ts established:
// the REAL ceremony (`bash scripts/release.sh`) driven against a REAL
// in-process server through the REAL repo client (`<world>/clients` is a
// symlink to the repo's `clients/`), with only `git` stubbed on PATH. Every
// fixture row is written through the server's own surfaces: the queue through
// `Store.replaceQueue` (as tests/release-provenance.test.ts seeds it), the
// dispositions through the same `…/queue/<cr>/void` and `…/queue/<cr>/supersede`
// routes the client's `cr-void` / `cr-supersede` post to, and the stored
// release record through `POST /api/v2/milestones`. Each behavioural test
// first PROVES its fixture through the HTTP read surface, so a pass can never
// be a queue that silently held nothing.
//
// The ceremony is spawned ASYNCHRONOUSLY: `Bun.spawnSync` blocks the event
// loop, so the in-process server could never answer the client.
//
// SAFETY: the server listens on an OS-assigned port over a per-test `mktemp`
// db, never the operator's board or database, and is stopped by its own handle.
// No real git, no remote, no push.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import { declareClientBoard } from "./helpers/client-board.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const RELEASE_SH = join(REPO_ROOT, "scripts", "release.sh");

/** The version `finish` cuts, and the sha its tag points at. */
const VERSION = "0.4.0";
const TAGGED_SHA = "abc1234def5678abc1234def5678abc1234def56";

/** The identity the ceremony declares, registered live as an ORCHESTRATOR —
 *  the role the queue's void/supersede routes require of their caller. */
const AGENT_ID = "release-ceremony-1";

/** The already-shipped tags `backfill-releases` replays, and each one's commit. */
const SHIPPED: ReadonlyArray<readonly [string, string]> = [
  ["0.1.0", "c07274c8ab0000000000000000000000000000aa"],
  ["0.1.1", "abc30d5700000000000000000000000000000bb0"],
  ["0.1.2", "9ef24b1800000000000000000000000000000cc0"],
];

/** The tag's own commit date, epoch SECONDS, as the stub `git log` answers it. */
const SHIP_DATE = Date.UTC(2026, 5, 12, 8, 15, 0) / 1000;

// ── The dead-and-live queue: nothing in it has landed ──────────────────────

/** VOID — the work is not happening. Its title holds a comma, the shape a
 *  reader that splits table rows on commas misreads. */
const VOID_CR = "CR-CRU-901";
const VOID_TITLE = "a tier is claimed, never measured";

/** SUPERSEDED by `LIVE_CR` — the work still happens, under the successor. */
const SUPERSEDED_CR = "CR-CRU-902";
const SUPERSEDED_TITLE = "measure the tier the old way";

/** The ONE live CR: PENDING, the successor of `SUPERSEDED_CR`, never landed.
 *  The only id the never-landed list may hold. Its title holds a comma too, so
 *  a reader that loses a comma-titled row loses this one as well. */
const LIVE_CR = "CR-CRU-903";
const LIVE_TITLE = "measure the tier, then claim it";

// ── The voided-then-named queue ────────────────────────────────────────────

/** VOID, and THEN named by a stored release record — so the board derives it
 *  COMPLETED_UNTRACKED, the status the evicted class is read from. */
const VOID_NAMED_CR = "CR-CRU-911";
const VOID_NAMED_TITLE = "drop the old reader, keep the new one";

/** Live, named by the same stored release, no landing record anywhere: the
 *  genuinely evicted CR, which must STILL be reported as evicted. */
const EVICTED_CR = "CR-CRU-912";

/** Live, named by nothing, never landed: the never-landed control. */
const QUEUED_CR = "CR-CRU-913";

/** The stored release that names `VOID_NAMED_CR` and `EVICTED_CR`. A label
 *  neither `finish` (VERSION) nor the backfill (SHIPPED) writes, so neither
 *  run touches the record. */
const STORED_RELEASE = "0.0.9";
const STORED_RELEASE_COMMIT = "5ee0d00000000000000000000000000000000009";
const STORED_RELEASE_AT = Date.UTC(2026, 4, 1, 12, 0, 0) / 1000;

/**
 * Stub `git` — the surface `release.sh finish` and `release.sh
 * backfill-releases` drive (tests/release-reporting-live.test.ts's stub).
 * Knobs (env): RSH_ROOT (`rev-parse --show-toplevel`, the world), RSH_BRANCH,
 * RSH_TAG (the tag `finish` cut), RSH_SHA (its commit), RSH_TAGS (what `git
 * tag` lists), RSH_SHIP (`log -1 --format=%ct`).
 */
const GIT_STUB = `#!/bin/sh
printf 'git %s\\n' "$*" >> "$RSH_LOG"
case "$*" in
  *show*HEAD:CHANGELOG.md*)
    cat "$RSH_ROOT/CHANGELOG.md"; exit $? ;;
esac
case "$1" in
  rev-parse)
    case "$*" in
      *--abbrev-ref*) echo "$RSH_BRANCH"; exit 0 ;;
      *--show-toplevel*) echo "$RSH_ROOT"; exit 0 ;;
      *) echo "$RSH_SHA"; exit 0 ;;
    esac ;;
  config)
    echo ""; exit 0 ;;
  describe)
    [ -n "$RSH_TAG" ] || exit 128
    echo "$RSH_TAG"; exit 0 ;;
  log)
    echo "$RSH_SHIP"; exit 0 ;;
  tag)
    for t in $RSH_TAGS; do echo "$t"; done
    exit 0 ;;
  rev-list)
    for a in "$@"; do tag="$a"; done
    case "$tag" in
      0.1.0) echo "${SHIPPED[0]![1]}"; exit 0 ;;
      0.1.1) echo "${SHIPPED[1]![1]}"; exit 0 ;;
      0.1.2) echo "${SHIPPED[2]![1]}"; exit 0 ;;
      *)
        if [ -n "$RSH_TAG" ] && [ "$tag" = "$RSH_TAG" ]; then echo "$RSH_SHA"; exit 0; fi
        exit 128 ;;
    esac ;;
  diff)
    exit 0 ;;
  add|commit|flow|push)
    exit 0 ;;
  *)
    exit 0 ;;
esac
`;

interface QueueRow {
  cr: string;
  title?: string;
  status: string;
  lifecycle?: { state: string; by?: string; reason?: string };
}

/** One queue row's fixture premise: its derived status, its lifecycle state
 *  (null for a live row) and, for a superseded row, its successor. */
interface RowPremise {
  status: string;
  lifecycle: string | null;
  by?: string;
}

/** The ceremony's unplaceable report, read apart into its classes. */
interface UnplaceableReport {
  /** Every line of the report that says "unplaceable". */
  lines: string[];
  /** The never-landed line(s). */
  neverLanded: string[];
  /** The landing-evidence-evicted line(s). */
  evicted: string[];
}

/** The ids a report line names: everything after its LAST `: `, space-separated. */
function idsOf(line: string): string[] {
  const at = line.lastIndexOf(": ");
  if (at < 0) return [];
  return line
    .slice(at + 2)
    .trim()
    .split(/\s+/)
    .filter((id) => id.length > 0)
    .sort();
}

/** The count a report line states (`provenance: N unplaceable …`), or null. */
function countOf(line: string): number | null {
  const m = /provenance:\s+(\d+)\s+unplaceable/.exec(line);
  return m === null ? null : Number(m[1]);
}

function readReport(output: string): UnplaceableReport {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /unplaceable/i.test(l));
  return {
    lines,
    neverLanded: lines.filter((l) => /NEVER landed/.test(l)),
    evicted: lines.filter((l) => /EVICTED/.test(l)),
  };
}

/** The report lines that mention `cr` at all — must be none for dead work. */
function linesNaming(report: UnplaceableReport, cr: string): string[] {
  return report.lines.filter((l) => l.split(/[\s:,]+/).includes(cr)).map((l) => idsOf(l).join(" "));
}

describe("the release ceremony's provenance report does not count VOID or SUPERSEDED work as unplaceable", () => {
  let handle: ServerHandle | undefined;
  const worlds: string[] = [];
  const dbDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const w of worlds.splice(0)) rmSync(w, { recursive: true, force: true });
    for (const d of dbDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** An in-process server on an OS-assigned port over a throwaway db. */
  function boot(): string {
    const dir = mkdtempSync(join(tmpdir(), "release-skips-voided-db-"));
    dbDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
    return `http://localhost:${handle.server.port}`;
  }

  async function postJson(base: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** A project, the ceremony's identity registered as ORCHESTRATOR, and the
   *  given queue rows (every one live, PENDING, unplanned on arrival). */
  async function seedProject(
    base: string,
    name: string,
    rows: ReadonlyArray<{ cr: string; title: string }>,
  ): Promise<string> {
    const res = await postJson(base, "/api/v2/projects", { name });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: { key: string } };
    const key = body.project.key;
    const reg = await postJson(base, "/api/v2/agents/register", {
      projectKey: key,
      agentId: AGENT_ID,
      role: "ORCHESTRATOR",
    });
    expect(reg.status).toBe(200);
    handle!.store.replaceQueue(
      key,
      rows.map(({ cr, title }) => ({ cr, title, wave: "1", dependsOn: [] })),
    );
    return key;
  }

  /** `cr-void`'s route: POST …/queue/<cr>/void {agentId, reason}. */
  async function voidCr(base: string, key: string, cr: string, reason: string): Promise<void> {
    const res = await postJson(base, `/api/v2/projects/${key}/queue/${cr}/void`, { agentId: AGENT_ID, reason });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);
  }

  /** `cr-supersede`'s route: POST …/queue/<cr>/supersede {agentId, by}. */
  async function supersedeCr(base: string, key: string, cr: string, by: string): Promise<void> {
    const res = await postJson(base, `/api/v2/projects/${key}/queue/${cr}/supersede`, { agentId: AGENT_ID, by });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);
  }

  /** A stored release record, written at the server's production entry. */
  async function plantRelease(base: string, key: string, crs: readonly string[]): Promise<void> {
    const res = await postJson(base, "/api/v2/milestones", {
      projectKey: key,
      agentId: AGENT_ID,
      type: "release",
      label: STORED_RELEASE,
      commit: STORED_RELEASE_COMMIT,
      releasedAt: STORED_RELEASE_AT,
      crs,
    });
    expect(res.status).toBe(201);
  }

  async function queueRows(base: string, key: string): Promise<QueueRow[]> {
    const res = await fetch(`${base}/api/v2/projects/${key}/queue`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { entries?: QueueRow[] }).entries ?? [];
  }

  async function plansFor(base: string, key: string, cr: string): Promise<unknown[]> {
    const res = await fetch(`${base}/api/v2/projects/${key}/plans?cr=${cr}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { plans?: unknown[] }).plans ?? [];
  }

  async function crMergedRecords(base: string, key: string): Promise<unknown[]> {
    const res = await fetch(`${base}/api/v2/projects/${key}/milestones?type=cr-merged`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { milestones?: unknown[] }).milestones ?? [];
  }

  async function storedReleases(base: string, key: string): Promise<Array<{ version?: string; crs?: string[] }>> {
    const res = await fetch(`${base}/api/v2/projects/${key}/releases`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { releases: Array<{ version?: string; crs?: string[] }> }).releases;
  }

  /**
   * FIXTURE PRECONDITION, through the HTTP read surface: the queue holds
   * EXACTLY these rows with these statuses and lifecycles, and none of them has
   * a landing record at any source (no plan at all, no `cr-merged` record).
   */
  async function expectQueueHolds(base: string, key: string, premise: Record<string, RowPremise>): Promise<QueueRow[]> {
    const rows = await queueRows(base, key);
    const seen: Record<string, RowPremise> = {};
    for (const row of rows) {
      seen[row.cr] = {
        status: row.status,
        lifecycle: row.lifecycle?.state ?? null,
        ...(row.lifecycle?.by !== undefined ? { by: row.lifecycle.by } : {}),
      };
    }
    expect(seen).toEqual(premise);
    for (const cr of Object.keys(premise)) expect(await plansFor(base, key, cr)).toEqual([]);
    expect(await crMergedRecords(base, key)).toEqual([]);
    return rows;
  }

  /** A throwaway world whose `clients/` is the REAL repo client directory and
   *  whose `.env` points the client at the live project. */
  function makeWorld(projectKey: string): { root: string; log: string } {
    const root = mkdtempSync(join(tmpdir(), "release-skips-voided-world-"));
    worlds.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const log = join(root, "argv.log");
    writeFileSync(log, "");
    writeFileSync(join(root, "package.json"), `{\n  "name": "crucible",\n  "version": "${VERSION}"\n}\n`);
    writeFileSync(
      join(root, "CHANGELOG.md"),
      `# Changelog\n\n## [${VERSION}] - 2026-10-21\n\n### Fixed\n\n- The release this world finishes.\n`,
    );
    writeFileSync(join(root, ".env"), `CRUCIBLE_PROJECT_KEY=${projectKey}\n`);
    symlinkSync(join(REPO_ROOT, "clients"), join(root, "clients"));
    writeFileSync(join(bin, "git"), GIT_STUB);
    chmodSync(join(bin, "git"), 0o755);
    writeFileSync(join(bin, "curl"), `#!/bin/sh\nprintf 'curl %s\\n' "$*" >> "$RSH_LOG"\nexit 7\n`);
    chmodSync(join(bin, "curl"), 0o755);
    return { root, log };
  }

  /** Runs `release.sh <args…>` against the world; stdout and stderr joined. */
  async function runCeremony(
    base: string,
    world: { root: string; log: string },
    args: string[],
  ): Promise<{ exitCode: number; output: string }> {
    const env: Record<string, string> = {
      PATH: [join(world.root, "bin"), ...(process.env.PATH ?? "").split(":").filter((d) => d.length > 0)].join(":"),
      HOME: world.root,
      SHELL: "/bin/sh",
      RSH_LOG: world.log,
      RSH_ROOT: world.root,
      RSH_BRANCH: `release/${VERSION}`,
      RSH_TAG: VERSION,
      RSH_SHA: TAGGED_SHA,
      RSH_TAGS: SHIPPED.map(([v]) => v).join(" "),
      RSH_SHIP: String(SHIP_DATE),
      PY_CRUCIBLE_PROJECT_DIR: world.root,
      CRUCIBLE_AGENT: AGENT_ID,
    };
    declareClientBoard(base, world.root);
    const proc = Bun.spawn({
      cmd: ["bash", RELEASE_SH, ...args],
      cwd: world.root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, output: `${stdout}\n${stderr}` };
  }

  /** The queue of a VOID (comma-titled), a SUPERSEDED and a PENDING CR — the
   *  PENDING one the successor — none landed, proven before it is returned. */
  async function deadAndLiveQueue(base: string, name: string): Promise<string> {
    const key = await seedProject(base, name, [
      { cr: VOID_CR, title: VOID_TITLE },
      { cr: SUPERSEDED_CR, title: SUPERSEDED_TITLE },
      { cr: LIVE_CR, title: LIVE_TITLE },
    ]);
    await voidCr(base, key, VOID_CR, "the tier is never measured, so the claim is withdrawn");
    await supersedeCr(base, key, SUPERSEDED_CR, LIVE_CR);

    const rows = await expectQueueHolds(base, key, {
      [VOID_CR]: { status: "PENDING", lifecycle: "VOID" },
      [SUPERSEDED_CR]: { status: "PENDING", lifecycle: "SUPERSEDED", by: LIVE_CR },
      [LIVE_CR]: { status: "PENDING", lifecycle: null },
    });
    // The comma really is in the stored title the client serves.
    expect(rows.find((r) => r.cr === VOID_CR)?.title).toBe(VOID_TITLE);
    expect(rows.find((r) => r.cr === LIVE_CR)?.title).toBe(LIVE_TITLE);
    // No stored release names any of them, so none is an eviction candidate.
    expect(await storedReleases(base, key)).toEqual([]);
    return key;
  }

  /** The queue holding a CR voided BEFORE a stored release named it, beside a
   *  live CR the same release names and a live CR nothing names. */
  async function voidedThenNamedQueue(base: string, name: string): Promise<string> {
    const key = await seedProject(base, name, [
      { cr: VOID_NAMED_CR, title: VOID_NAMED_TITLE },
      { cr: EVICTED_CR, title: "the record that lost its landing" },
      { cr: QUEUED_CR, title: "queued work, not yet started" },
    ]);
    // Void FIRST: the server refuses to void a CR a stored release names.
    await voidCr(base, key, VOID_NAMED_CR, "dropped before it shipped");
    await plantRelease(base, key, [VOID_NAMED_CR, EVICTED_CR]);

    await expectQueueHolds(base, key, {
      // COMPLETED_UNTRACKED is what puts a row in the evicted class's input.
      [VOID_NAMED_CR]: { status: "COMPLETED_UNTRACKED", lifecycle: "VOID" },
      [EVICTED_CR]: { status: "COMPLETED_UNTRACKED", lifecycle: null },
      [QUEUED_CR]: { status: "PENDING", lifecycle: null },
    });
    const releases = await storedReleases(base, key);
    expect(releases.length).toBe(1);
    expect(releases[0]!.version).toBe(STORED_RELEASE);
    expect([...(releases[0]!.crs ?? [])].sort()).toEqual([VOID_NAMED_CR, EVICTED_CR].sort());
    return key;
  }

  /** The dead-and-live queue's report, the same on both reporting paths. */
  function expectOnlyTheLiveCrNeverLanded(report: UnplaceableReport): void {
    // POSITIVE — exactly one never-landed line, naming exactly the live CR,
    // and counting it as one.
    expect(report.neverLanded.length).toBe(1);
    expect(idsOf(report.neverLanded[0]!)).toEqual([LIVE_CR]);
    expect(countOf(report.neverLanded[0]!)).toBe(1);
    // NEGATIVE — the dead work is in NO unplaceable line, of either class.
    expect(linesNaming(report, VOID_CR)).toEqual([]);
    expect(linesNaming(report, SUPERSEDED_CR)).toEqual([]);
    // Nothing here is named by a release, so nothing is evicted.
    expect(report.evicted).toEqual([]);
  }

  /** The voided-then-named queue's report, the same on both reporting paths. */
  function expectTheVoidedCrIsNotEvicted(report: UnplaceableReport): void {
    // POSITIVE — the genuinely evicted live CR is still reported as such, and
    // ALONE: one evicted line, naming exactly it, counting one.
    expect(report.evicted.length).toBe(1);
    expect(idsOf(report.evicted[0]!)).toEqual([EVICTED_CR]);
    expect(countOf(report.evicted[0]!)).toBe(1);
    // …and the never-landed control is still reported, alone.
    expect(report.neverLanded.length).toBe(1);
    expect(idsOf(report.neverLanded[0]!)).toEqual([QUEUED_CR]);
    expect(countOf(report.neverLanded[0]!)).toBe(1);
    // NEGATIVE — the voided CR is in no unplaceable line, evicted or otherwise.
    expect(linesNaming(report, VOID_NAMED_CR)).toEqual([]);
  }

  test(
    "finish reports only the live PENDING CR as never landed — a VOID CR with a comma in its " +
      "title and a SUPERSEDED CR appear in no unplaceable line",
    async () => {
      const base = boot();
      const key = await deadAndLiveQueue(base, "finish-skips-dead-work");
      const world = makeWorld(key);

      const run = await runCeremony(base, world, ["finish", VERSION]);

      expect(run.exitCode).toBe(0);
      expectOnlyTheLiveCrNeverLanded(readReport(run.output));
    },
  );

  test(
    "backfill-releases reports only the live PENDING CR as never landed — a VOID CR with a comma " +
      "in its title and a SUPERSEDED CR appear in no unplaceable line",
    async () => {
      const base = boot();
      const key = await deadAndLiveQueue(base, "backfill-skips-dead-work");
      const world = makeWorld(key);

      const run = await runCeremony(base, world, ["backfill-releases"]);

      expect(run.exitCode).toBe(0);
      expect(run.output).toContain("backfill-releases: 3/3 recorded");
      expectOnlyTheLiveCrNeverLanded(readReport(run.output));
    },
  );

  test(
    "finish does not report a CR voided before a stored release named it as landing evidence " +
      "EVICTED, while the live CR that release names still is",
    async () => {
      const base = boot();
      const key = await voidedThenNamedQueue(base, "finish-voided-then-named");
      const world = makeWorld(key);

      const run = await runCeremony(base, world, ["finish", VERSION]);

      expect(run.exitCode).toBe(0);
      expectTheVoidedCrIsNotEvicted(readReport(run.output));
    },
  );

  test(
    "backfill-releases does not report a CR voided before a stored release named it as landing " +
      "evidence EVICTED, while the live CR that release names still is",
    async () => {
      const base = boot();
      const key = await voidedThenNamedQueue(base, "backfill-voided-then-named");
      const world = makeWorld(key);

      const run = await runCeremony(base, world, ["backfill-releases"]);

      expect(run.exitCode).toBe(0);
      expect(run.output).toContain("backfill-releases: 3/3 recorded");
      expectTheVoidedCrIsNotEvicted(readReport(run.output));
    },
  );
});

describe("the provenance report reads the queue as JSON, not by splitting text rows", () => {
  const SOURCE = readFileSync(RELEASE_SH, "utf8");

  /** The script's text with comment-only lines removed, so prose that names a
   *  table shape is never mistaken for code that parses it. */
  const CODE = SOURCE.split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  /** The body of a top-level bash function `name() {` … `}` (column-0 opener
   *  and closer, as every function in release.sh is written), comment lines
   *  removed. */
  function bashFunctionBody(name: string): string | undefined {
    const lines = SOURCE.split("\n");
    const start = lines.findIndex((l) => l === `${name}() {`);
    if (start < 0) return undefined;
    const end = lines.findIndex((l, i) => i > start && l === "}");
    if (end < 0) return undefined;
    return lines
      .slice(start + 1, end)
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
  }

  test("queue_read asks the client for `queue --format json`", () => {
    const body = bashFunctionBody("queue_read");
    expect(body).toBeDefined();
    // The client's queue verb, invoked asking for the JSON envelope.
    expect(body!).toMatch(/python3\s+\S+\s+queue\s+--format(\s+|=)json\b/);
  });

  test("release.sh holds no awk reader of the text envelope's `queue[N]{…}` table or its `crMerged[N]:` list", () => {
    const codeLines = CODE.split("\n").map((l) => l.trim());
    // The text table's header pattern, as an awk program would match it.
    expect(codeLines.filter((l) => l.includes("queue\\[[0-9]+\\]\\{"))).toEqual([]);
    // The text envelope's crMerged list header.
    expect(codeLines.filter((l) => l.includes("crMerged\\[[0-9]+\\]"))).toEqual([]);
  });
});
