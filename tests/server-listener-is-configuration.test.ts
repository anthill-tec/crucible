// CR-CRU-139 §S1 — the server's LISTENER is CONFIGURATION, declared in the
// server's own `crucible.toml`, and `$CRUCIBLE_PORT`/`$CRUCIBLE_HOST` are
// RETIRED exactly as CR-CRU-131 retired the three limit variables.
//
// The rule this file defends: an operator decides which port this server
// listens on by EDITING A FILE — the commented `crucible.toml` already laid
// down beside the server's own database — and by nothing else. Today the two
// values are only expressible as exports (`src/server.ts:249-252`), so the
// decision's only record is a shell history and the failure mode of
// forgetting is silent: a second instance quietly lands on the first one's
// port, or an agent reports into the wrong board.
//
// ── The seam this file is written against ─────────────────────────────────
//
//   src/crucible.toml   [server] host / port / port_range_min / port_range_max
//   startServer(opts)   port  = opts.port     ?? file `[server] port` ?? shipped
//                       host  = opts.hostname ?? file `[server] host` ?? shipped
//   resolveListener(o?) { port, host, portRule, hostRule }  PURE, binds nothing
//   ServerHandle        listenerResolution { port, host, portRule, hostRule }
//   healthPayload()     listener           { …the same four }   (ONE site)
//
// None of that is a new mechanism: it is exactly what the STORE already has —
// a pure exported `resolveStore(opts?)` with injectable `env`/`cwd`
// (src/server.ts:39-79), its answer kept on the handle as `storeResolution`,
// and repeated at the one shared `healthPayload` site so `/api/health` and
// `/api/v2/health` cannot drift (:94,:218,:226-245,:291, CR-CRU-068 §S1) —
// applied to the second thing a boot resolves.
//
// The rule is PER AXIS. Port and host resolve independently, so ONE field
// could not describe a boot that takes its port from an argument and its host
// from the file; `portRule`/`hostRule` can, and that mixed case is asserted
// below rather than avoided. Each is `explicit` (an argument — the word
// `resolveStore` already uses for an explicit `dbPath`, and `port: 0` is one),
// `file` (a `[server]` table) or `shipped`.
//
// The file is the one `serverConfigPath()` (src/limits.ts:158) already
// resolves — `dirname(resolveStore().path)/crucible.toml` — so the listener is
// discovered AFTER the store is in hand, which is why it never needed the
// environment. `CRUCIBLE_DB` itself STAYS an environment variable (§S3): it is
// how the server finds its file, and every fixture below relies on that.
//
// ── How each test FAILS while §S1 is unimplemented ────────────────────────
//
// `src/crucible.toml` carries no `[server]` table at all, so every shipped
// declaration read below throws by name; and `startServer` reads
// `process.env.CRUCIBLE_PORT` rather than the file, so every booted server
// below binds something other than the port its own file names.
//
// ── Safety: no reserved port is ever bound, probed or killed ──────────────
//
// Every port this file uses is SELF-ALLOCATED — `freePorts()` asks the kernel
// for ephemeral ports and releases them — or `0`, which lets the kernel pick.
// `:3850` (this workstation's live development board) and `:3849` (reserved
// for a separate production install) are never bound and never contacted.
//
// That reservation is WHY the pure function exists, and the CR says so:
// proving "with no file present it listens on the shipped default" by a real
// bind means binding `:3849` — the port a production instance holds on exactly
// the two-instance machine this CR serves — so the test would be flaky
// precisely where the mechanism is working. So the shipped default is asserted
// on `resolveListener()` itself, which reads the layers and opens no socket.
//
// The disclosure of a RUNNING server, by contrast, always describes the socket
// that server actually bound — a `listenerResolution.port` naming a port the
// process is not listening on would be a disclosure that lies, and one of the
// criteria below exists to forbid exactly that.
//
// Every store is ":memory:" and every `crucible.toml` is in a fresh OS tmpdir
// (tests/helpers/server-limits-fixture.ts's convention). `CRUCIBLE_DB` is set
// only so the config path RESOLVES beside it — no database is opened there,
// and `data/crucible.db` is never touched.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  restoreServerLimitsFixture,
  scratch,
  serverConfigDir,
  setEnv,
} from "./helpers/server-limits-fixture.ts";
import { REPO_ROOT } from "./helpers/source-scan.ts";
import * as serverModule from "../src/server.ts";
import { startServer, type ServerHandle, type StartServerOpts } from "../src/server.ts";

