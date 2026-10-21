// The local WebKit pass (`bun run webkit:docker [-- <args>]`) goes through the
// bun Crucible client, so a WebKit run reaches the board like every other e2e
// run, and the pinned container it starts never outlives the pass.
//
// Spec: the change request "a phone tap on a history cycle line opens its
// runs", its step "the WebKit pass goes through the client" and its criterion
// "WebKit runs through the client" (docs/changes/, filed for wave 8).
//
// THE SEAM. The CLI entry (scripts/webkit-docker-server.ts) is a thin shell
// over `runWebkitPass(passArgs, deps)`, exported by
// scripts/webkit-docker-runner.ts. Every side effect is injected:
//   docker(args)             -> { status, stdout, stderr }   every `docker` call
//   waitForServer(port, ms)  -> Promise<boolean>             run-server readiness
//   spawn(argv, env)         -> { exited: Promise<number>, kill(signal?) }
//                                                            the ONE child: the client
//   signals                  an EventEmitter the pass listens on for SIGINT /
//                            SIGTERM (production hands it `process`)
//   stderr(text)             every remedy / progress line
// and the pass RESOLVES with the exit code the entry exits with — it never
// calls process.exit itself (that is what let today's never-ready path skip
// its own `finally` and leak the container).
//
// No Docker daemon, no browser, no real client run: every dependency below is
// a scripted fake, and environment VALUES are never printed — the child's
// environment is compared by key name or as a true/false equality only.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import * as runner from "../scripts/webkit-docker-runner.ts";
import {
  CONTAINER_NAME,
  EXPOSE_NETWORK,
  RUN_SERVER_PORT,
  dockerImageTag,
  dockerRunArgs,
  exactPlaywrightVersion,
  pinnedPlaywrightRange,
  runServerWsEndpoint,
} from "../scripts/webkit-docker-runner.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const CLIENT_SCRIPT_ABSOLUTE = join(REPO_ROOT, "clients", "bun-crucible.py");
const CLIENT_SCRIPT_RELATIVE = "clients/bun-crucible.py";
const FAKE_CONTAINER_ID = "cafebabe1234";

interface DockerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface ClientChild {
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals | number) => void;
}

interface WebkitPassDeps {
  docker: (args: string[]) => DockerResult;
  waitForServer: (port: number, timeoutMs: number) => Promise<boolean>;
  spawn: (argv: string[], env: Record<string, string | undefined>) => ClientChild;
  signals: EventEmitter;
  stderr: (text: string) => void;
}

type RunWebkitPass = (passArgs: string[], deps: WebkitPassDeps) => Promise<number>;

/** The seam, or a failure that names exactly what is missing — so each test
 *  fails on its own assertion rather than the whole file failing to link. */
function runWebkitPass(passArgs: string[], deps: WebkitPassDeps): Promise<number> {
  const seam = (runner as unknown as { runWebkitPass?: RunWebkitPass }).runWebkitPass;
  if (typeof seam !== "function") {
    throw new Error("scripts/webkit-docker-runner.ts exports no runWebkitPass(passArgs, deps)");
  }
  return seam(passArgs, deps);
}

type Event =
  | { kind: "docker"; args: string[] }
  | { kind: "wait"; port: number; timeoutMs: number }
  | { kind: "spawn"; argv: string[]; env: Record<string, string | undefined> }
  | { kind: "kill"; signal: NodeJS.Signals | number | undefined }
  | { kind: "client-exit"; code: number };

interface Harness {
  deps: WebkitPassDeps;
  events: Event[];
  stderrText: () => string;
  /** Settles the client child's `exited` with `code`. */
  exitClient: (code: number) => void;
  /** Settles a pending readiness wait (only when `ready` was "pending"). */
  settleWait: (ready: boolean) => void;
  signals: EventEmitter;
}

interface HarnessOptions {
  /** `docker` answers every call with this status — models a daemon that is
   *  not reachable (nothing succeeds), or a reachable one (default 0). */
  dockerStatus?: number;
  /** What `docker run` itself answers. */
  runResult?: DockerResult;
  /** The readiness wait's answer, or "pending" to hold it open. */
  ready?: boolean | "pending";
  /** Exit the client child on its own with this code as soon as it spawns. */
  clientExitsWith?: number;
}

