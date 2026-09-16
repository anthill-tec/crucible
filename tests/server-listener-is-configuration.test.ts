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
// That reservation is also why the PORT half of "with no file present it
// listens on the shipped default" is asserted here on the HOST axis plus the
// shipped declaration, and not by binding the shipped default number: a test
// that bound `:3849` would collide with precisely the two-instance machine
// this CR exists to serve. See the note on that test.
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
  serverConfigDir,
  setEnv,
} from "./helpers/server-limits-fixture.ts";
import { REPO_ROOT } from "./helpers/source-scan.ts";
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

interface HealthBody {
  ok: boolean;
  status: string;
}

/** A REAL request to a REAL listener — the only proof that a port was bound. */
async function health(host: string, port: number): Promise<HealthBody> {
  const res = await fetch(`http://${host}:${port}/api/health`);
  expect(res.status).toBe(200);
  return (await res.json()) as HealthBody;
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

  test("AC3: with NO `crucible.toml` beside its store, a server falls back to the SHIPPED declaration", async () => {
    const shipped = shippedServerTable();
    const dir = serverConfigDir();
    expect(
      fs.existsSync(path.join(dir, "crucible.toml")),
      "AC3: the fixture must leave the server's config path EMPTY, or the fallback is not the " +
        "thing under test",
    ).toBe(false);

    // The kernel picks the port (`0`) DELIBERATELY: the shipped default is
    // :3849, reserved on this workstation for a separate production install,
    // and a test that bound it would collide on precisely the two-instance
    // machine this CR exists to serve. So the fallback is proven here on the
    // BIND ADDRESS — a real boot, a real request — while the shipped default
    // PORT is pinned as a declaration by AC1/AC6 above.
    const handle = boot({ port: 0, dbPath: ":memory:" });

    expect(
      handle.server.hostname,
      "AC3: with no operator file the bind address is the SHIPPED declaration's — read out of " +
        `${SHIPPED_FILE}, never retyped here`,
    ).toBe(shipped.host);
    const body = await health(shipped.host, boundPort(handle.server));
    expect(
      body.ok,
      "AC3: and it really serves there — a fallback that resolves a value nothing binds is not " +
        "a listener",
    ).toBe(true);
  });
});
