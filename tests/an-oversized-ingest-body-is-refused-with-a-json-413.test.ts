// An oversized ingest body is drained and refused with a JSON 413 that names
// the limit — on a real server, over a real socket, by a real Python client.
//
// The three ingest routes — `POST /api/v2/runs`, `/api/v2/runs/parsed` and
// `/api/v2/runs/compile` (dispatched by `handleV2` in src/v2.ts) — read at
// most `ingest_body_bytes` of request body, resolved live through
// `resolveLimit` (src/limits.ts) like every limit. A body past it — known by
// its `Content-Length`, or counted as it is read when it is sent chunked with
// no `Content-Length` — is read to its end and discarded, then answered with
// 413 and `{ok: false, error}` naming `ingest_body_bytes` and its value.
// Nothing is stored.
//
// Bun's own `maxRequestBodySize` sits above every value an operator can set:
// the server module exports it and passes it to `Bun.serve`, fixed at twice
// the limit's declared `max` (2 GiB). That is asserted on the VALUE — no body
// of 128 MiB or more is sent anywhere in this suite.
//
// ── Why Python's urllib, and why a body bigger than the socket buffers ──────
//
// A handler that answers without reading the body leaves a client still
// writing into a socket the server has closed; Python's urllib then reports a
// broken pipe or a reset, which reads as "board unreachable", never as the
// JSON refusal. That only shows when the body outruns what the kernel buffers
// on the way, so every oversized body here is several MiB past a 1 MiB limit,
// sent by `python3` through `urllib.request` over a real TCP connection, and
// the client side must report NO error of its own.
//
// ── What "nothing is stored" means ──────────────────────────────────────────
//
// Every oversized body is a VALID ingest padded with trailing JSON whitespace,
// so a server that read and accepted it would store a run. The project's event
// ids are snapshotted after the caller registers and must be unchanged.
//
// ── Safety ──────────────────────────────────────────────────────────────────
//
// `serverConfigDir()` (tests/helpers/server-limits-fixture.ts) points
// `CRUCIBLE_DB` at a fresh OS tmpdir only so the operator `crucible.toml`
// resolves beside it; the store itself is ":memory:".
import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
import * as serverModule from "../src/server.ts";

afterEach(restoreServerLimitsFixture);

const MiB = 1024 * 1024;

/** How far past the limit an oversized body runs — several MiB, well past
 *  what the loopback socket buffers hold while nobody reads, and small
 *  enough to keep the suite fast. */
const OVERSIZE_BY = 8 * MiB;

/** Per-test timeout: each test spawns python3 and moves a few MiB. */
const SLOW = 30_000;

function bodyLimit(): LimitDeclaration {
  const d = shippedLimits().ingest_body_bytes;
  expect(d, "src/crucible.toml declares no [limits.ingest_body_bytes] table").toBeDefined();
  return d!;
}

// ── The Python client ───────────────────────────────────────────────────────

/**
 * Reads the JSON payload from stdin, pads it with trailing spaces to exactly
 * `total` bytes, and POSTs it with urllib — either as one `bytes` object
 * (urllib sets `Content-Length`) or as a generator (urllib sends
 * `Transfer-Encoding: chunked` and no `Content-Length`). It prints one JSON
 * line: the status, content type and body the server answered, the framing
 * headers urllib actually sent, and any error the CLIENT itself raised.
 */
const PY_CLIENT = String.raw`
import json, sys, urllib.request, urllib.error
url, mode, total = sys.argv[1], sys.argv[2], int(sys.argv[3])
payload = sys.stdin.buffer.read()
pad = total - len(payload)
if pad < 0:
    raise SystemExit("payload is longer than the requested total")
CHUNK = 65536
def chunks():
    yield payload
    left = pad
    while left > 0:
        n = min(CHUNK, left)
        yield b" " * n
        left -= n
data = payload + b" " * pad if mode == "length" else chunks()
req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
out = {"status": None, "contentType": None, "body": None, "clientError": None}
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        out["status"] = r.status
        out["contentType"] = r.headers.get("Content-Type")
        out["body"] = r.read().decode("utf-8", "replace")
except urllib.error.HTTPError as e:
    out["status"] = e.code
    out["contentType"] = e.headers.get("Content-Type")
    out["body"] = e.read().decode("utf-8", "replace")
except BaseException as e:
    reason = getattr(e, "reason", None)
    out["clientError"] = type(e).__name__ + ": " + str(e) + ("" if reason is None else " (" + type(reason).__name__ + ")")
out["contentLength"] = req.get_header("Content-length")
out["transferEncoding"] = req.get_header("Transfer-encoding")
print(json.dumps(out))
`;

type Framing = "length" | "chunked";

