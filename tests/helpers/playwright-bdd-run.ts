// A `playwright-bdd` run in the shape the board stores for it — one suite per
// feature and browser, one test per scenario, the scenario's Gherkin steps in
// `TestLeaf.steps` — streamed in `crucible-events` and closed over HTTP to a
// real in-process board, exactly as the bun client streams a `playwright-bdd`
// target. The run-detail view tests mount the production shell against that
// board (tests/helpers/served-app.ts), so the view draws what the store serves.
import { expect } from "bun:test";
import type { ServerHandle } from "../../src/server.ts";
import { closeStream, eventLine, openRun, register, sendBatch } from "./run-stream-harness.ts";

export const BDD_AGENT = "bdd-run-view-runner";

export interface BddFailure {
  message?: string;
  type?: string;
  trace?: string;
}

export interface BddStep {
  name: string;
  status: "pass" | "fail";
  duration_ms: number;
  failure?: BddFailure;
}

export interface BddScenario {
  feature: string;
  browser: string;
  name: string;
  status: "pass" | "fail";
  steps: BddStep[];
  /** Absent: the test-end carries no `failure` key at all. */
  failure?: BddFailure;
}

export const passingStep = (name: string): BddStep => ({ name, status: "pass", duration_ms: 5 });

export const failingStep = (name: string, message: string): BddStep => ({
  name,
  status: "fail",
  duration_ms: 5,
  failure: { message },
});

/** A frontend project on `handle` with the runner registered; answers its key. */
export async function bddProject(handle: ServerHandle, name: string): Promise<string> {
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name, type: "frontend", sutRoot: `/tmp/${name}` });
  await register(handle, key, BDD_AGENT);
  return key;
}

function scenarioLine(s: BddScenario, index: number): string {
  return eventLine({
    event: "test-end",
    id: `scenario-${index}-${s.browser}`,
    name: s.name,
    suite: s.feature,
    file: `features/${s.feature.toLowerCase().replace(/[^a-z]+/g, "-")}.feature`,
    browser: s.browser,
    status: s.status,
    duration_ms: 20,
    steps: s.steps,
    ...(s.failure !== undefined ? { failure: s.failure } : {}),
  });
}

function streamOf(scenarios: BddScenario[]): string {
  const failed = scenarios.filter((s) => s.status === "fail").length;
  return (
    eventLine({ event: "run-start", total: scenarios.length }) +
    scenarios.map(scenarioLine).join("") +
    eventLine({
      event: "run-end",
      total: scenarios.length,
      passed: scenarios.length - failed,
      failed,
      pending: 0,
      duration_ms: 20 * scenarios.length,
    })
  );
}

/** Opens, streams and closes a `playwright-bdd` run under `tier`; answers the event it stored. */
export async function streamBddRun(
  handle: ServerHandle,
  key: string,
  scenarios: BddScenario[],
  tier: string,
): Promise<string> {
  const runId = await openRun(handle, key, BDD_AGENT, { tier, stack: "bun", framework: "playwright-bdd" });
  const batch = await sendBatch(handle, runId, { projectKey: key, agentId: BDD_AGENT, from: 0, data: streamOf(scenarios) });
  expect(batch.status, JSON.stringify(batch.body)).toBe(200);
  const closed = await closeStream(handle, key, BDD_AGENT, runId);
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  expect(typeof closed.body.event).toBe("string");
  return closed.body.event as string;
}

// ── reading the mounted specification view ──────────────────────────────

export function overlay(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="run-overlay"]');
  if (el === null) throw new Error('no [data-testid="run-overlay"] mounted');
  return el;
}

export function featureOf(title: string): HTMLElement {
  const groups = Array.from(overlay().querySelectorAll<HTMLElement>('[data-testid="feature-group"]'));
  const found = groups.find((g) => g.getAttribute("data-feature-name") === title);
  if (found === undefined) {
    throw new Error(
      `no feature-group named "${title}"; features present: ${JSON.stringify(groups.map((g) => g.getAttribute("data-feature-name")))}`,
    );
  }
  return found;
}

/** The scenario rows of a feature: its `[data-testid="suite-row"]`s. */
export function scenarioRowsOf(feature: string): HTMLElement[] {
  return Array.from(featureOf(feature).querySelectorAll<HTMLElement>('[data-testid="suite-row"]'));
}

/** The one scenario row of `name` in `feature`, naming `browser` when given. */
export function scenarioRow(feature: string, name: string, browser?: string): HTMLElement {
  const rows = scenarioRowsOf(feature);
  const matching = rows.filter((r) => {
    const label = r.querySelector(".app-suite-name")?.textContent ?? r.textContent ?? "";
    return label.includes(name) && (browser === undefined || (r.textContent ?? "").includes(browser));
  });
  const [only] = matching;
  if (matching.length !== 1 || only === undefined) {
    throw new Error(
      `expected one scenario row "${name}"${browser !== undefined ? ` naming ${browser}` : ""} in feature "${feature}", found ${matching.length}; rows: ${JSON.stringify(rows.map((r) => (r.textContent ?? "").trim()))}`,
    );
  }
  return only;
}

/** A scenario's OWN failure boxes: those in its group (or on its row) and
 *  inside no step row. */
export function ownFailureBoxes(row: HTMLElement): HTMLElement[] {
  const group = row.parentElement ?? row;
  return Array.from(group.querySelectorAll<HTMLElement>('[data-testid="failure-box"]')).filter(
    (box) => box.closest('[data-testid="leaf-row"]') === null,
  );
}

/** The heat cells of a scenario named `name`, of `status` (`fail`|`pass`|`pending`). */
export function heatCellsOf(name: string, status: "fail" | "pass" | "pending"): HTMLElement[] {
  return Array.from(overlay().querySelectorAll<HTMLElement>(`[data-testid="heat-cell"].app-heat-${status}`)).filter(
    (cell) => (cell.getAttribute("title") ?? "").endsWith(` › ${name}`),
  );
}

/** Records every `scrollIntoView` call; `restore` puts the original back. */
export function interceptScrollIntoView(): { calls: HTMLElement[]; restore: () => void } {
  const calls: HTMLElement[] = [];
  const proto = HTMLElement.prototype as unknown as { scrollIntoView?: (...args: unknown[]) => void };
  const original = proto.scrollIntoView;
  proto.scrollIntoView = function (this: HTMLElement) {
    calls.push(this);
  };
  return {
    calls,
    restore: () => {
      proto.scrollIntoView = original;
    },
  };
}

/** Yields in short real steps until `done()` holds or `maxMs` passes. */
export async function waitUntil(done: () => boolean, maxMs = 3000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!done() && Date.now() < deadline) await Bun.sleep(20);
}
