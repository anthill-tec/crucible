// A failure's `message`, when it comes from the `message` attribute, is
// stored trimmed of its surrounding whitespace — exactly as the first-line
// fallback and the trace already are — and the trim comes before the
// 1000-character cut. A whitespace-only attribute is empty: it falls through
// to the first non-empty line of the failure's text.
//
// Real runners write such attributes: bun's `message` attributes end in a
// newline (`tests/fixtures/reports/bun/junit.xml`), which its client strips
// (`tests/fixtures/reports/bun/expected.json` holds the client's parse).
//
// Driven through the real production HTTP surface (`startServer`, in-memory
// store): reports go to `POST /api/v2/runs` with `codec: "junit"`, and every
// stored outcome is read back through the run detail read
// `GET /api/v2/events/<id>`.
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";

const BUN_FIXTURE = join(import.meta.dir, "fixtures", "reports", "bun");

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  handles.push(handle);
  return handle;
}

function base(handle: ServerHandle): string {
  return `http://127.0.0.1:${handle.server.port}`;
}

interface Posted {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(handle: ServerHandle, route: string, body: unknown): Promise<Posted> {
  const res = await fetch(`${base(handle)}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function getJson(handle: ServerHandle, route: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base(handle)}${route}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** A project with one registered (unbound) agent, ready to ingest. */
async function ready(handle: ServerHandle, agentId: string): Promise<string> {
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name: "P", type: "backend", sutRoot: "/tmp/p" });
  const res = await postJson(handle, "/api/v2/agents/register", {
    projectKey: key,
    agentId,
    role: "ORCHESTRATOR",
  });
  expect(res.status).toBe(200);
  return key;
}

interface StoredFailure {
  message?: string;
  type?: string;
  trace?: string;
}

interface StoredLeaf {
  name: string;
  status: string;
  duration_ms: number;
  failure?: StoredFailure;
}

interface StoredSuite {
  name: string;
  children: StoredLeaf[];
}

interface StoredEvent {
  id: string;
  tree?: StoredSuite[];
  [key: string]: unknown;
}

/**
 * Ingest `body` (its `codec`, `data`, and any `stack`/`raw`) as one run and
 * read the stored run back.
 */
async function ingest(agentId: string, body: Record<string, unknown>): Promise<{ res: Posted; event: StoredEvent }> {
  const handle = boot();
  const key = await ready(handle, agentId);
  const res = await postJson(handle, "/api/v2/runs", { projectKey: key, agentId, ...body });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  const detail = await getJson(handle, `/api/v2/events/${res.body.event as string}`);
  return { res, event: detail.event as StoredEvent };
}

function ingestJunit(agentId: string, data: string, stack: string | undefined) {
  return ingest(agentId, { codec: "junit", ...(stack !== undefined ? { stack } : {}), data });
}

function leaf(event: StoredEvent, name: string): StoredLeaf {
  const found = (event.tree ?? []).flatMap((s) => s.children).filter((c) => c.name === name);
  expect(found.length).toBe(1);
  return found[0]!;
}

function counts(run: unknown): Record<string, unknown> {
  const r = run as Record<string, unknown>;
  return { total: r.total, passed: r.passed, failed: r.failed, pending: r.pending };
}

/** Every stack the failure-text rule holds for — none included. */
const EVERY_STACK: Array<string | undefined> = [undefined, "bun", "python", "mvn", "rust", "arduino"];

function stackLabel(stack: string | undefined): string {
  return stack === undefined ? "no stack" : `stack ${stack}`;
}

/** A letters-only text of `length` characters, varied so a cut is checkable. */
function letters(length: number, offset = 0): string {
  return Array.from({ length }, (_, i) => String.fromCharCode(97 + ((i + offset) % 26))).join("");
}

// ── Reports ─────────────────────────────────────────────────────────────────
// Whitespace inside an attribute is written as character references
// (`&#10;` newline, `&#13;` carriage return, `&#9;` tab) — the form a runner
// writes, and the only form an XML attribute keeps a newline in.

/** Message attributes padded with whitespace and newlines on either side. */
const REPORT_PADDED = [
  '<testsuite name="Padded" tests="5">',
  '<testcase name="spaces-and-newlines" time="0.01"><failure message="  &#10;expected 2&#10;  " type="AssertionError">at line one\nat line two</failure></testcase>',
  '<testcase name="error-tabs-crlf" time="0.01"><error message="&#9;&#13;&#10;io broke&#10;&#10;then more&#13;&#10;&#9;" type="IOError">io stack</error></testcase>',
  '<testcase name="bun-style-trailing-newline" time="0.01"><failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 5&#10;Received: 4&#10;">AssertionError: expect(received).toBe(expected)&#10;&#10;Expected: 5&#10;Received: 4&#10;&#10;      at t.test.ts:14:23&#10;</failure></testcase>',
  '<testcase name="attribute-only" time="0.01"><failure type="TimeoutError" message="test timed out&#10;"/></testcase>',
  '<testcase name="leading-only" time="0.01"><failure message="   leading spaces">text line</failure></testcase>',
  "</testsuite>",
].join("\n");

/** Message attributes holding nothing but whitespace. */
const REPORT_WHITESPACE_ONLY = [
  '<testsuite name="Blank" tests="4">',
  '<testcase name="spaces-attr" time="0.01"><failure message="   " type="E">\n   \nfirst real line\nsecond line</failure></testcase>',
  '<testcase name="newlines-and-tabs-attr" time="0.01"><error message="&#10;&#9;&#13;&#10; " type="IOError">  only text line  \nmore text</error></testcase>',
  '<testcase name="blank-attr-with-type-only" time="0.01"><failure message="&#10;  &#10;" type="AssertionError"/></testcase>',
  '<testcase name="blank-attr-alone" time="0.01"><failure message=" &#10; "></failure></testcase>',
  "</testsuite>",
].join("\n");

const LONG_BODY = letters(1500);
const NEAR_LIMIT_BODY = letters(999, 5);

/** Long padded attributes: the trim comes before the 1000-character cut. */
const REPORT_PADDED_LONG = [
  '<testsuite name="PaddedLong" tests="2">',
  `<testcase name="padded-long" time="0.01"><failure message="   &#10;&#9;${LONG_BODY}&#10;" type="T">short trace</failure></testcase>`,
  `<testcase name="near-limit-trailing-pad" time="0.01"><failure message="${NEAR_LIMIT_BODY}   &#10;" type="T">short trace</failure></testcase>`,
  "</testsuite>",
].join("\n");

// ── Padded attributes are stored trimmed ────────────────────────────────────

describe("a failure's message attribute is stored trimmed of its surrounding whitespace, under every stack", () => {
  for (const stack of EVERY_STACK) {
    test(`leading and trailing spaces, tabs and newlines around a message attribute are not stored, its inner newlines are (${stackLabel(stack)})`, async () => {
      const { res, event } = await ingestJunit(`trim-padded-${stack ?? "none"}`, REPORT_PADDED, stack);
      expect(counts(res.body.run)).toEqual({ total: 5, passed: 0, failed: 5, pending: 0 });

      expect(leaf(event, "spaces-and-newlines").failure).toEqual({
        message: "expected 2",
        type: "AssertionError",
        trace: "at line one\nat line two",
      });
      expect(leaf(event, "error-tabs-crlf").failure).toEqual({
        message: "io broke\n\nthen more",
        type: "IOError",
        trace: "io stack",
      });
      expect(leaf(event, "bun-style-trailing-newline").failure?.message).toBe(
        "expect(received).toBe(expected)\n\nExpected: 5\nReceived: 4",
      );
      expect(leaf(event, "bun-style-trailing-newline").failure?.type).toBe("AssertionError");
      expect(leaf(event, "attribute-only").failure).toEqual({ message: "test timed out", type: "TimeoutError" });
      expect(leaf(event, "leading-only").failure?.message).toBe("leading spaces");
      // The attribute was taken, not the text's first line.
      expect(leaf(event, "leading-only").failure?.trace).toBe("text line");

      // No stored message starts or ends with whitespace.
      for (const stored of (event.tree ?? []).flatMap((s) => s.children)) {
        const message = stored.failure?.message ?? "";
        expect(message).toBe(message.trim());
      }
    });

    test(`a padded message attribute is trimmed before it is cut at 1000 characters (${stackLabel(stack)})`, async () => {
      const { event } = await ingestJunit(`trim-before-cut-${stack ?? "none"}`, REPORT_PADDED_LONG, stack);

      const long = leaf(event, "padded-long").failure!;
      expect(long.message).toBe(LONG_BODY.slice(0, 1000));
      expect(long.message?.length).toBe(1000);
      expect(long.type).toBe("T");
      expect(long.trace).toBe("short trace");

      // 999 characters and trailing padding: the padding is gone, not cut into.
      const near = leaf(event, "near-limit-trailing-pad").failure!;
      expect(near.message).toBe(NEAR_LIMIT_BODY);
      expect(near.message?.length).toBe(999);
    });
  }
});

// ── Whitespace-only attributes fall through ─────────────────────────────────

describe("a whitespace-only message attribute is empty and gives way to the text, under every stack", () => {
  for (const stack of EVERY_STACK) {
    test(`a message attribute of only spaces, tabs or newlines gives way to the first non-empty line of the text (${stackLabel(stack)})`, async () => {
      const { res, event } = await ingestJunit(`trim-blank-${stack ?? "none"}`, REPORT_WHITESPACE_ONLY, stack);
      expect(counts(res.body.run)).toEqual({ total: 4, passed: 0, failed: 4, pending: 0 });

      expect(leaf(event, "spaces-attr").failure).toEqual({
        message: "first real line",
        type: "E",
        trace: "first real line\nsecond line",
      });
      expect(leaf(event, "newlines-and-tabs-attr").failure).toEqual({
        message: "only text line",
        type: "IOError",
        trace: "only text line  \nmore text",
      });
    });

    test(`a whitespace-only message attribute with no text stores no message at all — only what else is non-empty (${stackLabel(stack)})`, async () => {
      const { event } = await ingestJunit(`trim-blank-bare-${stack ?? "none"}`, REPORT_WHITESPACE_ONLY, stack);
      const typed = leaf(event, "blank-attr-with-type-only");
      expect(typed.status).toBe("fail");
      expect(typed.failure).toEqual({ type: "AssertionError" });
      const alone = leaf(event, "blank-attr-alone");
      expect(alone.status).toBe("fail");
      expect(alone.failure ?? {}).toEqual({});
    });
  }
});

// ── The real bun report ─────────────────────────────────────────────────────

interface ClientLeaf {
  name: string;
  status: string;
  failure?: StoredFailure;
}

interface BunExpected {
  stack: string;
  reports: string[];
  raw: string;
  client: { tree: Array<{ name: string; children: ClientLeaf[] }> };
}

describe("the real bun report's failure messages are stored as its client parses them", () => {
  test("every failure in bun's junit.xml is stored with the message, type and trace the bun client's expected.json holds — no trailing newline", async () => {
    const expected = JSON.parse(readFileSync(join(BUN_FIXTURE, "expected.json"), "utf-8")) as BunExpected;
    const read = (rel: string): string => readFileSync(join(BUN_FIXTURE, rel), "utf-8");
    const reportText = expected.reports.map(read);
    // The fixture really carries the trailing newline the board must trim.
    expect(reportText.join("")).toContain('Received: &quot;HI!&quot;&#10;">');

    const { event } = await ingest("trim-real-bun", {
      codec: "junit",
      stack: expected.stack,
      data: reportText,
      raw: read(expected.raw),
    });

    const clientFailed = expected.client.tree.flatMap((s) => s.children).filter((c) => c.status === "fail");
    expect(clientFailed.length).toBe(5);
    for (const client of clientFailed) {
      const stored = leaf(event, client.name);
      expect(stored.status).toBe("fail");
      expect(stored.failure?.message).toBe(client.failure?.message);
      expect(stored.failure).toEqual(client.failure);
      expect(stored.failure?.message?.endsWith("\n")).toBe(false);
    }

    expect(leaf(event, "shouts the wrong thing").failure?.message).toBe(
      'expect(received).toEqual(expected)\n\nExpected: "hi"\nReceived: "HI!"',
    );
    expect(leaf(event, "waits longer than its budget").failure).toEqual({
      message: "test timed out",
      type: "TimeoutError",
    });
  });
});