/** The distribution's own data file — the SHIPPED last resort (CR-CRU-131 §S1c). */
const SHIPPED_FILE = "src/crucible.toml";

/** The four keys the `[server]` table declares, agreed with the installer half
 *  of this cycle so one GREEN satisfies both suites. */
const SERVER_KEYS = ["host", "port", "port_range_min", "port_range_max"] as const;

/**
 * A sentence, not a word. `[limits.*]`'s own reasoning comments are multi-line
 * prose ("a bound nobody can justify is the same defect as a default nobody
 * chose"), and this floor is what stops `[server]\nport = 3849` — a table with
 * the values and none of the commentary — from satisfying the declaration AC.
 */
const COMMENTARY_FLOOR_CHARS = 40;

interface ShippedServer {
  readonly host: string;
  readonly port: number;
  readonly portRangeMin: number;
  readonly portRangeMax: number;
}

function shippedText(): string {
  return fs.readFileSync(path.join(REPO_ROOT, SHIPPED_FILE), "utf8");
}

/**
 * The shipped `[server]` declaration as DATA, parsed out of the file itself —
 * never a retyped copy (CR-CRU-134's rule). Each absence throws by name, so a
 * failure says which part of the declaration is missing rather than reading as
 * an undefined-property accident.
 */
function shippedServerTable(): ShippedServer {
  const parsed = Bun.TOML.parse(shippedText()) as { server?: unknown };
  const table = parsed.server;
  if (typeof table !== "object" || table === null) {
    throw new Error(
      `CR-CRU-139 §S1: ${SHIPPED_FILE} declares no top-level \`[server]\` table, so the ` +
        `listener this server binds is still a number in source plus an environment variable, ` +
        `and there is nothing for an operator to edit.`,
    );
  }
  const rec = table as Record<string, unknown>;
  const num = (key: string): number => {
    const raw = rec[key];
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      throw new Error(
        `CR-CRU-139 §S1: ${SHIPPED_FILE}'s \`[server]\` table declares no integer \`${key}\`.`,
      );
    }
    return raw;
  };
  const str = (key: string): string => {
    const raw = rec[key];
    if (typeof raw !== "string" || raw === "") {
      throw new Error(
        `CR-CRU-139 §S1: ${SHIPPED_FILE}'s \`[server]\` table declares no \`${key}\` string.`,
      );
    }
    return raw;
  };
  return {
    host: str("host"),
    port: num("port"),
    portRangeMin: num("port_range_min"),
    portRangeMax: num("port_range_max"),
  };
}

