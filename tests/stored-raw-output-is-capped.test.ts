// A run's stored raw output is capped at `raw_output_chars` — its first and
// last halves kept, its middle cut and named — on a real server.
//
// A run's raw output longer than `raw_output_chars` Unicode CODE POINTS is
// stored as its first `floor(n/2)` code points, then the marker
// "\n… <k> characters cut …\n", then its last `ceil(n/2)` code points — `n`
// the limit, `k` the number of code points cut. The marker and its two
// newlines do not count against `n`; no code point is ever split, so an
// astral character (one code point, two UTF-16 code units) is kept or cut
// whole. A text at the limit is stored whole. The limit is resolved live, as
// every limit is (`resolveLimit`, src/limits.ts).
//
// The cap applies AFTER decoding: a codec reads the whole text first, so a
// bun console detail printed in the part the cap removes still marries its
// bare `<failure/>` (`parseBunConsoleFailures`, src/codecs/bun-console.ts).
// The parsed route (`POST /api/v2/runs/parsed`, whose `raw` it stores)
// applies the same cap.
//
// Every case is driven through the production HTTP surface (`startServer`,
// in-memory store, a scratch operator `crucible.toml` setting
// `raw_output_chars`) and read back through the run detail read
// (`GET /api/v2/events/<id>`, `handleEventGet` in src/v2.ts), which answers the
// stored `raw` in full.
//
// ── The oracle ───────────────────────────────────────────────────────────────
//
// Each exact case below spells its expected stored string out of literal
// pieces (a head block, the marker with its count, a tail block), so the
// assertion does not rest on a helper that could share the implementation's
// mistake. `capOracle` is used only where a case's text is generated (the bun
// console case and the live-limit case), and it is itself pinned against the
// literal cases first.
//
// The runs route trims and joins the body's `raw` with a report's own output
// (`joinRaw`, src/codecs/index.ts); every text here has no surrounding
// whitespace and every report carries no output of its own, so the text posted
// is the text the cap sees.
import { afterEach, describe, expect, test } from "bun:test";
import {
  boot,
  declare,
  restoreServerLimitsFixture,
  serverConfigDir,
  writeConfig,
  type BootedServer,
  type LimitDeclaration,
} from "./helpers/server-limits-fixture.ts";
import { shippedLimits } from "../src/limits.ts";

afterEach(restoreServerLimitsFixture);

/** An odd and an even limit, both inside the declared range (min 10000). */
const ODD = 10001;
const EVEN = 10000;

function rawLimit(): LimitDeclaration {
  const d = shippedLimits().raw_output_chars;
  expect(d, "src/crucible.toml declares no [limits.raw_output_chars] table").toBeDefined();
  return d!;
}

/** The marker the spec names, spelled out literally. */
function marker(k: number): string {
  return `\n… ${k} characters cut …\n`;
}

