// CR-CRU-072 C1 — the installer cannot upgrade: bare `uv tool install`
// no-ops on an existing install (RED).
//
// Spec: docs/changes/CR-CRU-072-installer-upgrades-in-place.md
//   AC1 — the installer detects an existing install and upgrades it
//   AC2 — the no-op is impossible to reintroduce (regression guard)
//   AC3 — the transition is reported, not silent
//   AC6 — idempotent and re-runnable ("already current")
//   Scope — uv's resolver is NOT reimplemented; no version pin in install.sh
//
// TECHNIQUE — behavioural, not source-text.
// `install.sh`'s only existing coverage is tests/cr009-release-bundle.test.ts
// §S1, which asserts the SOURCE TEXT contains "uv tool install crucible-axi"
// (cr009-release-bundle.test.ts:209). A source-text assertion is exactly what
// let this defect ship: the string was present and correct-looking, and the
// behaviour was a silent no-op. So every test here EXECUTES the real
// install.sh as a subprocess and asserts on what it actually CALLED.
//
// The world is a throwaway tmp dir holding a stub `uv` and (when the world
// models a machine that already has Crucible) a stub `crucible-axi`, both
// earliest — and exclusively — on the PATH handed to the script. Each stub
// appends its full argv to a log file, so the installer's DECISION ("did it
// call `uv tool upgrade`, or the bare `uv tool install` that uv no-ops?") is
// directly observable. No network, no real uv, no real HOME.
//
// The stub `uv` is a faithful model of the uv semantics this CR turns on,
// reproduced by the orchestrator in an isolated UV_TOOL_DIR:
//   uv tool install crucible-axi   (already installed) -> NO-OP, version stays
//   uv tool install --upgrade|-U|--force               -> advances
//   uv tool upgrade crucible-axi                       -> advances
// `uv tool install` on a fresh machine materialises the `crucible-axi`
// executable into the stub bin dir, so `command -v crucible-axi` is a genuine
// signal rather than a fixture constant.
//
// RED expectation: the FRESH-machine test and the no-pin test PASS today —
// they are the proof the harness is sound. Every other test FAILS, and each
// failure names the missing upgrade contract.
import { afterAll, describe, expect, test } from "bun:test";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const INSTALL_SH = join(REPO_ROOT, "install.sh");

/** The version a stale machine is seeded at (the CR's reproduction). */
const OLD_VERSION = "0.1.1";
/** The version uv would resolve to — what an upgrade must land on. */
const NEW_VERSION = "0.1.2";

// ---------------------------------------------------------------------------
// PATH sandbox — the real uv must be unreachable
// ---------------------------------------------------------------------------

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return existsSync(path);
  } catch {
    return false;
  }
}

