// CR-CRU-132 §S1 — the response gate answers JSON, always. RED phase.
//
// The server still renders every v2 GET as TOON when asked: `reply()`
// (`src/v2.ts:213`) branches on `wantsToon()` and answers `text/toon`. §S1
// DELETES that branch, `wantsToon`, `truncatedToon`, `jsonVariantUrl`,
// `TOON_MAX_BYTES`, the `toToon` import and `src/toon.ts` itself, and MOVES
// `@toon-format/toon` from `dependencies` to `devDependencies` so the
// server's runtime dependency set becomes empty while the client-emit
// oracle keeps its reference decoder.
//
// HOW EACH TEST BELOW FAILS IF THE CODE DOES NOTHING — stated per test in
// its own comment, and summarised here:
//
//   RED today — the construction scan (every deleted name plus the
//   `text/toon` media type is live in `src/v2.ts` right now), the
//   `src/toon.ts`-is-gone assertion, the three negotiation tests (the
//   server answers `text/toon; charset=utf-8`, not JSON), the
//   body-byte-identity test, the empty-`dependencies` assertion, the
//   `devDependencies` pin, and the clean production-install test (a
//   `bun install --production` of today's tree installs `@toon-format/toon`).
//
//   GREEN-GUARD — `?fmt=json`, the surviving oracle's import of the
//   reference decoder, and the JSON envelope shapes of every
//   `reply()`-routed GET. These pass today and MUST keep passing: this CR
//   drops an ENCODING, never a payload.
//
// NO TEST HERE ASSERTS A REFUSAL. §S1 makes `?fmt=toon` INERT, not an
// error — each negotiation test pins 200 + `application/json` AND pins
// "not 406", so a future 406 fails here rather than passing as "TOON is
// gone".
//
// The construction scan reuses tests/helpers/source-scan.ts's ONE tree
// walker and ONE comment/string classifier rather than growing a second
// scan mechanism (CR-CRU-097 §S6, CR-CRU-128 §S2), and carries its own
// CONTROL so a green scan later is the deletion's doing and not a blind
// matcher's.
import { describe, test, expect, afterEach } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { startServer } from "../src/server.ts";
import { REPO_ROOT, jsLiveCode, jsUncommented, listFiles } from "./helpers/source-scan.ts";

// ── The CONSTRUCTION scan (§S1 AC1 + AC9) ───────────────────────────────────
//
// The five names §S1 deletes, matched in LIVE CODE only (a name inside a
// comment or a string is not a surviving implementation), and the `text/toon`
// media type, matched in live code AND string prose but never in comments
// (the media type only ever appears as a string literal, and a provenance
// comment naming the retired encoding is not a capability).

const DELETED_NAMES = [
  "wantsToon",
  "truncatedToon",
  "jsonVariantUrl",
  "TOON_MAX_BYTES",
  "toToon",
] as const;

const TOON_MEDIA_TYPE = "text/toon";

