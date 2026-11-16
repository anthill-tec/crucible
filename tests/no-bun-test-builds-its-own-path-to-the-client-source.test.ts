// No bun test builds its own path to the checkout's client source (AC2, the
// TypeScript half).
//
// The bun suite reaches its clients through ONE place, the test install helper
// `tests/helpers/test-install.ts`: the test install's client paths
// (`clientScript`, `TEST_INSTALL_CLIENTS`) to LOAD or SPAWN a client, and the
// checkout's client source constant (`CLIENT_SOURCE_DIR`) to READ client
// source or COPY it into a test's own install. A module that builds its own
// path to the checkout's `clients/` spawns a client whose install is the repo
// root, which reads the operator's root `crucible.toml`.
//
// "Builds a path", for TypeScript, means one of:
//
//   - a `clients` path segment joined to a base derived from the repo:
//     `import.meta.dir`, `import.meta.dirname`, `import.meta.url`,
//     `import.meta.path`, `__dirname`, `__filename`, `process.cwd()` (the
//     suite's working directory is the repo root), `REPO_ROOT` and its aliases
//     (any name the module binds to such a value, or a conventional repo-root
//     name), and `resolve(…, "..")` / `dirname(…)` chains over them. The joins
//     looked at: `join`/`resolve` (bare or `path.`), a template literal
//     `${base}/clients…`, a concatenation `base + "/clients…"`, and
//     `new URL("…/clients/…", import.meta.url)`. The segment may come through
//     a name: a constant bound to a relative `clients/…` value, or a loop
//     variable over a list holding one;
//   - a relative `clients/…` (or a name bound to one) used as a spawn argument
//     (Bun's own spawn and its sync twin, `spawn`, `execFile`, …, or a module function
//     that spawns), a file read (`readFileSync`, `Bun.file`, `readdirSync`,
//     `existsSync`, `listFiles`, …, or a module function that reads), or an
//     import path (a static or dynamic `import`, `require`) — including a
//     module-relative `../clients/…` import.
//
// Exempt: comments; assertion and message text (a test or describe title,
// an `Error`, a `console` line, `expect`'s message argument, a `toThrow`
// argument); paths under a temp base (a base not derived from the repo is
// never a repo path); the wheel's package data (`crucible_axi/clients`); and
// source reads through the helper's `CLIENT_SOURCE_DIR`, which name no
// `clients` segment of their own. The helper itself is the one module
// allowed to build the path. The Playwright e2e suite (`tests/e2e/`) is out
// of scope (the CR's non-goals).
//
// THE JS REPORTERS. `clients/reporters/*.ts` run from the checkout today
// (RED 961b left them for this cycle). They are LOADS: a test hands their
// path to Playwright or Vitest, which imports and runs them, exactly as it
// spawns a python client. They derive no install and read no `crucible.toml`,
// but AC2 makes no exception for them, and one rule is a guard with no hole:
// they are reached through the test install's `clients/` (the symlink makes
// that free), and their source is read through `CLIENT_SOURCE_DIR`.
//
// Each spelling is proved on a planted module, both ways, before the scan is
// run over the tree.
//
// Tier: unit. It reads source files.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { balancedEnd, jsInertSpans, jsLiveCode, jsUncommented, listFiles, unnestedEnd } from "./helpers/source-scan.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** The one module allowed to build the path. */
const HELPER_MODULE = "tests/helpers/test-install.ts";

const CONVENTIONAL_REPO_NAMES = [
  "REPO_ROOT",
  "REPO",
  "ROOT",
  "REPO_DIR",
  "PROJECT_ROOT",
  "CHECKOUT",
  "CHECKOUT_ROOT",
  "REPOSITORY_ROOT",
].flatMap((name) => [name, `_${name}`]);

const REPO_BASE_TOKENS =
  "import\\.meta\\.(?:dirname|dir|url|path)\\b|__dirname\\b|__filename\\b|process\\.cwd\\(\\)";

/** The spawning and reading calls, spelled so this file carries no tier
 *  marker of its own (`scripts/test-targets.ts` classifies by raw text). */
