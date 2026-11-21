// The bun dependency preload of a hermetic unit run:
//
//   HERMETIC_EVENTS=<abs path> bun test --preload ./scripts/hermetic/hooks/bun-preload.ts <dir>
//
// It records each real dependency a test file takes: a spawned process, a
// served socket (Bun.serve, Bun.listen, net.Server.listen), an outbound
// fetch, connection or WebSocket, and any wait on the clock — a timer or a
// sleep above 0 ms (a 0 ms timer is a yield) and any interval. It records
// only; it never fails a call.
//
// One tab-separated line per event, appended to $HERMETIC_EVENTS:
//
//   <charge>\t<event>\t<detail>\t<frame>
//
// <charge> is the test file found on the call stack (`helper:<file>` for a
// tests/ helper with no test file above it), else `-`. <frame> is the top
// stack frame outside this preload, node_modules and Bun's internals, so an event
// charged to no file can still be traced. Lines are de-duplicated on
// charge, event and detail. The preload's own first line is marked with the
// event `preload` (detail `loaded`): it proves the preload ran and is never
// a dependency.
import { appendFileSync } from "node:fs";
import * as child_process from "node:child_process";
import * as net from "node:net";

const LOG = process.env.HERMETIC_EVENTS;
const SELF = "hooks/bun-preload.ts";
const seen = new Set<string>();

type AnyFn = (...a: unknown[]) => unknown;

function charge(stack: string): string {
  const test = stack.match(/(tests\/[^\s:()]+\.test\.ts)/);
  if (test) return test[1];
  const helper = stack.match(/(tests\/[^\s:()]+\.ts)/);
  return helper ? `helper:${helper[1]}` : "-";
}

/** A frame inside Bun itself: its location (the part in the trailing
 *  parentheses, or the whole frame when it has none) is a `node:`, `bun:` or
 *  `internal:` module or native code (`native:1:11`, `[native code]`). A
 *  source file whose path merely contains "native" is not one. */
function isInternalFrame(frame: string): boolean {
  const location = /\(([^()]*)\)$/.exec(frame)?.[1] ?? frame;
  return (
    /^(?:node|bun|internal|native):/.test(location) ||
    location === "native" ||
    location.includes("[native code]")
  );
}

function topFrame(stack: string): string {
  for (const line of stack.split("\n").slice(1)) {
    const frame = line.trim().replace(/^at\s+/, "");
    if (frame.includes(SELF) || frame.includes("node_modules") || isInternalFrame(frame)) continue;
    return frame.slice(0, 200);
  }
  return "?";
}

function record(event: string, detail: string): void {
  if (!LOG) return;
  const stack = new Error().stack ?? "";
  const key = `${charge(stack)}\t${event}\t${detail.slice(0, 160)}`;
  if (seen.has(key)) return;
  seen.add(key);
  try {
    appendFileSync(LOG, `${key}\t${topFrame(stack)}\n`);
  } catch (error) {
    process.stderr.write(`hermetic preload: cannot record to ${LOG}: ${String(error)}\n`);
  }
}

function cmdOf(arg: unknown): string {
  const a = arg && typeof arg === "object" && "cmd" in arg ? (arg as { cmd: unknown }).cmd : arg;
  if (Array.isArray(a)) {
    return a.slice(0, 3).map(String).map((w, i) => (i === 0 ? w.split("/").pop() ?? w : w)).join(" ");
  }
  return String(a);
}

// SAFETY: Bun's exports are a plain mutable object; each member is read, wrapped and reassigned by name.
const B = Bun as unknown as Record<string, unknown>;

for (const name of ["spawn", "spawnSync"]) {
  const orig = B[name] as AnyFn;
  B[name] = (...a: unknown[]) => {
    record("spawn", cmdOf(a[0]));
    return orig.apply(Bun, a);
  };
}

const origServe = B.serve as AnyFn;
B.serve = (...a: unknown[]) => {
  const opts = a[0] as { port?: number } | undefined;
  record("serve", `port=${opts?.port ?? "?"}`);
  return origServe.apply(Bun, a);
};

for (const name of ["listen", "connect", "udpSocket"]) {
  const orig = B[name] as AnyFn | undefined;
  if (typeof orig !== "function") continue;
  B[name] = (...a: unknown[]) => {
    record(name === "listen" ? "serve" : "connect", `Bun.${name}`);
    return orig.apply(Bun, a);
  };
}

