// THE IN-FLIGHT WINDOW, HELD OPEN — a test-side gate over the already-mounted
// `globalThis.fetch` mock.
//
// Every happy-dom mount harness in this suite scripts `fetch` to resolve
// IMMEDIATELY, which is exactly right for asserting what a settled request
// produced and exactly useless for asserting what the UI shows WHILE one is
// still in flight (CR-CRU-122: a spinner, and a control that refuses a second
// click). A setTimeout-based "slow fetch" would trade that for a race; this
// holds the response on an explicit promise instead, so the in-flight window
// stays open for as long as the test needs and closes exactly when it says.
//
// It WRAPS rather than replaces: install it AFTER `mountApp()` and the file's
// own mock still services every request (and still records its own
// postCalls / patchCalls / fetchLog) — the gate only decides WHEN the wrapped
// mock is reached, and counts the requests that reached the gate.
//
// `fired` counts ATTEMPTS, not deliveries: that is the honest counter for a
// double-submit guard, because a second request that is fired and then held
// has still been fired.

export interface HeldRequest {
  url: string;
  method: string;
}

export interface FetchGate {
  /** Matching requests ATTEMPTED since install — held or not. */
  readonly fired: number;
  /** Matching requests currently held open. */
  readonly held: readonly HeldRequest[];
  /** Lets the held requests whose url matches through to the wrapped mock. */
  resolveWhere(match: (url: string) => boolean): number;
  /** Lets every held request through to the wrapped mock. */
  resolveAll(): number;
  /** Rejects every held request — the caller's `fetch` promise rejects and the
   *  wrapped mock is never reached, so no server-side fixture state moves. */
  rejectAll(error?: Error): number;
  /** Stops holding: everything held is released and later matches go straight
   *  through, still counted by `fired`. */
  passThrough(): void;
  /** Puts the wrapped `fetch` back. */
  restore(): void;
}

interface Slot {
  url: string;
  method: string;
  settle: (error?: Error) => void;
}

export function gateFetch(shouldHold: (url: string, method: string) => boolean): FetchGate {
  const inner = globalThis.fetch;
  const slots: Slot[] = [];
  let fired = 0;
  let holding = true;

  const drop = (slot: Slot): void => {
    const at = slots.indexOf(slot);
    if (at !== -1) slots.splice(at, 1);
  };

  const gated = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (shouldHold(url, method)) {
      fired += 1;
      if (holding) {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const slot: Slot = {
          url,
          method,
          settle: (error?: Error) => {
            if (error === undefined) resolve();
            else reject(error);
          },
        };
        slots.push(slot);
        try {
          await promise;
        } finally {
          drop(slot);
        }
      }
    }
    return inner(input, init);
  }) as typeof fetch;

  globalThis.fetch = gated;

  const settleWhere = (match: (url: string) => boolean, error?: Error): number => {
    const chosen = slots.filter((slot) => match(slot.url));
    for (const slot of chosen) {
      drop(slot);
      slot.settle(error);
    }
    return chosen.length;
  };

  return {
    get fired() {
      return fired;
    },
    get held() {
      return slots.map(({ url, method }) => ({ url, method }));
    },
    resolveWhere: (match) => settleWhere(match),
    resolveAll: () => settleWhere(() => true),
    rejectAll: (error?: Error) =>
      settleWhere(() => true, error ?? new Error("gated fetch rejected by the test")),
    passThrough: () => {
      holding = false;
      settleWhere(() => true);
    },
    restore: () => {
      globalThis.fetch = inner;
    },
  };
}
