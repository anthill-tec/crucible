// THE SHARED RENDER FLUSH — a condition-wait, not a sleep.
//
// 56 test files each carried their own copy of
//
//   async function settle(ticks = 8) {
//     for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 20));
//   }
//
// which spends a FIXED 160ms per call whatever the app is doing. Measured
// 2026-09-08 over the whole suite (`bun test --reporter=junit`): 2183 tests in
// 525s, of which 371s sat in the 53 happy-dom-mounting files — and the flush
// loop, not the rendering, is what that time buys.
//
// WHY YIELDING WITHOUT THE SLEEP IS SOUND, measured rather than assumed:
// production schedules exactly two classes of timer (`public/app.js`,
// `public/app-logic.mjs`, and the van/van-x bundles) —
//   • 0ms: `setTimeout(remeasure, 0)` (app.js:3428), `setTimeout(boot, 0)`
//     (app.js:5477) and van-x's own scheduler, which passes no delay at all;
//   • 5000ms: `setInterval(refetch, 5000)` (app.js:413),
//     `setTimeout(connectStream, 5000)` (app.js:406) and
//     `setInterval(watchdogTick, 5000)` (app.js:5467).
// There is NO debounce in between, so a 20ms sleep buys nothing a 0ms macrotask
// yield does not already give: every render-relevant callback is queued at 0ms.
// The 5000ms channel is deliberately NOT covered here — a test that needs a
// poll tick waits for it explicitly (`waitForPollTick`), and that wait is a
// real one because the interval it observes is real.
//
// THE STOPPING RULE IS DELIBERATELY UNCHANGED — the loop still yields the event
// loop a FIXED number of times, because a cleverer rule was measured WRONG.
// A first version here returned as soon as the document reported no mutations
// across two consecutive yields; `tests/roadmap-selection-durability.test.ts`
// then failed AC33 with `gateVersions()` == `[]` against `["0.1.0"]`, because a
// mount QUIETS while its release fetch is still in flight — the DOM is idle,
// the render is not finished, and "no mutations yet" is indistinguishable from
// "no mutations coming". Quiescence is therefore not a sound proxy for a
// completed render pass, and only the STEP is shortened: the number of yields,
// and so the number of chances pending work gets to land, is exactly what each
// caller already asked for.
//
// A test that needs a specific outcome should wait for THAT outcome
// (`waitForDom` below), not for a duration.

export interface SettleOptions {
  /** Macrotask yields — the caller's own tick count, unchanged. */
  ticks?: number;
  /** Sleep per yield. 0 replaces the copied 20ms; a bare yield is enough
   *  because nothing production schedules lands between 0ms and 5000ms, and
   *  measured 3.5% of one representative file's wall time (213ms of 6110ms)
   *  once the step was gone — the rest of that file was a real 5.7s poll wait,
   *  which is why waiting files are INTEGRATION rather than tuned here. */
  stepMs?: number;
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export async function settleDom(options: SettleOptions = {}): Promise<void> {
  const { ticks = 8, stepMs = 0 } = options;
  for (let i = 0; i < ticks; i++) await sleep(stepMs);
}

/** Wait for a CONDITION instead of a duration — the honest tool when a test
 *  knows what it is waiting for. Polls on the same short step the flush uses
 *  and fails with the caller's own description, so a timeout reads as the
 *  unmet expectation rather than as "this test timed out". */
export async function waitForDom(
  what: string,
  condition: () => boolean,
  options: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const { timeoutMs = 2_000, stepMs = 2 } = options;
  const startedAt = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`timed out after ${String(Date.now() - startedAt)}ms waiting for ${what}`);
    }
    await sleep(stepMs);
  }
}
