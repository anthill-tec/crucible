// CR-CRU-165 §S1/§S2/§S2b/§S3/AC6 — the Workflow tab surfaces a filed plan's
// RECORDED changes as a defect signal: a plan's skip count, each skipped or
// otherwise-changed cycle's reason/cause/spec-reference, and an aborted
// plan's own reason — all read straight off the real `GET …/plans` payload
// (`PlanCycle.reason/cause/specRef/changeKind`, `Plan.reason/cause/specRef`,
// `src/types.ts`). A historical skip/abort that predates this CR carries
// none of those fields (never back-filled, §S3's own words) and must read as
// "unrecorded" — never blank, never a guessed value.
//
// Baseline (measured against the current public/app.js + public/app-
// logic.mjs): `CycleRow`/`LensCycleRow` render only `<glyph> cycle N ·
// "<label>" · <status>` plus the existing timer/kind-badge/runs-boundary
// bits — nothing reads `cycle.reason`/`cause`/`specRef`/`changeKind` at all.
// `LensCrGroup`'s toggle header renders `<cr> · <done>/<total> cycles [✓] ·
// merged <sha>` — no skip count, no abort reason. `workflowLens` (public/
// app-logic.mjs) builds its declared cycle/CR nodes WITHOUT passing
// reason/cause/specRef/changeKind through at all, so even a correct
// app.js-side renderer would have nothing to read in the History view.
// Every assertion below that looks for a `cycle-change-record`,
// `plan-skip-count` or `plan-abort-reason` element is therefore expected to
// fail against current production.
//
// Storyboard check (.lavish/crucible-v2-design.html, read-only): F13
// ("Workflow tab — the live plan + no-mistakes pane") and F13½ cover the
// cycle-row/lens anatomy this CR extends, but neither frame (nor any other
// in the file) shows a skip reason, a skip count, or an aborted plan's
// reason — this CR's board surface postdates the storyboard. No frame is
// contradicted; none covers these additions, so the DOM contract below is
// drawn from the spec text alone (§S1/§S2/§S2b/§S3), reusing the file's own
// `" · "` segment idiom (e.g. `activeHeaderText`) and the established
// `"reason unrecorded"` wording already used for a RUN's abort
// (`AbortedCard`, `e.abortReason ?? "reason unrecorded"`).
//
// Testid/format contract this file introduces for GREEN (none exist yet):
//   - `[data-testid="cycle-change-record"]` on a cycle row (`CycleRow` in
//     Active, `LensCycleRow` in History) whenever the cycle's status is
//     "skipped" OR it carries a `changeKind` (insert/rename/append/skip/
//     abort) — i.e. every skipped cycle AND every cycle a recorded change
//     (R1) touched, skipped or not. Absent entirely otherwise (no clutter on
//     an ordinary cycle). Text is EXACTLY
//     `reason: <reason> · cause: <cause> · spec: <specRef>` when the three
//     fields are present, else EXACTLY `reason unrecorded`.
//   - `[data-testid="plan-skip-count"]` on the plan's always-visible summary
//     line (the `cr-group-toggle` header in History, the `workflow-cr-root`
//     block in Active) with text EXACTLY `<n> skipped` where n = the plan's
//     count of cycles with status "skipped"; ABSENT entirely when n is 0
//     (mirrors the file's own "zero registered participants -> no pill at
//     all" convention for the agents pill).
//   - `[data-testid="plan-abort-reason"]` on the same always-visible summary
//     line, present ONLY when the plan's status is "aborted". Text is
//     EXACTLY `reason: <reason> · cause: <cause> · spec: <specRef>` when the
//     plan carries them, else EXACTLY `reason unrecorded`.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";

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

interface CycleFixture {
  id: number;
  label: string;
  kind?: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
  reason?: string;
  cause?: "spec-design" | "gap-analysis";
  specRef?: string;
  changeKind?: "insert" | "rename" | "append" | "skip" | "abort";
}

interface PlanFixture {
  planId: number | string;
  cr: string;
  projectKey: string;
  status: "open" | "closed" | "aborted";
  wave?: string;
  cycles: CycleFixture[];
  merge?: { commit: string };
  closedAt?: number;
  reason?: string;
  cause?: "spec-design" | "gap-analysis";
  specRef?: string;
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

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  plans: PlanFixture[];
}

