// What the coverage file table's DOM suites share.
//
// The production shell is mounted in happy-dom against a REAL board
// (tests/helpers/served-app.ts): every run is ingested over HTTP with its
// coverage report, so the rows a suite reads are drawn from what the board
// decoded, stored and answers, never from a reply shaped to the test.
//
//  - a board with one project, and the runs a suite files on it: a green run
//    with a coverage report, a run filed with coverage totals only, a failing
//    run;
//  - the page, opened with a scriptable stream so a suite decides when a frame
//    arrives;
//  - what the page shows of a run's files, read without leaning on any class
//    name: the rows by their test id, a row's `title`, its text and the widths
//    its meter is drawn at;
//  - which reads of a run's files the page sent, as the shell asked for them.
import { expect } from "bun:test";
import type { BoardHandle } from "../../src/server.ts";
import {
  eventIdOf,
  eventRead,
  FAILING_REPORT,
  lcovText,
  PASSING_REPORT,
  type CoverageFile,
  type LcovRecord,
} from "./coverage-files-harness.ts";
import { bootInProcess, postJson, readyProject } from "./run-stream-harness.ts";
import { mountServedApp, restoreRealFetch, servedFetchLog, settleServedApp } from "./served-app.ts";
import { FakeEventSource, installEventSource, restoreEventSource } from "./stream-workspace-harness.ts";

// ── The board ───────────────────────────────────────────────────────────────

/** A board with no socket, answered by its own `fetch` at
 *  `http://board.invalid`, holding one project and its registered agent. */
export interface InProcessBoard {
  handle: BoardHandle;
  /** The one project's key. */
  key: string;
  /** The agent every run is filed by. */
  agentId: string;
}

/** The board every helper below drives. */
export type AnyBoard = InProcessBoard;

const started: BoardHandle[] = [];

/** An in-memory store with no socket, holding one project and its registered
 *  agent; `closeBoards` stops it. */
export async function startBoardInProcess(name = "coverage-files-view"): Promise<InProcessBoard> {
  const handle = bootInProcess();
  started.push(handle);
  const agentId = "coverage-runner";
  const key = await readyProject(handle, [agentId], name);
  return { handle, key, agentId };
}

/** Take the page down, put the runtime's own fetch and stream back, and stop every board. */
export async function closeBoards(): Promise<void> {
  await restoreRealFetch();
  restoreEventSource();
  while (started.length > 0) started.pop()?.stop();
}

// ── Runs ────────────────────────────────────────────────────────────────────

/** Two runs filed back to back never share a timestamp: the later one is the newer. */
async function laterThanTheLastRun(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 3);
  await promise;
}

/** A green run of two tests, with the coverage block when one is given; answers its event id. */
export async function greenRun(
  board: AnyBoard,
  coverage?: unknown,
  extra: Record<string, unknown> = {},
): Promise<string> {
  await laterThanTheLastRun();
  return eventIdOf(
    await postJson(board.handle, "/api/v2/runs", {
      projectKey: board.key,
      agentId: board.agentId,
      codec: "junit",
      data: PASSING_REPORT,
      ...(coverage !== undefined ? { coverage } : {}),
      ...extra,
    }),
  );
}

/** A green run whose coverage report is an lcov text of `records`. */
export function lcovRun(board: AnyBoard, records: readonly LcovRecord[], extra: Record<string, unknown> = {}): Promise<string> {
  return greenRun(board, { codec: "lcov", data: lcovText(records) }, extra);
}

/** A run of one failing test, with the coverage block when one is given: the board keeps no coverage for it. */
export async function failingRun(board: AnyBoard, coverage?: unknown): Promise<string> {
  await laterThanTheLastRun();
  return eventIdOf(
    await postJson(board.handle, "/api/v2/runs", {
      projectKey: board.key,
      agentId: board.agentId,
      codec: "junit",
      data: FAILING_REPORT,
      ...(coverage !== undefined ? { coverage } : {}),
    }),
  );
}

export interface Totals {
  lines: { total: number; covered: number; percent: number };
  functions?: { total: number; covered: number; percent: number };
}

/** A green run filed already decoded, its coverage as totals alone: the board keeps no file for it. */
export async function totalsOnlyRun(board: AnyBoard, coverage: Totals): Promise<string> {
  await laterThanTheLastRun();
  return eventIdOf(
    await postJson(board.handle, "/api/v2/runs/parsed", {
      projectKey: board.key,
      agentId: board.agentId,
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 },
      tree: [{ name: "Green", status: "pass", children: [{ name: "g1", status: "pass", duration_ms: 5 }] }],
      coverage,
    }),
  );
}

/** The directory every file of `numberedRecords` shares, unless another is given. */
export const NUMBERED_ROOT = "/srv/app/src/";

/**
 * `count` files of 100 lines each, file `i` with `i` lines covered and two of
 * its four functions: no two share a lines percent, so the board keeps them
 * in the order written here, `m00.ts` first.
 */
export function numberedRecords(count: number, root = NUMBERED_ROOT): LcovRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `${root}m${String(index).padStart(2, "0")}.ts`,
    lf: 100,
    lh: index,
    fnf: 4,
    fnh: 2,
  }));
}

