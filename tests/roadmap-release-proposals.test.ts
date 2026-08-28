// CR-CRU-078 §S9 / AC33 — the release strip's SECOND read: proposals.
//
// Spec: docs/changes/CR-CRU-078-roadmap-graph-and-table-together.md §S9 + AC33
// Wire: docs/changes/CR-CRU-091-roadmap-registration-is-declared.md §S1 + §S8
//
// The frontend holds exactly ONE release read today — `state.releases`, filled
// from `body.releases` in `refetchRoadmap` (public/app.js ~L293), which is
// `GET …/releases`, deliberately free of proposals (CR-091 §S1: `listReleases`
// filters `event.type === "release"`). A `LC_ALL=C grep -a` over `public/` for
// `release-proposals` / `listReleaseProposals` / `proposals` returns ZERO hits
// (measured 2026-08-28; app-logic.mjs carries literal NUL bytes, so an
// unforced grep silently reports nothing — hence `-a`). §S9 adds the second
// read, and this file is its contract.
//
// SCOPE — DATA PLUMBING ONLY. Nothing here renders: the strip (C2), the zones
// (C3), selection/durability (C4) and the visual grammar (C5) are later
// cycles. What is pinned here is the fetch, the slice, its cadence, its clear,
// and the two reads' INDEPENDENCE.
//
// RED phase — expected to FAIL against current production, which issues no
// `release-proposals` fetch at all and whose state object carries no second
// release slice: `proposalCalls()` is empty and `state.releaseProposals` is
// `undefined`.
//
// Observability without a production seam: `public/app.js` calls
// `vanX.reactive` exactly ONCE — the state object at app.js L17. The harness
// wraps that global between evaluating the VanX bundle and evaluating app.js
// and keeps the returned proxy, so the assertions read the REAL live state.
// No debug hook is added to production for a cycle that renders nothing.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"),
  "utf8",
);
const VAN_X_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"),
  "utf8",
);
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

/** The state field this cycle adds, beside `state.releases`. Named once here
 *  because it IS the interface the later render cycles consume. */
const PROPOSALS_SLICE = "releaseProposals";

// ── Fixture shapes ─────────────────────────────────────────────────────────

/** CR-091 §S8: `GET …/release-proposals` answers
 *  `{ok, proposals:[{label, targetAt?, timestamp, waves[]}], totalCount}`.
 *  `targetAt` is OPTIONAL and is epoch SECONDS (§S1, the same unit as
 *  `releasedAt`); `waves` is joined SERVER-side so five clients cannot join it
 *  differently; there is NO `status` field — every returned proposal is live by
 *  construction. */
interface ProposalFixture {
  label: string;
  targetAt?: number;
  timestamp: number;
  waves: string[];
}

/** The CR-074 releases-ledger shape `state.releases` already holds. */
interface ReleaseFixture {
  version: string;
  commit?: string;
  timestamp: number;
  releasedAt?: number;
}

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

/** Per-project payloads, so a project SWITCH can be asserted for leaks. */
interface ProjectData {
  releases?: ReleaseFixture[];
  proposals?: ProposalFixture[];
  /** HTTP status for this project's proposals read; a non-2xx exercises the
   *  degraded path through `getJson`'s `!res.ok` throw. */
  proposalsStatus?: number;
  /** Make this project's proposals read REJECT outright (transport failure). */
  proposalsThrows?: boolean;
  releasesStatus?: number;
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  data?: Record<string, ProjectData>;
}

// ── Harness ────────────────────────────────────────────────────────────────

/** The slice of app.js's reactive state this file reads. Extra fields exist;
 *  none of them is this cycle's business. */
interface AppState {
  releases: ReleaseFixture[];
  releaseProposals?: ProposalFixture[];
}

/** The VanX surface the harness uses: `reactive` is wrapped to capture the
 *  state object, `compact` produces the plain deep snapshots the assertions
 *  compare (it preserves ABSENT optional keys — see `snapshot`). */
interface VanXGlobal {
  reactive: <T extends object>(obj: T) => T;
  compact: <T>(value: T) => T;
}