// SAFETY: the module namespace is indexed by export name; a frozen namespace throws and is caught below.
const cp = child_process as unknown as Record<string, AnyFn>;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const orig = cp[name];
  if (typeof orig !== "function") continue;
  try {
    cp[name] = (...a: unknown[]) => {
      record("spawn", cmdOf(Array.isArray(a[1]) ? [a[0], ...(a[1] as unknown[])] : [a[0]]));
      return orig.apply(child_process, a);
    };
  } catch {
    // A frozen module namespace: Bun.spawn, which node:child_process uses, is wrapped above.
  }
}

// SAFETY: net.connect is a function; it is only called through with its own arguments.
const netExports = net as unknown as Record<string, AnyFn>;
// SAFETY: as above — the original is forwarded the same arguments it was called with.
const origConnect = net.connect as unknown as AnyFn;
try {
  netExports.connect = (...a: unknown[]) => {
    const o = a[0] as { port?: number; host?: string } | number;
    record("connect", typeof o === "number" ? `port=${o}` : `${o?.host ?? "?"}:${o?.port ?? "?"}`);
    return origConnect(...a);
  };
} catch {
  // A frozen module namespace: net.Socket.prototype.connect, wrapped below, still records it.
}

// SAFETY: listen is a method on the prototype; the wrapper forwards `this` and every argument.
const serverProto = net.Server.prototype as unknown as Record<string, AnyFn>;
const origListen = serverProto.listen;
serverProto.listen = function (this: unknown, ...a: unknown[]) {
  record("serve", "net.Server.listen");
  return origListen.apply(this, a);
};
// SAFETY: connect is a method on the prototype; the wrapper forwards `this` and every argument.
const socketProto = net.Socket.prototype as unknown as Record<string, AnyFn>;
const origSocketConnect = socketProto.connect;
socketProto.connect = function (this: unknown, ...a: unknown[]) {
  record("connect", "net.Socket.connect");
  return origSocketConnect.apply(this, a);
};

const OrigWebSocket = globalThis.WebSocket;
globalThis.WebSocket = new Proxy(OrigWebSocket, {
  construct(target, args) {
    record("connect", "WebSocket");
    return new target(...(args as [string]));
  },
});

const origFetch = globalThis.fetch;
globalThis.fetch = ((input: unknown, init?: unknown) => {
  let url = "?";
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else if (input instanceof Request) url = input.url;
  try {
    const u = new URL(url);
    record("fetch", `${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}`);
  } catch {
    record("fetch", url.slice(0, 60));
  }
  return origFetch(input as Request, init as RequestInit);
}) as typeof fetch;

// SAFETY: the timer wrappers forward every argument unchanged and return the original's handle.
const origSetTimeout = globalThis.setTimeout as unknown as AnyFn;
// SAFETY: same signature as the original; the handle it returns is the original's.
globalThis.setTimeout = ((fn: unknown, ms?: number, ...rest: unknown[]) => {
  if (typeof ms === "number" && ms > 0) record("wait", ms >= 1000 ? "timer>=1s" : "timer>0");
  return origSetTimeout(fn, ms, ...rest);
}) as unknown as typeof setTimeout;
// SAFETY: as for setTimeout — every argument forwarded, the original's handle returned.
const origSetInterval = globalThis.setInterval as unknown as AnyFn;
// SAFETY: same signature as the original; the handle it returns is the original's.
globalThis.setInterval = ((fn: unknown, ms?: number, ...rest: unknown[]) => {
  record("wait", "interval");
  return origSetInterval(fn, ms, ...rest);
}) as unknown as typeof setInterval;
const origSleep = B.sleep as AnyFn;
B.sleep = (ms: number | Date) => {
  if (!(typeof ms === "number" && ms <= 0)) record("wait", "sleep");
  return origSleep(ms);
};
const origSleepSync = B.sleepSync as AnyFn | undefined;
if (typeof origSleepSync === "function") {
  B.sleepSync = (ms: number) => {
    if (ms > 0) record("wait", "sleepSync");
    return origSleepSync(ms);
  };
}

record("preload", "loaded");
