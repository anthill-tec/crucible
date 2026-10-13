// A gate run's own release stamp (`version`) should outlive it across every
// later snapshot the SAME no-mistakes run posts, even though only the first
// of them is ever given the label explicitly.
//
// The contract under test (absent until the store/route grow it):
//   POST /api/v2/gates already accepts a sibling top-level `version` and
//   stores it first-class, and already lifts `gate.run.id` onto the stored
//   event as `runId`. What does NOT exist yet: when a posted snapshot omits
//   `version` and its `gate.run.id` names a run, the server must look up
//   that SAME run's latest earlier snapshot IN THE SAME PROJECT and stamp
//   the new one with whatever `version` it carried. A run that was never
//   given one stays release-less, a snapshot naming no run is never looked
//   up at all, an explicit `version` is never overwritten, and a run id that
//   happens to match a DIFFERENT project's run is never consulted.
//
// This file drives the real production server (`startServer`) end to end —
// every assertion below fails against production as it stands, because
// nothing inherits anything yet.
import { describe, test, expect, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import { declareClientBoard } from "./helpers/client-board.ts";

interface OkResponse {
  ok: true;
  event?: string;
  [key: string]: unknown;
}

interface EventDetail {
  id: string;
  kind: string;
  runId?: string;
  version?: string;
  [key: string]: unknown;
}

interface EventDetailResponse {
  ok: true;
  event: EventDetail;
}

describe("a run's snapshots keep the run's release", () => {
  let handle: ServerHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function boot(): ServerHandle {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    return handle;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`);
  }

  async function createProject(name: string, agentId = "orchestrator-1"): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    const key = body.project.key;
    const regRes = await postJson("/api/v2/agents/register", {
      projectKey: key,
      agentId,
      role: "ORCHESTRATOR",
    });
    expect(regRes.status).toBe(200);
    return key;
  }

  function defaultGate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      intent: "release gate",
      outcome: "passed",
      steps: [{ name: "test", status: "passed" }],
      ...overrides,
    };
  }

  /** Posts one gate snapshot; returns its stored event id. */
  async function postGate(
    key: string,
    agentId: string,
    gateOverrides: Record<string, unknown> = {},
    version?: string,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      projectKey: key,
      agentId,
      gate: defaultGate(gateOverrides),
    };
    if (version !== undefined) body.version = version;
    const res = await postJson("/api/v2/gates", body);
    expect(res.status).toBe(201);
    const parsed = (await res.json()) as OkResponse;
    return parsed.event as string;
  }

  async function getEventDetail(id: string): Promise<EventDetail> {
    const res = await getJson(`/api/v2/events/${id}`);
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as EventDetailResponse;
    return parsed.event;
  }

  describe("server inheritance — POST /api/v2/gates", () => {
    test("a release-less snapshot inherits its run's version; a run never given one, and a snapshot naming no run, stay release-less", async () => {
      boot();
      const key = await createProject("inherit-basic");

      // The run's sealed snapshot carries a release; a later snapshot of the
      // SAME run, posted with no version at all, inherits it.
      await postGate(key, "orchestrator-1", { run: { id: "run-basic-a" } }, "0.4.0");
      const followUpId = await postGate(key, "orchestrator-1", { run: { id: "run-basic-a" } });
      const followUp = await getEventDetail(followUpId);
      expect(followUp.version).toBe("0.4.0");

      // A different run in the same project that was NEVER given a release:
      // its own release-less snapshots stay release-less, even though the
      // project holds a versioned run elsewhere.
      const neverA = await postGate(key, "orchestrator-1", { run: { id: "run-basic-never" } });
      const neverB = await postGate(key, "orchestrator-1", { run: { id: "run-basic-never" } });
      expect((await getEventDetail(neverA)).version).toBeUndefined();
      expect((await getEventDetail(neverB)).version).toBeUndefined();

      // A snapshot naming no run at all (no `run` key on the gate object)
      // stays release-less too — nothing to inherit FROM.
      const noRunId = await postGate(key, "orchestrator-1", {});
      expect((await getEventDetail(noRunId)).version).toBeUndefined();
    });

    test("an explicit version is kept, not overridden; inheritance follows the run's LATEST earlier snapshot; and a matching run id in another project is never read", async () => {
      boot();
      const keyA = await createProject("inherit-latest-a");
      const runId = "run-latest-shared";

      const sealId = await postGate(keyA, "orchestrator-1", { run: { id: runId } }, "0.4.0");
      expect((await getEventDetail(sealId)).version).toBe("0.4.0");

      // A later snapshot of the SAME run that carries its OWN version is
      // never overwritten by the earlier one.
      const ownId = await postGate(keyA, "orchestrator-1", { run: { id: runId } }, "0.5.0");
      expect((await getEventDetail(ownId)).version).toBe("0.5.0");

      // A still-later release-less snapshot inherits the LATEST earlier
      // snapshot's version (0.5.0), not the first one the run ever carried
      // (0.4.0) — "latest earlier snapshot", not "any earlier snapshot".
      const inheritsLatestId = await postGate(keyA, "orchestrator-1", { run: { id: runId } });
      expect((await getEventDetail(inheritsLatestId)).version).toBe("0.5.0");

      // A second project whose own run happens to share the EXACT SAME run
      // id never sees project A's version — runs in another project are
      // never read.
      const keyB = await createProject("inherit-latest-b");
      const crossProjectId = await postGate(keyB, "orchestrator-1", { run: { id: runId } });
      expect((await getEventDetail(crossProjectId)).version).toBeUndefined();
    });
  });

  // ONE real client, run as a subprocess against the live board above, drives
  // one no-mistakes run in two calls: `gate-run --release 0.4.0` stops at the
  // run's review approval (a held exit), then `gate-respond` approves it and
  // drives the SAME run on to its seal. `gate-respond` takes no release, so
  // every snapshot it posts reaches the board without one; what the board
  // stores for them is read back over HTTP.
  //
  // The client finds the board through the scratch project's own
  // `crucible.toml` `[client] url` (`declareClientBoard`), and `no-mistakes`
  // is a fake on PATH answering from scripted TOON snapshots — the same
  // `axi status` / `axi run` / `axi respond` stand-in the client gate suites
  // under tests/client/ use, with its state directory written into the
  // script rather than handed over in the environment.
  describe("end to end — one real client drives gate-run then gate-respond on the same run, against a live board", () => {
    const CLIENT = join(import.meta.dir, "..", "clients", "bun-crucible.py");
    const RUN_ID = "e2e-release-run-0001";
    const RELEASE = "0.4.0";
    const CALLER = "release-e2e-caller";
    const RUN_INTENT = "release the run end to end";
    // How long the fake's `axi run` / `axi respond` keep going before they
    // answer: past the client's first status poll, so each drive streams at
    // least one interim snapshot to the board before its own answer.
    const DRIVE_SECONDS = 3;

    const scratch: string[] = [];

    afterEach(() => {
      for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function scratchDir(prefix: string): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      scratch.push(dir);
      return dir;
    }

    /** One `no-mistakes axi` TOON snapshot of the run. */
    function snapshot(status: string, steps: Array<[string, string]>, outcome?: string): string {
      const lines = [
        "run:",
        `  id: "${RUN_ID}"`,
        "  branch: feature/release-e2e",
        `  status: ${status}`,
        "  head: cafe4004",
        "  findings: 0",
        `  steps[${steps.length}]{step,status,findings,duration_ms}:`,
        ...steps.map(([step, stepStatus]) => `    ${step},${stepStatus},0,10`),
      ];
      if (outcome !== undefined) lines.push(`outcome: ${outcome}`);
      return `${lines.join("\n")}\n`;
    }

    /**
     * Puts a fake `no-mistakes` in `binDir`. `axi run` answers with the run
     * held at review; `axi respond` marks itself launched and answers with
     * the run sealed. `axi status` shows review awaiting approval until a
     * respond has launched, and review completed with test running after.
     * Every invocation is appended to `calls.log` in `stateDir`.
     */
    function installFakeNoMistakes(binDir: string, stateDir: string): void {
      writeFileSync(
        join(stateDir, "awaiting-review.toon"),
        snapshot("awaiting_approval", [
          ["intent", "completed"],
          ["review", "awaiting_approval"],
        ]),
      );
      writeFileSync(
        join(stateDir, "test-running.toon"),
        snapshot("running", [
          ["intent", "completed"],
          ["review", "completed"],
          ["test", "running"],
        ]),
      );
      writeFileSync(
        join(stateDir, "sealed.toon"),
        snapshot(
          "completed",
          [
            ["intent", "completed"],
            ["review", "completed"],
            ["test", "completed"],
          ],
          "passed",
        ),
      );
      const fake = [
        "#!/usr/bin/env python3",
        "import os",
        "import sys",
        "import time",
        `STATE = ${JSON.stringify(stateDir)}`,
        `SECONDS = ${DRIVE_SECONDS}`,
        "argv = sys.argv[1:]",
        "def answer(name):",
        "    with open(os.path.join(STATE, name)) as f:",
        "        sys.stdout.write(f.read())",
        "with open(os.path.join(STATE, 'calls.log'), 'a') as f:",
        "    f.write(' '.join(argv) + '\\n')",
        "launched = os.path.join(STATE, 'respond.launched')",
        "if argv[:2] == ['axi', 'status']:",
        "    answer('test-running.toon' if os.path.exists(launched) else 'awaiting-review.toon')",
        "    sys.exit(0)",
        "if argv[:2] == ['axi', 'run']:",
        "    time.sleep(SECONDS)",
        "    answer('awaiting-review.toon')",
        "    sys.exit(0)",
        "if argv[:2] == ['axi', 'respond']:",
        "    with open(launched, 'w') as f:",
        "        f.write('1')",
        "    time.sleep(SECONDS)",
        "    answer('sealed.toon')",
        "    sys.exit(0)",
        "sys.stderr.write('fake no-mistakes: unsupported invocation: %r\\n' % (argv,))",
        "sys.exit(1)",
        "",
      ].join("\n");
      const path = join(binDir, "no-mistakes");
      writeFileSync(path, fake);
      chmodSync(path, 0o755);
    }

    interface Drive {
      code: number;
      stdout: string;
      stderr: string;
    }

    /** Runs the real client once, in `projectDir`, with the fake first on PATH. */
    async function drive(projectDir: string, binDir: string, args: string[]): Promise<Drive> {
      const env: Record<string, string | undefined> = { ...process.env };
      for (const name of Object.keys(env)) {
        if (name.startsWith("WORKFLOW_") || name.startsWith("CRUCIBLE_")) delete env[name];
      }
      env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
      const proc = Bun.spawn({
        cmd: ["python3", CLIENT, ...args, "--project-dir", projectDir],
        cwd: projectDir,
        env,
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

    interface GateBrief {
      id: string;
      kind: string;
      gate?: { inFlight?: boolean; outcome?: string };
    }

    async function gateEvents(key: string): Promise<GateBrief[]> {
      const res = await getJson(`/api/v2/events?project=${key}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: true; events: GateBrief[] };
      return body.events.filter((e) => e.kind === "gate");
    }

    test(
      "every snapshot gate-respond posts, and its seal, is stored with the release gate-run was given",
      async () => {
        boot();
        const key = await createProject("release-e2e", CALLER);
        const projectDir = scratchDir("release-e2e-project-");
        const binDir = scratchDir("release-e2e-bin-");
        const stateDir = scratchDir("release-e2e-state-");
        writeFileSync(
          join(projectDir, ".env"),
          `CRUCIBLE_PROJECT_KEY=${key}\nCRUCIBLE_PROJECT_NAME=release-e2e\n`,
        );
        declareClientBoard(`http://localhost:${handle!.server.port}`, projectDir);
        installFakeNoMistakes(binDir, stateDir);

        // gate-run --release 0.4.0 drives the run to its review approval and
        // stops there: a held exit, nothing sealed.
        const run = await drive(projectDir, binDir, [
          "gate-run",
          "--intent",
          RUN_INTENT,
          "--release",
          RELEASE,
          "--agent",
          CALLER,
        ]);
        expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 1 });
        expect(run.stderr).toContain("NOT SEALED");
        const runSnapshots = await gateEvents(key);
        expect(runSnapshots.length).toBeGreaterThan(0);
        const postedByRun = new Set(runSnapshots.map((e) => e.id));

        // gate-respond approves review on the same run, with no release, and
        // drives it on to its seal.
        const respond = await drive(projectDir, binDir, [
          "gate-respond",
          "--action",
          "approve",
          "--step",
          "review",
          "--agent",
          CALLER,
        ]);
        expect({ code: respond.code, stderr: respond.stderr }).toMatchObject({ code: 0 });

        // The fake really was driven by both verbs, in that order.
        const calls = readFileSync(join(stateDir, "calls.log"), "utf8")
          .split("\n")
          .filter((line) => line.startsWith("axi run") || line.startsWith("axi respond"));
        expect(calls.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
          "axi run",
          "axi respond",
        ]);

        const respondSnapshots = (await gateEvents(key)).filter((e) => !postedByRun.has(e.id));
        const interims = respondSnapshots.filter((e) => e.gate?.inFlight === true);
        const seals = respondSnapshots.filter((e) => e.gate?.inFlight !== true);
        expect(interims.length).toBeGreaterThan(0);
        expect(seals).toHaveLength(1);
        expect(seals[0]!.gate?.outcome).toBe("passed");

        // Read back through the board's HTTP API: every snapshot of the run,
        // gate-run's and gate-respond's alike, is keyed by the run and stored
        // under the release gate-run was given.
        for (const brief of [...runSnapshots, ...respondSnapshots]) {
          const event = await getEventDetail(brief.id);
          expect({ id: brief.id, runId: event.runId, version: event.version }).toEqual({
            id: brief.id,
            runId: RUN_ID,
            version: RELEASE,
          });
        }
      },
      60_000,
    );
  });
});
