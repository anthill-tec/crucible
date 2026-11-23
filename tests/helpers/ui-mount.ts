// THE SHARED UI MOUNT — the production SPA shell in happy-dom, with its
// intervals opt-in per mount.
//
// Real VanJS/VanX vendor bundles, the real public/app-logic.mjs and the real
// public/app.js, in the order every mounting test file has always used:
// register happy-dom, evaluate the vendor bundles, import a fresh (cache-
// busted) app-logic.mjs — which writes a fresh `window.CrucibleLogic` — then
// evaluate app.js, whose `boot` hands that object to `main(L)`.
//
// INTERVALS ARE OPT-IN, ONE MOUNT AT A TIME. `intervals` replaces
// `window.CrucibleLogic.intervals` with a NEW object (the module's own values
// with the given ones laid over them) after the app-logic import and before
// the app.js eval, so every timer the shell arms on that mount reads it.
// With no `intervals` the bridge is left exactly as the module built it and
// the production cadences run: a test that relies on no poll firing keeps
// the defaults simply by passing none.
//
// ONE POLL-TICK WAIT. `waitForPollTick` waits for a CONDITION — the next
// poll's first read (`/api/v2/projects`, which every `refetch` reads first)
// observed on the mounted shell's fetch — within a 1 s deadline, then settles
// until no read is in flight. It never sleeps out a duration: a poll that
// never fires fails it at the deadline, by name.
//
// The deadlines run on `performance.now()`, never `Date.now()`, so a test
// that pins or moves the wall clock with `setSystemTime` cannot freeze them.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./dom-settle";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

/** The shell's six interval settings (`window.CrucibleLogic.intervals`). */
export interface UiIntervals {
  pollMs?: number;
  cycleTickMs?: number;
  runTickMs?: number;
  watchdogMs?: number;
  silenceMs?: number;
  reconnectMs?: number;
}

/** A short poll, at the safe minimum: for a test that waits on a poll tick. */
export const SHORT_POLL: UiIntervals = Object.freeze({ pollMs: 200 });

/** The deadline every condition wait in this helper gives its condition. */
export const TICK_DEADLINE_MS = 1000;

/** The fixture's answer to one of the shell's reads. */
export type UiFetch = (url: string, init?: RequestInit) => Promise<Response> | Response;

export interface UiMountOptions {
  /** Path (and query) the window opens at; `/` when omitted. */
  pathname?: string;
  /** The test file's own fixture fetch: every read the shell makes goes here. */
  fetch: UiFetch;
  /** Short intervals for THIS mount only; none keeps the production values. */
  intervals?: UiIntervals;
  /** File-specific setup once the window is registered and its fetch wired,
   *  before any script evaluates (spies, storage, a fake EventSource …). */
  beforeBoot?: () => void;
  /** The body the shell mounts into; `<div id="app"></div>` when omitted. */
  bodyHtml?: string;
}

let cacheBust = 0;
let inFlight = 0;
let pollReads = 0;

/** Every read the mounted shell made, in order, as the url it asked for. */
export const uiFetchLog: string[] = [];

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  const asUrl = (input as { url?: unknown; href?: unknown }) ?? {};
  if (typeof asUrl.url === "string") return asUrl.url;
  if (typeof asUrl.href === "string") return asUrl.href;
  return String(input);
}

/** The read every `refetch` makes first — and so the mark of a poll tick. */
function isPollRead(url: string): boolean {
  const pathOnly = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  return pathOnly === "/api/v2/projects";
}

/** Mount the production shell, every read answered by `opts.fetch`. */
export async function mountUi(opts: UiMountOptions): Promise<void> {
  await unmountUi();
  await GlobalRegistrator.register({ url: `http://localhost${opts.pathname ?? "/"}` });
  document.body.innerHTML = opts.bodyHtml ?? '<div id="app"></div>';
  uiFetchLog.length = 0;
  inFlight = 0;
  pollReads = 0;

  const answer = opts.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = urlOf(input);
    uiFetchLog.push(url);
    if (isPollRead(url)) pollReads += 1;
    inFlight += 1;
    try {
      return await answer(url, init);
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;

  opts.beforeBoot?.();

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?uiMount=${cacheBust}`);

  if (opts.intervals !== undefined) {
    const logic = (globalThis as unknown as { CrucibleLogic: { intervals?: UiIntervals } }).CrucibleLogic;
    logic.intervals = { ...(logic.intervals ?? {}), ...opts.intervals };
  }

  (0, eval)(APP_JS_SRC);
  await settleDom({ ticks: 8 });
}

/** Tear the mounted window down (its timers go with it). Safe to call twice. */
export async function unmountUi(): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
}

/** Wait until `condition` holds, yielding between checks, or fail by name. */
export async function waitUntil(
  condition: () => boolean,
  what: string,
  deadlineMs: number = TICK_DEADLINE_MS,
): Promise<void> {
  const deadline = performance.now() + deadlineMs;
  while (!condition()) {
    if (performance.now() >= deadline) {
      throw new Error(`${what}: not observed within ${deadlineMs}ms`);
    }
    await Bun.sleep(5);
  }
}

/** Wait until no read is in flight across several consecutive yields, then flush the render. */
export async function settleReads(): Promise<void> {
  const deadline = performance.now() + TICK_DEADLINE_MS;
  let quiet = 0;
  while (quiet < 4 && performance.now() < deadline) {
    await settleDom({ ticks: 1 });
    quiet = inFlight === 0 ? quiet + 1 : 0;
  }
  await settleDom({ ticks: 8 });
}

/** How many poll-mark reads (`/api/v2/projects`) the mounted shell has made. */
export function pollReadCount(): number {
  return pollReads;
}

/** Wait for the NEXT poll's read (1 s deadline), then settle until its refresh lands. */
export async function waitForPollTick(): Promise<void> {
  const seen = pollReads;
  await waitUntil(() => pollReads > seen, "waitForPollTick: the next poll's /api/v2/projects read");
  await settleReads();
}