/** The spec's rule, independently written, for generated texts only. */
function capOracle(text: string, n: number): string {
  const cps = Array.from(text);
  if (cps.length <= n) return text;
  const head = Math.floor(n / 2);
  const tail = Math.ceil(n / 2);
  const k = cps.length - head - tail;
  return cps.slice(0, head).join("") + marker(k) + cps.slice(cps.length - tail).join("");
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

// ── The server and the two routes ───────────────────────────────────────────

interface Subject {
  handle: BootedServer;
  dir: string;
  key: string;
  agentId: string;
}

/** A real server whose operator file sets `raw_output_chars` to `limit`, one
 *  project, and one live registered caller. */
async function subject(limit: number): Promise<Subject> {
  const d = rawLimit();
  expect(limit).toBeGreaterThanOrEqual(d.min);
  expect(limit).toBeLessThanOrEqual(d.max);
  const dir = serverConfigDir();
  writeConfig(dir, { raw_output_chars: declare(d, limit) });
  const handle = boot();
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name: "raw-cap", type: "backend", sutRoot: "/tmp/raw-cap" });
  const agentId = "raw-cap-orchestrator";
  const res = await fetch(`http://127.0.0.1:${handle.server.port}/api/v2/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectKey: key, agentId, role: "ORCHESTRATOR" }),
  });
  expect(res.status, "registering the caller must succeed").toBe(200);
  return { handle, dir, key, agentId };
}

type Route = "/api/v2/runs" | "/api/v2/runs/parsed";
const ROUTES: readonly Route[] = ["/api/v2/runs", "/api/v2/runs/parsed"];

/** A passing one-case JUnit report with no output of its own. */
const PASSING_JUNIT =
  '<testsuite name="suite" tests="1" failures="0"><testcase name="t" time="0.01"/></testsuite>';

function payload(s: Subject, route: Route, raw: string, extra: Record<string, unknown> = {}): unknown {
  const common = { projectKey: s.key, agentId: s.agentId, raw, ...extra };
  if (route === "/api/v2/runs") return { ...common, codec: "junit", data: PASSING_JUNIT };
  return {
    ...common,
    summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 10 },
    tree: [{ name: "suite", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 10 }] }],
  };
}

interface StoredLeaf {
  name: string;
  status: string;
  failure?: { type?: string; message?: string; trace?: string };
}

interface StoredEvent {
  raw?: string;
  tree?: Array<{ name: string; children?: StoredLeaf[] }>;
}

async function post(s: Subject, route: Route, body: unknown): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${s.handle.server.port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok?: unknown; event?: unknown; error?: unknown };
  expect(res.status, `the ingest must be accepted: ${String(json.error)}`).toBe(200);
  expect(json.ok).toBe(true);
  expect(typeof json.event).toBe("string");
  return json.event as string;
}

async function readBack(s: Subject, eventId: string): Promise<StoredEvent> {
  const res = await fetch(`http://127.0.0.1:${s.handle.server.port}/api/v2/events/${eventId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { event: StoredEvent }).event;
}

/** Ingest `raw` through `route` and answer the raw the run detail read returns. */
async function storedRaw(s: Subject, route: Route, raw: string): Promise<string | undefined> {
  return (await readBack(s, await post(s, route, payload(s, route, raw)))).raw;
}

/** Compare long strings by length and pieces first, so a failure names WHERE
 *  they differ instead of dumping ten thousand characters. */
function expectStoredExactly(stored: string | undefined, expected: string): void {
  expect(typeof stored, "the run detail read must answer the stored raw").toBe("string");
  const s = stored!;
  expect(codePoints(s), "stored code points").toBe(codePoints(expected));
  expect(s.length, "stored UTF-16 length").toBe(expected.length);
  expect(s.isWellFormed(), "no code point may be split — no lone surrogate").toBe(true);
  const want = [...expected];
  const at = [...s].findIndex((cp, i) => cp !== want[i]);
  expect(at, "the first code point where stored and expected differ").toBe(-1);
  expect(s === expected).toBe(true);
}

// ── The oracle, pinned against a literal case ───────────────────────────────