interface ClientOutcome {
  status: number | null;
  contentType: string | null;
  body: string | null;
  clientError: string | null;
  contentLength: string | null;
  transferEncoding: string | null;
}

/** POST `payload` padded to exactly `total` bytes, through python3's urllib. */
async function pythonPost(
  handle: BootedServer,
  route: string,
  payload: unknown,
  total: number,
  framing: Framing,
): Promise<ClientOutcome> {
  const url = `http://127.0.0.1:${handle.server.port}${route}`;
  const proc = Bun.spawn(["python3", "-c", PY_CLIENT, url, framing, String(total)], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, `the python client itself failed: ${stderr}`).toBe(0);
  const outcome = JSON.parse(stdout.trim()) as ClientOutcome;
  // The framing under test is the framing actually sent.
  if (framing === "length") {
    expect(outcome.contentLength, "urllib must send a Content-Length").toBe(String(total));
    expect(outcome.transferEncoding).toBeNull();
  } else {
    expect(outcome.transferEncoding, "urllib must send the body chunked").toBe("chunked");
    expect(outcome.contentLength, "a chunked body carries no Content-Length").toBeNull();
  }
  return outcome;
}

// ── The routes and a valid ingest for each ─────────────────────────────────

interface IngestRoute {
  route: string;
  payload(projectKey: string, agentId: string): Record<string, unknown>;
}

const ROUTES: readonly IngestRoute[] = [
  {
    route: "/api/v2/runs",
    payload: (projectKey, agentId) => ({
      projectKey,
      agentId,
      codec: "junit",
      data: '<testsuite name="suite" tests="1" failures="0"><testcase name="t" time="0.01"/></testsuite>',
    }),
  },
  {
    route: "/api/v2/runs/parsed",
    payload: (projectKey, agentId) => ({
      projectKey,
      agentId,
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 10 },
      tree: [
        { name: "suite", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 10 }] },
      ],
    }),
  },
  {
    route: "/api/v2/runs/compile",
    payload: (projectKey, agentId) => ({
      projectKey,
      agentId,
      errors: "src/x.ts:1:1: error TS2304: Cannot find name 'x'.",
    }),
  },
];

interface Subject {
  handle: BootedServer;
  dir: string;
  key: string;
  agentId: string;
}

/** A real server whose operator file sets `ingest_body_bytes` to `limit`, one
 *  project, and one live registered caller. */
