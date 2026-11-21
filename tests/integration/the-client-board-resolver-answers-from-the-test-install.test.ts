// The client-board resolver answers from the test install, never from the
// repo root's install (AC10, the bun backstops).
//
// `tests/helpers/client-board.ts` asks the fleet's OWN resolver which board a
// client started in a directory would reach, by loading `_crucible_axi.py` in
// a python process. Loaded from the checkout's `clients/`, that module's
// `_INSTALL_DIR` is the REPO ROOT, so a directory that declares no board falls
// through to the operator's root `crucible.toml` and answers the operator's
// board. Loaded from the test install's `clients/` (a symlink, which the
// client never resolves), its install is the test install, whose
// `crucible.toml` declares nothing — so the same question answers the
// `BoardUndeclared` refusal, naming the test install's file.
//
// Pinned surface: `client-board.ts` exports `RESOLVER_MODULE`, the module path
// its probe loads, and it is `clientScript("_crucible_axi.py")`.
//
// Tier: integration. Each case starts at most ONE small python child that
// loads client modules and prints what they derived: no board, no socket, no
// verb. A case never spawns until the path it would load is proved to be the
// test install's, so a failing run never reads the operator's root file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const HELPER_PATH = path.join(import.meta.dir, "../helpers", "test-install.ts");
const HELPER_NAME = "tests/helpers/test-install.ts";
const BOARD_HELPER_PATH = path.join(import.meta.dir, "../helpers", "client-board.ts");
const CHILD_TIMEOUT_MS = 60_000;

let helper: Record<string, unknown> | null = null;
let helperLoadError = "";
try {
  helper = (await import(HELPER_PATH)) as Record<string, unknown>;
} catch (error) {
  helperLoadError = error instanceof Error ? error.message : String(error);
}
const board = (await import(BOARD_HELPER_PATH)) as Record<string, unknown>;

function surface<T>(name: string): T {
  if (helper === null) {
    throw new Error(
      `${HELPER_NAME} does not load (${helperLoadError}): the bun suite has no test install helper yet`,
    );
  }
  if (!(name in helper)) {
    throw new Error(`${HELPER_NAME} exports no \`${name}\`: the bun suite has no test install ${name} yet`);
  }
  return helper[name] as T;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** `p` as the client's own messages show it: home-abbreviated. */
function shown(p: string): string {
  const home = homedir();
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** Loads the bun client and the shared core by the given paths and prints
 *  each one's derived install dir. */
const INSTALL_DIR_PROBE = [
  "import importlib.util, json, sys",
  "def load(file, name):",
  "    spec = importlib.util.spec_from_file_location(name, file)",
  "    module = importlib.util.module_from_spec(spec)",
  "    spec.loader.exec_module(module)",
  "    return module",
  "bun_client = load(sys.argv[1], 'bun_client_install_probe')",
  "core = load(sys.argv[2], 'core_install_probe')",
  "print(json.dumps({'bun_client_core': bun_client._axi()._INSTALL_DIR, 'core': core._INSTALL_DIR}))",
].join("\n");

let owned = "";

beforeEach(() => {
  owned = mkdtempSync(path.join(tmpdir(), "client-board-resolver-"));
});

afterEach(() => {
  rmSync(owned, { recursive: true, force: true });
});

describe("the client-board resolver answers from the test install", () => {
  test(
    "a client spawned from the test install derives the test install as its install dir, for the bun client and the shared core",
    () => {
      const clientScript = surface<(name: string) => string>("clientScript");
      const root = surface<string>("TEST_INSTALL_DIR");
      const bunClient = clientScript("bun-crucible.py");
      const core = clientScript("_crucible_axi.py");
      expect(isInside(bunClient, root)).toBe(true);
      expect(isInside(core, root)).toBe(true);

      const child = Bun.spawnSync({
        cmd: ["python3", "-c", INSTALL_DIR_PROBE, bunClient, core],
        cwd: owned,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PYTHONDONTWRITEBYTECODE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(child.exitCode === 0 ? "loaded" : child.stderr.toString().slice(-1500)).toBe("loaded");
      const derived = JSON.parse(child.stdout.toString().trim()) as Record<string, string>;
      expect(derived).toEqual({ bun_client_core: root, core: root });
      expect(derived.core).not.toBe(REPO_ROOT);
    },
    CHILD_TIMEOUT_MS,
  );

  test("client-board.ts's resolver probe loads the shared core from the test install", () => {
    const clientScript = surface<(name: string) => string>("clientScript");
    expect("RESOLVER_MODULE" in board ? "exported" : "client-board.ts exports no RESOLVER_MODULE").toBe(
      "exported",
    );
    expect(board.RESOLVER_MODULE).toBe(clientScript("_crucible_axi.py"));
  });

  test(
    "asked about a directory that declares no board, the resolver probe refuses naming the test install's crucible.toml, never the repo root's",
    () => {
      const clientScript = surface<(name: string) => string>("clientScript");
      const config = surface<string>("TEST_INSTALL_CONFIG");
      // Proved first, so a failing run never loads the core from the checkout.
      expect(board.RESOLVER_MODULE).toBe(clientScript("_crucible_axi.py"));
      const declaredClientBoard = board.declaredClientBoard as (dir: string) => { url: string } | { skip: string };

      const answer = declaredClientBoard(owned);

      expect("skip" in answer ? "refused" : `answered ${JSON.stringify(answer)}`).toBe("refused");
      const why = "skip" in answer ? answer.skip : "";
      expect(why).toContain("no board declared");
      expect(why).toContain(shown(config));
      expect(why).not.toContain(shown(path.join(REPO_ROOT, "crucible.toml")));
    },
    CHILD_TIMEOUT_MS,
  );
});