function harness(options: HarnessOptions = {}): Harness {
  const events: Event[] = [];
  const stderrChunks: string[] = [];
  const signals = new EventEmitter();
  let resolveClient: ((code: number) => void) | undefined;
  let resolveWait: ((ready: boolean) => void) | undefined;
  const dockerStatus = options.dockerStatus ?? 0;

  const deps: WebkitPassDeps = {
    docker: (args) => {
      events.push({ kind: "docker", args: [...args] });
      if (dockerStatus !== 0) return { status: dockerStatus, stdout: "", stderr: "Cannot connect to the Docker daemon" };
      if (args[0] === "run" && options.runResult) return options.runResult;
      if (args[0] === "run") return { status: 0, stdout: `${FAKE_CONTAINER_ID}\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    waitForServer: (port, timeoutMs) => {
      events.push({ kind: "wait", port, timeoutMs });
      if (options.ready === "pending") {
        const { promise, resolve } = Promise.withResolvers<boolean>();
        resolveWait = resolve;
        return promise;
      }
      return Promise.resolve(options.ready ?? true);
    },
    spawn: (argv, env) => {
      events.push({ kind: "spawn", argv: [...argv], env: { ...env } });
      const { promise, resolve } = Promise.withResolvers<number>();
      resolveClient = (code) => {
        events.push({ kind: "client-exit", code });
        resolve(code);
      };
      if (options.clientExitsWith !== undefined) {
        const code = options.clientExitsWith;
        queueMicrotask(() => resolveClient?.(code));
      }
      return {
        exited: promise,
        kill: (signal) => {
          events.push({ kind: "kill", signal });
        },
      };
    },
    signals,
    stderr: (text) => {
      stderrChunks.push(text);
    },
  };

  return {
    deps,
    events,
    signals,
    stderrText: () => stderrChunks.join(""),
    exitClient: (code) => {
      if (!resolveClient) throw new Error("the client was never spawned");
      resolveClient(code);
    },
    settleWait: (ready) => {
      if (!resolveWait) throw new Error("no readiness wait is pending");
      resolveWait(ready);
    },
  };
}

/** Lets the pass run until `predicate` holds, or fails the test — short ticks
 *  only, so a hang reads as an assertion and never as a stuck suite. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let tick = 0; tick < 200; tick += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** A few short timer ticks, so pending microtasks and timers run. */
async function ticks(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Resolves with the pass's exit code, or with "still running" if it has not
 *  settled after a bounded number of short ticks. */
async function settled(pass: Promise<number>): Promise<number | "still running"> {
  let outcome: number | "still running" = "still running";
  void pass.then((code) => {
    outcome = code;
  });
  for (let tick = 0; tick < 200 && outcome === "still running"; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return outcome;
}

function dockerCalls(events: Event[]): string[][] {
  return events.flatMap((event) => (event.kind === "docker" ? [event.args] : []));
}

/** A call that removes the pass's container: `docker rm|stop|kill` (optionally
 *  spelled `docker container …`) naming the container or the id `run` printed.
 *  `stop`/`kill` count because the container is started `--rm`. */
function isRemoval(args: string[]): boolean {
  const verbArgs = args[0] === "container" ? args.slice(1) : args;
  const verb = verbArgs[0];
  if (verb !== "rm" && verb !== "stop" && verb !== "kill") return false;
  return verbArgs.includes(CONTAINER_NAME) || verbArgs.includes(FAKE_CONTAINER_ID);
}

function removalIndexes(events: Event[]): number[] {
  return events.flatMap((event, index) => (event.kind === "docker" && isRemoval(event.args) ? [index] : []));
}

function spawns(events: Event[]): Array<Extract<Event, { kind: "spawn" }>> {
  return events.flatMap((event) => (event.kind === "spawn" ? [event] : []));
}

function clientExitIndex(events: Event[]): number {
  return events.findIndex((event) => event.kind === "client-exit");
}

/** The argv after the client script: what `bun-crucible.py` itself receives. */
function clientArgs(argv: string[]): string[] | undefined {
  const index = argv.findIndex((arg) => arg === CLIENT_SCRIPT_ABSOLUTE || arg === CLIENT_SCRIPT_RELATIVE);
  return index === -1 ? undefined : argv.slice(index + 1);
}

const pinnedVersion = exactPlaywrightVersion(pinnedPlaywrightRange(REPO_ROOT));
const pinnedImage = dockerImageTag(pinnedVersion);

describe("runWebkitPass — the webkit-iphone project runs through bun-crucible.py e2e", () => {
  test("a passing run starts the pinned container, waits on run-server's port, then spawns the client exactly once as `bun-crucible.py e2e -- --project=webkit-iphone`", async () => {
    const h = harness({ clientExitsWith: 0 });
    const code = await runWebkitPass([], h.deps);

    expect(code).toBe(0);
    const runCalls = dockerCalls(h.events).filter((args) => args[0] === "run");
    expect(runCalls).toEqual([dockerRunArgs({ image: pinnedImage, port: RUN_SERVER_PORT, playwrightVersion: pinnedVersion })]);
    const waits = h.events.filter((event) => event.kind === "wait");
    expect(waits.length).toBe(1);
    expect((waits[0] as Extract<Event, { kind: "wait" }>).port).toBe(RUN_SERVER_PORT);

    const children = spawns(h.events);
    expect(children.length, "the client is the pass's ONE child — no separate bddgen, no direct playwright").toBe(1);
    const argv = (children[0] as Extract<Event, { kind: "spawn" }>).argv;
    expect(clientArgs(argv), `the spawned argv names no ${CLIENT_SCRIPT_RELATIVE}: ${argv.join(" ")}`).toEqual([
      "e2e",
      "--",
      "--project=webkit-iphone",
    ]);
  });

  test("with no arguments the run is unfiled, exactly as a bare `e2e` is — no --agent, --cycle or --release is invented", async () => {
    const h = harness({ clientExitsWith: 0 });
    await runWebkitPass([], h.deps);

    const argv = spawns(h.events)[0]?.argv ?? [];
    expect(argv).not.toContain("--agent");
    expect(argv).not.toContain("--cycle");
    expect(argv).not.toContain("--release");
  });

  test("`-- --agent X` files the run: the arguments reach the client verbatim, between `e2e` and the project passthrough", async () => {
    const h = harness({ clientExitsWith: 0 });
    await runWebkitPass(["--agent", "X"], h.deps);

    expect(clientArgs(spawns(h.events)[0]?.argv ?? [])).toEqual(["e2e", "--agent", "X", "--", "--project=webkit-iphone"]);
  });

  test("--cycle and --release among the arguments are forwarded in order, so the run files under that cycle or release", async () => {
    const byCycle = harness({ clientExitsWith: 0 });
    await runWebkitPass(["--agent", "X", "--cycle", "716"], byCycle.deps);
    expect(clientArgs(spawns(byCycle.events)[0]?.argv ?? [])).toEqual([
      "e2e",
      "--agent",
      "X",
      "--cycle",
      "716",
      "--",
      "--project=webkit-iphone",
    ]);

    const byRelease = harness({ clientExitsWith: 0 });
    await runWebkitPass(["--agent", "X", "--release", "0.4.0"], byRelease.deps);
    expect(clientArgs(spawns(byRelease.events)[0]?.argv ?? [])).toEqual([
      "e2e",
      "--agent",
      "X",
      "--release",
      "0.4.0",
      "--",
      "--project=webkit-iphone",
    ]);
  });

  test("the script's own bddgen and direct Playwright invocation are gone, and the project's dependency is not cut off (no --no-deps)", async () => {
    const h = harness({ clientExitsWith: 0 });
    await runWebkitPass(["--agent", "X"], h.deps);

    for (const child of spawns(h.events)) {
      expect(child.argv).not.toContain("bddgen");
      expect(child.argv).not.toContain("--no-deps");
      expect(child.argv.slice(0, 3)).not.toEqual(["bunx", "playwright", "test"]);
      expect(child.argv.slice(0, 2)).not.toEqual(["playwright", "test"]);
    }
  });

  test("the client is spawned with the run-server endpoint and the loopback tether set, on top of the caller's own environment (compared by key and equality only)", async () => {
    const h = harness({ clientExitsWith: 0 });
    await runWebkitPass([], h.deps);

    const env = spawns(h.events)[0]?.env ?? {};
    expect("PW_TEST_CONNECT_WS_ENDPOINT" in env).toBe(true);
    expect(env.PW_TEST_CONNECT_WS_ENDPOINT === runServerWsEndpoint(RUN_SERVER_PORT)).toBe(true);
    expect("PW_TEST_CONNECT_EXPOSE_NETWORK" in env).toBe(true);
    expect(env.PW_TEST_CONNECT_EXPOSE_NETWORK === EXPOSE_NETWORK).toBe(true);
    // The client needs PATH, CRUCIBLE_* and the rest of the caller's
    // environment: every inherited key survives (names only on failure).
    const dropped = Object.keys(process.env).filter((key) => !(key in env));
    expect(dropped).toEqual([]);
  });
});

describe("runWebkitPass — exits with the client's code, and the container never outlives the pass", () => {
  test("a passing run resolves 0 and removes the container only AFTER the client has exited", async () => {
    const h = harness({ clientExitsWith: 0 });
    const code = await runWebkitPass([], h.deps);

    expect(code).toBe(0);
    const removals = removalIndexes(h.events);
    expect(removals.length, "the container was never removed").toBeGreaterThanOrEqual(1);
    expect(Math.min(...removals)).toBeGreaterThan(clientExitIndex(h.events));
  });

  test("a failing run resolves with the client's OWN exit code (3, not a normalised 1) and still removes the container after the client exits", async () => {
    const h = harness({ clientExitsWith: 3 });
    const code = await runWebkitPass(["--agent", "X"], h.deps);

    expect(code).toBe(3);
    const removals = removalIndexes(h.events);
    expect(removals.length, "the container was never removed").toBeGreaterThanOrEqual(1);
    expect(Math.min(...removals)).toBeGreaterThan(clientExitIndex(h.events));
  });

  test("a run-server that never becomes ready resolves non-zero with a remedy, spawns no client, and still removes the container", async () => {
    const h = harness({ ready: false });
    const code = await runWebkitPass(["--agent", "X"], h.deps);

    expect(code).not.toBe(0);
    expect(spawns(h.events)).toEqual([]);
    expect(removalIndexes(h.events).length, "the container started but was never removed").toBeGreaterThanOrEqual(1);
    expect(h.stderrText()).toMatch(/remedy/i);
  });

  for (const [signal, clientCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    test(`${signal} during the client run lets the client finish filing its abandoned run BEFORE the container is removed, then resolves with the client's code (${String(clientCode)})`, async () => {
      const h = harness();
      const pass = runWebkitPass(["--agent", "X"], h.deps);
      await until(() => spawns(h.events).length === 1, "the client to be spawned");
      // The pass must TRAP the signal: with no listener, production's bun
      // would die on it and leave the container behind.
      expect(h.signals.listenerCount(signal), `the pass installs no ${signal} handler`).toBeGreaterThanOrEqual(1);

      h.signals.emit(signal, signal);
      // The client is still filing: the container it is running against must
      // still be there, and the pass must still be waiting on it.
      await ticks();
      expect(removalIndexes(h.events), "the container was removed while the client was still filing").toEqual([]);
      expect(await settled(pass), "the pass settled before the client had exited").toBe("still running");

      h.exitClient(clientCode);
      expect(await settled(pass)).toBe(clientCode);
      const removals = removalIndexes(h.events);
      expect(removals.length, `the container survived ${signal}`).toBeGreaterThanOrEqual(1);
      expect(Math.min(...removals)).toBeGreaterThan(clientExitIndex(h.events));
    });

    test(`${signal} while waiting for run-server removes the container, resolves non-zero, and never spawns the client afterwards`, async () => {
      const h = harness({ ready: "pending" });
      const pass = runWebkitPass(["--agent", "X"], h.deps);
      await until(() => h.events.some((event) => event.kind === "wait"), "the readiness wait to start");

      h.signals.emit(signal, signal);
      const code = await settled(pass);
      expect(code, `the pass did not settle after ${signal} while the server was not yet ready`).not.toBe("still running");
      expect(code).not.toBe(0);
      expect(removalIndexes(h.events).length, `the container survived ${signal}`).toBeGreaterThanOrEqual(1);

      // A readiness answer arriving after the signal must not start a run.
      h.settleWait(true);
      await ticks();
      expect(spawns(h.events)).toEqual([]);
    });
  }
});

