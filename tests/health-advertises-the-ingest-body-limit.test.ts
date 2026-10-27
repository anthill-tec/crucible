// Health advertises the ingest body limit, so a client can refuse a body the
// board would refuse before it sends a byte of it.
//
// Both health routes — `GET /api/health` and `GET /api/v2/health`, built from
// the one shared `healthPayload` site in `startServer` (src/server.ts) — carry
// `limits: {ingest_body_bytes: <n>}`, where `<n>` is the value
// `resolveLimit("ingest_body_bytes")` (src/limits.ts) resolves: the shipped
// recommendation with no operator file, the operator's `value` when its range
// admits it. The value is read at the point of use like every limit, so an
// operator's edit is advertised on the next health read with no restart — a
// health route that cached it would advertise a bound the handler no longer
// enforces.
//
// Driven through the REAL production boot (`startServer` on port 0, a
// ":memory:" store) over a real socket. Every expectation is derived from the
// shipped declaration read back (`shippedLimits()`), never written out.
//
// ── Safety ──────────────────────────────────────────────────────────────────
//
// `serverConfigDir()` (tests/helpers/server-limits-fixture.ts) points
// `CRUCIBLE_DB` at a fresh OS tmpdir only so the server's `crucible.toml`
// resolves beside it; the store itself is ":memory:".
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

const HEALTH_ROUTES = ["/api/health", "/api/v2/health"] as const;

function bodyLimit(): LimitDeclaration {
  const d = shippedLimits().ingest_body_bytes;
  expect(d, "src/crucible.toml declares no [limits.ingest_body_bytes] table").toBeDefined();
  return d!;
}

/** The `limits` member each health route answers, by route. */
async function advertised(handle: BootedServer): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const route of HEALTH_ROUTES) {
    const res = await fetch(`http://127.0.0.1:${handle.server.port}${route}`);
    expect(res.status, `${route} must answer 200`).toBe(200);
    const body = (await res.json()) as { ok?: unknown; limits?: unknown };
    expect(body.ok, `${route} must answer ok`).toBe(true);
    out[route] = body.limits;
  }
  return out;
}

/** Both routes, each carrying exactly `{ingest_body_bytes: n}`. */
function onBothRoutes(n: number): Record<string, unknown> {
  return Object.fromEntries(HEALTH_ROUTES.map((route) => [route, { ingest_body_bytes: n }]));
}

describe("both health routes advertise the ingest body limit", () => {
  test("with no operator file, both carry limits.ingest_body_bytes at the shipped recommendation — and nothing else under limits", async () => {
    serverConfigDir();
    const d = bodyLimit();
    const handle = boot();

    expect(await advertised(handle)).toEqual(onBothRoutes(d.recommended));
  });

  test("an operator-set value inside the range is the value both routes advertise", async () => {
    const dir = serverConfigDir();
    const d = bodyLimit();
    const chosen = d.min;
    expect(chosen, "a value distinguishable from the recommendation").not.toBe(d.recommended);
    writeConfig(dir, { ingest_body_bytes: declare(d, chosen) });
    const handle = boot();

    expect(await advertised(handle)).toEqual(onBothRoutes(chosen));
  });

  test("an edit to the operator file is advertised on the next health read, with no restart", async () => {
    const dir = serverConfigDir();
    const d = bodyLimit();
    writeConfig(dir, { ingest_body_bytes: declare(d, d.min) });
    const handle = boot();

    // The first read, asserted BEFORE the edit, so "it changed" is a claim
    // about the edit and not about the fixture.
    expect(await advertised(handle)).toEqual(onBothRoutes(d.min));

    writeConfig(dir, { ingest_body_bytes: declare(d, d.max) });
    expect(await advertised(handle)).toEqual(onBothRoutes(d.max));
  });

  test("a refused out-of-range value is not advertised — both routes carry the recommendation the server runs at", async () => {
    const dir = serverConfigDir();
    const d = bodyLimit();
    const illegal = d.max + 1;
    writeConfig(dir, { ingest_body_bytes: declare(d, illegal) });
    const handle = boot();

    const limits = await advertised(handle);
    expect(limits).toEqual(onBothRoutes(d.recommended));
    for (const route of HEALTH_ROUTES) {
      expect(limits[route], `${route} advertised the refused value`).not.toEqual({
        ingest_body_bytes: illegal,
      });
    }
  });
});