const SYNC = "Sync";
const SPAWN_SEGMENTS = new Set(["spawn", `spawn${SYNC}`, "execFile", `execFile${SYNC}`, `exec${SYNC}`]);
const SPAWN_CALLEES = new Set(["exec", ["Bun", "spawn"].join("."), ["Bun", `spawn${SYNC}`].join(".")]);
const SPAWN_IN_BODY = new RegExp(`\\b(?:Bun\\.spawn(?:${SYNC})?|spawn(?:${SYNC})?|execFile(?:${SYNC})?|exec${SYNC})\\s*\\(`);
const READ_SEGMENTS = new Set([
  "readFileSync",
  "readFile",
  "readdirSync",
  "readdir",
  "existsSync",
  "statSync",
  "lstatSync",
  "openSync",
  "createReadStream",
  "copyFileSync",
  "cpSync",
  "realpathSync",
]);
const READ_CALLEES = new Set(["Bun.file", "listFiles"]);
const READ_IN_BODY =
  /\b(?:readFileSync|readFile|readdirSync|readdir|existsSync|statSync|lstatSync|openSync|createReadStream|listFiles|Bun\.file)\s*\(/;
const JOIN_SEGMENTS = new Set(["join", "resolve"]);
const PATH_MODULES = new Set(["", "path", "posix", "path.posix", "nodePath", "pathModule", "nodepath"]);
const MESSAGE_CALLS = new Set(["Error", "TypeError", "RangeError", "fail", "toThrow", "console.log", "console.error", "console.warn", "console.info", "console.debug"]);
const TITLE_CALLS = new Set(["describe", "test", "it"]);

interface Hit {
  line: number;
  spelling: string;
}

interface Call {
  callee: string;
  open: number;
  close: number;
  args: Array<[number, number]>;
}

interface Scoped {
  name: string;
  start: number;
  end: number;
}

function components(value: string): string[] {
  return value.split("/").filter((c) => c !== "" && c !== ".");
}

/** The `clients` segment, reached only through `..` steps (so
 *  `crucible_axi/clients` and `fixtures/clients` are not the checkout's). */
function clientsAfterDots(parts: string[]): boolean {
  const at = parts.indexOf("clients");
  return at >= 0 && parts.slice(0, at).every((c) => c === "..");
}

/** A relative value whose first segment is `clients`. */
function relativeClients(value: string): boolean {
  return !value.startsWith("/") && components(value)[0] === "clients";
}

/** The static text of a lone literal argument (a template up to its first
 *  substitution), or null when the argument is not a literal. */
function literalValue(arg: string): string | null {
  const quoted = /^(["'])((?:\\.|(?!\1)[^\\])*)\1$/.exec(arg);
  if (quoted) return quoted[2] ?? "";
  const template = /^`([^`$]*)/.exec(arg);
  return template ? (template[1] ?? "") : null;
}

class ClientsPathScanner {
  private readonly code: string;
  private readonly live: string;
  private readonly strings: Array<{ start: number; end: number; value: string; opener: string }>;
  private readonly calls: Call[] = [];
  private readonly repoNames = new Set(CONVENTIONAL_REPO_NAMES);
  private readonly relNames = new Set<string>();
  private readonly scoped: Scoped[] = [];
  private readonly readers = new Set<string>();
  private readonly spawners = new Set<string>();
  private readonly hits: Hit[] = [];

  constructor(
    private readonly text: string,
    private readonly relPath: string,
  ) {
    this.code = jsUncommented(text);
    this.live = jsLiveCode(text);
    this.strings = jsInertSpans(text)
      .filter((span) => span.kind === "string")
      .map((span) => {
        const raw = text.slice(span.start, span.end);
        const opener = raw[0] ?? "";
        const value = raw
          .replace(/^[`"'}]/, "")
          .replace(/(?:\$\{|[`"'])$/, "");
        return { start: span.start, end: span.end, value, opener };
      });
    this.collectCalls();
    this.collectFunctions();
    this.collectBindings();
    this.collectLoopScopes();
  }

  private lineOf(index: number): number {
    return this.text.slice(0, index).split("\n").length;
  }

  private collectCalls(): void {
    for (const match of this.live.matchAll(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g)) {
      const open = match.index + match[0].length - 1;
      let before = match.index - 1;
      while (before >= 0 && /\s/.test(this.live[before] ?? "")) before--;
      const callee = (match[1] ?? "").replace(/\s+/g, "");
      // `[...].join("/")` and `x.y().join()` are methods, not path joins.
      const method = before >= 0 && /[.)\]]/.test(this.live[before] ?? "") && !callee.includes(".");
      const close = balancedEnd(this.live, open);
      const end = this.live[close - 1] === ")" ? close - 1 : close;
      const args: Array<[number, number]> = [];
      let depth = 0;
      let start = open + 1;
      for (let i = open + 1; i < end; i++) {
        const c = this.live[i] ?? "";
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) depth--;
        else if (c === "," && depth === 0) {
          args.push([start, i]);
          start = i + 1;
        }
      }
      if (this.code.slice(start, end).trim() !== "") args.push([start, end]);
      this.calls.push({ callee: method ? `.${callee}` : callee, open, close: end, args });
    }
  }

  private arg(range: [number, number]): string {
    return this.code.slice(range[0], range[1]).trim();
  }

  private collectFunctions(): void {
    const record = (name: string, body: string): void => {
      if (READ_IN_BODY.test(body)) this.readers.add(name);
      if (SPAWN_IN_BODY.test(body)) this.spawners.add(name);
    };
    for (const match of this.code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g)) {
      if (this.live[match.index] !== "f") continue;
      const paramsEnd = balancedEnd(this.live, match.index + match[0].length - 1);
      const brace = this.bodyBrace(paramsEnd);
      if (brace < 0) continue;
      record(match[1] ?? "", this.code.slice(brace, balancedEnd(this.live, brace)));
    }
    const arrow = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+?)?=>/g;
    for (const match of this.code.matchAll(arrow)) {
      if (this.live[match.index] !== "c" && this.live[match.index] !== "l") continue;
      const from = match.index + match[0].length;
      const end = unnestedEnd(this.live, from, ";");
      record(match[1] ?? "", this.code.slice(from, end));
    }
  }

  /** The `{` that opens a function body after its parameter list, past any
   *  object type in its return annotation (`): { a: string } {`). */
  private bodyBrace(from: number): number {
    let at = from;
    for (;;) {
      const brace = this.live.indexOf("{", at);
      if (brace < 0) return -1;
      let prev = brace - 1;
      while (prev >= 0 && /\s/.test(this.live[prev] ?? "")) prev--;
      if (!":<|&,".includes(this.live[prev] ?? "")) return brace;
      at = balancedEnd(this.live, brace);
    }
  }

  private isRepoBase(expr: string): boolean {
    if (new RegExp(REPO_BASE_TOKENS).test(expr)) return true;
    for (const token of expr.match(/[A-Za-z_$][\w$]*/g) ?? []) if (this.repoNames.has(token)) return true;
    return false;
  }

  private stringsIn(start: number, end: number): Array<{ start: number; value: string }> {
    return this.strings.filter((s) => s.start >= start && s.end <= end);
  }

  /** Is `init` (a binding's initializer) a relative `clients/…` value: a
   *  literal, a list holding one, or a join that starts with one? */
  private initIsRelative(init: string, start: number, end: number): boolean {
    const trimmed = init.trim();
    if (/^["'`]/.test(trimmed)) return relativeClients(literalValue(trimmed.replace(/\s+as\s+const$/, "")) ?? "");
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      if (this.stringsIn(start, end).some((s) => relativeClients(s.value))) return true;
      for (const spread of trimmed.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) {
        if (this.relNames.has(spread[1] ?? "")) return true;
      }
      return false;
    }
    const join = /^(?:path\.)?(?:join|resolve)\(\s*(["'`])([^"'`]*)\1/.exec(trimmed);
    return join !== null && relativeClients(join[2] ?? "");
  }

  private collectBindings(): void {
    const bindings: Array<{ name: string; init: string; start: number; end: number }> = [];
    const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=(?!=|>)\s*/g;
    for (const match of this.code.matchAll(pattern)) {
      if (!/[clv]/.test(this.live[match.index] ?? "")) continue;
      const start = match.index + match[0].length;
      const end = unnestedEnd(this.live, start, ";");
      const init = this.code.slice(start, end);
      if (/^\s*(?:async\b|function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/.test(init)) continue;
      bindings.push({ name: match[1] ?? "", init, start, end });
    }
    for (let pass = 0; pass < 3; pass++) {
      for (const b of bindings) {
        const hasClients = this.stringsIn(b.start, b.end).some((s) => components(s.value).includes("clients"));
        if (!hasClients && this.isRepoBase(b.init)) this.repoNames.add(b.name);
        else if (!this.isRepoBase(b.init) && this.initIsRelative(b.init, b.start, b.end)) this.relNames.add(b.name);
      }
    }
  }

  private iterableIsRelative(expr: string, start: number, end: number): boolean {
    const trimmed = expr.trim().replace(/^Object\.(?:entries|values|keys)\(\s*([A-Za-z_$][\w$]*)\s*\)$/, "$1");
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return this.relNames.has(trimmed);
    return trimmed.startsWith("[") && this.initIsRelative(trimmed, start, end);
  }

  private collectLoopScopes(): void {
    const forOf = /\bfor\s*\(\s*(?:const|let|var)\s+(\[[^\]]*\]|\{[^}]*\}|[A-Za-z_$][\w$]*)\s+of\s+/g;
    for (const match of this.code.matchAll(forOf)) {
      const head = balancedEnd(this.live, this.live.indexOf("(", match.index));
      const iterStart = match.index + match[0].length;
      if (!this.iterableIsRelative(this.code.slice(iterStart, head - 1), iterStart, head - 1)) continue;
      let bodyStart = head;
      while (/\s/.test(this.live[bodyStart] ?? "")) bodyStart++;
      const end = this.live[bodyStart] === "{" ? balancedEnd(this.live, bodyStart) : unnestedEnd(this.live, bodyStart, ";");
      for (const name of (match[1] ?? "").match(/[A-Za-z_$][\w$]*/g) ?? []) this.scoped.push({ name, start: head, end });
    }
    const callback =
      /([A-Za-z_$][\w$]*|\[[^\]]*\])\s*\.\s*(?:map|flatMap|forEach|filter|some|every|find)\s*\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/g;
    for (const match of this.code.matchAll(callback)) {
      const receiver = match[1] ?? "";
      if (!this.iterableIsRelative(receiver, match.index, match.index + receiver.length)) continue;
      const open = this.live.indexOf("(", match.index + receiver.length);
      this.scoped.push({ name: match[2] ?? "", start: open, end: balancedEnd(this.live, open) });
    }
  }

  private isRelativeName(name: string, at: number): boolean {
    return this.relNames.has(name) || this.scoped.some((s) => s.name === name && s.start <= at && at < s.end);
  }

  /** A name bound to a relative `clients/…` value, or a property read off
   *  one (`site.file` over a list of sites). */
  private isRelativeExpr(arg: string, at: number): boolean {
    const root = /^([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/.exec(arg);
    return root !== null && this.isRelativeName(root[1] ?? "", at);
  }

  /** Is the position inside assertion or message text? */
  private inMessage(at: number): boolean {
    for (const call of this.calls) {
      if (!(call.open < at && at < call.close)) continue;
      const index = call.args.findIndex(([s, e]) => s <= at && at <= e);
      const segment = call.callee.replace(/^\./, "");
      const last = segment.split(".").pop() ?? "";
      const first = segment.split(".")[0] ?? "";
      if (MESSAGE_CALLS.has(segment) || MESSAGE_CALLS.has(last)) return true;
      if (TITLE_CALLS.has(first) && !segment.startsWith(".") && index === 0) return true;
      if (segment === "expect" && index >= 1) return true;
    }
    return false;
  }

  private flag(at: number, spelling: string): void {
    if (this.inMessage(at)) return;
    const line = this.lineOf(at);
    if (this.hits.some((h) => h.line === line)) return;
    this.hits.push({ line, spelling });
  }

  private scanJoins(): void {
    for (const call of this.calls) {
      const segments = call.callee.split(".");
      const last = segments.pop() ?? "";
      if (call.callee.startsWith(".") || !JOIN_SEGMENTS.has(last) || !PATH_MODULES.has(segments.join("."))) continue;
      const [base, ...rest] = call.args;
      if (base === undefined || !this.isRepoBase(this.arg(base))) continue;
      const parts: string[] = [];
      for (const range of rest) {
        const arg = this.arg(range);
        const value = literalValue(arg);
        if (value !== null) parts.push(...components(value));
        else if (this.isRelativeExpr(arg, range[0])) parts.push("clients");
        else parts.push("?");
        if (clientsAfterDots(parts)) {
          const through = value === null ? ` through ${arg}` : "";
          this.flag(range[0], `${call.callee}(<repo base>, …clients…)${through}`);
          break;
        }
      }
    }
  }

  private scanUrls(): void {
    for (const call of this.calls) {
      if (call.callee !== "URL" || call.args.length < 2) continue;
      const [first, second] = call.args as [[number, number], [number, number]];
      const value = literalValue(this.arg(first));
      if (value !== null && clientsAfterDots(components(value)) && /import\.meta\.url/.test(this.arg(second))) {
        this.flag(first[0], 'new URL("…clients…", import.meta.url)');
      }
    }
  }

  private scanTemplatesAndConcatenations(): void {
    for (const s of this.strings) {
      if (!/^\/(?:\.\.\/)*clients(?:\/|$)/.test(s.value)) continue;
      if (this.text[s.start] === "}") {
        const hole = this.code.lastIndexOf("${", s.start);
        if (hole >= 0 && this.isRepoBase(this.code.slice(hole + 2, s.start))) {
          this.flag(s.start, "`${<repo base>}/clients…`");
        }
        continue;
      }
      const before = /([A-Za-z_$][\w$.]*(?:\(\))?)\s*\+\s*$/.exec(this.live.slice(Math.max(0, s.start - 120), s.start));
      if (before && this.isRepoBase(before[1] ?? "")) this.flag(s.start, '<repo base> + "/clients…"');
    }
  }

  private scanImports(): void {
    const resolveSpec = (spec: string): boolean => {
      if (spec.startsWith(".")) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(this.relPath), spec));
        return components(resolved)[0] === "clients";
      }
      return relativeClients(spec);
    };
    const statics = /\b(?:import|export)\s+(?:[^;'"`]*?\s+from\s+)?(["'])([^"']+)\1/g;
    for (const match of this.code.matchAll(statics)) {
      if (!/[ie]/.test(this.live[match.index] ?? "")) continue;
      if (resolveSpec(match[2] ?? "")) this.flag(match.index, `import from "${match[2] ?? ""}"`);
    }
    for (const call of this.calls) {
      if (call.callee !== "import" && call.callee !== "require") continue;
      const first = call.args[0];
      const value = first === undefined ? null : literalValue(this.arg(first));
      if (first !== undefined && value !== null && resolveSpec(value)) this.flag(first[0], `${call.callee}("${value}")`);
    }
  }

  private scanRelativeUses(): void {
    for (const call of this.calls) {
      if (call.callee.startsWith(".")) continue;
      const last = call.callee.split(".").pop() ?? "";
      const reads =
        READ_SEGMENTS.has(last) || READ_CALLEES.has(call.callee) || (!call.callee.includes(".") && this.readers.has(call.callee));
      const spawns =
        SPAWN_SEGMENTS.has(last) || SPAWN_CALLEES.has(call.callee) || (!call.callee.includes(".") && this.spawners.has(call.callee));
      if (reads) {
        const first = call.args[0];
        if (first !== undefined) {
          const arg = this.arg(first);
          const value = literalValue(arg);
          if ((value !== null && relativeClients(value)) || this.isRelativeExpr(arg, first[0])) {
            this.flag(first[0], `relative clients/… read by ${call.callee}`);
          }
        }
      }
      if (spawns) {
        for (const s of this.stringsIn(call.open, call.close)) {
          if (relativeClients(s.value)) this.flag(s.start, `relative clients/… spawn argument of ${call.callee}`);
        }
        const args = this.live.slice(call.open + 1, call.close);
        for (const token of args.matchAll(/[A-Za-z_$][\w$]*/g)) {
          const at = call.open + 1 + token.index;
          const prior = this.live.slice(Math.max(0, at - 3), at);
          const propertyAccess = prior.endsWith(".") && !prior.endsWith("...");
          if (!propertyAccess && this.isRelativeName(token[0], at) && !/^\s*:/.test(this.live.slice(at + token[0].length))) {
            this.flag(at, `relative clients/… spawn argument ${token[0]} of ${call.callee}`);
          }
        }
      }
    }
  }

  offenders(): Hit[] {
    if (this.relPath === HELPER_MODULE) return [];
    this.scanJoins();
    this.scanUrls();
    this.scanTemplatesAndConcatenations();
    this.scanImports();
    this.scanRelativeUses();
    return [...this.hits].sort((a, b) => a.line - b.line);
  }
}

function clientsPathOffenders(text: string, relPath = "tests/planted.test.ts"): Hit[] {
  return new ClientsPathScanner(text, relPath).offenders();
}

/** Every `.ts` under `tests/` but the e2e suite, repo-relative and sorted. */
function scannedModules(): string[] {
  return listFiles("tests", [".ts"])
    .map((file) => path.relative(REPO_ROOT, file))
    .filter((relPath) => !relPath.startsWith("tests/e2e/"))
    .sort();
}

/** A planted module from its lines; `@SPAWN_SYNC` spells the sync spawn so
 *  this file never carries the tier marker itself. */
function planted(lines: string[]): string {
  return lines.join("\n").replaceAll("@SPAWN_SYNC", ["Bun", `spawn${SYNC}`].join("."));
}

const PLANTED_BUILDS: Record<string, string[]> = {
  "join on import.meta.dir and ..": ['const SCRIPT = join(import.meta.dir, "..", "clients", "bun-crucible.py");'],
  "path.join on REPO_ROOT": ['const SCRIPT = path.join(REPO_ROOT, "clients", "bun-crucible.py");'],
  "join on REPO_ROOT inside a spawn argv": [
    'const proc = @SPAWN_SYNC({ cmd: ["python3", join(REPO_ROOT, "clients", client), ...args] });',
  ],
  "resolve on import.meta.dir with a ../clients piece": ['const SCRIPT = resolve(import.meta.dir, "../clients/toon.py");'],
  "join on __dirname": ['const DIR = join(__dirname, "..", "clients");'],
  "join on a name bound through a dirname/resolve chain": [
    "const HERE = dirname(new URL(import.meta.url).pathname);",
    'const TOP = resolve(HERE, "..", "..");',
    'const AXI = join(TOP, "clients", "_crucible_axi.py");',
  ],
  "join on process.cwd()": ['const text = readFileSync(join(process.cwd(), "clients", "_crucible_axi.py"), "utf8");'],
  "template literal on REPO_ROOT": ["const SCRIPT = `${REPO_ROOT}/clients/bun-crucible.py`;"],
  "concatenation on REPO_ROOT": ['const SCRIPT = REPO_ROOT + "/clients/bun-crucible.py";'],
  "new URL relative to the module": ['const TOON = new URL("../clients/toon.py", import.meta.url).pathname;'],
  "relative path as a spawn argument": ['const proc = spawn("python3", ["clients/bun-crucible.py", "--help"], { cwd: REPO_ROOT });'],
  "relative path in a sync spawn argv": ['const proc = @SPAWN_SYNC({ cmd: ["python3", "clients/bun-crucible.py"], cwd: REPO_ROOT });'],
  "relative path read": ['const text = readFileSync("clients/_crucible_axi.py", "utf8");'],
  "relative tree listed": ['const files = listFiles("clients", [".py"]);'],
  "relative constant joined to REPO_ROOT": [
    'const CLIENT_MODULE = "clients/_crucible_axi.py";',
    'const text = readFileSync(join(REPO_ROOT, CLIENT_MODULE), "utf8");',
  ],
  "relative join constant joined to REPO_ROOT": [
    'const CLIENT_REL = join("clients", "bun-crucible.py");',
    "const argv = [join(REPO_ROOT, CLIENT_REL)];",
  ],
  "tree list mapped into a listing": [
    'const TREES = ["src", "clients"];',
    'const files = TREES.flatMap((dir) => listFiles(dir, [".py"]));',
  ],
  "site list looped into a read": [
    'const SITES = ["src/v2.ts", "clients/bun-crucible.py"] as const;',
    "for (const site of SITES) {",
    '  const text = readFileSync(join(process.cwd(), site), "utf8");',
    "}",
  ],
  "spread site list looped into a read": [
    'const SITES = ["src/v2.ts", "clients/bun-crucible.py"] as const;',
    'const searched = [...SITES, "src/store.ts"];',
    "for (const site of searched) {",
    '  const text = readFileSync(join(process.cwd(), site), "utf8");',
    "}",
  ],
  "module function that reads, called with a relative path": [
    'function readSource(rel: string): string { return readFileSync(join(REPO_ROOT, rel), "utf8"); }',
    'const src = readSource("clients/bun-crucible.py");',
  ],
  "property of a looped site list read by a module function": [
    'const SITES = [{ file: "src/limits.ts" }, { file: "clients/_crucible_axi.py" }];',
    'function sourceOf(file: string): string { return readFileSync(file, "utf8"); }',
    "for (const site of SITES) {",
    "  const text = sourceOf(site.file);",
    "}",
  ],
  "value of a destructured entry of a site table read by a module function": [
    'const SITES = { axi: { file: "clients/_crucible_axi.py" } };',
    'function sourceOf(file: string): string { return readFileSync(file, "utf8"); }',
    "for (const [name, site] of Object.entries(SITES)) {",
    "  const text = sourceOf(site.file);",
    "}",
  ],
  "module function with an object return type that spawns, handed a relative tree": [
    'const TREES = ["clients", "src"];',
    "function git(args: string[]): { stdout: string; exitCode: number } {",
    '  const res = execFileSync("git", args, { cwd: REPO_ROOT });',
    "  return { stdout: res.toString(), exitCode: 0 };",
    "}",
    'const diff = git(["diff", "--", ...TREES]);',
  ],
  "module function that spawns, handed a relative tree": [
    'const TREES = ["clients", "src"];',
    'function git(args: string[]): string { return execFileSync("git", args, { cwd: REPO_ROOT }).toString(); }',
    'const diff = git(["diff", "--", ...TREES]);',
  ],
  "symlink of the checkout's clients into a world": ['symlinkSync(join(REPO_ROOT, "clients"), join(world, "clients"));'],
  "static import of a reporter": ['import reporter from "../clients/reporters/playwright-crucible.ts";'],
  "dynamic import of a reporter": ['const reporter = await import("../clients/reporters/vitest-crucible.ts");'],
  "reporters dir handed to a config": ['const REPORTERS_DIR = join(REPO_ROOT, "clients", "reporters");'],
};

const PLANTED_CORRECT_USES: Record<string, string[]> = {
  "a temp install's clients": [
    'const install = mkdtempSync(join(tmpdir(), "install-"));',
    'const copy = join(install, "clients", "bun-crucible.py");',
  ],
  "a temp world's clients listed": ['const clients = join(root, "clients");', "const names = readdirSync(clients);"],
  "a line comment": ['// const SCRIPT = join(REPO_ROOT, "clients", "bun-crucible.py");'],
  "a block comment": ["/* spawns `${REPO_ROOT}/clients/bun-crucible.py` */"],
  "a describe and a test title": [
    'describe("clients/bun-crucible.py — verbs", () => {',
    '  test("clients/bun-crucible.py --help lists every verb", () => {});',
    "});",
  ],
  "an error message": ["throw new Error(`${REPO_ROOT}/clients is the client source, never spawned`);"],
  "an expect message": ["expect(found, `under ${REPO_ROOT}/clients`).toBe(true);"],
  "an assertion value": ['expect(readme).not.toContain("clients/skills");'],
  "a source read through the source constant": ['const text = readFileSync(join(CLIENT_SOURCE_DIR, "_crucible_axi.py"), "utf8");'],
  "a spawn through the test install": ['const proc = spawn("python3", [clientScript("bun-crucible.py"), "--help"]);'],
  "the wheel's package data": ['const DATA = join(REPO_ROOT, "crucible_axi", "clients", "crucible.toml");'],
  "a tree list used only for comparison": [
    'const TREES = ["src", "clients"];',
    "const inScope = TREES.some((tree) => rel.startsWith(`${tree}/`));",
  ],
  "an array joined into a label": ['const label = ["clients", "bun-crucible.py"].join("/");'],
  "a label handed to a function that reads nothing": [
    "function userVisible(rel: string, body: string): string[] { return [rel, body]; }",
    'const leaks = userVisible("clients/probe.py", fixture);',
  ],
  "an intruder list checked under a temp root": [
    'for (const intruder of ["tests", "docs", "clients"]) {',
    "  expect(existsSync(join(root, intruder))).toBe(false);",
    "}",
  ],
  // CR-CRU-260 cycle 963 (GREEN 962's finding 2): the words INSIDE a string
  // literal are text, never identifiers. A temp-dir prefix that happens to
  // spell a repo-root name, or a name this module binds to the repo, does
  // not make the temp dir a repo base.
  "a temp-dir prefix that spells REPO_ROOT, its clients read": [
    'const root = mkdtempSync(join(tmpdir(), "REPO_ROOT-clients-"));',
    'const text = readFileSync(join(root, "clients", "bun-crucible.py"), "utf8");',
  ],
  "a temp-dir prefix that spells a repo-bound name, its clients listed": [
    'const world = resolve(import.meta.dir, "..");',
    'const root = mkdtempSync(join(tmpdir(), "release-live-world-"));',
    'const clients = join(root, "clients");',
    "const names = readdirSync(clients);",
  ],
};

describe("no bun test builds its own path to the client source — the guard, on planted modules", () => {
  for (const [spelling, lines] of Object.entries(PLANTED_BUILDS)) {
    test(`flags a ${spelling}, exactly once`, () => {
      expect(clientsPathOffenders(planted(lines))).toHaveLength(1);
    });
  }

  for (const [use, lines] of Object.entries(PLANTED_CORRECT_USES)) {
    test(`passes ${use}`, () => {
      expect(clientsPathOffenders(planted(lines))).toEqual([]);
    });
  }

  test("the test install helper is the one module allowed to build the path", () => {
    const text = 'export const CLIENT_SOURCE_DIR = join(import.meta.dir, "..", "..", "clients");';
    expect(clientsPathOffenders(text, HELPER_MODULE)).toEqual([]);
    expect(clientsPathOffenders(text, "tests/helpers/other-helper.ts")).toHaveLength(1);
  });

  test("a module-relative import resolves from the importing module's own directory", () => {
    const text = 'import { x } from "../../clients/reporters/vitest-crucible.ts";';
    expect(clientsPathOffenders(text, "tests/helpers/x.ts")).toHaveLength(1);
    expect(clientsPathOffenders(text, "tests/a.test.ts")).toEqual([]);
  });
});

describe("no bun test builds its own path to the client source — the tree", () => {
  test("the scan covers the bun suite and its helpers, and not the e2e suite", () => {
    const scanned = scannedModules();
    expect(scanned).toContain("tests/helpers/client-board.ts");
    expect(scanned).toContain("tests/clients-bun-crucible.test.ts");
    expect(scanned.some((relPath) => relPath.startsWith("tests/e2e/"))).toBe(false);
    expect(scanned.length).toBeGreaterThan(300);
  });

  test("no test module, helper or fixture builds its own path to the checkout's clients/", () => {
    const offenders: string[] = [];
    for (const relPath of scannedModules()) {
      const text = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      for (const hit of clientsPathOffenders(text, relPath)) offenders.push(`${relPath}:${String(hit.line)} ${hit.spelling}`);
    }
    expect(offenders).toEqual([]);
  });
});