let cacheBust = 0;
let calls: string[] = [];
let liveState: AppState | undefined;
let vanX: VanXGlobal | undefined;

function project(overrides: Partial<ProjectFixture> & { key: string }): ProjectFixture {
  return {
    name: overrides.key,
    type: "backend",
    agentsOnline: 0,
    agentsTotal: 0,
    active: true,
    lastActivity: Date.now(),
    ...overrides,
  };
}

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  const data = opts.data ?? {};
  calls = [];
  liveState = undefined;
  vanX = undefined;
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  const scriptedFetch = async (url: string): Promise<Response> => {
    calls.push(url);
    // Well-known DOM/fetch boundary: happy-dom has no server, so every
    // response here is a hand-built stub the app only ever reads `ok`,
    // `status` and `json()` from.
    const okResponse = (body: unknown): Response =>
      ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

    // Order matters: `/release-proposals`, `/releases`, `/queue` and `/plans`
    // all sit under `/api/v2/projects`, and `/releases` must not swallow
    // `/release-proposals`.
    const proposalsMatch = /\/api\/v2\/projects\/([^/?]+)\/release-proposals/.exec(url);
    if (proposalsMatch !== null) {
      const d = data[decodeURIComponent(proposalsMatch[1]!)] ?? {};
      if (d.proposalsThrows === true) throw new TypeError("Failed to fetch");
      const status = d.proposalsStatus ?? 200;
      const proposals = d.proposals ?? [];
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ ok: true, proposals, totalCount: proposals.length }),
      } as unknown as Response;
    }
    const releasesMatch = /\/api\/v2\/projects\/([^/?]+)\/releases/.exec(url);
    if (releasesMatch !== null) {
      const d = data[decodeURIComponent(releasesMatch[1]!)] ?? {};
      const status = d.releasesStatus ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ ok: true, releases: d.releases ?? [] }),
      } as unknown as Response;
    }
    if (/\/api\/v2\/projects\/[^/?]+\/queue/.test(url)) return okResponse({ ok: true, entries: [] });
    if (/\/api\/v2\/projects\/[^/?]+\/plans/.test(url)) return okResponse({ ok: true, plans: [] });
    if (/\/api\/v2\/plans(?:\?|$)/.test(url)) return okResponse({ ok: true, plans: [] });
    if (url.includes("/api/v2/projects")) return okResponse({ ok: true, projects: opts.projects });
    if (url.includes("/api/v2/agents")) return okResponse({ ok: true, agents: [] });
    if (url.includes("/api/v2/events")) return okResponse({ ok: true, events: [] });
    if (url.includes("/api/v2/health")) {
      return okResponse({ ok: true, version: "2.0.0-test", counts: { events: 0 } });
    }
    throw new Error(`roadmap-release-proposals.test.ts mountApp: unexpected fetch url ${url}`);
  };
  // happy-dom installs its own `fetch`; the app is driven entirely off this
  // script, so the global is replaced wholesale (house harness pattern).
  const scriptedGlobals = globalThis as unknown as { fetch: typeof fetch; vanX: VanXGlobal };
  scriptedGlobals.fetch = scriptedFetch as unknown as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  // Capture the ONE reactive state object app.js builds (app.js L17) before
  // app.js runs. Identified by `releases` — the slice this cycle's second read
  // sits beside — never by call order.
  vanX = scriptedGlobals.vanX;
  const realReactive = vanX.reactive;
  vanX.reactive = <T extends object>(obj: T): T => {
    const proxy = realReactive(obj);
    if (Object.prototype.hasOwnProperty.call(obj, "releases")) {
      liveState = proxy as unknown as AppState;
    }
    return proxy;
  };

  // Dynamic import is REQUIRED here, not a style choice: the specifier carries
  // a per-mount cache-bust query so each test re-evaluates app-logic.mjs into
  // a fresh happy-dom global (house harness pattern).
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?roadmapReleaseProposals=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

/** Real timers, deliberately: the subject is the production `public/app.js`
 *  shell driving its own fetch chain, SSE watchdog and poll fallback inside
 *  happy-dom. Faking the clock would freeze the very refresh path under test,
 *  so this yields to the real macrotask queue exactly as every other app-shell
 *  test in `tests/` does. */