/** The names of `numberedRecords(count)` as a row shows them, in the board's order. */
export function numberedNames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `m${String(index).padStart(2, "0")}.ts`);
}

export interface BoardFiles {
  count: number;
  root: string;
  files: CoverageFile[];
}

/** What the board itself answers for a run's files, read in full. */
export async function boardFiles(board: AnyBoard, eventId: string): Promise<BoardFiles> {
  const event = await eventRead(board.handle, eventId, "?depth=coverage");
  return {
    count: event.coverageFileCount as number,
    root: event.coverageRoot as string,
    files: event.coverageFiles as CoverageFile[],
  };
}

// ── The page ────────────────────────────────────────────────────────────────

const live: { source: FakeEventSource | null } = { source: null };

/** Open the board's page at `pathname`, its stream open and its first reads answered. */
export async function openPage(board: AnyBoard, pathname: string): Promise<void> {
  live.source = null;
  installEventSource(
    class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        live.source = this;
      }
    },
  );
  await mountServedApp(board.handle, pathname);
  if (live.source === null) throw new Error("coverage-files-view: the page opened no stream");
  (live.source as FakeEventSource).open();
  await settleServedApp();
}

/** An `events` frame arrives on the page's stream, and every read it sets off is answered. */
export async function eventsFrameArrives(board: AnyBoard): Promise<void> {
  if (live.source === null) throw new Error("coverage-files-view: the page opened no stream");
  live.source.dispatch("events", board.key);
  await settleServedApp();
}

/** The path of a run's own page inside the home pane. */
export const homeRunPath = (_board: AnyBoard, eventId: string): string => `/run/${encodeURIComponent(eventId)}`;

/** The path of a run's own page inside its project's workspace. */
export const workspaceRunPath = (board: AnyBoard, eventId: string): string =>
  `/p/${encodeURIComponent(board.key)}/run/${encodeURIComponent(eventId)}`;

/** The two containers a run's own page is drawn in. */
export const RUN_PAGE_CONTAINERS = [
  ["the home pane", homeRunPath],
  ["the workspace", workspaceRunPath],
] as const;

/** Open the project's workspace and select its Coverage tab. */
export async function openCoverageTab(board: AnyBoard): Promise<void> {
  await openPage(board, `/p/${encodeURIComponent(board.key)}`);
  await selectCoverageTab();
}

/** Select the workspace's Coverage tab, which must be there and enabled. */
export async function selectCoverageTab(): Promise<void> {
  const tab = all("workspace-tab").find((el) => reading(el).includes("Coverage"));
  expect(tab, "the workspace shows a Coverage tab").toBeDefined();
  expect(tab!.hasAttribute("disabled"), "the Coverage tab is enabled").toBe(false);
  tab!.click();
  await settleServedApp();
  expect(one("coverage-panel"), "the Coverage tab's panel is drawn").not.toBeNull();
}

// ── What the page shows ─────────────────────────────────────────────────────

/** The first element carrying `testId` under `root`. */
export function one(testId: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

/** Every element carrying `testId` under `root`, in document order. */
export function all(testId: string, root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));
}

/**
 * A node's text as a reader takes it: runs of white space are one space, and
 * a zero-width space (a break point a long name may be given) is not text.
 */
export function reading(node: Node | null | undefined): string {
  return (node?.textContent ?? "").replace(/\u200B/g, "").replace(/\s+/g, " ").trim();
}

/** The innermost elements under `root` that read exactly `text`. */
export function reads(text: string, root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("*")).filter(
    (el) => reading(el) === text && !Array.from(el.children).some((child) => reading(child) === text),
  );
}

/** Whether `later` comes after `earlier` in the document. */
export function follows(later: Node, earlier: Node): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/** Click `el`, which must be there, and let every read the click sets off answer. */
export async function press(el: HTMLElement | null | undefined, what: string): Promise<void> {
  expect(el ?? null, what).not.toBeNull();
  el!.click();
  await settleServedApp();
}

export interface ShownRow {
  /** The row's `title` attribute. */
  title: string | null;
  /** The row's text, as `reading` takes it. */
  text: string;
  /** Every inline percent width drawn inside the row: its meter's fill. */
  widths: string[];
}

/** Every file row under `root`, in document order. */
export function shownRows(root: ParentNode = document): ShownRow[] {
  return all("coverage-file-row", root).map((row) => ({
    title: row.getAttribute("title"),
    text: reading(row),
    widths: [row, ...Array.from(row.querySelectorAll<HTMLElement>("*"))]
      .map((el) => /(?:^|;)\s*width:\s*([\d.]+%)/.exec(el.getAttribute("style") ?? "")?.[1])
      .filter((width): width is string => width !== undefined),
  }));
}

/** A percent as the page words the totals' percents: the board's number and a `%`. */
export const percentOf = (axis: { percent: number }): string => `${String(axis.percent)}%`;

/** An axis's counters as the page words the totals' counters: `covered/total`. */
export const countersOf = (axis: { covered: number; total: number }): string =>
  `${String(axis.covered)}/${String(axis.total)}`;