/** The raw `[server]` block, header line included, up to the next table. */
function serverBlockLines(): string[] {
  const lines = shippedText().split("\n");
  const start = lines.findIndex((l) => l.trim() === "[server]");
  if (start < 0) {
    throw new Error(
      `CR-CRU-139 §S1: ${SHIPPED_FILE} carries no \`[server]\` header line, so there is no ` +
        `table for an operator to read the listener out of.`,
    );
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.trimStart().startsWith("["));
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * The commentary a key carries: the contiguous `#` block directly above it,
 * which is how `[limits.*]` documents every bound it declares.
 */
function commentaryFor(key: string): string {
  const lines = serverBlockLines();
  const at = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (at < 0) {
    throw new Error(
      `CR-CRU-139 §S1: ${SHIPPED_FILE}'s \`[server]\` table has no \`${key}\` line.`,
    );
  }
  const prose: string[] = [];
  for (let i = at - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith("#")) {
      prose.unshift(line.replace(/^#+\s?/, ""));
      continue;
    }
    break;
  }
  return prose.join(" ").trim();
}

// ── Booting, on ports this file allocates itself ───────────────────────────

/**
 * `n` ports the kernel has just confirmed are free, allocated TOGETHER so two
 * of them cannot collide, then released. The TypeScript mirror of the python
 * suites' `_free_port()`.
 */
function freePorts(n: number): number[] {
  const probes = Array.from({ length: n }, () =>
    Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") }),
  );
  const ports = probes.map((p) => boundPort(p));
  for (const probe of probes) probe.stop(true);
  return ports;
}

/** The port a live listener actually holds. `Bun.serve` types it as optional
 *  (a unix-socket server has none), and a server with no port is a fixture
 *  failure worth naming rather than an `undefined` smuggled into a compare. */
function boundPort(server: { port?: number | null }): number {
  const port = server.port;
  if (typeof port !== "number") {
    throw new Error(
      "CR-CRU-139 §S1: the booted server reports no port, so nothing was bound and there is " +
        "no listener for this test to make a request to.",
    );
  }
  return port;
}

const handles: ServerHandle[] = [];

function boot(opts: StartServerOpts): ServerHandle {
  const handle = startServer(opts);
  handles.push(handle);
  return handle;
}

/** A REAL request to a REAL listener — the only proof that a port was bound. */
async function health(
  host: string,
  port: number,
  route = "/api/health",
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://${host}:${port}${route}`);
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  if (body === null || typeof body !== "object") {
    throw new Error(`CR-CRU-139 §S1: GET ${route} did not return a JSON object.`);
  }
  return { ...body } as Record<string, unknown>;
}

// ── The resolved listener, as the boot DISCLOSES it ────────────────────────
//
// Read structurally and absent until GREEN, the way
// tests/store-disclosure.test.ts reads `storeResolution`: a missing disclosure
// throws a sentence naming what is missing, rather than comparing against
// `undefined` and reading as an accident.

/** The closed vocabulary of layers that can win, PER AXIS. `explicit` is the
 *  word `resolveStore` already uses for an explicit `dbPath`. */
const LISTENER_RULES = ["explicit", "file", "shipped"] as const;
type ListenerRule = (typeof LISTENER_RULES)[number];

interface ListenerResolution {
  readonly port: number;
  readonly host: string;
  readonly portRule: ListenerRule;
  readonly hostRule: ListenerRule;
}

function asListener(value: unknown, absence: string): ListenerResolution {
  if (value === null || typeof value !== "object") {
    throw new Error(absence);
  }
  const { port, host, portRule, hostRule } = value as Record<string, unknown>;
  if (
    typeof port !== "number" ||
    typeof host !== "string" ||
    typeof portRule !== "string" ||
    typeof hostRule !== "string"
  ) {
    throw new Error(
      `CR-CRU-139 §S1: a resolved listener must be { port: number, host: string, portRule: ` +
        `string, hostRule: string } — got ${JSON.stringify(value)}. One rule for two axes cannot ` +
        `describe a port from an argument beside a host from the file, which is why there are two.`,
    );
  }
  return {
    port,
    host,
    portRule: portRule as ListenerRule,
    hostRule: hostRule as ListenerRule,
  };
}

/**
 * §S1's PURE resolver, read off the module the way
 * tests/store-disclosure.test.ts reads `resolveStore` — structurally, so the
 * suite compiles while the export is still absent and the absence is reported
 * as a sentence instead of a type error.
 */
interface ResolveListenerOpts {
  port?: number;
  hostname?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

function resolveListener(opts?: ResolveListenerOpts): ListenerResolution {
  const mod: object = serverModule;
  if (!("resolveListener" in mod) || typeof mod.resolveListener !== "function") {
    throw new Error(
      "CR-CRU-139 §S1: src/server.ts exports no pure `resolveListener(opts?) => { port, host, " +
        "portRule, hostRule }` — so the only way to observe which layer a listener came from is " +
        "to BIND it, and observing the shipped default that way means binding :3849.",
    );
  }
  const resolve = mod.resolveListener as (o?: ResolveListenerOpts) => unknown;
  return asListener(resolve(opts), "CR-CRU-139 §S1: resolveListener returned nothing.");
}

/** A store path inside `dir`, for injecting as `env.CRUCIBLE_DB` — the same
 *  rule `serverConfigPath()` uses to find the file beside the database. */
function storeIn(dir: string): NodeJS.ProcessEnv {
  return { CRUCIBLE_DB: path.join(dir, "crucible.db") };
}

/** The resolution the HANDLE must carry — `storeResolution`'s counterpart. */
function listenerOf(handle: ServerHandle): ListenerResolution {
  const h: object = handle;
  const got = "listenerResolution" in h ? h.listenerResolution : undefined;
  return asListener(
    got,
    "CR-CRU-139 §S1: startServer()'s ServerHandle exposes no `listenerResolution` — the boot " +
      "path resolves a port and a host through three layers and returns nothing about WHICH " +
      "port, WHICH host or WHICH layer decided, so the shipped default can only be observed by " +
      "binding :3849.",
  );
}

/** The same resolution as a health ROUTE reports it. */
function listenerIn(body: Record<string, unknown>, route: string): ListenerResolution {
  return asListener(
    body.listener,
    `CR-CRU-139 §S1: GET ${route} reports no \`listener\` { port, host, rule } block beside the ` +
      `\`store\` one, so an operator asking a running server where it is listening — and why — ` +
      `has to read its configuration file and guess.`,
  );
}

/** True when NOTHING is listening there — the negative half of "it bound the
 *  port its file names, and no other". */
async function nothingListensOn(host: string, port: number): Promise<boolean> {
  try {
    await fetch(`http://${host}:${port}/api/health`);
    return false;
  } catch {
    return true;
  }
}

function writeServerToml(dir: string, table: { host?: string; port?: number }): string {
  const lines = ["[server]"];
  if (table.host !== undefined) lines.push(`host = ${JSON.stringify(table.host)}`);
  if (table.port !== undefined) lines.push(`port = ${table.port}`);
  const file = path.join(dir, "crucible.toml");
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/**
 * The environment every test starts from: `$CRUCIBLE_PORT` pointed at a
 * SELF-ALLOCATED free port and `$CRUCIBLE_HOST` at loopback.
 *
 * That export is a SAFETY BELT, not a fixture the assertions depend on. While
 * §S1 is unimplemented `startServer` still reads `$CRUCIBLE_PORT`, and a boot
 * that took no explicit port would otherwise bind the shipped default `:3849`
 * — a port reserved on this workstation for a separate production install.
 * Once §S1 lands the variable is not read at all (the AC below proves it), so
 * this export becomes inert rather than load-bearing.
 */
let safetyEnvPort = 0;

beforeEach(() => {
  safetyEnvPort = freePorts(1)[0]!;
  setEnv("CRUCIBLE_PORT", String(safetyEnvPort));
  setEnv("CRUCIBLE_HOST", "127.0.0.1");
});

afterEach(() => {
  while (handles.length > 0) {
    try {
      handles.pop()!.stop();
    } catch {
      // A test that stopped its own handle mid-body (the precedence proof) —
      // stopping twice is not an error worth failing a suite over.
    }
  }
  restoreServerLimitsFixture();
});

describe("CR-CRU-139 §S1 — the shipped `[server]` declaration", () => {
  test("AC1: `src/crucible.toml` declares a top-level `[server]` table carrying `port` and `host`, each with the commentary the `[limits.*]` tables carry", () => {
    const shipped = shippedServerTable();

    // POSITIVE — the two values an operator came to set, at the numbers this
    // server has always run at, so adopting the file changes no behaviour
    // (CR-CRU-131's safety argument, applied to the listener).
    expect(
      shipped.port,
      "AC1: the shipped `[server] port` must be the 3849 this server has always defaulted to, " +
        "so an install with no operator file listens exactly where it did before",
    ).toBe(3849);
    expect(
      shipped.host,
      "AC1: the shipped `[server] host` must stay loopback — the API is unauthenticated and " +
        "dataPath ingest reads server-side files, so wider exposure is an operator's explicit act",
    ).toBe("127.0.0.1");

    // POSITIVE — the commentary IS the declaration. A table carrying the four
    // values and none of the reasoning is the "knob nobody can justify" the
    // limits file names as a defect in its own header.
    for (const key of SERVER_KEYS) {
      const prose = commentaryFor(key);
      expect(
        prose.length,
        `AC1: \`[server] ${key}\` carries no documenting comment above it in ${SHIPPED_FILE} ` +
          `(found ${prose.length} characters of prose). The \`[limits.*]\` tables state what ` +
          `each value means and why its bound is what it is; a listener declared without that ` +
          `is a number moved, not configuration published.`,
      ).toBeGreaterThanOrEqual(COMMENTARY_FLOOR_CHARS);
    }
  });

  test("AC6: the shipped `[server]` table declares the port RANGE, and the default it ships lies inside the bounds THAT FILE declares", () => {
    const shipped = shippedServerTable();

    // POSITIVE — the range §S1a probes is declared where it is set, never in
    // the installer. These two numbers are the AC's own subject ("the declared
    // range is 3800-3899 in the shipped file"), which is why they are stated
    // here and nowhere else in this file.
    expect(
      [shipped.portRangeMin, shipped.portRangeMax],
      "AC6: the shipped `[server]` table must declare the hundred ports in the 3000s this " +
        "project may occupy, as bounds an installer can READ rather than a constant it carries",
    ).toEqual([3800, 3899]);

    // NEGATIVE / bound — read back off the FILE's own declaration, so a later
    // widening of the range is judged by what the file says, not by these
    // literals (CR-CRU-134's rule). A runaway range fails here.
    expect(
      shipped.portRangeMax - shipped.portRangeMin + 1,
      "AC6: the declared range must stay the hundred ports it documents — a range that drifted " +
        "wider is a project quietly claiming ports it never justified",
    ).toBe(100);
    expect(
      shipped.port >= shipped.portRangeMin && shipped.port <= shipped.portRangeMax,
      `AC6: the shipped default port ${shipped.port} falls outside the range ` +
        `[${shipped.portRangeMin}, ${shipped.portRangeMax}] declared beside it, so the file ` +
        `contradicts itself and an install probing that range could never reproduce the default`,
    ).toBe(true);
  });
});

describe("CR-CRU-139 §S1 — what a BOOTED server actually binds", () => {
  test("AC2: a server whose own `crucible.toml` declares `[server] port` listens on THAT port — proven by a real request to it", async () => {
    const dir = serverConfigDir();
    const [filePort] = freePorts(1) as [number];
    writeServerToml(dir, { host: "127.0.0.1", port: filePort });

    // No `port` in the opts: the FILE is the only thing that can name one.
    const handle = boot({ dbPath: ":memory:" });

    // POSITIVE — the exact port the operator's file names, read off the real
    // listener rather than off any resolver's return value.
    expect(
      handle.server.port,
      `AC2: the file at ${path.join(dir, "crucible.toml")} declares \`[server] port = ` +
        `${filePort}\`, so that is the port this server must be listening on`,
    ).toBe(filePort);

    // POSITIVE — and it SERVES there. A bound socket that answers nothing is
    // not a listener an operator got what they asked for from.
    const body = await health("127.0.0.1", filePort);
    expect(body.ok, "AC2: GET /api/health on the file's port must answer ok:true").toBe(true);
    expect(body.status, "AC2: ...and report the server healthy there").toBe("healthy");
  });

  test("AC4: an explicit `startServer({ port })` still WINS over the file, and dropping it hands the listener back to the file", async () => {
    const dir = serverConfigDir();
    const [filePort, explicitPort] = freePorts(2) as [number, number];
    writeServerToml(dir, { host: "127.0.0.1", port: filePort });

    // ── The in-process test seam is UNCHANGED: opts beat the file. ────────
    const explicit = boot({ port: explicitPort, dbPath: ":memory:" });
    expect(
      explicit.server.port,
      "AC4: `startServer({ port })` is the seam every TypeScript suite steers by, so an " +
        "explicit port must outrank the file exactly as it outranks everything else",
    ).toBe(explicitPort);
    expect((await health("127.0.0.1", explicitPort)).ok).toBe(true);
    expect(
      await nothingListensOn("127.0.0.1", filePort),
      `AC4: the file named ${filePort} and the caller named ${explicitPort} — the file's port ` +
        `must be left alone, not bound as well`,
    ).toBe(true);
    explicit.stop();

    // ── ...and precedence is a CHAIN: drop the opt and the file decides. ──
    const fromFile = boot({ dbPath: ":memory:" });
    expect(
      fromFile.server.port,
      "AC4: with no explicit port the next layer down is the file, not the environment and not " +
        "the shipped default — precedence is opts > file > shipped",
    ).toBe(filePort);
    expect((await health("127.0.0.1", filePort)).ok).toBe(true);
  });

  test("AC5: `$CRUCIBLE_PORT` and `$CRUCIBLE_HOST` are RETIRED — a server booted with both exported to junk still listens per its own file", async () => {
    const dir = serverConfigDir();
    const [filePort, retiredPort] = freePorts(2) as [number, number];
    writeServerToml(dir, { host: "127.0.0.1", port: filePort });

    // Junk = "anything other than what the file says". Both variables are
    // exported at boot time, which is the only way this can be asserted: a
    // grep of the source proves nothing about what the process READ.
    setEnv("CRUCIBLE_PORT", String(retiredPort));
    setEnv("CRUCIBLE_HOST", "127.0.0.2");

    const handle = boot({ dbPath: ":memory:" });

    // POSITIVE — the file won, on both axes.
    expect(
      handle.server.port,
      `AC5: \`$CRUCIBLE_PORT=${retiredPort}\` was exported and the file declares ${filePort}. ` +
        `A retired variable that silently still works is worse than either state`,
    ).toBe(filePort);
    expect(
      handle.server.hostname,
      "AC5: `$CRUCIBLE_HOST=127.0.0.2` was exported and the file declares 127.0.0.1 — the bind " +
        "address is read from the file too, not just the port",
    ).toBe("127.0.0.1");
    expect((await health("127.0.0.1", filePort)).ok).toBe(true);

    // NEGATIVE — nothing was bound at the retired variables' address, on
    // either interface. This is what fails if the environment is still read.
    expect(
      await nothingListensOn("127.0.0.1", retiredPort),
      `AC5: something is listening on 127.0.0.1:${retiredPort} — the port only \`$CRUCIBLE_PORT\` ` +
        `named, so the retired variable is still being obeyed`,
    ).toBe(true);
    expect(
      await nothingListensOn("127.0.0.2", retiredPort),
      `AC5: something is listening on 127.0.0.2:${retiredPort} — the exact address the two ` +
        `retired variables name together`,
    ).toBe(true);
  });

  test("AC: what a RUNNING server discloses matches the socket it bound — every boot's `listenerResolution` port/host is the one its own `server` is listening on", async () => {
    const dir = serverConfigDir();
    const [filePort, explicitPort] = freePorts(2) as [number, number];
    writeServerToml(dir, { host: "127.0.0.1", port: filePort });

    // Both layers a running server can actually take: its file, and an
    // explicit argument. (`shipped` is not booted here — that would mean
    // binding :3849 — it is proven on the pure resolver below.)
    const fromFile = boot({ dbPath: ":memory:" });
    const fileDisclosed = listenerOf(fromFile);
    expect(
      fileDisclosed.port,
      "AC: a disclosure naming a port the process is not listening on is the defect this " +
        "criterion forbids — the file-configured boot must disclose its real socket",
    ).toBe(boundPort(fromFile.server));
    expect(fromFile.server.hostname, "AC: and its real bind address").toBe(fileDisclosed.host);
    expect(
      (await health(fileDisclosed.host, fileDisclosed.port)).ok,
      "AC: the disclosed address is reachable — that is what 'matches the socket' means",
    ).toBe(true);
    fromFile.stop();

    const fromExplicit = boot({ port: explicitPort, hostname: "127.0.0.1", dbPath: ":memory:" });
    const explicitDisclosed = listenerOf(fromExplicit);
    expect(
      explicitDisclosed.port,
      `AC: the caller named ${explicitPort}, so that is both the socket and the disclosure`,
    ).toBe(boundPort(fromExplicit.server));
    expect(explicitDisclosed.port).toBe(explicitPort);
    expect(
      (await health(explicitDisclosed.host, explicitDisclosed.port)).ok,
      "AC: ...and it is reachable there too",
    ).toBe(true);
  });
});

describe("CR-CRU-139 §S1 — `resolveListener`, the PURE resolver that binds nothing", () => {
  test("AC: with no file present and no argument, the SHIPPED default is what resolves — asserted without binding anything", () => {
    const shipped = shippedServerTable();
    const empty = scratch("crucible-listener-shipped-");
    expect(
      fs.existsSync(path.join(empty, "crucible.toml")),
      "AC: the injected store directory must hold no `crucible.toml`, or the shipped fallback is " +
        "not the thing under test",
    ).toBe(false);

    const resolved = resolveListener({ env: storeIn(empty) });

    // POSITIVE — the shipped declaration, read out of the shipped FILE, with
    // the layer that supplied it named on BOTH axes. No socket exists: this
    // is the whole reason the pure function is in the contract, because
    // binding the real default means binding :3849.
    expect(
      resolved,
      `AC: with nothing supplied and no file beside the store, ${SHIPPED_FILE}'s \`[server]\` ` +
        `declaration is what a server would listen on, and both rules must say \`shipped\``,
    ).toEqual({
      port: shipped.port,
      host: shipped.host,
      portRule: "shipped",
      hostRule: "shipped",
    });
  });

  test("AC: `resolveListener` is PURE — it reads the env it is GIVEN, opens no socket, and mutates no ambient state", async () => {
    const dir = scratch("crucible-listener-pure-");
    const [filePort] = freePorts(1) as [number];
    writeServerToml(dir, { host: "127.0.0.1", port: filePort });
    const ambientBefore = process.env.CRUCIBLE_DB;

    const resolved = resolveListener({ env: storeIn(dir) });

    // POSITIVE — the INJECTED environment is what it read. The ambient
    // `CRUCIBLE_DB` still points at the suite's own store, so a resolver that
    // ignored its argument could not have produced this file's port.
    expect(
      resolved,
      `AC: the file at ${path.join(dir, "crucible.toml")} declares ${filePort}, and it was ` +
        `reachable ONLY through the injected \`env\` — an env-injectable resolver is what lets a ` +
        `test observe a layer without mutating the process`,
    ).toEqual({ port: filePort, host: "127.0.0.1", portRule: "file", hostRule: "file" });

    // NEGATIVE — it BOUND NOTHING. A resolver that opened a socket to find out
    // whether it could would be a probe, not a resolution.
    expect(
      await nothingListensOn("127.0.0.1", filePort),
      `AC: resolveListener bound 127.0.0.1:${filePort} — it must READ the layers and open no ` +
        `socket at all`,
    ).toBe(true);

    // NEGATIVE — and it changed nothing about the process it ran in.
    expect(
      process.env.CRUCIBLE_DB,
      "AC: a pure resolver does not write the environment it was handed an alternative to",
    ).toBe(ambientBefore);

    // ...and it is repeatable: same input, same answer, no accumulated state.
    expect(resolveListener({ env: storeIn(dir) })).toEqual(resolved);
  });

  test("AC: `portRule` and `hostRule` are PER AXIS — including the MIXED case a single `rule` field could not express", () => {
    const shipped = shippedServerTable();
    const dir = scratch("crucible-listener-rules-");
    const empty = scratch("crucible-listener-rules-empty-");
    const [filePort, explicitPort] = freePorts(2) as [number, number];
    writeServerToml(dir, { host: "127.0.0.1", port: filePort });

    // THE MIXED CASE, first because it is the one that forced two fields: a
    // port from the argument, a host from the file.
    expect(
      resolveListener({ port: explicitPort, env: storeIn(dir) }),
      "AC(mixed): the caller named a port and nothing else, so the PORT came from the argument " +
        "and the HOST came from the file — one `rule` field could not have said this",
    ).toEqual({
      port: explicitPort,
      host: "127.0.0.1",
      portRule: "explicit",
      hostRule: "file",
    });

    // The mirror image: a host from the argument, a port from the file.
    expect(
      resolveListener({ hostname: "127.0.0.2", env: storeIn(dir) }),
      "AC(mixed): and the other way round — the axes resolve INDEPENDENTLY, not as a pair",
    ).toEqual({
      port: filePort,
      host: "127.0.0.2",
      portRule: "file",
      hostRule: "explicit",
    });

    // A third mixture, across the layer the file cannot supply: an explicit
    // port with no file at all leaves the HOST on the shipped declaration.
    expect(
      resolveListener({ port: explicitPort, env: storeIn(empty) }),
      "AC(mixed): with no file, an explicit port still leaves the host to the shipped " +
        "declaration — three layers, two axes, resolved separately",
    ).toEqual({
      port: explicitPort,
      host: shipped.host,
      portRule: "explicit",
      hostRule: "shipped",
    });

    // Both axes explicit — the unambiguous end of the vocabulary.
    const bothExplicit = resolveListener({
      port: explicitPort,
      hostname: "127.0.0.2",
      env: storeIn(dir),
    });
    expect(
      bothExplicit,
      "AC(rule=explicit): an argument outranks the file on both axes, and `explicit` is the word " +
        "`resolveStore` already uses for one",
    ).toEqual({
      port: explicitPort,
      host: "127.0.0.2",
      portRule: "explicit",
      hostRule: "explicit",
    });

    // `port: 0` is an ARGUMENT, not an absence: the caller asking the kernel
    // to choose has still chosen. A resolver that treated it as unset would
    // report a port the server is not listening on.
    expect(
      resolveListener({ port: 0, env: storeIn(dir) }).portRule,
      "AC(rule=explicit): `port: 0` is an explicit argument — the caller said 'bind anything', " +
        "which is a decision, and the file must not override it",
    ).toBe("explicit");

    // NEGATIVE / bound — the vocabulary is CLOSED on both axes. A fourth rule
    // name, or free text, would make the field unreadable by anything that has
    // to branch on it.
    for (const [axis, rule] of [
      ["portRule", bothExplicit.portRule],
      ["hostRule", bothExplicit.hostRule],
    ] as const) {
      expect(
        [...LISTENER_RULES],
        `AC: \`${axis}\` must be one of ${LISTENER_RULES.join(", ")} — got "${rule}"`,
      ).toContain(rule);
    }
  });
});

describe("CR-CRU-139 §S1 — the resolved listener is DISCLOSED, as the store already is", () => {
  test("AC: `/api/health` and `/api/v2/health` both carry the `listener` block, identical to each other and to the handle's `listenerResolution`", async () => {
    const dir = serverConfigDir();
    const [filePort] = freePorts(1) as [number];
    writeServerToml(dir, { host: "127.0.0.1", port: filePort });

    const handle = boot({ dbPath: ":memory:" });
    const fromHandle = listenerOf(handle);
    const v1 = listenerIn(await health("127.0.0.1", filePort, "/api/health"), "/api/health");
    const v2 = listenerIn(await health("127.0.0.1", filePort, "/api/v2/health"), "/api/v2/health");

    // POSITIVE — the values themselves, so parity cannot be satisfied by two
    // routes agreeing on the same wrong answer.
    expect(
      v1,
      `AC: the running server must report the listener its own file configured — ${filePort} on ` +
        `127.0.0.1, by the \`file\` rule on both axes`,
    ).toEqual({ port: filePort, host: "127.0.0.1", portRule: "file", hostRule: "file" });

    // ANTI-DRIFT — CR-CRU-068 §S1's rule, applied to the second block: ONE
    // shared `healthPayload` site, so the two routes cannot diverge, and
    // neither can diverge from what the boot handed its caller.
    expect(
      v2,
      "AC: /api/v2/health must report the SAME listener as /api/health — one shared payload " +
        "site is what makes that structural instead of coincidental",
    ).toEqual(v1);
    expect(
      fromHandle,
      "AC: ...and the handle's `listenerResolution` is that same resolution, not a second one " +
        "computed beside it",
    ).toEqual(v1);
  });

  // ── `port: 0` — the one case where the RESOLVER does not have the last word
  //
  // The rules describe which LAYER decided; `0` is that layer asking the kernel
  // to choose. So the disclosure must carry the port the kernel actually gave,
  // or it reports a number nobody can connect to on every kernel-chosen boot —
  // the precise lie §S1 forbids, wearing the shape of a faithfully reported
  // configuration value. The two tests below are the ONLY thing standing
  // between that and a boot whose socket correction has been deleted: every
  // other test in this file names its own port, so `0` never reaches them.

  test("AC: an explicit `startServer({ port: 0 })` is disclosed as the port the KERNEL chose, never as `0`", async () => {
    const dir = serverConfigDir();
    // Host only: the port must come from the argument, so `portRule` is the
    // axis under test and the host is merely somewhere reachable.
    writeServerToml(dir, { host: "127.0.0.1" });

    const handle = boot({ port: 0, dbPath: ":memory:" });
    const bound = boundPort(handle.server);
    const fromHandle = listenerOf(handle);

    // POSITIVE — the kernel's answer, on the handle.
    expect(
      bound,
      "AC: `port: 0` asks the kernel for an ephemeral port, so the socket must hold a real one",
    ).not.toBe(0);
    expect(
      fromHandle,
      `AC: the boot bound 127.0.0.1:${bound}, so that is what it must DISCLOSE — the rule stays ` +
        `\`explicit\` because the caller is who decided, but the port is the kernel's answer, ` +
        `not the \`0\` that was asked with`,
    ).toEqual({ port: bound, host: "127.0.0.1", portRule: "explicit", hostRule: "file" });

    // POSITIVE — and the same numbers over the wire, from the live listener.
    // This is the half that cannot be satisfied by a handle field alone: the
    // request is made TO the disclosed port.
    const overTheWire = listenerIn(await health("127.0.0.1", bound), "/api/health");
    expect(
      overTheWire,
      "AC: the running server reports the same listener it is answering on — a disclosure a " +
        "caller cannot connect to is worse than none",
    ).toEqual(fromHandle);
  });

  test("AC: a file-declared `[server] port = 0` is disclosed the same way — the FILE asked the kernel, and the kernel's answer is reported", async () => {
    const dir = serverConfigDir();
    // The staged-boot fixture in tests/v2-json-only-responses.test.ts declares
    // exactly this, so a subprocess server can be reached without naming a port
    // this machine has reserved. It is load-bearing for that suite and untested
    // by it: what it reads is the BANNER, which is this disclosure.
    writeServerToml(dir, { host: "127.0.0.1", port: 0 });

    const handle = boot({ dbPath: ":memory:" });
    const bound = boundPort(handle.server);
    const fromHandle = listenerOf(handle);

    expect(
      bound,
      "AC: `port = 0` in the file is the same request as `port: 0` in the opts — the kernel " +
        "chooses, and it must choose a real port",
    ).not.toBe(0);
    expect(
      fromHandle,
      `AC: the file asked for a kernel-chosen port and got ${bound}, so \`file\` is the rule and ` +
        `${bound} is the port — reporting \`0\` would send an operator to a port that does not ` +
        `exist while the server ran perfectly well beside it`,
    ).toEqual({ port: bound, host: "127.0.0.1", portRule: "file", hostRule: "file" });

    const overTheWire = listenerIn(await health("127.0.0.1", bound), "/api/health");
    expect(
      overTheWire,
      "AC: ...and the live listener says the same thing the handle does",
    ).toEqual(fromHandle);
  });
});
