/**
 * CR-CRU-139 §S2 — a client's target board is CONFIGURATION, declared in the
 * project's own `crucible.toml`, and the environment channel these suites used
 * to aim is retired.
 *
 * Every bun suite that drives a real client as a subprocess declares its board
 * through here, so the fleet's target is spelled one way in the TypeScript
 * half exactly as it is in the python half (`declare_and_require_board` in
 * `tests/client/test_client_fleet_envelope_census.py`).
 *
 * THE INTERLOCK IS A SAFETY DEVICE, NOT CEREMONY. A suite that simply stopped
 * exporting does not fail: it silently stops steering, and the drive falls
 * through the resolution chain to whatever the install dir declares — which,
 * for a client run out of this checkout, is the operator's OWN development
 * board. The verbs these suites drive include writes, so the failure mode is
 * not a red test but somebody else's board carrying this suite's rows. So the
 * declaration is READ BACK through the real shared resolver, in the same
 * process the client will load it with, before the spawn.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const AXI_MODULE = join(REPO_ROOT, "clients", "_crucible_axi.py");
const CONFIG_NAME = "crucible.toml";

/** The board a drive lands on when nothing declares one — named so a refusal
 *  can say what it avoided rather than only that it refused. */
export const SHIPPED_DEFAULT_BOARD = "http://localhost:3849";

/** Ask the fleet's OWN resolver what a client started in `dir` would resolve.
 *  In process, over no socket — the python interlock's exact question. */
const RESOLVER_PROBE = [
  "import importlib.util, sys",
  "spec = importlib.util.spec_from_file_location('axi', sys.argv[1])",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "module.bind_project_dir(sys.argv[2])",
  "print(module.resolve_base_url())",
].join("\n");

/** (dir, url) pairs already proven in this process. A suite that drives the
 *  same project dir twenty times pays for the probe once. */
const proven = new Set<string>();

function requireResolves(dir: string, url: string): void {
  const key = `${dir}\u0000${url}`;
  if (proven.has(key)) return;
  const probe = Bun.spawnSync({
    cmd: ["python3", "-c", RESOLVER_PROBE, AXI_MODULE, dir],
    stdout: "pipe",
    stderr: "pipe",
  });
  const resolved = new TextDecoder().decode(probe.stdout).trim();
  if (resolved !== url) {
    const why = probe.exitCode === 0
      ? `it answers ${resolved || "(nothing)"}`
      : `the resolver failed: ${new TextDecoder().decode(probe.stderr).trim()}`;
    throw new Error(
      `refusing to drive a client in ${dir}: the board declared there is ` +
        `${url} but ${why}. A drive that does not resolve its own declared ` +
        `board reaches another one — the shipped default is ` +
        `${SHIPPED_DEFAULT_BOARD}, and these verbs include writes.`,
    );
  }
  proven.add(key);
}

/**
 * Declare `url` as the `[client]` board for every directory a drive might
 * resolve as its project root (its cwd, and any explicit project dir it is
 * given), and refuse unless the shared module really resolves it.
 */
export function declareClientBoard(url: string, ...dirs: Array<string | undefined>): void {
  for (const dir of dirs.filter((d): d is string => Boolean(d))) {
    if (resolve(dir) === REPO_ROOT) {
      throw new Error(
        `refusing to declare a board at ${REPO_ROOT}: that file is the ` +
          `OPERATOR's own connection, and a suite that wrote it would both ` +
          `destroy their setting and make every later drive in this checkout ` +
          `resolve a fixture's board. Drive from a temp project dir instead.`,
      );
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, CONFIG_NAME), `[client]\nurl = "${url}"\n`);
    requireResolves(dir, url);
  }
}

/** (dir -> answer) for the READ side, so a suite that asks twenty times pays
 *  for one python start. */
const declared = new Map<string, DeclaredBoard>();

export type DeclaredBoard = { url: string } | { skip: string };

/**
 * The board THIS checkout declares, asked of the fleet's OWN resolver — the
 * same question, through the same module, that a client started here would
 * ask — or the reason there is none to read.
 *
 * For suites that READ a live board rather than drive a client at one. The
 * hazard is the declaring one in reverse: with nothing declared the chain does
 * not fail, it ENDS at `SHIPPED_DEFAULT_BOARD`, which on a machine carrying a
 * production install is the production board. A census aimed there either
 * asserts a board fact against the wrong board or finds nothing and passes
 * VACUOUSLY, having quietly stopped measuring anything. So an undeclared board
 * is a STATED skip and never a request — the shipped default is named in the
 * refusal, not fetched.
 *
 * THE TRADE, STATED: "nothing is declared" is decided by comparing the
 * resolver's answer against `SHIPPED_DEFAULT_BOARD`, not by asking whether
 * anything is listening there. So an operator on a single-instance install at
 * the default port, who has legitimately and deliberately declared
 * `http://localhost:3849` as their board, is treated here as having declared
 * nothing, and loses the four live-board censuses that call this: they SKIP,
 * with the reason printed, rather than running against the board they meant.
 * That is the deliberate side to fail on. The alternative — distinguishing the
 * two cases by connectivity — means fetching the reserved port to find out,
 * which is the exact accident §S2 exists to make impossible, and it would fail
 * OPEN on the machine that carries a production install (where something is
 * always listening there). A census that announces why it did not run costs a
 * measurement; one that quietly reads production costs the board.
 */
export function declaredClientBoard(dir: string = REPO_ROOT): DeclaredBoard {
  const key = resolve(dir);
  const already = declared.get(key);
  if (already !== undefined) return already;
  const probe = Bun.spawnSync({
    cmd: ["python3", "-c", RESOLVER_PROBE, AXI_MODULE, key],
    stdout: "pipe",
    stderr: "pipe",
  });
  const answer = new TextDecoder().decode(probe.stdout).trim();
  let result: DeclaredBoard;
  if (probe.exitCode !== 0 || answer === "") {
    const said = new TextDecoder().decode(probe.stderr).trim() || "it printed nothing";
    result = { skip: `the fleet's resolver could not say which board ${key} declares (${said})` };
  } else if (answer === SHIPPED_DEFAULT_BOARD) {
    result = {
      skip:
        `${key} declares no \`[client] url\`, so the resolution chain ends at the ` +
        `shipped default (${SHIPPED_DEFAULT_BOARD}) — which on a machine carrying a ` +
        `production install IS the production board. Nothing is read: a census against ` +
        `the wrong board is worse than one that was not taken.`,
    };
  } else {
    result = { url: answer };
  }
  declared.set(key, result);
  return result;
}

/** The project dir an argv names, so a drive whose cwd and `--project-dir`
 *  differ declares the board in the one the client will actually resolve. */
export function projectDirFromArgs(args: string[]): string | undefined {
  const index = args.indexOf("--project-dir");
  return index >= 0 ? args[index + 1] : undefined;
}
