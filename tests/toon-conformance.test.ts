// CR-CRU-046 §S4 — the CLIENT-EMIT TOON conformance oracle: a real client's
// own stdout AXI envelope, decoded by the official `@toon-format/toon`
// library, in the client→agent direction.
//
// THIS FILE WAS the two-direction §S4 gate. CR-CRU-132 §S2 deleted its
// SERVER-WIRE half: the seven envelope-shape round-trips, the six
// type-preservation cases and the two server-fetched `help[]` decode tests.
//
// THE SUPERSEDED CLAIM, named rather than silently dropped:
//
//   - CR-CRU-046 §S4, server direction — "the TOON body the server returns
//     for every v2 GET envelope shape decodes, via the OFFICIAL library, to
//     exactly the JSON twin of the same call: list arrays in the official
//     `- `-prefixed form, and number/boolean/null-LOOKING strings still
//     strings." SUPERSEDED BY CR-CRU-132 §S1, which deletes the server's
//     TOON rendering: there is no server wire left to decode, so the
//     conformance of a body that is never emitted is not a requirement.
//     `src/toon.ts` and the `toToon` seam those tests pinned go with it.
//
// WHAT SURVIVES — and what this file now exists for — is the CLIENT-EMIT
// ORACLE below. `clients/toon.py` still encodes every fleet client's stdout
// envelope (the TOON-AXI contract of CR-CRU-030 / CR-CRU-046), and this is
// the only independent check that its output is conformant, measured by the
// official library rather than by our own encoder agreeing with itself. It
// is ALSO this CR's own proof that removing the server's TOON did not touch
// the fleet's — which is why `@toon-format/toon` MOVES to `devDependencies`
// instead of leaving the repo. Deleting it would take this oracle with it.
import { decode } from "@toon-format/toon";
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