async function subject(limit: number): Promise<Subject> {
  const dir = serverConfigDir();
  writeConfig(dir, { ingest_body_bytes: declare(bodyLimit(), limit) });
  const handle = boot();
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name: "body-limit", type: "backend", sutRoot: "/tmp/body-limit" });
  const agentId = "body-limit-orchestrator";
  const res = await fetch(`http://127.0.0.1:${handle.server.port}/api/v2/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectKey: key, agentId, role: "ORCHESTRATOR" }),
  });
  expect(res.status, "registering the caller must succeed").toBe(200);
  return { handle, dir, key, agentId };
}

function eventIds(s: Subject): string[] {
  return s.handle.store.listEvents(s.key, Number.MAX_SAFE_INTEGER).map((e) => e.id);
}

/** The refusal, asserted whole: a JSON 413 naming the limit and its value,
 *  answered to a client that raised nothing of its own. */
function expectJsonRefusal(outcome: ClientOutcome, limit: number): void {
  expect(outcome.clientError, "the client must not see a broken pipe or a reset").toBeNull();
  expect(outcome.status).toBe(413);
  expect(outcome.contentType ?? "").toContain("application/json");
  const body = JSON.parse(outcome.body ?? "null") as { ok?: unknown; error?: unknown };
  expect(body.ok).toBe(false);
  expect(typeof body.error).toBe("string");
  expect(body.error as string).toContain("ingest_body_bytes");
  expect(body.error as string).toContain(String(limit));
}

/** An acceptance, asserted whole: 200, ok, and exactly one new stored event —
 *  the one the response names. */
function expectStored(outcome: ClientOutcome, before: string[], after: string[]): void {
  expect(outcome.clientError).toBeNull();
  expect(outcome.status).toBe(200);
  const body = JSON.parse(outcome.body ?? "null") as { ok?: unknown; event?: unknown };
  expect(body.ok).toBe(true);
  expect(after.length).toBe(before.length + 1);
  expect(after).toContain(body.event as string);
  expect(before).not.toContain(body.event as string);
}

// ═══════════════════════════════════════════════════════════════════════════
// Each ingest route
// ═══════════════════════════════════════════════════════════════════════════

for (const { route, payload } of ROUTES) {
  describe(`POST ${route} bounds its body by ingest_body_bytes`, () => {
    test(
      "a body past the limit sent with Content-Length by urllib is drained and answered with a JSON 413 naming ingest_body_bytes and its value — no broken pipe, nothing stored",
      async () => {
        const limit = bodyLimit().min;
        const s = await subject(limit);
        const before = eventIds(s);

        const outcome = await pythonPost(
          s.handle,
          route,
          payload(s.key, s.agentId),
          limit + OVERSIZE_BY,
          "length",
        );

        expectJsonRefusal(outcome, limit);
        expect(eventIds(s)).toEqual(before);
      },
      SLOW,
    );

    test(
      "the same body sent chunked with no Content-Length is counted as it is read and answered with the same JSON 413 — no broken pipe, nothing stored",
      async () => {
        const limit = bodyLimit().min;
        const s = await subject(limit);
        const before = eventIds(s);

        const outcome = await pythonPost(
          s.handle,
          route,
          payload(s.key, s.agentId),
          limit + OVERSIZE_BY,
          "chunked",
        );

        expectJsonRefusal(outcome, limit);
        expect(eventIds(s)).toEqual(before);
      },
      SLOW,
    );

    test(
      "a body one byte past the limit is refused with the JSON 413 — the bound is exclusive of nothing past it",
      async () => {
        const limit = bodyLimit().min;
        const s = await subject(limit);
        const before = eventIds(s);

        const outcome = await pythonPost(s.handle, route, payload(s.key, s.agentId), limit + 1, "length");

        expectJsonRefusal(outcome, limit);
        expect(eventIds(s)).toEqual(before);
      },
      SLOW,
    );

    test(
      "a body exactly at the limit is accepted and stored, with Content-Length and chunked alike",
      async () => {
        const limit = bodyLimit().min;
        const s = await subject(limit);

        for (const framing of ["length", "chunked"] as const) {
          const before = eventIds(s);
          const outcome = await pythonPost(s.handle, route, payload(s.key, s.agentId), limit, framing);
          expect(outcome.status, `${framing}: a body at the limit is not refused`).not.toBe(413);
          expectStored(outcome, before, eventIds(s));
        }
      },
      SLOW,
    );

    test(
      "the limit is read live — an operator's edit to crucible.toml is honoured on the next request, with no restart",
      async () => {
        const d = bodyLimit();
        const low = d.min;
        const high = 4 * MiB;
        expect(high, "the raised value must sit inside the declared range").toBeLessThanOrEqual(d.max);
        const size = 2 * MiB;
        const s = await subject(low);

        // Before the edit: the body is past the operator's value and refused.
        const before = eventIds(s);
        const refused = await pythonPost(s.handle, route, payload(s.key, s.agentId), size, "length");
        expectJsonRefusal(refused, low);
        expect(eventIds(s)).toEqual(before);

        // The operator raises it; the very next request is judged against it.
        writeConfig(s.dir, { ingest_body_bytes: declare(d, high) });
        const accepted = await pythonPost(s.handle, route, payload(s.key, s.agentId), size, "length");
        expectStored(accepted, before, eventIds(s));

        // …and lowers it again: refused once more, naming the value now set.
        writeConfig(s.dir, { ingest_body_bytes: declare(d, low) });
        const afterRaise = eventIds(s);
        const refusedAgain = await pythonPost(s.handle, route, payload(s.key, s.agentId), size, "chunked");
        expectJsonRefusal(refusedAgain, low);
        expect(eventIds(s)).toEqual(afterRaise);
      },
      SLOW,
    );
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Bun's own limit sits above every value an operator can set
// ═══════════════════════════════════════════════════════════════════════════

describe("Bun's own body limit is raised above every ingest_body_bytes an operator can set", () => {
  test("the server module exports MAX_REQUEST_BODY_SIZE as 2 GiB — twice ingest_body_bytes' declared max", () => {
    const d = bodyLimit();
    const exported = (serverModule as Record<string, unknown> as { maxRequestBodySize: () => number }).maxRequestBodySize();
    expect(exported).toBe(2 * d.max);
    expect(exported).toBe(2 * 1024 * 1024 * 1024);
    // With no operator file the board runs at the recommendation, so its own
    // JSON 413 answers well before Bun's would.
    expect(exported as number).toBeGreaterThan(d.recommended);
  });

  test("startServer passes exactly that value to Bun.serve as maxRequestBodySize", () => {
    serverConfigDir();
    const serve = spyOn(Bun, "serve");
    try {
      boot();
      expect(serve).toHaveBeenCalledTimes(1);
      const options = serve.mock.calls[0]![0] as { maxRequestBodySize?: unknown };
      expect(options.maxRequestBodySize).toBe(2 * bodyLimit().max);
      expect(options.maxRequestBodySize).toBe(
        (serverModule as Record<string, unknown> as { maxRequestBodySize: () => number }).maxRequestBodySize(),
      );
    } finally {
      serve.mockRestore();
    }
  });
});
