// The installer lands crucible-axi on python 3.14 — on a fresh machine, on an
// upgrade of a tool environment that runs an older python, and on an upgrade of
// one that already runs 3.14.
//
// uv keeps an existing tool environment's interpreter across
// `uv tool install --upgrade`, so an environment on python 3.13 silently stays
// on the newest release 3.13 allows, and a fresh install picks uv's default
// interpreter, which may be older too. Passing `--python 3.14` (after the
// package name) makes uv rebuild the environment on 3.14 and install the 3.14
// release. Before that rebuild happens, the installer says so, naming the old
// python and that the environment is rebuilt on 3.14.
//
// TECHNIQUE — the source-text pins below cover the shape of the two commands
// (in `install.sh` and in the README). The behaviour is driven by running the
// REAL `install.sh` as a subprocess in a throwaway world: a scratch HOME, a
// stub `uv` and a stub `crucible-axi` first on a PATH whose tail is a toolbox
// of ordinary utilities only — the real uv, the real crucible-axi and the real
// `~/.local/share/uv` are unreachable by construction.
//
// The stub `uv` models the real uv 0.11.8 surface an installer can use to
// learn a tool environment's python, measured read-only on a real machine:
//   uv tool list --show-python   -> `crucible-axi v0.3.0 [CPython 3.13.13]`
//   uv tool list --show-paths    -> `crucible-axi v0.3.0 (<tool dir>/crucible-axi)`
//   uv tool dir                  -> the tools directory (`--bin`: the executables dir)
//   <tool dir>/crucible-axi/pyvenv.cfg carries `version_info = 3.13.13`
//   <tool dir>/crucible-axi/bin/python --version -> `Python 3.13.13`
// and the interpreter rule this change turns on:
//   uv tool install --upgrade crucible-axi              keeps the env's python;
//     on 3.13 the newest release allowed is the stranded one
//   uv tool install [--upgrade] crucible-axi --python 3.14
//     rebuilds an env on another python, then installs the 3.14 release
//   a fresh `uv tool install crucible-axi` uses uv's default python (3.13 here)
// A decoy tool on python 3.13 is always listed, so reading the python of the
// whole `uv tool list` output instead of crucible-axi's own line is caught.
// Every `uv tool install` call also prints a marker line to stdout, so the
// order of the installer's own narration and the install call is observable.
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
const README = join(REPO_ROOT, "README.md");

/** The release an interpreter older than 3.14 is stranded on. */
const STRANDED_RELEASE = "0.3.0";
/** The newest release — it requires python 3.14. */
const LATEST_RELEASE = "0.4.0";
/** The python an old tool environment runs, and uv's default interpreter here. */
const OLD_PYTHON = "3.13.13";
/** The python a 3.14 environment runs once built. */
const NEW_PYTHON = "3.14.8";

const FRESH_COMMAND = "uv tool install crucible-axi --python 3.14";
const UPGRADE_COMMAND = "uv tool install --upgrade crucible-axi --python 3.14";

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