describe("TOON conformance — official library decode of a real CLIENT envelope (CR-CRU-046 §S4)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  // ── §S4 AC — client-emit direction: a REAL client's own stdout envelope ──
  // decodes via the official library. This is the direction named by §S4
  // ("client `_emit` output ... → `@toon-format/toon` decode ...
  // across the client envelope shapes"). `clients/bun-crucible.py` writes
  // its own AXI envelope to stdout via `_crucible_axi.py:84`
  // (`sys.stdout.write(_toon().encode({"axi": axi}) + "\n")`) — a REAL
  // client-side TOON encode, produced by `clients/toon.py`, not the
  // server's `src/toon.ts`. Self-contained: its own spawn helper, its own
  // scratch-dir lifecycle, reusing only `createProject`/`handle` from the
  // outer describe.

  describe("client-emit oracle — a real client envelope decodes via the official library (§S4, client→agent direction)", () => {
    const CLIENT_SCRIPT_PATH = join(import.meta.dir, "..", "clients", "bun-crucible.py");
    const scratchDirs: string[] = [];

    afterEach(() => {
      while (scratchDirs.length > 0) {
        rmSync(scratchDirs.pop()!, { recursive: true, force: true });
      }
    });

    interface ClientRunResult {
      code: number;
      stdout: string;
      stderr: string;
    }

    /**
     * Spawns `uv run clients/bun-crucible.py <args>` against a REAL server —
     * the same PEP 723 `uv run` invocation pattern
     * `tests/clients-bun-crucible.test.ts`'s `runScript` helper uses (§S3),
     * copied locally (that helper is not exported) rather than imported.
     * Strips ambient `WORKFLOW_*` env so each call controls it explicitly,
     * and always injects `CRUCIBLE_URL` at the fixture server under test.
     */
    async function runClient(
      args: string[],
      cwd: string,
      crucibleUrl: string,
    ): Promise<ClientRunResult> {
      const baseEnv: Record<string, string | undefined> = { ...process.env };
      for (const k of Object.keys(baseEnv)) {
        if (k.startsWith("WORKFLOW_")) delete baseEnv[k];
      }
      const proc = Bun.spawn({
        cmd: ["uv", "run", CLIENT_SCRIPT_PATH, ...args],
        cwd,
        env: { ...baseEnv, CRUCIBLE_URL: crucibleUrl },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    }

    /** A fresh scratch project dir carrying only the `.env` project-key pin
     * the client's `_project_key()` resolution needs — the ephemeral FIXTURE
     * server's project, never the live :3849 board. */
    function scratchProjectDir(key: string): string {
      const dir = mkdtempSync(join(tmpdir(), "toon-oracle-client-"));
      scratchDirs.push(dir);
      writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
      return dir;
    }

    test("a real client `register` envelope's stdout decodes via the official library into a well-formed AXI envelope (§S4 AC — 'every client-emitted envelope round-trips')", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("client-emit-register-rt");
      const projectDir = scratchProjectDir(key);

      const res = await runClient(
        ["register", "--agent", "toon-oracle-probe", "--role", "report", "--project-dir", projectDir],
        projectDir,
        `http://localhost:${handle.server.port}`,
      );

      expect(res.code).toBe(0);
      const decoded = decode(res.stdout) as {
        axi: {
          verb: string;
          ok: boolean;
          agent: string;
          help: unknown;
          context: { projectKey: string };
          warnings: unknown;
        };
      };

      // POSITIVE — the exact deterministic shape a real register call must emit.
      expect(decoded.axi.verb).toBe("register");
      expect(decoded.axi.ok).toBe(true);
      expect(decoded.axi.agent).toBe("toon-oracle-probe");
      expect(Array.isArray(decoded.axi.help)).toBe(true);
      expect((decoded.axi.help as unknown[]).length).toBeGreaterThan(0);
      expect((decoded.axi.help as unknown[]).every((h) => typeof h === "string")).toBe(true);
      // NEGATIVE/bound — the fixture project's own key, not some other value.
      expect(decoded.axi.context.projectKey).toBe(key);
    });

    // ESCALATION: the dispatch brief asked for this case to be driven via
    // `--message "42"`, but reading `clients/bun-crucible.py:339-421`
    // (`_register_agent`/`cmd_register`) shows `message` is POSTed to the
    // server ONLY — the `_emit_axi("register", ok, {"agent": args.agent,
    // "help": _HELP_STEPS["register"]}, ...)` call at bun-crucible.py:419-420
    // never includes it, and `_crucible_axi.py`'s documented envelope shape
    // (`axi: {verb, ok, <verb-specific result fields>, context, warnings}`)
    // confirms `register`'s result fields are exactly `{agent, help}` — no
    // field carries `message` in the CLIENT's own stdout to decode. The
    // AGENT ID (`args.agent`) IS echoed verbatim into both `axi.agent` and
    // `axi.context.agentId`, giving the identical client-emit
    // type-preservation property the §S4 AC requires ("42" must not become
    // a number), so this test drives it through `--agent "42"` instead of
    // `--message "42"` — flagged here rather than silently substituted.
    test("a numeric-looking agent id ('42') survives the client's own encode→official-decode as a STRING, never coerced to a number (§S4 AC type preservation, client-emit direction)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("client-emit-type-preserve-rt");
      const projectDir = scratchProjectDir(key);

      const res = await runClient(
        ["register", "--agent", "42", "--role", "report", "--project-dir", projectDir],
        projectDir,
        `http://localhost:${handle.server.port}`,
      );

      expect(res.code).toBe(0);
      const decoded = decode(res.stdout) as {
        axi: { agent: unknown; context: { agentId: unknown } };
      };

      // POSITIVE — the exact string, unchanged.
      expect(decoded.axi.agent).toBe("42");
      expect(decoded.axi.context.agentId).toBe("42");
      // NEGATIVE — never silently coerced to the JS number 42 by the
      // official decoder reading the client's OWN TOON output.
      expect(typeof decoded.axi.agent).toBe("string");
      expect(typeof decoded.axi.context.agentId).toBe("string");
    });

    test("`unregister` through the same spawn path also decodes via the official library to a well-formed ok:true envelope (lighter, decode-asserted)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("client-emit-unregister-rt");
      const projectDir = scratchProjectDir(key);

      await runClient(
        ["register", "--agent", "toon-oracle-probe", "--role", "report", "--project-dir", projectDir],
        projectDir,
        `http://localhost:${handle.server.port}`,
      );

      const res = await runClient(
        ["unregister", "--agent", "toon-oracle-probe", "--project-dir", projectDir],
        projectDir,
        `http://localhost:${handle.server.port}`,
      );

      expect(res.code).toBe(0);
      const decoded = decode(res.stdout) as { axi: { verb: string; ok: boolean; agent: string } };
      // POSITIVE — the exact deterministic unregister shape.
      expect(decoded.axi.verb).toBe("unregister");
      expect(decoded.axi.ok).toBe(true);
      expect(decoded.axi.agent).toBe("toon-oracle-probe");
    });
  });

  // ── Sanity — the DN/spec doc still exists (retired, not deleted, per §S5) ─

  describe("§S5 — the subset DN is retired, not deleted", () => {
    test("docs/research/DN-crucible-toon-subset.md still exists (content is rewritten by §S5, the file is not removed)", () => {
      const dnPath = join(import.meta.dir, "../docs/research/DN-crucible-toon-subset.md");
      const content = readFileSync(dnPath, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    });
  });
});