/** Resolve `name` against an explicit list of PATH dirs, like `command -v`. */
function whichIn(name: string, dirs: string[]): string | null {
  for (const d of dirs) {
    const candidate = join(d, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

const REAL_PATH_DIRS: string[] = (process.env.PATH ?? "").split(":").filter((d) => d.length > 0);

/**
 * The ordinary utilities a POSIX-sh installer may legitimately reach for. The
 * TOOLBOX below is built by symlinking exactly these — and nothing else — out
 * of the real PATH, which is how `uv` and `crucible-axi` are made unreachable
 * by CONSTRUCTION rather than by ordering.
 *
 * `curl` is deliberately ABSENT: the only thing install.sh curls is Astral's
 * uv bootstrap, and a stubbed uv is always present, so a run that reaches for
 * the network fails loudly instead of quietly downloading.
 */
const TOOLBOX_UTILITIES = [
  "sh", "bash", "env", "cat", "cp", "mv", "rm", "ln", "ls", "mkdir", "chmod", "touch",
  "printf", "echo", "test", "[", "true", "false", "expr", "seq",
  "grep", "sed", "awk", "gawk", "tr", "cut", "sort", "uniq", "head", "tail", "wc",
  "basename", "dirname", "readlink", "realpath", "mktemp", "tee", "xargs",
  "date", "sleep", "uname", "id", "whoami", "which",
];

/**
 * A synthetic bin dir holding symlinks to TOOLBOX_UTILITIES only. Handed to
 * install.sh as the whole tail of its PATH, so no real `uv` or real
 * `crucible-axi` is reachable no matter where the operator has them installed.
 */
const TOOLBOX = mkdtempSync(join(tmpdir(), "cr072-toolbox-"));
for (const name of TOOLBOX_UTILITIES) {
  const real = whichIn(name, REAL_PATH_DIRS);
  if (real !== null) symlinkSync(real, join(TOOLBOX, name));
}

/** Everything install.sh may see beyond the world's own stub bin dir. */
const SANITISED_PATH_DIRS: string[] = [TOOLBOX];

afterAll(() => {
  rmSync(TOOLBOX, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/**
 * Stub `uv`. Models exactly the uv behaviour CR-CRU-072 hinges on — most
 * importantly that a BARE `uv tool install` over an already-installed tool
 * changes nothing.
 */
const UV_STUB = `#!/bin/sh
printf '%s\\n' "uv $*" >> "$CR072_LOG"

cur=""
if [ -s "$CR072_STATE" ]; then cur="$(cat "$CR072_STATE")"; fi

materialise() {
  cp "$CR072_AXI_SRC" "$CR072_BIN/crucible-axi"
  chmod 755 "$CR072_BIN/crucible-axi"
}

case "\${1:-}" in
  --version|-V) echo "uv 0.9.9 (cr072 stub)"; exit 0 ;;
esac

if [ "\${1:-}" != tool ]; then
  echo "cr072 stub uv: unsupported argv: $*" >&2
  exit 64
fi

verb="\${2:-}"
shift 2 2>/dev/null || shift $#

upgrade_flag=0
for a in "$@"; do
  case "$a" in
    --upgrade|-U|--force|--reinstall|--upgrade-package) upgrade_flag=1 ;;
  esac
done

case "$verb" in
  list)
    # A decoy tool is always present, so "is crucible-axi installed?" cannot be
    # answered by testing whether the output is empty.
    echo "ruff v0.6.0"
    echo "- ruff"
    if [ -n "$cur" ]; then
      echo "crucible-axi v$cur"
      echo "- crucible-axi"
    fi
    ;;
  install)
    if [ -z "$cur" ]; then
      printf '%s\\n' "$CR072_LATEST" > "$CR072_STATE"
      materialise
      echo "Resolved 1 package"
      echo "Installed 1 executable: crucible-axi"
      echo "crucible-axi v$CR072_LATEST"
    elif [ "$upgrade_flag" = 1 ]; then
      if [ "$cur" = "$CR072_LATEST" ]; then
        echo "crucible-axi v$CR072_LATEST"
      else
        printf '%s\\n' "$CR072_LATEST" > "$CR072_STATE"
        materialise
        echo " - crucible-axi==$cur"
        echo " + crucible-axi==$CR072_LATEST"
        echo "Installed 1 executable: crucible-axi"
      fi
    else
      # THE DEFECT, verbatim: uv checks and does nothing.
      echo "Checked 1 package in 0.02ms"
      echo "Installed 1 executable: crucible-axi"
    fi
    ;;
  upgrade)
    if [ -z "$cur" ]; then
      echo "warning: \\\`crucible-axi\\\` is not installed; skipping" >&2
    elif [ "$cur" = "$CR072_LATEST" ]; then
      echo "Nothing to upgrade"
    else
      printf '%s\\n' "$CR072_LATEST" > "$CR072_STATE"
      materialise
      echo " - crucible-axi==$cur"
      echo " + crucible-axi==$CR072_LATEST"
      echo "Installed 1 executable: crucible-axi"
    fi
    ;;
  uninstall)
    : > "$CR072_STATE"
    rm -f "$CR072_BIN/crucible-axi"
    echo "Uninstalled 1 executable: crucible-axi"
    ;;
  *)
    echo "cr072 stub uv: unsupported tool verb: $verb" >&2
    exit 64
    ;;
esac
exit 0
`;

/** Stub `crucible-axi`. Reports the version uv currently has installed. */
const AXI_STUB = `#!/bin/sh
printf '%s\\n' "crucible-axi $*" >> "$CR072_LOG"
ver=""
if [ -s "$CR072_STATE" ]; then ver="$(cat "$CR072_STATE")"; fi
case "\${1:-}" in
  --version|-V|version) echo "crucible-axi $ver" ;;
  install) echo "[bun] ok"; echo "[server] ok"; echo "[manifest] ok" ;;
  uninstall) echo "[uninstall] ok" ;;
esac
exit 0
`;

function writeExecutable(path: string, script: string): void {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

// ---------------------------------------------------------------------------
// World — a throwaway machine
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Every stub invocation, in call order, one `<binary> <argv…>` per line. */
  argvLog: string[];
}

interface World {
  root: string;
  bin: string;
  /** The version currently "installed" according to the stub uv's state. */
  installedVersion(): string;
  /** Every stub invocation recorded so far. */
  argvLog(): string[];
  run(args?: string[]): RunResult;
  dispose(): void;
}

/**
 * Builds a throwaway machine.
 *
 * `seeded` = the crucible-axi version already installed, or `null` for a fresh
 * machine. `latest` = what uv would resolve to.
 */
function makeWorld(opts: { seeded: string | null; latest: string }): World {
  const root = mkdtempSync(join(tmpdir(), "cr072-world-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const state = join(root, "uv-tool-state");
  const log = join(root, "argv.log");
  const axiSrc = join(root, "crucible-axi.template");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(log, "");
  writeFileSync(state, opts.seeded ? `${opts.seeded}\n` : "");
  writeExecutable(axiSrc, AXI_STUB);
  writeExecutable(join(bin, "uv"), UV_STUB);
  if (opts.seeded) writeExecutable(join(bin, "crucible-axi"), AXI_STUB);

  const pathDirs = [bin, ...SANITISED_PATH_DIRS];

  // The harness asserts its OWN safety before it will run anything: the stubs
  // must shadow the real binaries completely, and no real uv may be reachable
  // from the PATH handed to install.sh.
  const resolvedUv = whichIn("uv", pathDirs);
  if (resolvedUv !== join(bin, "uv")) {
    throw new Error(
      `cr072 harness unsafe: \`uv\` on the test PATH resolves to ${resolvedUv} — expected the stub at ${join(bin, "uv")}`,
    );
  }
  const leakedUv = whichIn("uv", SANITISED_PATH_DIRS);
  if (leakedUv !== null) {
    throw new Error(`cr072 harness unsafe: a REAL uv is still reachable at ${leakedUv}`);
  }
  const leakedAxi = whichIn("crucible-axi", SANITISED_PATH_DIRS);
  if (leakedAxi !== null) {
    throw new Error(`cr072 harness unsafe: a REAL crucible-axi is still reachable at ${leakedAxi}`);
  }

  const readLog = (): string[] =>
    readFileSync(log, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

  return {
    root,
    bin,
    installedVersion: () => readFileSync(state, "utf8").trim(),
    argvLog: readLog,
    run(args: string[] = []): RunResult {
      const res = Bun.spawnSync({
        cmd: ["sh", INSTALL_SH, ...args],
        cwd: root,
        // A curated env — the real HOME, XDG dirs and CRUCIBLE_* knobs are
        // deliberately NOT inherited, so nothing can touch ~/.bun, ~/.crucible,
        // ~/.local/share/crucible or ~/.config/systemd/user.
        env: {
          PATH: pathDirs.join(":"),
          HOME: home,
          SHELL: "/bin/sh",
          CR072_LOG: log,
          CR072_STATE: state,
          CR072_LATEST: opts.latest,
          CR072_BIN: bin,
          CR072_AXI_SRC: axiSrc,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: res.exitCode,
        stdout: res.stdout.toString(),
        stderr: res.stderr.toString(),
        argvLog: readLog(),
      };
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Runs `body` against a fresh world and always tears it down. */
function withWorld<T>(opts: { seeded: string | null; latest?: string }, body: (w: World) => T): T {
  const world = makeWorld({ seeded: opts.seeded, latest: opts.latest ?? NEW_VERSION });
  try {
    return body(world);
  } finally {
    world.dispose();
  }
}

// ---------------------------------------------------------------------------
// argv-log predicates
// ---------------------------------------------------------------------------

const UPGRADE_FLAG_RE = /(^|\s)(--upgrade|-U|--force|--reinstall)(\s|$)/;

/** `uv tool upgrade …`, or `uv tool install …` carrying an upgrade flag. */
function isUvUpgradeInvocation(line: string): boolean {
  if (/^uv tool upgrade(\s|$)/.test(line)) return true;
  return /^uv tool install(\s|$)/.test(line) && UPGRADE_FLAG_RE.test(line);
}

/** The shipped defect: `uv tool install crucible-axi` with no upgrade flag. */
function isBareUvInstall(line: string): boolean {
  return /^uv tool install(\s|$)/.test(line) && !UPGRADE_FLAG_RE.test(line);
}

const isUvCall = (line: string): boolean => line.startsWith("uv ");
const isStagedInstall = (line: string): boolean => /^crucible-axi install(\s|$)/.test(line);

// ---------------------------------------------------------------------------
// Harness soundness
// ---------------------------------------------------------------------------

describe("CR-CRU-072 harness", () => {
  test("install.sh exists and the real uv is unreachable from the test PATH", () => {
    expect(existsSync(INSTALL_SH)).toBe(true);
    // The sanitised tail carries no uv at all — the only `uv` the script can
    // ever find is the stub the world places first.
    expect(whichIn("uv", SANITISED_PATH_DIRS)).toBeNull();
    expect(whichIn("crucible-axi", SANITISED_PATH_DIRS)).toBeNull();
    withWorld({ seeded: null }, (w) => {
      expect(whichIn("uv", [w.bin, ...SANITISED_PATH_DIRS])).toBe(join(w.bin, "uv"));
    });
  });
});

// ---------------------------------------------------------------------------
// AC1 — fresh machine (the path that already works; proves the harness sound)
// ---------------------------------------------------------------------------

describe("CR-CRU-072 AC1 — fresh machine", () => {
  test("a fresh machine installs the tool and then runs the staged `crucible-axi install`, in that order", () => {
    withWorld({ seeded: null }, (w) => {
      const res = w.run();

      expect(res.exitCode).toBe(0);

      const installIdx = res.argvLog.findIndex((l) => /^uv tool install(\s|$)/.test(l));
      const stagedIdx = res.argvLog.findIndex(isStagedInstall);

      expect({
        sawUvToolInstall: installIdx !== -1,
        sawStagedInstall: stagedIdx !== -1,
        argvLog: res.argvLog,
      }).toMatchObject({ sawUvToolInstall: true, sawStagedInstall: true });

      // Order matters: the CLI must exist before the staged verb runs.
      expect(installIdx).toBeLessThan(stagedIdx);

      // And the fresh install genuinely landed the latest version.
      expect(w.installedVersion()).toBe(NEW_VERSION);
    });
  });
});

// ---------------------------------------------------------------------------
// AC1 / AC2 — existing install at an OLDER version
// ---------------------------------------------------------------------------

describe("CR-CRU-072 AC1 — existing install is upgraded", () => {
  test("a machine already carrying an older crucible-axi is upgraded via uv's own upgrade mechanism", () => {
    withWorld({ seeded: OLD_VERSION }, (w) => {
      const res = w.run();
      const uvCalls = res.argvLog.filter(isUvCall);

      const verdict = uvCalls.some(isUvUpgradeInvocation)
        ? "install.sh used uv's upgrade mechanism"
        : `install.sh never invoked uv's upgrade mechanism on a machine already carrying crucible-axi ${OLD_VERSION} — CR-CRU-072 AC1 requires \`uv tool upgrade crucible-axi\` (or \`uv tool install\` with --upgrade/-U/--force). uv was called with: ${JSON.stringify(uvCalls)}`;

      expect(verdict).toBe("install.sh used uv's upgrade mechanism");
      expect(res.exitCode).toBe(0);
    });
  });
});

describe("CR-CRU-072 AC2 — the no-op is impossible to reintroduce", () => {
  test("install.sh never runs a BARE `uv tool install crucible-axi` over an existing install (uv no-ops that — the shipped defect)", () => {
    withWorld({ seeded: OLD_VERSION }, (w) => {
      const res = w.run();
      const bare = res.argvLog.filter(isBareUvInstall);

      const verdict =
        bare.length === 0
          ? "no bare `uv tool install` over an existing install"
          : `install.sh ran a BARE \`uv tool install\` over an existing install: ${JSON.stringify(bare)}. uv treats that as a NO-OP ("Checked 1 package in 0.02ms") — the CLI never advances, and \`crucible-axi install\` then re-pins the SERVER to the old release. This is the exact defect CR-CRU-072 fixes (AC2).`;

      expect(verdict).toBe("no bare `uv tool install` over an existing install");
    });
  });

  test("after running against a seeded OLDER version, the installed crucible-axi is the NEWER version", () => {
    withWorld({ seeded: OLD_VERSION }, (w) => {
      w.run();

      const landed = w.installedVersion();
      const verdict =
        landed === NEW_VERSION
          ? `crucible-axi advanced ${OLD_VERSION} -> ${NEW_VERSION}`
          : `crucible-axi is STILL at ${landed} after install.sh ran — seeded ${OLD_VERSION}, uv could resolve ${NEW_VERSION}. The installer's Python half did not advance the CLI (CR-CRU-072 AC2). uv calls: ${JSON.stringify(w.argvLog().filter(isUvCall))}`;

      expect(verdict).toBe(`crucible-axi advanced ${OLD_VERSION} -> ${NEW_VERSION}`);
    });
  });
});

// ---------------------------------------------------------------------------
// AC3 — the transition is reported
// ---------------------------------------------------------------------------

describe("CR-CRU-072 AC3 — the transition is reported, not silent", () => {
  test("upgrading from an older version names BOTH the old and the new version on one line of stdout", () => {
    withWorld({ seeded: OLD_VERSION }, (w) => {
      const res = w.run();

      // A single line carrying BOTH versions can only be the installer's own
      // narration: uv's output names one version per line. This pins the
      // reporting without over-fitting the wording.
      const transitionLine = res.stdout
        .split("\n")
        .find((l) => l.includes(OLD_VERSION) && l.includes(NEW_VERSION));

      const verdict =
        transitionLine !== undefined
          ? "install.sh reported the version transition"
          : `install.sh never reported the ${OLD_VERSION} -> ${NEW_VERSION} transition on any single line of its output — CR-CRU-072 AC3 requires the installer to state which path it took and the version transition. stdout was:\n${res.stdout}`;

      expect(verdict).toBe("install.sh reported the version transition");
    });
  });
});

// ---------------------------------------------------------------------------
// AC6 — already current
// ---------------------------------------------------------------------------

describe("CR-CRU-072 AC6 — already current is idempotent and says so", () => {
  test("a fully-current machine is told `already current` with the version, exits 0, and is not re-provisioned", () => {
    withWorld({ seeded: NEW_VERSION }, (w) => {
      const res = w.run();

      expect(res.exitCode).toBe(0);

      const saysCurrent = /already current/i.test(res.stdout) && res.stdout.includes(NEW_VERSION);
      const currentVerdict = saysCurrent
        ? `install.sh reported already current: ${NEW_VERSION}`
        : `install.sh did not state that the machine is already current at ${NEW_VERSION} — CR-CRU-072 AC6 requires an \`already current\` statement naming the version. stdout was:\n${res.stdout}`;
      expect(currentVerdict).toBe(`install.sh reported already current: ${NEW_VERSION}`);

      // No reinstall and no re-provision: running the one-liner twice must be
      // indistinguishable from running it once.
      const churn = res.argvLog.filter((l) => isBareUvInstall(l) || isStagedInstall(l));
      const churnVerdict =
        churn.length === 0
          ? "no reinstall and no re-provision on a current machine"
          : `install.sh reinstalled/re-provisioned a fully-current machine: ${JSON.stringify(churn)} — CR-CRU-072 AC6 requires convergence with no reinstall and no re-provision.`;
      expect(churnVerdict).toBe("no reinstall and no re-provision on a current machine");
    });
  });

  test("a fully-current machine is NOT told `Crucible bootstrap complete` over work that did not happen", () => {
    withWorld({ seeded: NEW_VERSION }, (w) => {
      const res = w.run();

      const claimed = /bootstrap complete/i.test(res.stdout);
      const verdict = claimed
        ? `install.sh printed a bootstrap-complete line on a machine where nothing was installed, upgraded or provisioned — CR-CRU-072 AC3 forbids announcing completion over an upgrade that did not happen. stdout was:\n${res.stdout}`
        : "no bootstrap-complete claim over a no-op run";

      expect(verdict).toBe("no bootstrap-complete claim over a no-op run");
    });
  });
});

// ---------------------------------------------------------------------------
// AC1 — the staged verb runs on BOTH mutating paths
// ---------------------------------------------------------------------------

describe("CR-CRU-072 AC1 — the staged install runs on both the fresh and the upgrade path", () => {
  test("`crucible-axi install` runs after a fresh install AND after an upgrade", () => {
    const fresh = withWorld({ seeded: null }, (w) => w.run());
    const upgrade = withWorld({ seeded: OLD_VERSION }, (w) => w.run());

    const freshRan = fresh.argvLog.some(isStagedInstall);
    const upgradeRan = upgrade.argvLog.some(isStagedInstall);

    const verdict = [
      freshRan ? null : `fresh path never ran \`crucible-axi install\` (argv: ${JSON.stringify(fresh.argvLog)})`,
      upgradeRan
        ? null
        : `upgrade path never ran \`crucible-axi install\`, so the SERVER half never follows the CLI (CR-CRU-072 AC1/AC4). argv: ${JSON.stringify(upgrade.argvLog)}`,
    ]
      .filter((m): m is string => m !== null)
      .join(" | ");

    expect(verdict).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Scope — uv's resolver is not reimplemented
// ---------------------------------------------------------------------------

describe("CR-CRU-072 scope — version selection stays uv's job", () => {
  test("install.sh never passes a crucible-axi version specifier to uv on any path", () => {
    const runs: Array<[string, RunResult]> = [
      ["fresh", withWorld({ seeded: null }, (w) => w.run())],
      ["stale", withWorld({ seeded: OLD_VERSION }, (w) => w.run())],
      ["current", withWorld({ seeded: NEW_VERSION }, (w) => w.run())],
    ];

    const pinned = runs.flatMap(([world, res]) =>
      res.argvLog
        .filter(isUvCall)
        .filter((l) => /crucible-axi\s*[=<>~!]=/.test(l))
        .map((l) => `${world}: ${l}`),
    );

    const verdict =
      pinned.length === 0
        ? "no version specifier passed to uv"
        : `install.sh pinned crucible-axi to a version: ${JSON.stringify(pinned)} — CR-CRU-072's scope keeps version selection with uv; the one-liner must track the latest release.`;

    expect(verdict).toBe("no version specifier passed to uv");
  });
});