function whichIn(name: string, dirs: string[]): string | null {
  for (const d of dirs) {
    const candidate = join(d, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

const REAL_PATH_DIRS: string[] = (process.env.PATH ?? "").split(":").filter((d) => d.length > 0);

/** Ordinary utilities only; `curl`, `uv`, `python*` and `crucible-axi` are absent. */
const TOOLBOX_UTILITIES = [
  "sh", "bash", "env", "cat", "cp", "mv", "rm", "ln", "ls", "mkdir", "chmod", "touch",
  "printf", "echo", "test", "[", "true", "false", "expr", "seq",
  "grep", "sed", "awk", "gawk", "tr", "cut", "sort", "uniq", "head", "tail", "wc",
  "basename", "dirname", "readlink", "realpath", "mktemp", "tee", "xargs",
  "date", "sleep", "uname", "id", "whoami", "which",
];

const TOOLBOX = mkdtempSync(join(tmpdir(), "pyfloor-toolbox-"));
for (const name of TOOLBOX_UTILITIES) {
  const real = whichIn(name, REAL_PATH_DIRS);
  if (real !== null) symlinkSync(real, join(TOOLBOX, name));
}

afterAll(() => {
  rmSync(TOOLBOX, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Stubs (plain JS strings, so the shell's `${...}` is never interpolated)
// ---------------------------------------------------------------------------

const UV_STUB = [
  "#!/bin/sh",
  'printf \'%s\\n\' "uv $*" >> "$PYFLOOR_LOG"',
  'ver=""',
  'if [ -s "$PYFLOOR_VER" ]; then ver="$(cat "$PYFLOOR_VER")"; fi',
  'py=""',
  'if [ -s "$PYFLOOR_PY" ]; then py="$(cat "$PYFLOOR_PY")"; fi',
  "",
  "full_py() {",
  '  case "$1" in',
  '    3.14|3.14.*) echo "$PYFLOOR_NEW_PYTHON" ;;',
  '    3.13|3.13.*) echo "$PYFLOOR_OLD_PYTHON" ;;',
  '    *) echo "$1" ;;',
  "  esac",
  "}",
  "release_for() {",
  '  case "$1" in',
  '    3.14|3.14.*) echo "$PYFLOOR_LATEST" ;;',
  '    *) echo "$PYFLOOR_STRANDED" ;;',
  "  esac",
  "}",
  "build_env() {",
  '  mkdir -p "$PYFLOOR_TOOL_DIR/crucible-axi/bin"',
  "  printf 'home = /stub/python/cpython-%s/bin\\nimplementation = CPython\\nuv = 0.11.8\\nversion_info = %s\\ninclude-system-site-packages = false\\n' \"$1\" \"$1\" > \"$PYFLOOR_TOOL_DIR/crucible-axi/pyvenv.cfg\"",
  '  cp "$PYFLOOR_PYTHON_SRC" "$PYFLOOR_TOOL_DIR/crucible-axi/bin/python"',
  '  chmod 755 "$PYFLOOR_TOOL_DIR/crucible-axi/bin/python"',
  '  printf \'%s\\n\' "$1" > "$PYFLOOR_PY"',
  '  cp "$PYFLOOR_AXI_SRC" "$PYFLOOR_BIN/crucible-axi"',
  '  chmod 755 "$PYFLOOR_BIN/crucible-axi"',
  "}",
  "",
  'case "${1:-}" in',
  '  --version|-V) echo "uv 0.11.8 (stub)"; exit 0 ;;',
  "esac",
  'if [ "${1:-}" != tool ]; then',
  '  echo "stub uv: unsupported argv: $*" >&2',
  "  exit 64",
  "fi",
  'verb="${2:-}"',
  "shift 2 2>/dev/null || shift $#",
  "",
  'case "$verb" in',
  "  list)",
  "    show_py=0; show_paths=0",
  '    for a in "$@"; do',
  '      case "$a" in',
  "        --show-python) show_py=1 ;;",
  "        --show-paths) show_paths=1 ;;",
  "      esac",
  "    done",
  '    line="ruff v0.6.0"',
  '    if [ "$show_py" = 1 ]; then line="$line [CPython $PYFLOOR_OLD_PYTHON]"; fi',
  '    if [ "$show_paths" = 1 ]; then line="$line ($PYFLOOR_TOOL_DIR/ruff)"; fi',
  '    echo "$line"',
  '    echo "- ruff"',
  '    if [ -n "$ver" ]; then',
  '      line="crucible-axi v$ver"',
  '      if [ "$show_py" = 1 ]; then line="$line [CPython $py]"; fi',
  '      if [ "$show_paths" = 1 ]; then line="$line ($PYFLOOR_TOOL_DIR/crucible-axi)"; fi',
  '      echo "$line"',
  '      echo "- crucible-axi"',
  "    fi",
  "    ;;",
  "  dir)",
  '    if [ "${1:-}" = --bin ]; then echo "$PYFLOOR_BIN"; else echo "$PYFLOOR_TOOL_DIR"; fi',
  "    ;;",
  "  install)",
  '    echo "[stub uv] tool install $*"',
  '    upgrade=0; want_py=""; pkg=""; expect_py=0',
  '    for a in "$@"; do',
  '      if [ "$expect_py" = 1 ]; then want_py="$a"; expect_py=0; continue; fi',
  '      case "$a" in',
  "        --upgrade|-U|--force|--reinstall) upgrade=1 ;;",
  "        --python|-p) expect_py=1 ;;",
  "        --python=*) want_py=\"$(printf '%s' \"$a\" | sed 's/^--python=//')\" ;;",
  "        -*) ;;",
  '        *) if [ -z "$pkg" ]; then pkg="$a"; fi ;;',
  "      esac",
  "    done",
  '    if [ "$pkg" != crucible-axi ]; then',
  '      echo "stub uv: unexpected package: $pkg" >&2',
  "      exit 2",
  "    fi",
  '    if [ -z "$ver" ]; then',
  '      target="$(full_py "${want_py:-$PYFLOOR_OLD_PYTHON}")"',
  '      build_env "$target"',
  '      release_for "$target" > "$PYFLOOR_VER"',
  '      echo "Installed 1 executable: crucible-axi"',
  '    elif [ -n "$want_py" ] && [ "$(full_py "$want_py")" != "$py" ]; then',
  '      target="$(full_py "$want_py")"',
  '      build_env "$target"',
  '      release_for "$target" > "$PYFLOOR_VER"',
  '      echo "Installed 1 executable: crucible-axi"',
  '    elif [ "$upgrade" = 1 ]; then',
  '      release_for "$py" > "$PYFLOOR_VER"',
  '      echo "Installed 1 executable: crucible-axi"',
  "    else",
  '      echo "Checked 1 package in 0.02ms"',
  "    fi",
  "    ;;",
  "  upgrade)",
  '    if [ -n "$ver" ]; then release_for "$py" > "$PYFLOOR_VER"; fi',
  "    ;;",
  "  *)",
  '    echo "stub uv: unsupported tool verb: $verb" >&2',
  "    exit 64",
  "    ;;",
  "esac",
  "exit 0",
  "",
].join("\n");

/** The tool environment's own interpreter: answers `--version` from the stub state. */
const PYTHON_STUB = [
  "#!/bin/sh",
  'printf \'%s\\n\' "tool-env-python $*" >> "$PYFLOOR_LOG"',
  'case "${1:-}" in',
  '  --version|-V) echo "Python $(cat "$PYFLOOR_PY")" ;;',
  '  *) echo "stub python: unsupported argv: $*" >&2; exit 64 ;;',
  "esac",
  "",
].join("\n");

const AXI_STUB = [
  "#!/bin/sh",
  'printf \'%s\\n\' "crucible-axi $*" >> "$PYFLOOR_LOG"',
  'case "${1:-}" in',
  '  --version|-V|version) echo "crucible-axi $(cat "$PYFLOOR_VER")" ;;',
  '  install) echo "[server] ok"; echo "[fleet] ok"; echo "[manifest] ok" ;;',
  "esac",
  "exit 0",
  "",
].join("\n");

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
  argvLog: string[];
}

interface World {
  bin: string;
  toolDir: string;
  /** The crucible-axi release the stub uv has installed. */
  installedRelease(): string;
  /** The python the crucible-axi tool environment runs. */
  envPython(): string;
  run(args?: string[]): RunResult;
}

/** `env` = the existing crucible-axi tool environment's python, or null for a fresh machine. */
function makeWorld(root: string, env: { python: string; release: string } | null): World {
  const bin = join(root, "bin");
  const home = join(root, "home");
  const toolDir = join(home, ".local", "share", "uv", "tools");
  const verState = join(root, "release.state");
  const pyState = join(root, "python.state");
  const log = join(root, "argv.log");
  const axiSrc = join(root, "crucible-axi.template");
  const pySrc = join(root, "python.template");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(toolDir, "ruff", "bin"), { recursive: true });
  writeFileSync(
    join(toolDir, "ruff", "pyvenv.cfg"),
    `home = /stub/python/cpython-${OLD_PYTHON}/bin\nimplementation = CPython\nuv = 0.11.8\nversion_info = ${OLD_PYTHON}\ninclude-system-site-packages = false\n`,
  );
  writeFileSync(log, "");
  writeFileSync(verState, env ? `${env.release}\n` : "");
  writeFileSync(pyState, env ? `${env.python}\n` : "");
  writeExecutable(axiSrc, AXI_STUB);
  writeExecutable(pySrc, PYTHON_STUB);
  writeExecutable(join(bin, "uv"), UV_STUB);
  if (env) {
    const envDir = join(toolDir, "crucible-axi");
    mkdirSync(join(envDir, "bin"), { recursive: true });
    writeFileSync(
      join(envDir, "pyvenv.cfg"),
      `home = /stub/python/cpython-${env.python}/bin\nimplementation = CPython\nuv = 0.11.8\nversion_info = ${env.python}\ninclude-system-site-packages = false\n`,
    );
    writeExecutable(join(envDir, "bin", "python"), PYTHON_STUB);
    writeExecutable(join(bin, "crucible-axi"), AXI_STUB);
  }

  const pathDirs = [bin, TOOLBOX];
  if (whichIn("uv", pathDirs) !== join(bin, "uv")) {
    throw new Error(`harness unsafe: \`uv\` on the test PATH is not the stub at ${join(bin, "uv")}`);
  }
  for (const name of ["uv", "crucible-axi", "curl"]) {
    const leaked = whichIn(name, [TOOLBOX]);
    if (leaked !== null) throw new Error(`harness unsafe: a real ${name} is reachable at ${leaked}`);
  }

  const readLog = (): string[] =>
    readFileSync(log, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

  return {
    bin,
    toolDir,
    installedRelease: () => readFileSync(verState, "utf8").trim(),
    envPython: () => readFileSync(pyState, "utf8").trim(),
    run(args: string[] = []): RunResult {
      const res = Bun.spawnSync({
        cmd: ["sh", INSTALL_SH, ...args],
        cwd: root,
        // A curated env: the real HOME, XDG dirs, UV_* and CRUCIBLE_* knobs are
        // not inherited, so nothing real is read or written.
        env: {
          PATH: pathDirs.join(":"),
          HOME: home,
          SHELL: "/bin/sh",
          UV_TOOL_DIR: toolDir,
          PYFLOOR_LOG: log,
          PYFLOOR_VER: verState,
          PYFLOOR_PY: pyState,
          PYFLOOR_BIN: bin,
          PYFLOOR_TOOL_DIR: toolDir,
          PYFLOOR_AXI_SRC: axiSrc,
          PYFLOOR_PYTHON_SRC: pySrc,
          PYFLOOR_LATEST: LATEST_RELEASE,
          PYFLOOR_STRANDED: STRANDED_RELEASE,
          PYFLOOR_OLD_PYTHON: OLD_PYTHON,
          PYFLOOR_NEW_PYTHON: NEW_PYTHON,
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
  };
}

function withWorld<T>(env: { python: string; release: string } | null, body: (w: World) => T): T {
  const root = mkdtempSync(join(tmpdir(), "pyfloor-world-"));
  try {
    return body(makeWorld(root, env));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const OLD_ENV = { python: OLD_PYTHON, release: STRANDED_RELEASE };
const CURRENT_PYTHON_ENV = { python: NEW_PYTHON, release: STRANDED_RELEASE };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const installCalls = (log: string[]): string[] => log.filter((l) => /^uv tool install(\s|$)/.test(l));

/**
 * Empty when the `uv tool install` argv names crucible-axi and carries
 * `--python 3.14` after it; otherwise the reason it does not.
 */
function pythonPinDefect(call: string): string {
  const argv = call.split(/\s+/);
  const pkg = argv.indexOf("crucible-axi");
  const py = argv.indexOf("--python");
  if (pkg === -1) return `\`${call}\` does not name crucible-axi`;
  if (py === -1) return `\`${call}\` carries no \`--python 3.14\``;
  if (py < pkg) return `\`${call}\` puts \`--python\` before the package name`;
  if (argv[py + 1] !== "3.14") return `\`${call}\` passes \`--python ${argv[py + 1]}\`, not 3.14`;
  return "";
}

/** The installer's rebuild notice: one line naming the old python, 3.14 and the rebuild. */
const isRebuildNotice = (line: string): boolean =>
  /rebuil(d|t)/i.test(line) && line.includes("3.13") && line.includes("3.14") && !line.startsWith("[stub uv]");

const mentionsRebuild = (line: string): boolean => /rebuil(d|t)/i.test(line) && !line.startsWith("[stub uv]");

// ---------------------------------------------------------------------------
// Harness soundness
// ---------------------------------------------------------------------------

describe("installer python-floor harness", () => {
  test("the world's uv is the stub and its tool directory lives inside the scratch HOME", () => {
    expect(existsSync(INSTALL_SH)).toBe(true);
    expect(whichIn("uv", [TOOLBOX])).toBeNull();
    withWorld(OLD_ENV, (w) => {
      expect(whichIn("uv", [w.bin, TOOLBOX])).toBe(join(w.bin, "uv"));
      expect(w.toolDir.startsWith(tmpdir())).toBe(true);
      expect(w.envPython()).toBe(OLD_PYTHON);
      expect(w.installedRelease()).toBe(STRANDED_RELEASE);
    });
  });
});

// ---------------------------------------------------------------------------
// The commands, as written
// ---------------------------------------------------------------------------

describe("install.sh and the README name python 3.14 in their uv tool install commands", () => {
  test("install.sh's fresh and upgrade commands carry `--python 3.14` after the package name", () => {
    const script = readFileSync(INSTALL_SH, "utf8");
    const unpinned = [...script.matchAll(/uv tool install (--upgrade )?crucible-axi(?! --python 3\.14)[^\n]*/g)].map(
      (m) => m[0],
    );
    expect({
      fresh: script.includes(FRESH_COMMAND),
      upgrade: script.includes(UPGRADE_COMMAND),
      unpinned,
      // The flow-shape pins the release-bundle test holds stay satisfiable.
      freshShape: script.includes("uv tool install crucible-axi"),
      upgradeShape: script.includes("uv tool install --upgrade crucible-axi"),
    }).toEqual({ fresh: true, upgrade: true, unpinned: [], freshShape: true, upgradeShape: true });
  });

  test("the README's install and upgrade commands carry `--python 3.14` after the package name", () => {
    const readme = readFileSync(README, "utf8");
    const unpinned = [...readme.matchAll(/uv tool install (--upgrade )?crucible-axi(?! --python 3\.14)[^\n]*/g)].map(
      (m) => m[0],
    );
    expect({
      install: readme.includes(FRESH_COMMAND),
      upgrade: readme.includes(UPGRADE_COMMAND),
      unpinned,
    }).toEqual({ install: true, upgrade: true, unpinned: [] });
  });
});

// ---------------------------------------------------------------------------
// Behaviour — the real install.sh against the stub uv
// ---------------------------------------------------------------------------

describe("a fresh install lands on python 3.14", () => {
  test("a fresh machine installs crucible-axi with `--python 3.14` and lands the 3.14 release, with no rebuild notice", () => {
    withWorld(null, (w) => {
      const res = w.run();
      const calls = installCalls(res.argvLog);
      expect({
        exitCode: res.exitCode,
        installCalls: calls.length,
        defects: calls.map(pythonPinDefect).filter((d) => d !== ""),
        envPython: w.envPython(),
        release: w.installedRelease(),
        rebuildLines: res.stdout.split("\n").filter(mentionsRebuild),
      }).toEqual({
        exitCode: 0,
        installCalls: 1,
        defects: [],
        envPython: NEW_PYTHON,
        release: LATEST_RELEASE,
        rebuildLines: [],
      });
    });
  });
});

describe("an upgrade of a tool environment on python 3.13 is rebuilt on 3.14", () => {
  test("the upgrade call carries `--python 3.14` after the package name and lands the 3.14 release on python 3.14", () => {
    withWorld(OLD_ENV, (w) => {
      const res = w.run();
      const upgrades = installCalls(res.argvLog).filter((l) => /(^|\s)--upgrade(\s|$)/.test(l));
      expect({
        exitCode: res.exitCode,
        upgradeCalls: upgrades.length,
        defects: upgrades.map(pythonPinDefect).filter((d) => d !== ""),
        envPython: w.envPython(),
        release: w.installedRelease(),
        reportsUpgrade: res.stdout.includes(`${STRANDED_RELEASE} -> ${LATEST_RELEASE}`),
      }).toEqual({
        exitCode: 0,
        upgradeCalls: 1,
        defects: [],
        envPython: NEW_PYTHON,
        release: LATEST_RELEASE,
        reportsUpgrade: true,
      });
    });
  });

  test("before the upgrade runs, install.sh says it rebuilds the python 3.13 environment on 3.14", () => {
    withWorld(OLD_ENV, (w) => {
      const res = w.run();
      const lines = res.stdout.split("\n");
      const notices = lines.map((l, i) => [l, i] as const).filter(([l]) => isRebuildNotice(l));
      const upgradeMarker = lines.findIndex((l) => /^\[stub uv\] tool install .*--upgrade/.test(l));
      expect({
        notices: notices.map(([l]) => l).length,
        noticeBeforeUpgrade: notices.length === 1 && upgradeMarker !== -1 && notices[0][1] < upgradeMarker,
        stdout: res.stdout,
      }).toMatchObject({ notices: 1, noticeBeforeUpgrade: true });
    });
  });
});

describe("an upgrade of a tool environment already on python 3.14 is not rebuilt", () => {
  test("the upgrade carries `--python 3.14`, prints no rebuild notice, and lands the 3.14 release", () => {
    withWorld(CURRENT_PYTHON_ENV, (w) => {
      const res = w.run();
      const upgrades = installCalls(res.argvLog).filter((l) => /(^|\s)--upgrade(\s|$)/.test(l));
      expect({
        exitCode: res.exitCode,
        upgradeCalls: upgrades.length,
        defects: upgrades.map(pythonPinDefect).filter((d) => d !== ""),
        rebuildLines: res.stdout.split("\n").filter(mentionsRebuild),
        envPython: w.envPython(),
        release: w.installedRelease(),
      }).toEqual({
        exitCode: 0,
        upgradeCalls: 1,
        defects: [],
        rebuildLines: [],
        envPython: NEW_PYTHON,
        release: LATEST_RELEASE,
      });
    });
  });
});