interface ToonResidue {
  file: string;
  name: string;
  line: number;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** Every surviving server-TOON name in one file, with the line a reader opens. */
function serverToonResidue(file: string, text: string): ToonResidue[] {
  const found: ToonResidue[] = [];
  const live = jsLiveCode(text);
  for (const name of DELETED_NAMES) {
    for (const match of live.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
      found.push({ file, name, line: lineAt(live, match.index ?? 0) });
    }
  }
  const uncommented = jsUncommented(text);
  for (const match of uncommented.matchAll(/text\/toon/g)) {
    found.push({ file, name: TOON_MEDIA_TYPE, line: lineAt(uncommented, match.index ?? 0) });
  }
  return found;
}

function scanSrc(): ToonResidue[] {
  return listFiles("src", [".ts"]).flatMap((abs) =>
    serverToonResidue(relative(REPO_ROOT, abs), readFileSync(abs, "utf8")),
  );
}

// The control fixture: one of every shape the scan must see, in the exact
// grammatical positions `src/v2.ts` uses them — a declaration, a call, a
// constant comparison, an import specifier, and the media type inside the
// `content-type` header string.
const PLANTED_SRC = [
  'import { toToon } from "./toon.ts";',
  "const TOON_MAX_BYTES = 64 * 1024;",
  "function wantsToon(req: Request): boolean {",
  '  return (req.headers.get("accept") ?? "").includes("toon");',
  "}",
  "function jsonVariantUrl(url: URL): string {",
  '  return url.pathname + "?fmt=json";',
  "}",
  "function truncatedToon(payload: Record<string, unknown>): string {",
  "  return toToon(payload).slice(0, TOON_MAX_BYTES);",
  "}",
  "function reply(req: Request, url: URL, payload: Record<string, unknown>): Response {",
  "  if (wantsToon(req)) {",
  "    return new Response(truncatedToon(payload), {",
  '      headers: { "content-type": "text/toon; charset=utf-8", full: jsonVariantUrl(url) },',
  "    });",
  "  }",
  "  return new Response(JSON.stringify(payload));",
  "}",
].join("\n");

// The mirror of the control: the SAME words, but only where they may
// legitimately survive — a provenance comment naming the retired encoding.
// The scan must stay silent here, or "src is clean" would be unachievable
// for any file that narrates its own history.
const PLANTED_PROVENANCE = [
  "// CR-CRU-132 deleted wantsToon/truncatedToon/jsonVariantUrl/TOON_MAX_BYTES",
  "// and the toToon import; no route answers text/toon any more.",
  "export function reply(payload: Record<string, unknown>): Response {",
  "  return Response.json(payload);",
  "}",
].join("\n");

// ── The JSON envelope every reply()-routed GET publishes (§S1 AC8) ──────────
//
// Measured against the live server at `da33801`, BEFORE this CR's edits.
// This CR changes no payload, so every one of these must still hold after it.
const REPLY_ROUTED_GET_ENVELOPES: Array<{ path: (ctx: Fixture) => string; keys: string[] }> = [
  { path: () => "/api/v2", keys: ["ok", "service", "version", "projects", "help"] },
  { path: () => "/api/v2/health", keys: ["ok", "status", "version", "uptime_s", "counts", "store"] },
  { path: () => "/api/v2/projects", keys: ["ok", "projects"] },
  { path: () => "/api/v2/plans", keys: ["ok", "plans"] },
  { path: () => "/api/v2/agents", keys: ["ok", "agents"] },
  { path: () => "/api/v2/events", keys: ["ok", "events", "openRuns"] },
  { path: (c) => `/api/v2/events/${c.eventId}`, keys: ["ok", "event"] },
  { path: (c) => `/api/v2/status?project=${c.key}`, keys: ["ok", "status"] },
  { path: (c) => `/api/v2/projects/${c.key}/plans`, keys: ["ok", "plans"] },
  { path: (c) => `/api/v2/projects/${c.key}/queue`, keys: ["ok", "entries", "tracks"] },
  { path: (c) => `/api/v2/projects/${c.key}/releases`, keys: ["ok", "releases"] },
  {
    path: (c) => `/api/v2/projects/${c.key}/milestones?type=release`,
    keys: ["ok", "milestones", "totalCount"],
  },
  {
    path: (c) => `/api/v2/projects/${c.key}/release-proposals`,
    keys: ["ok", "proposals", "totalCount"],
  },
  // CR-CRU-032 §S1 — `handleEventsList`'s ANCHORED branch (`src/v2.ts:3667`,
  // entered when `?cycleId=` is present) is a genuinely DIFFERENT payload
  // from the unanchored recent-N feed two rows above, not the same URL under
  // another query string: it omits `openRuns` ENTIRELY and adds `cycle` only
  // when the cycleId resolves. Both of its two shapes are pinned, because
  // "an unknown cycleId answers 200 with an empty set and NO `cycle` field"
  // is itself the documented contract (`src/v2.ts`'s own comment on that
  // branch), and a row that only ever drove the resolving case would miss a
  // regression that started emitting `cycle: null`.
  {
    path: (c) => `/api/v2/events?project=${c.key}&cycleId=${c.cycleId}`,
    keys: ["ok", "events", "cycle"],
  },
  {
    path: (c) => `/api/v2/events?project=${c.key}&cycleId=${UNKNOWN_CYCLE_ID}`,
    keys: ["ok", "events"],
  },
];

// A cycle id no fixture plan can have been assigned — the anchored branch's
// unknown-cycleId arm.
const UNKNOWN_CYCLE_ID = 999_999;

interface Fixture {
  key: string;
  eventId: string;
  cycleId: number;
}

describe("the v2 response gate answers JSON, always (CR-CRU-132 §S1)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      rmSync(scratchDirs.pop()!, { recursive: true, force: true });
    }
  });

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function get(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, init);
  }

  async function seed(name: string): Promise<Fixture> {
    const projectRes = await postJson("/api/v2/projects", { name });
    const project = (await projectRes.json()) as { project: { key: string } };
    const key = project.project.key;
    const registered = await postJson("/api/v2/agents/register", {
      projectKey: key,
      agentId: "json-only-agent",
      role: "ORCHESTRATOR",
    });
    expect(registered.status).toBe(200);
    // A real plan cycle, ACTIVATED through the real transition, so the
    // anchored read below resolves a `cycle` descriptor rather than falling
    // into the unknown-cycleId arm.
    const planRes = await postJson(`/api/v2/projects/${key}/plans`, {
      agentId: "json-only-agent",
      cr: "CR-AUTH-1",
      cycles: [{ label: "A" }],
    });
    expect(planRes.status).toBe(201);
    const plan = (await planRes.json()) as { planId: number | string; cycles: Array<{ id: number }> };
    const cycleId = plan.cycles[0]!.id;
    const activated = await fetch(
      `http://localhost:${handle!.server.port}/api/v2/projects/${key}/plans/${plan.planId}/cycles/${cycleId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "json-only-agent", status: "active" }),
      },
    );
    expect(activated.status).toBe(200);

    const runRes = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId: "json-only-agent",
      summary: { total: 5, passed: 5, failed: 0, pending: 0, duration_ms: 100 },
      tree: [
        { name: "s", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 50 }] },
      ],
      context: { cycleId },
    });
    const run = (await runRes.json()) as { event: string };
    return { key, eventId: run.event, cycleId };
  }

  // ── AC1 + AC9 — by CONSTRUCTION ──────────────────────────────────────────

  describe("by construction — the machinery is gone from src/, not merely unreachable", () => {
    test("no file under src/ still names wantsToon, truncatedToon, jsonVariantUrl, TOON_MAX_BYTES or toToon in live code, and none carries the text/toon media type", () => {
      // FAILS IF THE CODE DOES NOTHING: every one of the five names is live
      // in src/v2.ts today (`:161`, `:164`, `:170`, `:181`, `:33`) and
      // `text/toon; charset=utf-8` is the content-type `reply()` sets, so
      // this scan reports today and reports nothing only once §S1 lands.
      const residue = scanSrc();
      const rendered = residue.map((r) => `${r.file}:${r.line} ${r.name}`);
      expect(rendered).toEqual([]);
    });

    test("CONTROL — the same scan reports all five names AND the media type when they are planted, so an empty finding set is the deletion's doing rather than a blind matcher", () => {
      // FAILS IF THE SCAN IS BLIND: a matcher that can never see these names
      // would make the test above pass vacuously the day it is written.
      const planted = serverToonResidue("src/planted.ts", PLANTED_SRC);
      const names = [...new Set(planted.map((r) => r.name))].sort();

      expect(names).toEqual([
        "TOON_MAX_BYTES",
        "jsonVariantUrl",
        "text/toon",
        "toToon",
        "truncatedToon",
        "wantsToon",
      ]);
      // BOUND — the media type is seen where it really lives, inside the
      // header string literal, not merely somewhere in the file.
      expect(planted.filter((r) => r.name === TOON_MEDIA_TYPE)).toHaveLength(1);
      expect(planted.every((r) => r.file === "src/planted.ts")).toBe(true);
    });

    test("CONTROL — the scan stays SILENT on a file that only NARRATES the deletion in a comment, so a provenance note can never be mistaken for a surviving capability", () => {
      // FAILS IF THE SCAN READS COMMENTS: a raw-text matcher would report
      // all six here, making a clean src/ impossible for any file that
      // records its own history — the CR-CRU-096 defect in mirror image.
      expect(serverToonResidue("src/narrated.ts", PLANTED_PROVENANCE)).toEqual([]);
    });

    test("src/toon.ts no longer exists — the 12-line adapter goes with the branch that called it", () => {
      // FAILS IF THE CODE DOES NOTHING: the file is on disk today.
      expect(existsSync(join(REPO_ROOT, "src", "toon.ts"))).toBe(false);
    });
  });

  // ── AC5 + AC6 + AC7 — inert, never refused ───────────────────────────────

  describe("a TOON request is INERT — answered in JSON, never refused", () => {
    test("GET /api/v2/events?fmt=toon answers JSON 200 with content-type application/json, never text/toon", async () => {
      // FAILS IF THE CODE DOES NOTHING: today this route answers
      // `text/toon; charset=utf-8` with a TOON body, so both the
      // content-type assertion and the `res.json()` parse fail.
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await get("/api/v2/events?fmt=toon");

      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type") ?? "";
      expect(contentType).toContain("application/json");
      // NEGATIVE — inert, not a new refusal: no 406, no error envelope, and
      // not a whiff of the retired media type.
      expect(res.status).not.toBe(406);
      expect(contentType).not.toContain("toon");
      const body = (await res.json()) as { ok: boolean; events: unknown[] };
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.events)).toBe(true);
    });

    test("GET /api/v2 with Accept: text/toon answers JSON 200 with content-type application/json, never text/toon", async () => {
      // FAILS IF THE CODE DOES NOTHING: `wantsToon()` reads the Accept
      // header today and this GET comes back as TOON text.
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await get("/api/v2", { headers: { Accept: "text/toon" } });

      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type") ?? "";
      expect(contentType).toContain("application/json");
      expect(res.status).not.toBe(406);
      expect(contentType).not.toContain("toon");
      const body = (await res.json()) as { ok: boolean; service: string };
      expect(body.ok).toBe(true);
      expect(body.service).toBe("crucible");
    });

    test("GET /api/v2/agents with Accept listing text/toon among other media types answers JSON 200 — the header-substring path is gone too", async () => {
      // FAILS IF THE CODE DOES NOTHING: `(accept ?? "").includes("toon")`
      // matches this header today and selects TOON.
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await get("/api/v2/agents", {
        headers: { Accept: "text/html, text/toon;q=0.9, */*;q=0.1" },
      });

      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type") ?? "";
      expect(contentType).toContain("application/json");
      expect(res.status).not.toBe(406);
      expect(contentType).not.toContain("toon");
      const body = (await res.json()) as { ok: boolean; agents: unknown[] };
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.agents)).toBe(true);
    });

    test("the ?fmt=toon body is BYTE-IDENTICAL to the same GET's ordinary JSON body — the parameter changes nothing at all", async () => {
      // FAILS IF THE CODE DOES NOTHING: today the two bodies are different
      // encodings of the same payload (`ok: true\nplans: []` vs
      // `{"ok":true,"plans":[]}`), so the string comparison fails.
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const plain = await (await get("/api/v2/plans")).text();
      const negotiated = await (await get("/api/v2/plans?fmt=toon")).text();

      // POSITIVE — the exact JSON body, both times.
      expect(plain).toBe('{"ok":true,"plans":[]}');
      expect(negotiated).toBe(plain);
    });

    test("GREEN-GUARD — GET /api/v2/events?fmt=json still answers JSON 200, the documented escape hatch callers may have written down", async () => {
      // PASSES TODAY and must keep passing: `?fmt=json` is not retired by
      // this CR, only made redundant. It fails if GREEN over-reaches and
      // starts refusing an unknown `fmt` value.
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await get("/api/v2/events?fmt=json");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("application/json");
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });

  // ── AC8 — no payload moves ───────────────────────────────────────────────

  describe("GREEN-GUARD — every reply()-routed v2 GET keeps its JSON envelope exactly", () => {
    test("every reply()-routed GET shape — including BOTH arms of the anchored events branch — publishes its measured top-level key set, in order, over the ordinary JSON path", async () => {
      // PASSES TODAY (measured against `da33801`) and must keep passing:
      // this CR drops an encoding, never a payload. It fails the moment a
      // handler gains, loses or reorders a top-level field.
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const fixture = await seed("json-envelope-guard");

      const observed: Array<[string, string[]]> = [];
      for (const route of REPLY_ROUTED_GET_ENVELOPES) {
        const path = route.path(fixture);
        const res = await get(path);
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        observed.push([path, Object.keys(body)]);
      }

      expect(observed).toEqual(
        REPLY_ROUTED_GET_ENVELOPES.map((route) => [route.path(fixture), route.keys]),
      );
    });
  });

  // ── AC3 + AC4 — the dependency moves, it does not leave ──────────────────

  describe("the server's runtime dependency set becomes empty", () => {
    function readPackageJson(): {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    } {
      return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
    }

    test("package.json's dependencies object is EMPTY — the server carries no runtime dependency at all", () => {
      // FAILS IF THE CODE DOES NOTHING: `dependencies` holds exactly one
      // entry today, `@toon-format/toon`.
      expect(readPackageJson().dependencies).toEqual({});
    });

    test("@toon-format/toon is pinned in devDependencies at ^4.1.0 and appears in dependencies nowhere — MOVED, not deleted", () => {
      // FAILS IF THE CODE DOES NOTHING: the entry is in `dependencies`
      // today and `devDependencies` has no `@toon-format/toon` key.
      const pkg = readPackageJson();

      // POSITIVE — the exact pin, so a silent version drift fails here.
      expect(pkg.devDependencies?.["@toon-format/toon"]).toBe("^4.1.0");
      // NEGATIVE — and it is not left behind in the runtime set.
      expect(pkg.dependencies?.["@toon-format/toon"]).toBeUndefined();
    });

    test("GREEN-GUARD — the surviving client-emit oracle still imports the reference decoder from @toon-format/toon, so the move keeps a real consumer", () => {
      // PASSES TODAY and must keep passing: a CR that deleted the library
      // outright would take the only independent check of clients/toon.py
      // with it. Fails if the oracle's import is dropped.
      const oracle = readFileSync(join(REPO_ROOT, "tests", "toon-conformance.test.ts"), "utf8");
      expect(oracle).toContain('import { decode } from "@toon-format/toon";');
      expect(oracle).toContain("client-emit oracle");
    });

    test(
      "a clean `bun install --production` of the staged server tree installs NO runtime dependency, and that tree still boots and serves GET /api/v2/health",
      async () => {
        // FAILS IF THE CODE DOES NOTHING: a production install of today's
        // package.json materialises node_modules/@toon-format, so the first
        // assertion fails right now.
        //
        // AND IT IS THE ONE TEST THAT CATCHES A HALF-DONE §S1: once the
        // dependency has moved, a leftover `import … from
        // "@toon-format/toon"` anywhere in src/ makes the boot below die
        // with a module-resolution error against a tree that genuinely does
        // not have the package — which a `bun test` run inside the repo
        // (where devDependencies ARE installed) can never reveal.
        //
        // Staged copy, never the working checkout: the install writes
        // node_modules and a lockfile, and the boot writes a database.
        const staged = mkdtempSync(join(tmpdir(), "crucible-production-boot-"));
        scratchDirs.push(staged);
        for (const entry of ["package.json", "bun.lock", "src", "bin", "public"]) {
          cpSync(join(REPO_ROOT, entry), join(staged, entry), { recursive: true });
        }

        const install = Bun.spawnSync({
          cmd: ["bun", "install", "--production"],
          cwd: staged,
          stdout: "pipe",
          stderr: "pipe",
        });
        // The install's own failure channel, stated rather than swallowed:
        // a non-zero exit reports bun's stderr here instead of surfacing
        // three assertions later as a confusing "boots fine".
        expect(
          install.exitCode === 0 ? "" : install.stderr.toString().slice(-2000),
        ).toBe("");

        const proc = Bun.spawn({
          cmd: ["bun", "run", "src/server.ts"],
          cwd: staged,
          env: {
            ...process.env,
            CRUCIBLE_PORT: "0",
            CRUCIBLE_DB: join(staged, "boot-probe.db"),
          },
          stdout: "pipe",
          stderr: "pipe",
        });

        let port = 0;
        let bootFailure = "";
        try {
          port = await Promise.race([
            (async () => {
              const reader = proc.stdout.getReader();
              const decoder = new TextDecoder();
              let seen = "";
              try {
                for (;;) {
                  const { value, done } = await reader.read();
                  if (done) throw new Error(`server exited without a banner: ${seen}`);
                  seen += decoder.decode(value, { stream: true });
                  const match = seen.match(/listening on http:\/\/localhost:(\d+)/);
                  if (match) return Number(match[1]);
                }
              } finally {
                reader.releaseLock();
              }
            })(),
            new Promise<number>((_, reject) =>
              setTimeout(() => reject(new Error("boot timed out after 60s")), 60_000),
            ),
          ]);
        } catch (err) {
          proc.kill();
          const stderr = await new Response(proc.stderr).text();
          bootFailure = `${(err as Error).message}\n${stderr}`.slice(0, 4000);
        }

        // The failure channel, stated rather than swallowed: a boot that
        // dies on a missing module reports the module here.
        expect(bootFailure).toBe("");
        expect(port).toBeGreaterThan(0);

        try {
          const res = await fetch(`http://localhost:${port}/api/v2/health`);
          expect(res.status).toBe(200);
          expect(res.headers.get("content-type") ?? "").toContain("application/json");
          const body = (await res.json()) as { ok: boolean; status: string };
          expect(body.ok).toBe(true);
          expect(typeof body.status).toBe("string");
        } finally {
          proc.kill();
          await proc.exited;
        }

        // THE RED ASSERTION, deliberately LAST so the boot above is really
        // exercised today: the boot half is the post-GREEN half-done-§S1
        // detector, and an assertion placed before it would short-circuit
        // the run and leave that machinery unproven until GREEN lands.
        // POSITIVE — a production install of this tree materialises no
        // runtime dependency whatsoever.
        expect(existsSync(join(staged, "node_modules", "@toon-format"))).toBe(false);
      },
      180_000,
    );
  });
});