describe("runWebkitPass — fails loud before any container exists", () => {
  test("Docker unreachable resolves non-zero naming the remedy, and starts no container, no wait and no client", async () => {
    const h = harness({ dockerStatus: 1 });
    const code = await runWebkitPass(["--agent", "X"], h.deps);

    expect(code).not.toBe(0);
    expect(dockerCalls(h.events).filter((args) => args[0] === "run")).toEqual([]);
    expect(h.events.filter((event) => event.kind === "wait")).toEqual([]);
    expect(spawns(h.events)).toEqual([]);
    expect(h.stderrText()).toMatch(/remedy/i);
    expect(h.stderrText()).toMatch(/start docker/i);
  });

  test("a failed `docker run` resolves non-zero naming the remedy and the stale container to look for, and waits on nothing and spawns nothing", async () => {
    const h = harness({
      runResult: { status: 125, stdout: "", stderr: "docker: Error response from daemon: Conflict." },
    });
    const code = await runWebkitPass(["--agent", "X"], h.deps);

    expect(code).not.toBe(0);
    expect(h.events.filter((event) => event.kind === "wait")).toEqual([]);
    expect(spawns(h.events)).toEqual([]);
    expect(h.stderrText()).toMatch(/remedy/i);
    expect(h.stderrText()).toContain(CONTAINER_NAME);
  });
});