let cacheBust = 0;

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`workflow-recorded-change-visibility.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?workflowRecordedChange=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

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

async function openWorkflowTab(): Promise<void> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === "Workflow");
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
}

function history(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="workflow-history"]');
  expect(el).not.toBeNull();
  return el!;
}

function active(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="workflow-active"]');
  expect(el).not.toBeNull();
  return el!;
}

function recordText(reason: string, cause: string, specRef: string): string {
  return `reason: ${reason} · cause: ${cause} · spec: ${specRef}`;
}

// ── History — LensCrGroup / LensCycleRow ────────────────────────────────

describe("AC6 — a plan's recorded changes and skips read as a defect signal in Workflow History (DOM)", () => {
  test("an aborted plan with a recorded reason shows it UNEXPANDED beside a skip count, and expanding it shows the same record on the skipped cycle it covers", async () => {
    const key = "wf-rec-abort-recorded";
    const plan: PlanFixture = {
      planId: 501,
      cr: "CR-REC-ABORT",
      projectKey: key,
      status: "aborted",
      wave: "3",
      reason: "spec redesigned mid-flight — the planned verify sweep no longer fits",
      cause: "spec-design",
      specRef: "docs/changes/spec-x.md §S2",
      cycles: [
        { id: 5011, label: "c1 red-green", status: "failed" },
        {
          id: 5012,
          label: "c2 verify",
          status: "skipped",
          reason: "spec redesigned mid-flight — the planned verify sweep no longer fits",
          cause: "spec-design",
          specRef: "docs/changes/spec-x.md §S2",
          changeKind: "abort",
        },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Abort Recorded" })],
      plans: [plan],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>('[data-testid="cr-group"][data-cr="CR-REC-ABORT"]');
    expect(crGroup).not.toBeNull();
    const toggleHeader = crGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]');
    expect(toggleHeader).not.toBeNull();

    // Visible WITHOUT expanding — the whole point of a defect signal.
    const skipCount = toggleHeader!.querySelector<HTMLElement>('[data-testid="plan-skip-count"]');
    expect(skipCount).not.toBeNull();
    expect((skipCount!.textContent ?? "").trim()).toBe("1 skipped");
    const abortReason = toggleHeader!.querySelector<HTMLElement>('[data-testid="plan-abort-reason"]');
    expect(abortReason).not.toBeNull();
    expect((abortReason!.textContent ?? "").trim()).toBe(
      recordText(
        "spec redesigned mid-flight — the planned verify sweep no longer fits",
        "spec-design",
        "docs/changes/spec-x.md §S2",
      ),
    );

    // Collapsed by default (established LensCrGroup contract) — expand it.
    expect(crGroup!.querySelectorAll('[data-testid="lens-cycle-row"]').length).toBe(0);
    toggleHeader!.click();
    await settle();
    const rows = Array.from(crGroup!.querySelectorAll<HTMLElement>('[data-testid="lens-cycle-row"]'));
    expect(rows.length).toBe(2);

    const skippedRow = rows.find((r) => r.getAttribute("data-cycle-id") === "5012");
    expect(skippedRow).toBeDefined();
    const rowRecord = skippedRow!.querySelector<HTMLElement>('[data-testid="cycle-change-record"]');
    expect(rowRecord).not.toBeNull();
    expect((rowRecord!.textContent ?? "").trim()).toBe(
      recordText(
        "spec redesigned mid-flight — the planned verify sweep no longer fits",
        "spec-design",
        "docs/changes/spec-x.md §S2",
      ),
    );
    // RE-PIN (CR-CRU-176 §S2/AC2, F23, approved by the orchestrator — user
    // ruling 2026-10-08): the record reads BENEATH the cycle line, never
    // beside it — not a further child of `.app-cycle-line`. Meaning
    // unchanged (same element, same wording, asserted above); this adds the
    // DOM-position half of the contract.
    const skippedLine = skippedRow!.querySelector<HTMLElement>(".app-cycle-line");
    expect(skippedLine).not.toBeNull();
    expect(skippedLine!.contains(rowRecord!)).toBe(false);

    // BOUND — the abort-FAILED cycle (never skipped, carries no changeKind)
    // gets no record block at all: not every row in an aborted plan is one.
    const failedRow = rows.find((r) => r.getAttribute("data-cycle-id") === "5011");
    expect(failedRow).toBeDefined();
    expect(failedRow!.querySelector('[data-testid="cycle-change-record"]')).toBeNull();
  });

  test("an aborted plan and a skip predating this CR carry no reason and read as UNRECORDED — never blank, never a guess", async () => {
    const key = "wf-rec-abort-unrecorded";
    const plan: PlanFixture = {
      planId: 502,
      cr: "CR-LEGACY-ABORT",
      projectKey: key,
      status: "aborted",
      wave: "3",
      // No reason/cause/specRef at all — this CR never back-fills history.
      cycles: [{ id: 5021, label: "c1 legacy skip", status: "skipped" }],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Abort Unrecorded" })],
      plans: [plan],
    });
    await openWorkflowTab();

    const crGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-LEGACY-ABORT"]',
    );
    expect(crGroup).not.toBeNull();
    const toggleHeader = crGroup!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!;

    const abortReason = toggleHeader.querySelector<HTMLElement>('[data-testid="plan-abort-reason"]');
    expect(abortReason).not.toBeNull();
    expect((abortReason!.textContent ?? "").trim()).toBe("reason unrecorded");
    const skipCount = toggleHeader.querySelector<HTMLElement>('[data-testid="plan-skip-count"]');
    expect(skipCount).not.toBeNull();
    expect((skipCount!.textContent ?? "").trim()).toBe("1 skipped");

    toggleHeader.click();
    await settle();
    const row = crGroup!.querySelector<HTMLElement>('[data-testid="lens-cycle-row"][data-cycle-id="5021"]');
    expect(row).not.toBeNull();
    const rowRecord = row!.querySelector<HTMLElement>('[data-testid="cycle-change-record"]');
    // Present (not blank, not absent) and reads exactly "unrecorded".
    expect(rowRecord).not.toBeNull();
    expect((rowRecord!.textContent ?? "").trim()).toBe("reason unrecorded");
    expect((rowRecord!.textContent ?? "").trim().length).toBeGreaterThan(0);
  });

  test("a plain closed plan with nothing skipped or changed shows neither a skip count nor an abort reason; a closed plan with a recorded skip shows the count but still no abort reason (not aborted)", async () => {
    const key = "wf-rec-bounds";
    const plain: PlanFixture = {
      planId: 503,
      cr: "CR-NORMAL-CLOSED",
      projectKey: key,
      status: "closed",
      wave: "3",
      closedAt: 1_800_000_000_000,
      merge: { commit: "abc1234" },
      cycles: [{ id: 5031, label: "c1", status: "done" }],
    };
    const skippedButClosed: PlanFixture = {
      planId: 504,
      cr: "CR-SKIPPED-NOT-ABORTED",
      projectKey: key,
      status: "closed",
      wave: "3",
      closedAt: 1_800_000_001_000,
      merge: { commit: "def5678" },
      cycles: [
        { id: 5041, label: "c1", status: "done" },
        {
          id: 5042,
          label: "c2 obsolete",
          status: "skipped",
          reason: "the planned c2 no longer applied",
          cause: "gap-analysis",
          specRef: "docs/changes/spec-y.md §G3",
          changeKind: "skip",
        },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Bounds" })],
      plans: [plain, skippedButClosed],
    });
    await openWorkflowTab();

    const plainGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-NORMAL-CLOSED"]',
    )!;
    const plainHeader = plainGroup.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!;
    expect(plainHeader.querySelector('[data-testid="plan-skip-count"]')).toBeNull();
    expect(plainHeader.querySelector('[data-testid="plan-abort-reason"]')).toBeNull();

    const skippedGroup = history().querySelector<HTMLElement>(
      '[data-testid="cr-group"][data-cr="CR-SKIPPED-NOT-ABORTED"]',
    )!;
    const skippedHeader = skippedGroup.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]')!;
    const skipCount = skippedHeader.querySelector<HTMLElement>('[data-testid="plan-skip-count"]');
    expect(skipCount).not.toBeNull();
    expect((skipCount!.textContent ?? "").trim()).toBe("1 skipped");
    // BOUND — a merely-closed plan (never aborted) carries no abort reason,
    // however many of its cycles were recorded-skipped.
    expect(skippedHeader.querySelector('[data-testid="plan-abort-reason"]')).toBeNull();
  });
});

// ── Active — CycleRow / WorkflowActive ──────────────────────────────────

describe("AC6 — the Active (open-plan) panel shows the same recorded-change signal directly on its cycle rows (DOM)", () => {
  test("an open plan's skip count renders beside its CR root, and each skipped cycle's reason/cause/specRef renders on its row with no toggle needed — a fully unrecorded skip reads as 'reason unrecorded', not blank", async () => {
    const key = "wf-rec-active-skip";
    const plan: PlanFixture = {
      planId: 601,
      cr: "CR-ACTIVE-SKIP",
      projectKey: key,
      status: "open",
      wave: "4",
      cycles: [
        {
          id: 6011,
          label: "c1 red-green",
          status: "skipped",
          reason: "gap analysis found cycle 1 obsolete",
          cause: "gap-analysis",
          specRef: "docs/changes/spec-z.md §G2",
          changeKind: "skip",
        },
        { id: 6012, label: "c2 verify", status: "pending" },
        { id: 6013, label: "c3 fix", status: "active" },
        { id: 6014, label: "c4 legacy-shaped skip", status: "skipped" },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Active Skip" })],
      plans: [plan],
    });
    await openWorkflowTab();

    const root = active().querySelector<HTMLElement>(
      '[data-testid="workflow-cr-root"][data-cr="CR-ACTIVE-SKIP"]',
    );
    expect(root).not.toBeNull();
    const skipCount = root!.querySelector<HTMLElement>('[data-testid="plan-skip-count"]');
    expect(skipCount).not.toBeNull();
    expect((skipCount!.textContent ?? "").trim()).toBe("2 skipped");

    const recordedRow = active().querySelector<HTMLElement>('[data-testid="cycle-row"][data-cycle-id="6011"]');
    expect(recordedRow).not.toBeNull();
    const recordedBlock = recordedRow!.querySelector<HTMLElement>('[data-testid="cycle-change-record"]');
    expect(recordedBlock).not.toBeNull();
    expect((recordedBlock!.textContent ?? "").trim()).toBe(
      recordText("gap analysis found cycle 1 obsolete", "gap-analysis", "docs/changes/spec-z.md §G2"),
    );
    // RE-PIN (CR-CRU-176 §S2/AC2, F23, approved by the orchestrator — user
    // ruling 2026-10-08): the record reads BENEATH the cycle line, never
    // beside it — not a further child of `.app-cycle-line`. Meaning
    // unchanged (same element, same wording, asserted above); this adds the
    // DOM-position half of the contract.
    const recordedLine = recordedRow!.querySelector<HTMLElement>(".app-cycle-line");
    expect(recordedLine).not.toBeNull();
    expect(recordedLine!.contains(recordedBlock!)).toBe(false);

    const unrecordedRow = active().querySelector<HTMLElement>('[data-testid="cycle-row"][data-cycle-id="6014"]');
    expect(unrecordedRow).not.toBeNull();
    const unrecordedBlock = unrecordedRow!.querySelector<HTMLElement>('[data-testid="cycle-change-record"]');
    expect(unrecordedBlock).not.toBeNull();
    expect((unrecordedBlock!.textContent ?? "").trim()).toBe("reason unrecorded");

    // BOUND — a pending/active cycle untouched by any recorded change
    // carries no record block at all (no clutter on the ordinary case).
    const pendingRow = active().querySelector<HTMLElement>('[data-testid="cycle-row"][data-cycle-id="6012"]');
    expect(pendingRow!.querySelector('[data-testid="cycle-change-record"]')).toBeNull();
    const activeRow = active().querySelector<HTMLElement>('[data-testid="cycle-row"][data-cycle-id="6013"]');
    expect(activeRow!.querySelector('[data-testid="cycle-change-record"]')).toBeNull();
  });

  test("a pending cycle carrying a recorded rename (R1) shows its reason/cause/specRef though it was never skipped, and a plan with no skipped cycles shows no skip count at all", async () => {
    const key = "wf-rec-active-rename";
    const plan: PlanFixture = {
      planId: 602,
      cr: "CR-ACTIVE-RENAME",
      projectKey: key,
      status: "open",
      wave: "4",
      cycles: [
        {
          id: 6021,
          label: "c1 renamed per spec clarification",
          status: "pending",
          reason: "orchestrator renamed c1 after the spec clarified its scope",
          cause: "spec-design",
          specRef: "docs/changes/spec-w.md §S1",
          changeKind: "rename",
        },
        { id: 6022, label: "c2", status: "active" },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Active Rename" })],
      plans: [plan],
    });
    await openWorkflowTab();

    const root = active().querySelector<HTMLElement>(
      '[data-testid="workflow-cr-root"][data-cr="CR-ACTIVE-RENAME"]',
    );
    expect(root).not.toBeNull();
    // BOUND — zero skipped cycles -> no skip-count element at all.
    expect(root!.querySelector('[data-testid="plan-skip-count"]')).toBeNull();

    const row = active().querySelector<HTMLElement>('[data-testid="cycle-row"][data-cycle-id="6021"]');
    expect(row).not.toBeNull();
    const record = row!.querySelector<HTMLElement>('[data-testid="cycle-change-record"]');
    expect(record).not.toBeNull();
    expect((record!.textContent ?? "").trim()).toBe(
      recordText(
        "orchestrator renamed c1 after the spec clarified its scope",
        "spec-design",
        "docs/changes/spec-w.md §S1",
      ),
    );
  });
});
