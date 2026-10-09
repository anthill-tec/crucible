// CR-CRU-176 §S2/AC2 — F23 pin: "A cycle's recorded change sits beneath it,
// never beside it" (.lavish/crucible-v2-design.html, F23, APPROVED
// 2026-10-08, read-only). The cycle line keeps its full title, kind badge,
// timer and `→ Runs` exactly as a cycle with no record; the record renders
// as its OWN dim, indented line beneath the cycle line — never a further
// child of the SAME line.
//
// Baseline (measured against public/app.js): `CycleRow` and `LensCycleRow`
// both call `CycleLine(toggle, ...)` and spread `...cycleChangeRecord(cycle)`
// as FURTHER CHILDREN of that same call — `[data-testid="cycle-change-
// record"]` is a DESCENDANT of `.app-cycle-line`, sharing its flex row with
// the label, so a long record crowds the label off its own line (the
// defect F23 draws from the user's screenshot). Every assertion below that
// checks the record sits OUTSIDE `.app-cycle-line`, AFTER it, is therefore
// expected to fail against current production.
//
// Harness: the same happy-dom + real public/app.js/public/app-logic.mjs
// mounting pattern as tests/workflow-recorded-change-visibility.test.ts
// (reused near-verbatim). That file owns the record's existence/absence/
// wording contract (CR-CRU-165) and is re-pinned, in its own commit, to read
// the record beneath the line too; THIS file owns the DOM-position contract
// F23 adds — never duplicating the existence/absence/wording assertions.
//
// Each scenario below mounts the SAME cycle (same label, kind, status and
// timer fields, at the SAME cycle ordinal — cycle 1 of a single-cycle plan,
// so the `cycle N ·` prefix never differs) TWICE, in two separate projects:
// once with no recorded-change fields at all, and once carrying them (or,
// for the skipped case, carrying a full reason vs. none — a skip always
// shows a record, so its true baseline is "the shortest possible record",
// not "none at all"). Comparing the two mounts' `.app-cycle-line` text
// proves the record's own length never leaks into the line, whichever side
// of the comparison supplies it.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";
import { singleReleaseHistoryStub } from "./helpers/history-stub";

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
  activatedAt?: number;
  doneAt?: number;
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
    if (/\/api\/v2\/projects\/[^/]+\/history/.test(url)) {
      // CR-CRU-173 cycle 637 re-pin (user ruling 2026-10-09, approved): History
      // nests its waves under a release, read from GET …/history; this
      // fixture's plans fall in one release (tests/helpers/history-stub.ts).
      body = singleReleaseHistoryStub(opts.plans ?? []);
    } else if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
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
      throw new Error(
        `workflow-cycle-change-record-sits-beneath-line.test.ts mountApp: unexpected fetch url ${url}`,
      );
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?cycleChangeRecordBeneathLine=${cacheBust}`);

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

function recordText(reason: string, cause: string, specRef: string): string {
  return `reason: ${reason} · cause: ${cause} · spec: ${specRef}`;
}

function findCycleRow(root: ParentNode, cycleId: number): HTMLElement {
  const el = root.querySelector<HTMLElement>(
    `[data-testid="cycle-row"][data-cycle-id="${cycleId}"], ` +
      `[data-testid="lens-cycle-row"][data-cycle-id="${cycleId}"]`,
  );
  expect(el).not.toBeNull();
  return el!;
}

function lineOf(row: HTMLElement): HTMLElement {
  const el = row.querySelector<HTMLElement>(".app-cycle-line");
  expect(el).not.toBeNull();
  return el!;
}

async function expandHistoryGroup(cr: string): Promise<HTMLElement> {
  const history = document.querySelector<HTMLElement>('[data-testid="workflow-history"]');
  expect(history).not.toBeNull();
  const group = history!.querySelector<HTMLElement>(`[data-testid="cr-group"][data-cr="${cr}"]`);
  expect(group).not.toBeNull();
  const toggle = group!.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]');
  expect(toggle).not.toBeNull();
  toggle!.click();
  await settle();
  return group!;
}

// Shared asserts: the record sits OUTSIDE the line, AFTER it in document
// order, and its own text is exactly the expected record wording.
function assertRecordBeneathLine(
  row: HTMLElement,
  line: HTMLElement,
  expectedRecordText: string,
): void {
  const record = row.querySelector<HTMLElement>('[data-testid="cycle-change-record"]');
  expect(record).not.toBeNull();
  // NOT inside the line (today's defect: it is a further child of it).
  expect(line.contains(record!)).toBe(false);
  // Comes AFTER the line within the row, in real document order.
  const ordered = Array.from(
    row.querySelectorAll<HTMLElement>('.app-cycle-line, [data-testid="cycle-change-record"]'),
  );
  const lineIdx = ordered.indexOf(line);
  const recordIdx = ordered.indexOf(record!);
  expect(lineIdx).toBeGreaterThanOrEqual(0);
  expect(recordIdx).toBeGreaterThan(lineIdx);
  // Text unchanged from the established CR-CRU-165 wording.
  expect((record!.textContent ?? "").trim()).toBe(expectedRecordText);
}

const T0 = 1_700_000_000_000;
const T1 = 1_700_000_041_000;

describe("F23 — a cycle's recorded change sits beneath its line, never beside it (Now)", () => {
  test("a cycle carrying a recorded rename keeps its line identical to the same cycle with no record, and renders the record beneath it, not inside it", async () => {
    const label =
      'a sealed run leaves no running snapshot behind, and each pane carries its own title';
    const plainKey = "f23-now-plain-rename";
    await mountApp({
      pathname: `/p/${plainKey}`,
      projects: [project({ key: plainKey, name: "F23 Now Plain Rename" })],
      plans: [
        {
          planId: 901,
          cr: "F23-NOW-PLAIN",
          projectKey: plainKey,
          status: "open",
          wave: "7",
          cycles: [
            { id: 9011, label, kind: "verify", status: "done", activatedAt: T0, doneAt: T1 },
          ],
        },
      ],
    });
    await openWorkflowTab();
    const plainRow = findCycleRow(
      document.querySelector('[data-testid="workflow-active"]')!,
      9011,
    );
    const plainLineText = (lineOf(plainRow).textContent ?? "").trim();
    expect(plainLineText.length).toBeGreaterThan(0);
    // BOUND — confirms this really is the "no record at all" baseline.
    expect(plainRow.querySelector('[data-testid="cycle-change-record"]')).toBeNull();

    const changedKey = "f23-now-changed-rename";
    await mountApp({
      pathname: `/p/${changedKey}`,
      projects: [project({ key: changedKey, name: "F23 Now Changed Rename" })],
      plans: [
        {
          planId: 902,
          cr: "F23-NOW-CHANGED",
          projectKey: changedKey,
          status: "open",
          wave: "7",
          cycles: [
            {
              id: 9021,
              label,
              kind: "verify",
              status: "done",
              activatedAt: T0,
              doneAt: T1,
              reason:
                "user ruling 2026-10-08: cycle 620's screenshot showed 0.2.0's orphaned running snapshots read as a running gate",
              cause: "spec-design",
              specRef: "docs/changes/spec-f23-fixture.md §S2",
              changeKind: "rename",
            },
          ],
        },
      ],
    });
    await openWorkflowTab();
    const changedRow = findCycleRow(
      document.querySelector('[data-testid="workflow-active"]')!,
      9021,
    );
    const changedLine = lineOf(changedRow);

    assertRecordBeneathLine(
      changedRow,
      changedLine,
      recordText(
        "user ruling 2026-10-08: cycle 620's screenshot showed 0.2.0's orphaned running snapshots read as a running gate",
        "spec-design",
        "docs/changes/spec-f23-fixture.md §S2",
      ),
    );
    // The line itself — glyph, `cycle N · "label"`, kind badge, timer,
    // `→ Runs` — reads EXACTLY as the same cycle with no record at all.
    expect((changedLine.textContent ?? "").trim()).toBe(plainLineText);
  });

  test("a skipped cycle's line reads identically whether its record is a long reason or the unrecorded fallback, and the record renders beneath it, not inside it", async () => {
    const label =
      'a skip whose line must never shrink to fit a reason, however long the reason runs on';
    const unrecordedKey = "f23-now-skip-unrecorded";
    await mountApp({
      pathname: `/p/${unrecordedKey}`,
      projects: [project({ key: unrecordedKey, name: "F23 Now Skip Unrecorded" })],
      plans: [
        {
          planId: 903,
          cr: "F23-NOW-SKIP-UNRECORDED",
          projectKey: unrecordedKey,
          status: "open",
          wave: "7",
          cycles: [
            { id: 9031, label, kind: "fix", status: "skipped", activatedAt: T0, doneAt: T1 },
          ],
        },
      ],
    });
    await openWorkflowTab();
    const unrecordedRow = findCycleRow(
      document.querySelector('[data-testid="workflow-active"]')!,
      9031,
    );
    const unrecordedLine = lineOf(unrecordedRow);
    assertRecordBeneathLine(unrecordedRow, unrecordedLine, "reason unrecorded");
    // Held as a string: the remount below destroys this mount's nodes.
    const unrecordedLineText = (unrecordedLine.textContent ?? "").trim();
    expect(unrecordedLineText.length).toBeGreaterThan(0);

    const recordedKey = "f23-now-skip-recorded";
    await mountApp({
      pathname: `/p/${recordedKey}`,
      projects: [project({ key: recordedKey, name: "F23 Now Skip Recorded" })],
      plans: [
        {
          planId: 904,
          cr: "F23-NOW-SKIP-RECORDED",
          projectKey: recordedKey,
          status: "open",
          wave: "7",
          cycles: [
            {
              id: 9041,
              label,
              kind: "fix",
              status: "skipped",
              activatedAt: T0,
              doneAt: T1,
              reason:
                "re-verify after cycle 622 (the v20 orphan-gate migration and the pane titles, user ruling 2026-10-08), which ran after the first verify by the board's ascending order",
              cause: "gap-analysis",
              specRef: "docs/changes/spec-f23-fixture.md §S5, AC7, AC2",
              changeKind: "skip",
            },
          ],
        },
      ],
    });
    await openWorkflowTab();
    const recordedRow = findCycleRow(
      document.querySelector('[data-testid="workflow-active"]')!,
      9041,
    );
    const recordedLine = lineOf(recordedRow);
    assertRecordBeneathLine(
      recordedRow,
      recordedLine,
      recordText(
        "re-verify after cycle 622 (the v20 orphan-gate migration and the pane titles, user ruling 2026-10-08), which ran after the first verify by the board's ascending order",
        "gap-analysis",
        "docs/changes/spec-f23-fixture.md §S5, AC7, AC2",
      ),
    );
    // The line's own text (glyph, label, kind badge, timer, `→ Runs`) never
    // changes with the record's length — a one-word fallback or a
    // paragraph-long reason render the SAME line.
    expect((recordedLine.textContent ?? "").trim()).toBe(unrecordedLineText);
  });
});

describe("F23 — a cycle's recorded change sits beneath its line, never beside it (History)", () => {
  test("a closed plan's recorded-rename cycle keeps its line identical to the same cycle with no record, and renders the record beneath it, not inside it", async () => {
    const label =
      'the v20 migration retires every orphaned running snapshot a sealed gate left behind';
    const plainKey = "f23-hist-plain-rename";
    await mountApp({
      pathname: `/p/${plainKey}`,
      projects: [project({ key: plainKey, name: "F23 History Plain Rename" })],
      plans: [
        {
          planId: 905,
          cr: "F23-HIST-PLAIN",
          projectKey: plainKey,
          status: "closed",
          wave: "7",
          closedAt: 1_800_000_000_000,
          merge: { commit: "f23plain1" },
          cycles: [
            { id: 9051, label, kind: "verify", status: "done", activatedAt: T0, doneAt: T1 },
          ],
        },
      ],
    });
    await openWorkflowTab();
    const plainGroup = await expandHistoryGroup("F23-HIST-PLAIN");
    const plainRow = findCycleRow(plainGroup, 9051);
    const plainLineText = (lineOf(plainRow).textContent ?? "").trim();
    expect(plainLineText.length).toBeGreaterThan(0);
    expect(plainRow.querySelector('[data-testid="cycle-change-record"]')).toBeNull();

    const changedKey = "f23-hist-changed-rename";
    await mountApp({
      pathname: `/p/${changedKey}`,
      projects: [project({ key: changedKey, name: "F23 History Changed Rename" })],
      plans: [
        {
          planId: 906,
          cr: "F23-HIST-CHANGED",
          projectKey: changedKey,
          status: "closed",
          wave: "7",
          closedAt: 1_800_000_001_000,
          merge: { commit: "f23chg1" },
          cycles: [
            {
              id: 9061,
              label,
              kind: "verify",
              status: "done",
              activatedAt: T0,
              doneAt: T1,
              reason: "add F22's pane titles alongside retiring the orphaned running snapshots",
              cause: "spec-design",
              specRef: "docs/changes/spec-f23-fixture.md §S5, AC7",
              changeKind: "rename",
            },
          ],
        },
      ],
    });
    await openWorkflowTab();
    const changedGroup = await expandHistoryGroup("F23-HIST-CHANGED");
    const changedRow = findCycleRow(changedGroup, 9061);
    const changedLine = lineOf(changedRow);

    assertRecordBeneathLine(
      changedRow,
      changedLine,
      recordText(
        "add F22's pane titles alongside retiring the orphaned running snapshots",
        "spec-design",
        "docs/changes/spec-f23-fixture.md §S5, AC7",
      ),
    );
    expect((changedLine.textContent ?? "").trim()).toBe(plainLineText);
  });

  test("a closed plan's skipped cycle's line reads identically whether its record is a long reason or the unrecorded fallback, and the record renders beneath it, not inside it", async () => {
    const label =
      'a snapshot superseded by a gate stamped at the same moment is retired too, and a test says so';
    const unrecordedKey = "f23-hist-skip-unrecorded";
    await mountApp({
      pathname: `/p/${unrecordedKey}`,
      projects: [project({ key: unrecordedKey, name: "F23 History Skip Unrecorded" })],
      plans: [
        {
          planId: 907,
          cr: "F23-HIST-SKIP-UNRECORDED",
          projectKey: unrecordedKey,
          status: "closed",
          wave: "7",
          closedAt: 1_800_000_002_000,
          merge: { commit: "f23unr1" },
          cycles: [
            { id: 9071, label, kind: "fix", status: "skipped", activatedAt: T0, doneAt: T1 },
          ],
        },
      ],
    });
    await openWorkflowTab();
    const unrecordedGroup = await expandHistoryGroup("F23-HIST-SKIP-UNRECORDED");
    const unrecordedRow = findCycleRow(unrecordedGroup, 9071);
    const unrecordedLine = lineOf(unrecordedRow);
    assertRecordBeneathLine(unrecordedRow, unrecordedLine, "reason unrecorded");
    // Held as a string: the remount below destroys this mount's nodes.
    const unrecordedLineText = (unrecordedLine.textContent ?? "").trim();
    expect(unrecordedLineText.length).toBeGreaterThan(0);

    const recordedKey = "f23-hist-skip-recorded";
    await mountApp({
      pathname: `/p/${recordedKey}`,
      projects: [project({ key: recordedKey, name: "F23 History Skip Recorded" })],
      plans: [
        {
          planId: 908,
          cr: "F23-HIST-SKIP-RECORDED",
          projectKey: recordedKey,
          status: "closed",
          wave: "7",
          closedAt: 1_800_000_003_000,
          merge: { commit: "f23rec1" },
          cycles: [
            {
              id: 9081,
              label,
              kind: "fix",
              status: "skipped",
              activatedAt: T0,
              doneAt: T1,
              reason: "a snapshot superseded by a gate stamped at the same moment is retired too",
              cause: "gap-analysis",
              specRef: "docs/changes/spec-f23-fixture.md §S7",
              changeKind: "skip",
            },
          ],
        },
      ],
    });
    await openWorkflowTab();
    const recordedGroup = await expandHistoryGroup("F23-HIST-SKIP-RECORDED");
    const recordedRow = findCycleRow(recordedGroup, 9081);
    const recordedLine = lineOf(recordedRow);
    assertRecordBeneathLine(
      recordedRow,
      recordedLine,
      recordText(
        "a snapshot superseded by a gate stamped at the same moment is retired too",
        "gap-analysis",
        "docs/changes/spec-f23-fixture.md §S7",
      ),
    );
    expect((recordedLine.textContent ?? "").trim()).toBe(unrecordedLineText);
  });
});
