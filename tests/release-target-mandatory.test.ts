// CR-CRU-118 §S4a — A RELEASE PROPOSAL DECLARES ITS TARGET DATE: THE RULE.
//
// §S4 makes `targetAt` REQUIRED: refused client-side by argparse, refused
// server-side by the route, and no longer optional in
// `recordReleaseProposal`'s signature. The flag surface's own half — five
// clients, asserted per client with the client count asserted — lives beside
// the fleet's other censuses in `tests/client/test_release_target_mandatory_
// fleet.py`, because that is where the machinery for driving all five real
// clients as subprocesses already lives (the idiom
// `tests/client/test_queue_file_deprecation_fleet.py` set). THIS file is the
// ROUTE half plus the two properties the mandate must not break.
//
// WHY THE ROUTE IS ASSERTED SEPARATELY FROM THE FLAG. A rule that lives only
// in argparse is a rule any other caller walks past — and every caller of this
// route is in this repo, so "nobody would" is a statement about today's
// callers rather than about the contract. §S4's own words: "the rule lives
// server-side, not only in the flag surface."
//
// WHAT IS SYNTHETIC AND WHAT IS LIVE. Every board here is synthetic and
// in-memory: booted on an OS-assigned port against an mkdtempSync scratch db
// (the sibling convention of tests/queue-release-membership-mandatory.test.ts).
// The live data/crucible.db and port 3849 are never read and never written.
// The release LABELS are this suite's own `0.9.x` shapes, never the project's
// real versions, so nothing here can be confused with the board's own plan.
//
// THE ONE PLACE A PROCESS IS SPAWNED, and why it is not a stub: the ISO-date
// criterion is a claim about what LANDS IN THE STORE when a human types a
// date, and the ISO reading happens in `clients/_crucible_axi.py`
// (`parse_target_at`) while the storing happens in `src/store.ts`. Asserting
// the two halves separately would prove neither: a client that parsed to
// milliseconds and a route that stored whatever it was handed would both pass
// their own half. So that ONE test drives the real client binary against the
// real route and reads the stored integer back — the whole path, once.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
// The fleet's ONE home for refusal help[] (§S5's "no refusal is a bare 400").
// Consumed rather than re-spelled: the wording is GREEN's to choose, and a
// test that pinned a sentence would be pinning a decision it does not own.
import { roadmapHints } from "../src/hints.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const CLIENT_PATH = join(REPO_ROOT, "clients", "bun-crucible.py");

const ORCH = "orchestrator-1";

/** This suite's own label shape — a version no live board holds. */
const LABEL = "0.9.0";

/** The declared target, in the two forms a caller may type. Midnight UTC on
 *  an unambiguous day: an ISO DATE has no zone of its own, and this pair is
 *  the same instant read either way, so "the same stored integer" is a claim
 *  about the reading rather than about a timezone the runner happens to be in.
 *  Verified against `clients/_crucible_axi.py::parse_target_at` 2026-09-10. */
const TARGET_ISO = "2026-09-01";
const TARGET_SECONDS = 1_788_220_800;

/** The target after it SLIPS — the revision case. Also epoch SECONDS. */
const MOVED_SECONDS = 1_790_000_000;

interface ProposalWire {
  label: string;
  targetAt?: number;
  timestamp: number;
  waves?: unknown[];
  [key: string]: unknown;
}

interface AnyBody {
  ok: boolean;
  error?: string;
  help?: string[];
  converged?: boolean;
  project?: { key: string };
  proposal?: { label: string; targetAt?: number };
  proposals?: ProposalWire[];
  [key: string]: unknown;
}

/** Every `help[]` the roadmap refusals publish as a fixed list. §S5's shape
 *  claim is asserted against THIS set rather than against a sentence: the
 *  siblings (`missingRelease`, `dependencyCycle`, …) all name a runnable call
 *  and all live here, and a refusal whose help[] was written inline in the
 *  route would be outside it. */
function staticRoadmapHelp(): string[][] {
  return Object.values(roadmapHints).filter((entry): entry is string[] => Array.isArray(entry));
}

/**
 * `recordReleaseProposal`'s `meta` parameter, read off `src/store.ts` itself.
 *
 * A TYPE is not observable on the wire — the route can only ever send what it
 * chose to send, so no amount of driving it proves what the STORE will accept
 * from a future second caller, and `tsc` proves it only for callers that exist
 * today. §S4 names the signature as its own deliverable, and this repo already
 * reads a published type declaration as text where there is no runtime value
 * to interrogate (`queueWarningCodeUnion`,
 * tests/queue-release-membership-mandatory.test.ts). Same reason, same method.
 */