/** A file's functions as its row words them: `covered/total · percent`. */
export const functionsOf = (axis: { covered: number; total: number; percent: number }): string =>
  `${countersOf(axis)} · ${percentOf(axis)}`;

/**
 * What is left of `text` once each of `parts` is taken out of it once, in the
 * order given. A part that is not there is named in the answer, so a
 * comparison with the empty string says which one was missing.
 */
export function leftover(text: string, parts: readonly string[]): string {
  let rest = text;
  for (const part of parts) {
    const at = rest.indexOf(part);
    if (at === -1) return `no "${part}" in "${rest}"`;
    rest = `${rest.slice(0, at)} ${rest.slice(at + part.length)}`;
  }
  return rest.replace(/\s+/g, " ").trim();
}

/**
 * A row shows one file: its `title` is the file's whole name; its text is the
 * name without `root`, the lines as `covered/total`, the lines percent, and
 * the functions as `covered/total · percent` when the file has them, and
 * nothing else (so a file without functions has an empty functions cell); its
 * meter is filled to the lines percent.
 */
export function expectRowShows(row: ShownRow | undefined, file: CoverageFile, root: string): void {
  expect(row, `a row for ${file.path}`).toBeDefined();
  const name = file.path.slice(root.length);
  expect(row!.title, `the title of the row for ${name}`).toBe(file.path);
  if (root !== "") {
    expect(row!.text.includes(root), `the row for ${name} shows the shared directory: "${row!.text}"`).toBe(false);
  }
  const parts = [
    name,
    ...(file.functions !== undefined ? [functionsOf(file.functions)] : []),
    countersOf(file.lines),
    percentOf(file.lines),
  ];
  expect(leftover(row!.text, parts), `the row for ${name} reads "${row!.text}"`).toBe("");
  expect(row!.widths, `the meter of the row for ${name}`).toContain(percentOf(file.lines));
}

/** Every row under `root` shows the file at its place in `files`, and there are no other rows. */
export function expectRowsShow(files: readonly CoverageFile[], root: string, under: ParentNode = document): void {
  const rows = shownRows(under);
  expect(rows.map((row) => row.title)).toEqual(files.map((file) => file.path));
  files.forEach((file, index) => expectRowShows(rows[index], file, root));
}

/** The pane the Coverage tab is drawn in. */
export function coveragePane(): HTMLElement {
  const panel = one("coverage-panel");
  expect(panel, "the Coverage tab's panel is drawn").not.toBeNull();
  const pane = panel!.closest<HTMLElement>('[data-testid="pane-scroll"]');
  expect(pane, "the Coverage tab's panel sits in a pane").not.toBeNull();
  return pane!;
}

/** The container a run's own page is drawn in. */
export function runPage(): HTMLElement {
  const page = one("run-overlay");
  expect(page, "the run's own page is drawn").not.toBeNull();
  return page!;
}

/** Every `number%` figure in `text`, in order. */
export function percentsIn(text: string): string[] {
  return text.match(/\d+(?:\.\d+)?%/g) ?? [];
}

// ── The reads the page sent ─────────────────────────────────────────────────

/** A read of a run's first 50 files, as `fileReads` words it. */
export const FIRST_FIFTY = "depth=coverage&files=50";

/** A read of every file of a run, as `fileReads` words it. */
export const EVERY_FILE = "depth=coverage";

function coverageQuery(url: string, eventId?: string): string | null {
  const match = /^\/api\/v2\/events\/([^/?]+)\?(.*)$/.exec(url);
  if (match === null) return null;
  if (eventId !== undefined && decodeURIComponent(match[1]!) !== eventId) return null;
  const query = new URLSearchParams(match[2]!);
  if (query.get("depth") !== "coverage") return null;
  return Array.from(query.entries())
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("&");
}

/**
 * Every read of a run's files the page sent and the board answered, in order,
 * each as its query with the parameters sorted: of one run when `eventId` is
 * given, of any run otherwise.
 */
export function fileReads(eventId?: string): string[] {
  return servedFetchLog.map((url) => coverageQuery(url, eventId)).filter((query): query is string => query !== null);
}

/** Whether `url` is a read of a run's files (of `eventId`'s when given). */
export function isFileRead(url: string, eventId?: string): boolean {
  return coverageQuery(url, eventId) !== null;
}

export interface Refusal {
  /** How many reads of a run's files were answered with the refusal. */
  readonly refused: number;
  /** Stop refusing: later reads reach the board again. */
  lift(): void;
}

/**
 * From now on the board's answer to every read of a run's files is replaced by
 * an error answer of `status`; every other request reaches the board as before.
 */
export function refuseFileReads(status = 500): Refusal {
  const inner = globalThis.fetch;
  let refused = 0;
  let refusing = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (refusing && isFileRead(url)) {
      refused += 1;
      const text = JSON.stringify({ ok: false, error: "the store could not be read" });
      return { ok: false, status, json: async () => JSON.parse(text) as unknown, text: async () => text } as unknown as Response;
    }
    return inner(input, init);
  }) as typeof fetch;
  return {
    get refused() {
      return refused;
    },
    lift: () => {
      refusing = false;
    },
  };
}