async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

afterEach(async () => {
  liveState = undefined;
  vanX = undefined;
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function state(): AppState {
  if (liveState === undefined) {
    throw new Error("app.js published no reactive state object — the mount failed");
  }
  return liveState;
}

/** A plain deep snapshot of a reactive slice, via VanX's own `compact`, which
 *  preserves ABSENT optional keys — an absent `targetAt` stays absent rather
 *  than becoming `undefined`/`null`, which is exactly what §S1's date contract
 *  turns on. */
function snapshot<T>(value: T[] | undefined): T[] {
  if (vanX === undefined) throw new Error("VanX was never captured — the mount failed");
  if (value === undefined) return [];
  return vanX.compact(value);
}

/** The proposals slice as plain data. An absent field snapshots to `[]`, which
 *  is why the "the field exists" contract is asserted separately below. */
function proposalsSlice(): ProposalFixture[] {
  return snapshot(state().releaseProposals);
}

function releasesSlice(): ReleaseFixture[] {
  return snapshot(state().releases);
}

function proposalCalls(): string[] {
  return calls.filter((u) => u.includes("release-proposals"));
}

/** The shipped-releases read only — `/release-proposals` must not count. */
function releasesCalls(): string[] {
  return calls.filter((u) => /\/releases(?:\?|$)/.test(u));
}

/** Navigation over the documented popstate parity path (public/app.js
 *  L168-178: a scope change re-runs `scopeChanged()`), which is the same clear
 *  + refetch a project→project click takes. */
async function navigateTo(pathname: string): Promise<void> {
  history.pushState(null, "", pathname);
  window.dispatchEvent(new Event("popstate"));
  await settle();
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const KEY_A = "proposals-a";
const KEY_B = "proposals-b";

// CR-091 §S1: `listReleases` is newest-first. Held verbatim — this cycle sorts
// nothing.
const RELEASES_A: ReleaseFixture[] = [
  { version: "0.1.1", commit: "bbb2222", timestamp: 1_756_000_000_000, releasedAt: 1_756_000_000 },
  { version: "0.1.0", commit: "aaa1111", timestamp: 1_755_000_000_000, releasedAt: 1_755_000_000 },
];

// CR-091 §S1: `listReleaseProposals` is ASCENDING by version, and every
// proposal sorts after every shipped release, so a consumer concatenating
// "shipped, then proposed" needs NO reversal. `0.2.1` declares a target;
// `0.3.0` declares NONE (the key is ABSENT on the wire, not null); `0.4.0`
// carries an EMPTY `waves` — a proposal with zero CRs is legal (§S1).
const PROPOSALS_A: ProposalFixture[] = [
  { label: "0.2.1", targetAt: 1_757_000_000, timestamp: 1_756_500_000_000, waves: ["7", "8"] },
  { label: "0.3.0", timestamp: 1_756_600_000_000, waves: ["9"] },
  { label: "0.4.0", targetAt: 1_759_000_000, timestamp: 1_756_700_000_000, waves: [] },
];

const RELEASES_B: ReleaseFixture[] = [
  { version: "1.4.0", commit: "ccc3333", timestamp: 1_754_000_000_000, releasedAt: 1_754_000_000 },
];
const PROPOSALS_B: ProposalFixture[] = [
  { label: "1.5.0", targetAt: 1_760_000_000, timestamp: 1_756_800_000_000, waves: ["2"] },
];

const TWO_PROJECTS: ProjectFixture[] = [
  project({ key: KEY_A, name: "Proposals A" }),
  project({ key: KEY_B, name: "Proposals B" }),
];

/** Project A, healthy on both reads — the baseline most tests mount. */
async function mountHealthyA(): Promise<void> {
  await mountApp({
    pathname: `/p/${KEY_A}`,
    projects: TWO_PROJECTS,
    data: { [KEY_A]: { releases: RELEASES_A, proposals: PROPOSALS_A } },
  });
}

// ── AC33.1 — the fetch exists, on the SAME refresh path ────────────────────

describe("CR-CRU-078 §S9 / AC33 — the fetch: GET …/release-proposals on the state.releases refresh path", () => {
  test("a workspace mount issues the exact CR-091 §S8 path, once per refresh tick, alongside the releases read", async () => {
    await mountHealthyA();

    // The path is CR-091 §S8's, byte-for-byte: project-scoped, no query
    // string, plural `release-proposals`. A client that invents a path fails.
    const issued = proposalCalls();
    expect(issued.length).toBeGreaterThan(0);
    for (const url of issued) {
      expect(url).toBe(`/api/v2/projects/${KEY_A}/release-proposals`);
    }

    // SAME refresh path as `state.releases` — the two reads are issued
    // together, so the strip can never render a stale half of its own
    // sequence. Asserted as a COUNT equality, not mere presence: a proposals
    // read wired to boot only (or to a different cadence) diverges the moment
    // the poll / SSE tick fires the releases read again.
    expect(issued.length).toBe(releasesCalls().length);
  });

  test("HOME issues no proposals read at all — only a workspace has a scoped ledger", async () => {
    await mountApp({
      pathname: "/",
      projects: TWO_PROJECTS,
      data: { [KEY_A]: { releases: RELEASES_A, proposals: PROPOSALS_A } },
    });

    expect(releasesCalls()).toEqual([]);
    expect(proposalCalls()).toEqual([]);
  });
});

// ── AC33.2 — the slice holds the §S8 record verbatim ───────────────────────

describe("CR-CRU-078 §S9 / AC33 — the slice holds the CR-091 §S8 proposal record verbatim", () => {
  test(`the second read lands in its own state field, \`${PROPOSALS_SLICE}\`, beside state.releases`, async () => {
    await mountHealthyA();

    // The field must EXIST as an array (a bare `undefined` slice is what
    // production has today), and it must not be `state.releases` itself.
    const held = state().releaseProposals;
    expect(Array.isArray(held)).toBe(true);
    expect(held).not.toBe(state().releases);
  });

  test("label, targetAt, timestamp and waves survive the read unchanged, in server order", async () => {
    await mountHealthyA();

    // Deep equality against the wire fixture: nothing added, nothing dropped,
    // nothing renamed, nothing re-ordered.
    expect(proposalsSlice()).toEqual(PROPOSALS_A);
  });

  test("an ABSENT targetAt stays ABSENT — not null, not 0, not defaulted to the epoch", async () => {
    await mountHealthyA();

    const undated = proposalsSlice().find((p) => p.label === "0.3.0");
    expect(undated).toBeDefined();
    // The KEY itself must not exist. A defaulted 0 would render 1970-01-01
    // (AC6 / AC30) and a null would make absence indistinguishable from a
    // declared epoch target.
    expect(Object.prototype.hasOwnProperty.call(undated!, "targetAt")).toBe(false);
    expect(Object.keys(undated!)).toEqual(["label", "timestamp", "waves"]);

    // …while a proposal that DOES declare one keeps it verbatim, in epoch
    // SECONDS (§S1), unconverted.
    expect(proposalsSlice().find((p) => p.label === "0.2.1")!.targetAt).toBe(1_757_000_000);
  });

  test("waves is taken as the server joined it — including the empty join of a zero-CR proposal", async () => {
    await mountHealthyA();

    const byLabel = new Map(proposalsSlice().map((p) => [p.label, p]));
    // §S8: `waves` is joined SERVER-side deliberately, so five clients cannot
    // join it differently. Consumed, never recomputed from the queue.
    expect(byLabel.get("0.2.1")!.waves).toEqual(["7", "8"]);
    expect(byLabel.get("0.3.0")!.waves).toEqual(["9"]);
    // A proposal with zero CRs is legal (§S1) — an empty join stays empty and
    // is not swapped for a placeholder wave.
    expect(byLabel.get("0.4.0")!.waves).toEqual([]);
  });

  test("no `status` key is fabricated — every returned proposal is live by construction", async () => {
    await mountHealthyA();

    // Bound first — an empty slice would make the per-record loop below
    // vacuously true, which is exactly how this assertion "passes" against
    // current production.
    expect(proposalsSlice().length).toBe(PROPOSALS_A.length);

    // §S8: "No `status` field is emitted — every returned proposal is live by
    // construction, so a status would be fabricated; the client labels them."
    for (const p of proposalsSlice()) {
      const wire = PROPOSALS_A.find((f) => f.label === p.label)!;
      expect(Object.keys(p)).not.toContain("status");
      expect(Object.keys(p).sort()).toEqual(Object.keys(wire).sort());
    }
  });

  test("`totalCount` is not mistaken for the list — the slice length is the proposals array's", async () => {
    await mountHealthyA();

    expect(proposalsSlice().length).toBe(PROPOSALS_A.length);
  });
});

// ── AC33.3 — SEPARATE slices, neither sorted by this cycle ─────────────────

describe("CR-CRU-078 §S9 / AC28 + AC33 — the two lists are held SEPARATELY and neither is re-sorted", () => {
  test("shipped releases stay newest-first and proposals stay ascending, in two distinct slices", async () => {
    await mountHealthyA();

    // CR-091 fixed the two reads' sort directions deliberately OPPOSITE so a
    // consumer appends "shipped, then proposed" with no reversal. Merging them
    // in state would throw that away and re-open the question AC28 settles.
    expect(releasesSlice().map((r) => r.version)).toEqual(["0.1.1", "0.1.0"]);
    expect(proposalsSlice().map((p) => p.label)).toEqual(["0.2.1", "0.3.0", "0.4.0"]);

    // NEGATIVE — no shipped release leaked into the proposals slice, and no
    // proposal leaked into the releases slice. Concatenation is a RENDER
    // concern (a later cycle); state keeps them apart.
    expect(releasesSlice().length).toBe(RELEASES_A.length);
    for (const r of releasesSlice()) {
      expect(Object.keys(r)).not.toContain("label");
    }
    for (const p of proposalsSlice()) {
      expect(Object.keys(p)).not.toContain("version");
    }
  });
});

// ── AC33.4 — a project switch cannot leak one project's proposals ──────────

describe("CR-CRU-078 §S9 — a project switch clears the proposals slice exactly as it clears state.releases", () => {
  test("workspace A → workspace B replaces BOTH slices with B's own data; none of A's survives", async () => {
    await mountApp({
      pathname: `/p/${KEY_A}`,
      projects: TWO_PROJECTS,
      data: {
        [KEY_A]: { releases: RELEASES_A, proposals: PROPOSALS_A },
        [KEY_B]: { releases: RELEASES_B, proposals: PROPOSALS_B },
      },
    });
    expect(proposalsSlice()).toEqual(PROPOSALS_A);

    await navigateTo(`/p/${KEY_B}`);

    // Control — the nav actually took: `state.releases` is now B's.
    expect(releasesSlice().map((r) => r.version)).toEqual(["1.4.0"]);
    // The contract — the proposals slice is B's alone. `0.2.1`/`0.3.0`/`0.4.0`
    // are project A's plan and must not appear in B's sequence.
    expect(proposalsSlice()).toEqual(PROPOSALS_B);
  });

  test("a switch to a project whose proposals read FAILS empties the slice — A's proposals never linger", async () => {
    await mountApp({
      pathname: `/p/${KEY_A}`,
      projects: TWO_PROJECTS,
      data: {
        [KEY_A]: { releases: RELEASES_A, proposals: PROPOSALS_A },
        [KEY_B]: { releases: RELEASES_B, proposalsThrows: true },
      },
    });
    expect(proposalsSlice()).toEqual(PROPOSALS_A);

    await navigateTo(`/p/${KEY_B}`);

    // The synchronous scope-change clear is what makes this safe: the failed
    // refetch cannot overwrite, so only a clear at switch time keeps A's
    // proposals from being painted under B's releases.
    expect(proposalsSlice()).toEqual([]);
    // …and B's shipped releases are still there — a degraded strip, not an
    // empty one.
    expect(releasesSlice().map((r) => r.version)).toEqual(["1.4.0"]);
  });

  test("navigating workspace → HOME empties the proposals slice, exactly like state.releases", async () => {
    await mountHealthyA();

    await navigateTo("/");

    expect(releasesSlice()).toEqual([]);
    expect(proposalsSlice()).toEqual([]);
    // The field survives as an array — it is emptied, never deleted.
    expect(Array.isArray(state().releaseProposals)).toBe(true);
  });
});

// ── AC33.5 — the two reads fail INDEPENDENTLY ──────────────────────────────

describe("CR-CRU-078 §S9 / AC33 — a failing proposals read leaves the shipped gates intact", () => {
  test("a NON-OK proposals response leaves state.releases fully populated and untouched", async () => {
    await mountApp({
      pathname: `/p/${KEY_A}`,
      projects: TWO_PROJECTS,
      data: { [KEY_A]: { releases: RELEASES_A, proposals: PROPOSALS_A, proposalsStatus: 500 } },
    });

    // The read WAS attempted — this is a degraded read, not a skipped one.
    expect(proposalCalls().length).toBeGreaterThan(0);

    // §S9: the two reads fail independently. Shipped gates present with
    // proposals unavailable is a legitimate degraded state — NOT the AC19
    // empty state ("nothing registered at all"), and not an error over working
    // data.
    expect(releasesSlice()).toEqual(RELEASES_A);
    // Degraded representation: the proposals slice simply holds no proposals —
    // its last-known contents, empty on a cold mount. No sentinel value, no
    // fabricated record, no half-parsed body.
    expect(proposalsSlice()).toEqual([]);
  });

  test("a proposals read that REJECTS (transport failure) leaves state.releases fully populated", async () => {
    await mountApp({
      pathname: `/p/${KEY_A}`,
      projects: TWO_PROJECTS,
      data: { [KEY_A]: { releases: RELEASES_A, proposals: PROPOSALS_A, proposalsThrows: true } },
    });

    expect(proposalCalls().length).toBeGreaterThan(0);
    expect(releasesSlice()).toEqual(RELEASES_A);
    expect(proposalsSlice()).toEqual([]);
  });

  test("a failing proposals read does not stop the releases read being issued at all", async () => {
    await mountApp({
      pathname: `/p/${KEY_A}`,
      projects: TWO_PROJECTS,
      data: { [KEY_A]: { releases: RELEASES_A, proposals: PROPOSALS_A, proposalsThrows: true } },
    });

    // Independence in BOTH directions: whichever order the two reads are
    // issued in, one throwing may not swallow the other.
    expect(releasesCalls().length).toBeGreaterThan(0);
    expect(proposalCalls().length).toBe(releasesCalls().length);
  });

  test("a failing RELEASES read leaves a successful proposals slice populated", async () => {
    await mountApp({
      pathname: `/p/${KEY_A}`,
      projects: TWO_PROJECTS,
      data: { [KEY_A]: { releases: RELEASES_A, proposals: PROPOSALS_A, releasesStatus: 503 } },
    });

    expect(releasesSlice()).toEqual([]);
    expect(proposalsSlice()).toEqual(PROPOSALS_A);
  });

  test("a proposals route that RECOVERS fills the slice on the next pass through the same refresh path", async () => {
    const data: Record<string, ProjectData> = {
      [KEY_A]: { releases: RELEASES_A, proposals: PROPOSALS_A, proposalsThrows: true },
      [KEY_B]: { releases: RELEASES_B, proposals: PROPOSALS_B },
    };
    await mountApp({ pathname: `/p/${KEY_A}`, projects: TWO_PROJECTS, data });
    expect(proposalsSlice()).toEqual([]);
    expect(releasesSlice()).toEqual(RELEASES_A);

    data[KEY_A]!.proposalsThrows = false;
    await navigateTo(`/p/${KEY_B}`);
    await navigateTo(`/p/${KEY_A}`);

    expect(proposalsSlice()).toEqual(PROPOSALS_A);
    expect(releasesSlice()).toEqual(RELEASES_A);
  });
});