function recordReleaseProposalMeta(): string {
  const source = readFileSync(join(REPO_ROOT, "src", "store.ts"), "utf8");
  const declaration = /recordReleaseProposal\(([\s\S]*?)\)\s*:\s*\{\s*event:/.exec(source);
  if (declaration === null) {
    throw new Error(
      "src/store.ts declares no `recordReleaseProposal(...): { event: … }` — the method §S4 " +
        "changes the signature of has moved or been renamed",
    );
  }
  const meta = /meta:\s*\{([^}]*)\}/.exec(declaration[1]!);
  if (meta === null) {
    throw new Error(
      `recordReleaseProposal takes no inline \`meta: { … }\` object — read: ${declaration[1]!}`,
    );
  }
  return meta[1]!;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One real client process, pointed at one real board. `python3` rather than
 *  `uv run` because that is how the fleet's own suites invoke these scripts in
 *  this repo's checkout; ambient WORKFLOW_* is stripped so an orchestrator
 *  session cannot colour the call. */
async function runClient(args: string[], opts: { cwd: string; crucibleUrl: string }): Promise<RunResult> {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(baseEnv)) {
    if (key.startsWith("WORKFLOW_")) delete baseEnv[key];
  }
  const proc = Bun.spawn({
    cmd: ["python3", CLIENT_PATH, ...args],
    cwd: opts.cwd,
    env: { ...baseEnv, CRUCIBLE_URL: opts.crucibleUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("CR-CRU-118 §S4a — every release proposal names its target date", () => {
  let handle: ServerHandle | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  function boot(): ServerHandle {
    handle = startServer({ port: 0, dbPath: join(scratchDir("cru118-target-db-"), "crucible.db") });
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
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  async function get(path: string): Promise<{ status: number; body: AnyBody }> {
    const res = await send("GET", path);
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  function proposalsPath(key: string): string {
    return `/api/v2/projects/${key}/release-proposals`;
  }

  /** A project with a registered ORCHESTRATOR — the only role §S3 lets near a
   *  roadmap write, so every refusal below is the TARGET's refusal rather than
   *  an authorisation one. */
  async function seed(name: string): Promise<string> {
    boot();
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

  /** A project dir the real clients can read: `.env` naming the board's
   *  project, exactly as every deployment names it. */
  function fixtureProjectDir(key: string): string {
    const dir = scratchDir("cru118-target-proj-");
    writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
    return dir;
  }

  test("the route refuses a proposal carrying no targetAt, and writes nothing", async () => {
    const key = await seed("cru118-target-absent");

    const refused = await post(proposalsPath(key), { agentId: ORCH, label: LABEL });

    expect(refused.status).toBe(400);
    expect(refused.body.ok).toBe(false);
    expect(refused.body.error).toContain("targetAt");
    // Re-READ, never trust the refusal: "the store wrote nothing" is a claim
    // about the store. Both doors are asked, because a route that refused and
    // wrote anyway would answer one and not the other.
    expect((await get(proposalsPath(key))).body.proposals).toEqual([]);
    expect(handle!.store.listReleaseProposals(key)).toEqual([]);
  });

  test("a malformed targetAt keeps its OWN refusal — absence and nonsense are different findings", async () => {
    const key = await seed("cru118-target-malformed");

    const malformed = await post(proposalsPath(key), {
      agentId: ORCH,
      label: LABEL,
      targetAt: "yesterday",
    });
    const absent = await post(proposalsPath(key), { agentId: ORCH, label: LABEL });

    // The shipped sentence (CR-CRU-091 §S1) stays: a declared target that
    // silently vanished would read back as "no target was ever declared".
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toContain("epoch SECONDS");
    // And absence is refused too — with its own finding, not by collapsing
    // both into one message. A caller who typed nothing and a caller who
    // typed "yesterday" need different next moves.
    expect(absent.status).toBe(400);
    expect(absent.body.error).not.toBe(malformed.body.error);
    expect(handle!.store.listReleaseProposals(key)).toEqual([]);
  });

  test("the refusal names the field and the move that fixes it, drawn from the fleet's own hints (§S5)", async () => {
    const key = await seed("cru118-target-help");

    const refused = await post(proposalsPath(key), { agentId: ORCH, label: LABEL });

    expect(refused.body.error).toContain("targetAt");
    const help = refused.body.help;
    expect(Array.isArray(help)).toBe(true);
    expect(help!.length).toBeGreaterThan(0);
    expect(help!.every((line) => typeof line === "string" && line.length > 0)).toBe(true);
    // A runnable CALL naming the flag — the sibling convention (every entry in
    // `roadmapHints` offers the next call, never an explanation of the rule).
    expect(help!.some((line) => /^release-propose\b/.test(line) && line.includes("--target"))).toBe(
      true,
    );
    // …and it is published from src/hints.ts like every other roadmap refusal,
    // so five clients render one wording rather than the route inventing a
    // second one inline.
    expect(staticRoadmapHelp()).toContainEqual(help!);
  });

  test("recordReleaseProposal's meta.targetAt is no longer optional", () => {
    const meta = recordReleaseProposalMeta();

    expect(meta).toContain("label: string");
    expect(meta).toContain("targetAt: number");
    expect(meta).not.toContain("targetAt?");
  });

  test("an ISO --target and an epoch-SECONDS --target land the SAME stored integer", async () => {
    const key = await seed("cru118-target-iso-vs-epoch");
    const projectDir = fixtureProjectDir(key);

    const iso = await runClient(
      ["release-propose", "--label", LABEL, "--target", TARGET_ISO, "--agent", ORCH, "--project-dir", projectDir],
      { cwd: projectDir, crucibleUrl: base() },
    );
    expect(iso.code).toBe(0);
    const afterIso = handle!.store.listReleaseProposals(key);
    expect(afterIso).toHaveLength(1);
    expect(afterIso[0]!.targetAt).toBe(TARGET_SECONDS);

    const eventsAfterIso = handle!.store.countEvents(key);
    const epoch = await runClient(
      [
        "release-propose",
        "--label",
        LABEL,
        "--target",
        String(TARGET_SECONDS),
        "--agent",
        ORCH,
        "--project-dir",
        projectDir,
      ],
      { cwd: projectDir, crucibleUrl: base() },
    );
    expect(epoch.code).toBe(0);

    // ONE instant, named two ways: the second call is CONVERGENCE, not a
    // revision — which is only true if the first form landed the very same
    // integer. A client that read the ISO date as milliseconds, or as local
    // midnight, would retire the first row here instead of converging.
    const afterEpoch = handle!.store.listReleaseProposals(key);
    expect(afterEpoch).toHaveLength(1);
    expect(afterEpoch[0]!.targetAt).toBe(TARGET_SECONDS);
    expect(afterEpoch[0]!.id).toBe(afterIso[0]!.id);
    expect(handle!.store.countEvents(key)).toBe(eventsAfterIso);
  });

  test("a revision with a NEW target retires its predecessor and leaves exactly ONE live proposal", async () => {
    const key = await seed("cru118-target-revision");

    const first = await post(proposalsPath(key), {
      agentId: ORCH,
      label: LABEL,
      targetAt: TARGET_SECONDS,
    });
    expect(first.status).toBe(200);
    const held = handle!.store.listReleaseProposals(key);
    expect(held).toHaveLength(1);
    const predecessorId = held[0]!.id;

    const revised = await post(proposalsPath(key), {
      agentId: ORCH,
      label: LABEL,
      targetAt: MOVED_SECONDS,
    });

    expect(revised.status).toBe(200);
    expect(revised.body.converged).toBe(false);
    // Half one: a NEW row is live, and exactly one is.
    const live = handle!.store.listReleaseProposals(key);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(predecessorId);
    expect(live[0]!.targetAt).toBe(MOVED_SECONDS);
    expect((await get(proposalsPath(key))).body.proposals).toHaveLength(1);
    // Half two: the predecessor is still READABLE BY ID, carrying the target
    // it declared. This is the audit trail slippage is measured from — an
    // in-place edit would leave the same live count and destroy it, so the
    // live count alone proves nothing.
    const retired = handle!.store.getEvent(predecessorId);
    expect(retired?.label).toBe(LABEL);
    expect(retired?.targetAt).toBe(TARGET_SECONDS);
  });

  test("re-proposing the SAME label with the SAME target still converges, and writes nothing", async () => {
    const key = await seed("cru118-target-idempotent");

    const first = await post(proposalsPath(key), {
      agentId: ORCH,
      label: LABEL,
      targetAt: TARGET_SECONDS,
    });
    expect(first.status).toBe(200);
    expect(first.body.converged).toBe(false);
    const heldId = handle!.store.listReleaseProposals(key)[0]!.id;
    const eventsHeld = handle!.store.countEvents(key);

    const again = await post(proposalsPath(key), {
      agentId: ORCH,
      label: LABEL,
      targetAt: TARGET_SECONDS,
    });

    expect(again.status).toBe(200);
    expect(again.body.converged).toBe(true);
    expect(again.body.proposal).toEqual({ label: LABEL, targetAt: TARGET_SECONDS });
    // Nothing written: the SAME row, and not one extra event — a re-run of a
    // whole generation script mutates nothing (CR-CRU-091 AC12), which the
    // mandate must not cost.
    const live = handle!.store.listReleaseProposals(key);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(heldId);
    expect(handle!.store.countEvents(key)).toBe(eventsHeld);
  });

  test("a re-proposal that DROPS the target is refused, and the held target survives", async () => {
    const key = await seed("cru118-target-drop");

    expect(
      (await post(proposalsPath(key), { agentId: ORCH, label: LABEL, targetAt: TARGET_SECONDS }))
        .status,
    ).toBe(200);
    const held = handle!.store.listReleaseProposals(key)[0]!;

    const dropped = await post(proposalsPath(key), { agentId: ORCH, label: LABEL });

    // The convergence check is `live.targetAt === meta.targetAt`, so before the
    // mandate this call MISSED convergence and took the revision branch: the
    // held row was retired and replaced by one carrying no target at all — a
    // declared date destroyed by a call that mentioned no date. Once absence is
    // impossible the comparison only ever weighs two numbers, and this shape
    // is refused at the door instead.
    expect(dropped.status).toBe(400);
    expect(dropped.body.error).toContain("targetAt");
    const live = handle!.store.listReleaseProposals(key);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(held.id);
    expect(live[0]!.targetAt).toBe(TARGET_SECONDS);
  });
});