describe("the cap's oracle agrees with the literal spelling", () => {
  test("capOracle on an odd limit keeps floor(n/2) head and ceil(n/2) tail code points around the named count", () => {
    const text = "H".repeat(5000) + "abcdef" + "T".repeat(5001);
    expect(capOracle(text, ODD)).toBe("H".repeat(5000) + "\n… 6 characters cut …\n" + "T".repeat(5001));
    expect(capOracle("x".repeat(ODD), ODD)).toBe("x".repeat(ODD));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The cap, on each route
// ═══════════════════════════════════════════════════════════════════════════

for (const route of ROUTES) {
  describe(`POST ${route} stores a run's raw output capped at raw_output_chars`, () => {
    test("an odd limit keeps the first floor(n/2) and last ceil(n/2) code points around the marker naming the count cut", async () => {
      const s = await subject(ODD);
      // 5000 + 6 + 5001 = 10007 code points; head 5000, tail 5001, k = 6.
      const text = "H".repeat(5000) + "abcdef" + "T".repeat(5001);
      expect(codePoints(text)).toBe(ODD + 6);

      const stored = await storedRaw(s, route, text);

      expectStoredExactly(stored, "H".repeat(5000) + "\n… 6 characters cut …\n" + "T".repeat(5001));
      expect(stored!).not.toContain("a");
      expect(stored!).not.toContain("f");
    });

    test("an even limit keeps n/2 code points either side of the marker naming the count cut", async () => {
      const s = await subject(EVEN);
      // 5000 + 10 + 5000 = 10010 code points; head 5000, tail 5000, k = 10.
      const text = "H".repeat(5000) + "0123456789" + "T".repeat(5000);

      const stored = await storedRaw(s, route, text);

      expectStoredExactly(stored, "H".repeat(5000) + "\n… 10 characters cut …\n" + "T".repeat(5000));
      expect(stored!).not.toMatch(/[0-9]{2}/);
    });

    test("a text exactly at an odd limit is stored whole, with no marker", async () => {
      const s = await subject(ODD);
      const text = "H".repeat(5000) + "M" + "T".repeat(5000);
      expect(codePoints(text)).toBe(ODD);

      const stored = await storedRaw(s, route, text);

      expectStoredExactly(stored, text);
      expect(stored!).not.toContain("characters cut");
    });

    test("a text exactly at an even limit is stored whole, with no marker", async () => {
      const s = await subject(EVEN);
      const text = "H".repeat(4999) + "MN" + "T".repeat(4999);
      expect(codePoints(text)).toBe(EVEN);

      const stored = await storedRaw(s, route, text);

      expectStoredExactly(stored, text);
      expect(stored!).not.toContain("characters cut");
    });

    test("a text one code point over the limit loses exactly that one, named as 1 cut", async () => {
      const s = await subject(ODD);
      // 5000 + 1 + 5001 = 10002 code points; the lone middle "M" is cut.
      const text = "H".repeat(5000) + "M" + "T".repeat(5001);

      const stored = await storedRaw(s, route, text);

      expectStoredExactly(stored, "H".repeat(5000) + "\n… 1 characters cut …\n" + "T".repeat(5001));
      expect(stored!).not.toContain("M");
    });

    test("astral characters count as one code point each: a text of n emoji, twice n UTF-16 units, is at the limit and stored whole", async () => {
      const s = await subject(EVEN);
      const text = "😀".repeat(EVEN);
      expect(codePoints(text)).toBe(EVEN);
      expect(text.length).toBe(2 * EVEN);

      const stored = await storedRaw(s, route, text);

      expectStoredExactly(stored, text);
      expect(stored!).not.toContain("characters cut");
    });

    test("a cut whose edges fall on surrogate pairs keeps or cuts each astral character whole, counting it as one", async () => {
      const s = await subject(EVEN);
      // Head 5000 code points ends on 😀; the cut is 😁🎉 (2 code points, 4
      // UTF-16 units); the tail's 5000 code points begin on 😂. A cut counted
      // in UTF-16 units would split a pair at either edge and name 4, not 2.
      const head = "a".repeat(4999) + "😀";
      const tail = "😂" + "b".repeat(4999);
      const text = head + "😁🎉" + tail;
      expect(codePoints(text)).toBe(EVEN + 2);

      const stored = await storedRaw(s, route, text);

      expectStoredExactly(stored, head + "\n… 2 characters cut …\n" + tail);
      expect(stored!).not.toContain("😁");
      expect(stored!).not.toContain("🎉");
    });

    test("an odd limit over a text of emoji keeps floor(n/2) and ceil(n/2) whole emoji around the count cut", async () => {
      const s = await subject(ODD);
      // 10004 emoji: head 5000, tail 5001, k = 3 — in code points, never units.
      const text = "😀".repeat(5000) + "🎉🎊🎈" + "😂".repeat(5001);

      const stored = await storedRaw(s, route, text);

      expectStoredExactly(stored, "😀".repeat(5000) + "\n… 3 characters cut …\n" + "😂".repeat(5001));
    });

    test("a text under the limit is stored whole", async () => {
      const s = await subject(EVEN);
      const text = "line one\nline two\n😀 done";

      const stored = await storedRaw(s, route, text);

      expect(stored).toBe(text);
    });

    test("the limit is read live — an operator's edit to crucible.toml is honoured on the next ingest, with no restart", async () => {
      const d = rawLimit();
      const s = await subject(EVEN);
      // 10010 code points: over 10000, at 10010, over 10001.
      const text = "H".repeat(4000) + "0123456789".repeat(201) + "T".repeat(3999) + "!";
      expect(codePoints(text)).toBe(10010);

      // Before the edit: capped at the operator's 10000.
      const first = await storedRaw(s, route, text);
      expectStoredExactly(first, capOracle(text, EVEN));
      expect(first!).toContain(marker(10));

      // The operator raises it to the text's own length: stored whole.
      writeConfig(s.dir, { raw_output_chars: declare(d, 10010) });
      const second = await storedRaw(s, route, text);
      expectStoredExactly(second, text);

      // …and lowers it to an odd value: capped again, at the value now set.
      writeConfig(s.dir, { raw_output_chars: declare(d, ODD) });
      const third = await storedRaw(s, route, text);
      expectStoredExactly(third, capOracle(text, ODD));
      expect(third!).toContain(marker(9));
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// The codec reads the whole text before the cap
// ═══════════════════════════════════════════════════════════════════════════

describe("a codec reads a run's whole raw output before it is capped", () => {
  test("a bun console detail printed in the part the cap removes still marries its bare failure, and the stored raw is capped", async () => {
    const s = await subject(EVEN);
    const name = "kappa fails beyond the cap";
    const pad = (tag: string): string =>
      Array.from({ length: 200 }, (_, i) => `${tag} ${String(i).padStart(3, "0")} ` + "x".repeat(60)).join("\n");
    // Well over n/2 code points of padding either side, so the console block
    // sits entirely inside the middle the cap removes.
    const block = [
      `1 | test("${name}", () => {`,
      "2 |   expect(1).toBe(2);",
      "              ^",
      "error: expect(received).toBe(expected)",
      "",
      "Expected: 2",
      "Received: 1",
      "",
      "      at <anonymous> (/x/k.test.ts:2:13)",
      `(fail) ${name} [0.15ms]`,
    ].join("\n");
    const consoleText = pad("before") + "\n" + block + "\n" + pad("after");
    const before = pad("before");
    expect(codePoints(before)).toBeGreaterThan(EVEN / 2);
    expect(codePoints(pad("after"))).toBeGreaterThan(EVEN / 2);

    const report = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuites name="bun test" tests="1">',
      '<testsuite name="k.test.ts" file="k.test.ts" tests="1">',
      `<testcase name="${name}" classname="" time="0.0001" file="k.test.ts"><failure type="AssertionError" /></testcase>`,
      "</testsuite>",
      "</testsuites>",
    ].join("\n");

    const eventId = await post(s, "/api/v2/runs", {
      projectKey: s.key,
      agentId: s.agentId,
      codec: "junit",
      stack: "bun",
      data: report,
      raw: consoleText,
    });
    const event = await readBack(s, eventId);

    // The leaf carries the detail the console printed beyond the cap.
    const found = (event.tree ?? []).flatMap((suite) => suite.children ?? []).filter((c) => c.name === name);
    expect(found.length).toBe(1);
    expect(found[0]!.status).toBe("fail");
    expect(found[0]!.failure).toEqual({
      type: "AssertionError",
      message: "expect(received).toBe(expected)",
      trace:
        "error: expect(received).toBe(expected)\n\nExpected: 2\nReceived: 1\n\n      at <anonymous> (/x/k.test.ts:2:13)",
    });

    // The stored raw is capped, its middle — the console block — cut.
    const k = codePoints(consoleText) - EVEN;
    expectStoredExactly(event.raw, capOracle(consoleText, EVEN));
    expect(event.raw!.startsWith(Array.from(consoleText).slice(0, EVEN / 2).join("") + marker(k))).toBe(true);
    expect(event.raw!).not.toContain("error: expect(received)");
    expect(event.raw!).not.toContain(`(fail) ${name}`);
  });
});
