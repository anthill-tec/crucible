// CR-CRU-131 §S1c — the SHIPPED defaults are PACKAGE DATA, and the shipped
// declaration and the shipped documentation are ONE datum.
//
// ── What C1 and C2 left, measured 2026-09-14 ──────────────────────────────
//
// `SHIPPED` (src/limits.ts:90) is a TypeScript literal and `_SHIPPED_LIMITS`
// (clients/_crucible_axi.py:120) is a Python literal, so the six limit
// declarations exist in FOUR places: those two source tables, `data/crucible
// .toml` and the repo-root `crucible.toml` template. That is a drift farm, and
// it means the last resort is still a NUMBER IN A RESOLVER — which §S1c
// forbids in as many words: "the last resort is a DATA FILE in the
// distribution, not a number in a resolver. This is what makes 'no literal in
// source' achievable rather than aspirational."
//
// The same argument that put `min`/`max` beside the value an operator edits
// applies one layer deeper: the file a reader READS and the table the code
// FALLS BACK TO must be the same bytes, or they can disagree with nothing
// saying so.
//
// ── The three things this file proves ─────────────────────────────────────
//
//   1. NO DECLARATION LITERAL IN SOURCE. Neither `src/` nor `clients/` holds a
//      limit's `description`/`recommended`/`min`/`max`. A scan, derived from
//      the DECLARED limit set so a seventh limit is covered on the day it is
//      added, with a CONTROL that proves the matchers can see a declaration
//      when one is there (C2's retired-name scan keeps the bootstrap trio in
//      the corpus for exactly this reason — a green scan must be the move's
//      doing and not an empty walk).
//   2. THE DEFAULTS TRAVEL. A REAL `npm pack` tarball, extracted and asserted
//      to be a distribution and not this checkout, carries the `crucible.toml`
//      the server's resolver falls back to.
//   3. ONE DATUM. Mutating that file INSIDE THE STAGED DISTRIBUTION moves the
//      fallback. If the shipped table were a second copy in source, the
//      mutation would move one and not the other — which is the whole point.
//      Same proof shape as C1's widen/narrow pair, one layer down.
//
// …plus §S1c's VERSION-SKEW claim asserted rather than asserted-about: a
// distribution whose data file declares a limit this side does not enforce
// still resolves every limit it owns, and still refuses the foreign one.
//
// ── HOW EACH TEST FAILS IF THE CODE DOES NOTHING ─────────────────────────
//
//   scan          -> 24 offenders, measured: 18 `recommended`/`min`/`max`
//                    numeric literals (9 at src/limits.ts:96-129, 9 at
//                    clients/_crucible_axi.py:125-155) plus 6 limit names
//                    declared beside a `description` (src/limits.ts:91/104/117,
//                    clients/_crucible_axi.py:121/134/147).
//   travel        -> no `crucible.toml` in the packed tarball at all
//                    (package.json `files` is ["bin/","src/","public/"]).
//   one datum     -> the mutation is invisible: the probe reads `SHIPPED`,
//                    compiled in, and reports the pre-mutation numbers.
//   version skew  -> unreachable; there is no shipped data file to skew.
//
// ── Safety ────────────────────────────────────────────────────────────────
//
// Nothing here runs `npm publish`, `npm install`, `bun add -g` or `uv tool
// install`, and nothing mutates the developer's installed tooling. `npm pack`
// is a local, network-free tar of the `files` whitelist (the same mechanism
// tests/cr009-release-bundle.test.ts already drives). The tarball, its
// extraction and every mutation live in a fresh OS tmpdir that is removed
// afterwards; the only thing read out of the repo is the checkout itself, and
// `node_modules` is SYMLINKED into the stage rather than installed. No Store
// is opened, `data/crucible.db` is never touched, `data/crucible.toml` is
// never read or written, and nothing talks to the running board.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SERVER_LIMIT_NAMES } from "../src/limits.ts";
import { listFiles, REPO_ROOT } from "./helpers/source-scan.ts";

// ── The DECLARED limit set, both stacks ───────────────────────────────────
//
// The server's names come from the server's own export. The client's are read
// out of `clients/_crucible_axi.py`, which is the MIRROR of the trick
// tests/client/test_open_run_warning_names_the_limit.py already plays in the
// other direction (it parses `RETIRED_LIMIT_ENV` out of the bun fixture so a
// fourth retirement cannot land on one stack only). Two hand-maintained name
// lists in two languages is the second copy this CR family has already been
// bitten by twice.
const CLIENT_MODULE = "clients/_crucible_axi.py";

function clientLimitNames(): string[] {
  const text = readFileSync(join(REPO_ROOT, CLIENT_MODULE), "utf8");
  const match = /CLIENT_LIMIT_NAMES\s*=\s*\(([^)]*)\)/.exec(text);
  if (match === null) {
    throw new Error(
      `CR-CRU-131 §S1c: ${CLIENT_MODULE} no longer declares CLIENT_LIMIT_NAMES. It is the ` +
        `single list of the limits a CLIENT enforces; this scan reads it so a seventh limit is ` +
        `covered on the day it is added rather than the day someone remembers to edit a test.`,
    );
  }
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

const DECLARED_LIMITS = [...SERVER_LIMIT_NAMES, ...clientLimitNames()];

// ── The two matchers, and why they are EXACT rather than heuristic ────────
//
// A limit DECLARATION is four fields. Two shapes carry it, and both were
// measured across `src/` and `clients/` before this file was written:
//
//   FIELD_LITERAL     `recommended|min|max` assigned a NUMERIC LITERAL.
//                     12 hits today, every one inside the two shipped tables.
//                     ZERO false positives: the resolvers read these fields
//                     (`t.recommended`, `declaration["min"]`) but never assign
//                     a NUMBER to one, and `recommended: number` in the
//                     `LimitDeclaration` interface assigns a TYPE, not a value.
//   NAME_BESIDE_DOC   a declared limit's OWN name with the word `description`
//                     within 200 characters. 6 hits today, one per limit.
//                     ZERO false positives: `retention` is all over
//                     src/store.ts and never lands near a `description`.
//
// RAW TEXT, not a comment-stripped projection, and deliberately — the same
// direction C2's retired-variable scan took. A comment that restates a
// declaration is the very drift this section exists to end: an operator who
// reads a number in a comment and a different number in the file has been told
// two things. (It is also what keeps this scan from needing a SEVENTH walker
// of two grammars — the discipline tests/helpers/source-scan.ts's own header
// states.)
const SCANNED_TREES = ["src", "clients"];
const SCANNED_EXTS = [".ts", ".js", ".mjs", ".py"];
const DOC_WINDOW = 200;

// BUILT PER CALL, never a module constant — the same discipline
// `nameBesideDoc` below already follows, and for a measured reason.
//
// `RegExp.prototype.test` on a `/g` regex READS AND WRITES `lastIndex`, so a
// shared instance carries state from one name, one file and one test into the
// next. With one held at module scope, `namesDeclaredIn` reported a limit as
// UNDECLARED whenever the previous file scanned happened to be longer than the
// current one: the stale offset sat past the end, the first `.test()` returned
// false and reset, and exactly one name was lost per call. Measured on
// 2026-09-14 — the control walked the checkout's data files and left
// `lastIndex` at 4100, the staged 3964-byte `src/crucible.toml` then lost
// `run_abandon_ms`, and the fix by content would have been to trim comments
// until the byte offsets aligned. That makes the comment budget of a shipped
// documentation file load-bearing for a packaging assertion, and green by
// coincidence is worse than red. Constructing per call makes the hazard
// unrepresentable rather than merely managed; a `lastIndex = 0` reset would
// leave shared state that every future caller has to remember to clear.
//
// `declarationHits` was never affected: `String.prototype.matchAll` clones the
// regex it is given, so it neither reads nor writes the original's state.
function fieldLiteral(): RegExp {
  return /["']?\b(?:recommended|min|max)\b["']?\s*[:=]\s*-?\d[\d_]*/g;
}

function nameBesideDoc(name: string): RegExp {
  return new RegExp(`${name}[\\s\\S]{0,${String(DOC_WINDOW)}}?\\bdescription\\b`, "g");
}

interface Hit {
  where: string;
  what: string;
}

/** Every declaration-shaped construct in one text, as `file:line` hits. */
function declarationHits(where: string, text: string, names: readonly string[]): Hit[] {
  const lineOf = (index: number): number => text.slice(0, index).split("\n").length;
  const hits: Hit[] = [];
  for (const match of text.matchAll(fieldLiteral())) {
    hits.push({ where: `${where}:${String(lineOf(match.index))}`, what: match[0].trim() });
  }
  for (const name of names) {
    for (const match of text.matchAll(nameBesideDoc(name))) {
      hits.push({
        where: `${where}:${String(lineOf(match.index))}`,
        what: `\`${name}\` declared with a \`description\``,
      });
    }
  }
  return hits;
}

/** Which of `names` this text declares AT ALL — the control's measurement. */
function namesDeclaredIn(text: string, names: readonly string[]): string[] {
  return names.filter((name) => nameBesideDoc(name).test(text) && fieldLiteral().test(text));
}

// The data files a READER reads, in the checkout. `data/crucible.toml` is
// deliberately NOT among them: it is this board's live operator state, it is
// what caps the running :3849 instance, and a test has no business reading it
// (§S1c's own isolation rule).
const CANDIDATE_DATA_FILES = [
  "crucible.toml",
  "src/crucible.toml",
  "clients/crucible.toml",
  "crucible_axi/crucible.toml",
  "crucible_axi/clients/crucible.toml",
];

describe("CR-CRU-131 §S1c — no limit DECLARATION is a literal in source", () => {
  test("a name's verdict does not depend on what was scanned before it — the matchers carry no state between files", () => {
    // THE MATCHER'S OWN REGRESSION. Every assertion in this file runs
    // `namesDeclaredIn` repeatedly, over different files, in one process; a
    // matcher holding `lastIndex` between calls silently loses one name per
    // call whenever the previous text was the longer one. That failure is
    // INVISIBLE when the byte offsets happen to align, which is why it needs
    // an assertion rather than a comment: the guard would go on passing for
    // months and then fail on an edited `description`.
    //
    // Driven as ORDER-DEPENDENCE, not as an implementation check: the same two
    // texts are measured in both orders and each must report its own
    // declarations either way. A shared `/g` matcher fails this; a per-call
    // one cannot.
    const long = `${"# padding\n".repeat(400)}[limits.retention]\ndescription = "d"\nrecommended = 1\nmin = 1\nmax = 2\n`;
    const short = `[limits.roadmap_list_rows]\ndescription = "d"\nrecommended = 1\nmin = 1\nmax = 2\n`;
    expect(long.length, "the first text must be the longer one, or nothing is at risk").
      toBeGreaterThan(short.length);

    expect(namesDeclaredIn(long, ["retention"])).toEqual(["retention"]);
    expect(
      namesDeclaredIn(short, ["roadmap_list_rows"]),
      "a declaration went unseen because a LONGER text was measured first — the matcher is " +
        "carrying `lastIndex` between calls, so a green scan depends on the byte lengths of " +
        "files it is not testing",
    ).toEqual(["roadmap_list_rows"]);

    // …and the reverse order, so the assertion is about independence rather
    // than about one lucky sequence.
    expect(namesDeclaredIn(short, ["roadmap_list_rows"])).toEqual(["roadmap_list_rows"]);
    expect(namesDeclaredIn(long, ["retention"])).toEqual(["retention"]);
  });

  test("neither src/ nor clients/ declares a limit's description, recommendation or range — and the same matchers find every declaration in the data file, so this is not an empty walk", () => {
    expect(
      DECLARED_LIMITS.length,
      "the declared set must carry both stacks' limits, or the scan is scoped to half the tree",
    ).toBe(6);

    // ── THE CONTROL, first. ───────────────────────────────────────────────
    // A scan that reports nothing proves nothing until it has been shown to
    // report something. The declarations LEGITIMATELY live in a `crucible.toml`
    // — that is the whole move — so the matchers are run over the checkout's
    // own data file(s) and must find every one of the six there. A matcher
    // that had been quietly broken (a typo'd name, a regex that never
    // compiled) fails HERE rather than passing green over `src/`.
    const dataFiles = CANDIDATE_DATA_FILES.filter((rel) => existsSync(join(REPO_ROOT, rel)));
    expect(
      dataFiles,
      "§S1c's premise is a DATA FILE carrying the declarations; the checkout has none",
    ).not.toEqual([]);
    const declaredInData = new Set<string>();
    for (const rel of dataFiles) {
      for (const name of namesDeclaredIn(readFileSync(join(REPO_ROOT, rel), "utf8"), DECLARED_LIMITS)) {
        declaredInData.add(name);
      }
    }
    expect(
      DECLARED_LIMITS.filter((name) => !declaredInData.has(name)),
      `the matchers must see a declaration where one legitimately lives (${dataFiles.join(", ")}), ` +
        `or a green result over src/ and clients/ is an empty walk rather than the move's doing`,
    ).toEqual([]);

    // ── THE SCAN. ─────────────────────────────────────────────────────────
    const corpus = new Map(
      SCANNED_TREES.flatMap((dir) => listFiles(dir, SCANNED_EXTS)).map((file) => [
        relative(REPO_ROOT, file),
        readFileSync(file, "utf8"),
      ]),
    );
    expect(corpus.size, "the corpus must be real").toBeGreaterThan(10);

    const offenders = [...corpus].flatMap(([where, text]) =>
      declarationHits(where, text, DECLARED_LIMITS),
    );
    if (offenders.length > 0) {
      throw new Error(
        `CR-CRU-131 §S1c: ${String(offenders.length)} limit DECLARATION literal(s) remain in the ` +
          `shipped source trees — ${offenders.map((h) => `${h.where} (${h.what})`).join(" | ")}. ` +
          `The last resort must be a DATA FILE in the distribution, not a number in a resolver: ` +
          `that is what makes "no literal in source" achievable rather than aspirational. A ` +
          `declaration held in BOTH a source table and a crucible.toml is two copies of the same ` +
          `datum, and the file an operator reads can then disagree with the numbers the code ` +
          `falls back to with nothing saying so.`,
      );
    }
    expect(offenders).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The npm distribution — STAGED, never published
// ══════════════════════════════════════════════════════════════════════════
//
// `npm pack` tars exactly the `files` whitelist and contacts no registry
// (tests/cr009-release-bundle.test.ts drives the same command for the same
// reason). The tarball is extracted into a tmpdir; that extraction — NOT this
// checkout — is what every assertion below reads, because the checkout is
// exactly where the file exists anyway.

let stage = "";
let pkgDir = "";
let packStderr = "";
let emptyConfigDir = "";

function run(cmd: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const res = Bun.spawnSync({ cmd, cwd });
  return {
    code: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
}

beforeAll(() => {
  stage = mkdtempSync(join(tmpdir(), "crucible-server-dist-"));
  const packed = run(["npm", "pack", "--pack-destination", stage], REPO_ROOT);
  packStderr = packed.stderr;
  if (packed.code === 0) {
    const tarball = readdirSync(stage).find((n) => n.endsWith(".tgz"));
    if (tarball !== undefined) {
      run(["tar", "-xzf", join(stage, tarball)], stage);
      pkgDir = join(stage, "package");
      // The stage is a DISTRIBUTION, not an install: dependencies are
      // symlinked in rather than fetched, so nothing on this machine is
      // installed, upgraded or otherwise touched.
      const modules = join(pkgDir, "node_modules");
      if (existsSync(pkgDir) && !existsSync(modules)) {
        symlinkSync(join(REPO_ROOT, "node_modules"), modules, "dir");
      }
    }
  }
  // An EMPTY directory standing in for a machine with no operator file at all,
  // so what the probe reads is the distribution's last resort and nothing else.
  emptyConfigDir = mkdtempSync(join(tmpdir(), "crucible-no-operator-file-"));
});

afterAll(() => {
  for (const dir of [stage, emptyConfigDir]) {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  }
});

function requireStage(): string {
  expect(
    pkgDir !== "" && existsSync(pkgDir),
    `\`npm pack\` produced no extractable distribution; stderr:\n${packStderr}`,
  ).toBe(true);
  return pkgDir;
}

/** Every `crucible.toml` anywhere inside the staged distribution. */
function stagedDataFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "crucible.toml") found.push(full);
    }
  };
  walk(root);
  return found;
}

interface Probe {
  shipped: Record<string, { description: string; recommended: number; min: number; max: number }>;
  resolved: Record<string, number>;
  foreign: string;
}

/**
 * Drive the STAGED distribution's own resolver, in its own tree, with no
 * operator file reachable — so what comes back is the distribution's last
 * resort. `CRUCIBLE_DB` points at an empty tmpdir, which is what makes the
 * server's `crucible.toml` (resolved beside its database) absent.
 */
function probeStage(root: string): Probe {
  const limits = join(root, "src", "limits.ts");
  const script =
    `const m = await import(${JSON.stringify(limits)});\n` +
    `const out = { shipped: m.shippedLimits(), resolved: {}, foreign: "" };\n` +
    `for (const n of m.SERVER_LIMIT_NAMES) out.resolved[n] = m.resolveLimit(n);\n` +
    `try { m.resolveLimit("truncate_field_chars"); out.foreign = "resolved"; }\n` +
    `catch { out.foreign = "refused"; }\n` +
    `console.log("PROBE:" + JSON.stringify(out));\n`;
  const res = Bun.spawnSync({
    cmd: ["bun", "-e", script],
    cwd: root,
    env: { ...process.env, CRUCIBLE_DB: join(emptyConfigDir, "crucible.db") },
  });
  const stdout = res.stdout.toString();
  const line = stdout.split("\n").find((l) => l.startsWith("PROBE:"));
  if (line === undefined) {
    throw new Error(
      `the staged distribution could not resolve its own limits (exit ${String(res.exitCode)}).\n` +
        `stdout:\n${stdout}\nstderr:\n${res.stderr.toString()}`,
    );
  }
  return JSON.parse(line.slice("PROBE:".length)) as Probe;
}

/** Rewrite one `recommended =` line in a staged TOML table. */
function setRecommended(file: string, limit: string, value: number): void {
  const text = readFileSync(file, "utf8");
  const table = new RegExp(`(\\[limits\\.${limit}\\][\\s\\S]*?recommended\\s*=\\s*)-?\\d[\\d_]*`);
  expect(table.test(text), `the staged data file declares no \`${limit}\` to mutate: ${file}`).toBe(
    true,
  );
  writeFileSync(file, text.replace(table, `$1${String(value)}`));
}

describe("CR-CRU-131 §S1c — the server's shipped defaults TRAVEL in its distribution", () => {
  test("a packed @anthill-tec/crucible-server tarball — not this checkout — carries a crucible.toml declaring every server limit, and package.json's `files` list declares it", () => {
    const root = requireStage();

    // NON-VACUITY: prove the thing under assertion really is a DISTRIBUTION.
    // A test that read the checkout would pass on a `files` list that ships no
    // config at all, which is precisely today's state.
    expect(relative(REPO_ROOT, root).startsWith(".."), "the stage must be outside the repo").toBe(
      true,
    );
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name: string;
      files: string[];
    };
    expect(manifest.name).toBe("@anthill-tec/crucible-server");
    // The checkout's own contents that a distribution must NOT carry — if any
    // of these were here, the "stage" would be a copy of the repo.
    for (const intruder of ["tests", "data", ".git", "docs", "clients"]) {
      expect(existsSync(join(root, intruder)), `a distribution must not carry ${intruder}/`).toBe(
        false,
      );
    }
    expect(existsSync(join(root, "src", "limits.ts")), "fixture sanity: the resolver ships").toBe(
      true,
    );

    const shippedFiles = stagedDataFiles(root);
    expect(
      shippedFiles.map((f) => relative(root, f)),
      "§S1c: the shipped defaults must be PACKAGE DATA — a crucible.toml inside the distribution, " +
        "added to the npm `files` list beside src/. An installed server otherwise resolves every " +
        "limit from a file that does not exist.",
    ).not.toEqual([]);

    // The DECLARATION, complete, for every limit this side enforces.
    const declared = new Set<string>();
    for (const file of shippedFiles) {
      for (const name of namesDeclaredIn(readFileSync(file, "utf8"), SERVER_LIMIT_NAMES)) {
        declared.add(name);
      }
    }
    expect([...SERVER_LIMIT_NAMES].filter((n) => !declared.has(n))).toEqual([]);

    // …and the `files` whitelist DECLARES it, which is the line an author
    // editing package.json actually has to get right.
    const relativeNames = shippedFiles.map((f) => relative(root, f));
    expect(
      manifest.files.some((entry) =>
        relativeNames.some((name) => name === entry || name.startsWith(entry)),
      ),
      `package.json \`files\` (${manifest.files.join(", ")}) must name the shipped defaults ` +
        `(${relativeNames.join(", ")})`,
    ).toBe(true);
  });

  test("the shipped file and the shipped documentation are ONE datum: mutating the staged distribution's crucible.toml moves what the resolver falls back to", () => {
    const root = requireStage();
    const files = stagedDataFiles(root);
    expect(files, "there is no shipped data file to mutate").not.toEqual([]);

    // BEFORE — what the distribution falls back to with no operator file.
    const before = probeStage(root);
    for (const name of SERVER_LIMIT_NAMES) {
      expect(before.resolved[name], `\`${name}\` must resolve from the distribution`).toBe(
        before.shipped[name]!.recommended,
      );
    }

    // The operator's file is genuinely absent, so nothing but the shipped data
    // can be supplying these numbers.
    expect(existsSync(join(emptyConfigDir, "crucible.toml"))).toBe(false);

    // THE MUTATION — distinct, in-range, and nothing like the shipped value.
    const moved: Record<string, number> = {
      run_abandon_ms: 777_000,
      project_inactive_ms: 888_000,
      retention: 4_321,
    };
    for (const [name, value] of Object.entries(moved)) {
      expect(before.resolved[name], "the mutation must be distinguishable").not.toBe(value);
      for (const file of files) setRecommended(file, name, value);
    }

    // AFTER — the fallback FOLLOWED the file. Two copies cannot do this: a
    // source table would still be reporting the old numbers.
    const after = probeStage(root);
    for (const [name, value] of Object.entries(moved)) {
      expect(
        after.resolved[name],
        `\`${name}\` still resolves to the number compiled into the resolver, so the shipped ` +
          `declaration and the shipped documentation are TWO copies, not one datum`,
      ).toBe(value);
      expect(after.shipped[name]!.recommended).toBe(value);
      // NEGATIVE — the pre-mutation number is gone, not merely joined.
      expect(after.resolved[name]).not.toBe(before.resolved[name]);
    }
    // The DOCUMENTATION a reader meets is the same datum: descriptions survive
    // the round trip through the file rather than coming from somewhere else.
    for (const name of SERVER_LIMIT_NAMES) {
      expect(after.shipped[name]!.description.length).toBeGreaterThan(40);
    }
  });

  test("VERSION SKEW: a server distribution whose data file declares a limit this side does not enforce still resolves all three it owns, and still refuses the foreign one", () => {
    const root = requireStage();
    const files = stagedDataFiles(root);
    expect(files).not.toEqual([]);

    // The client fleet is a SEPARATE package, installable on another host at
    // an independently resolved version. So the server's own data file must
    // survive meeting a vocabulary from the other side of that boundary — a
    // client limit it does not enforce, and a limit from a future release it
    // has never heard of. This is the property the ownership split exists to
    // guarantee and the one a shared file would have destroyed.
    for (const file of files) {
      writeFileSync(
        file,
        readFileSync(file, "utf8") +
          "\n[limits.truncate_field_chars]\n" +
          'description = "A CLIENT limit, from a client package at another version."\n' +
          "recommended = 200\nmin = 20\nmax = 4000\nvalue = 64\n" +
          "\n[limits.future_server_knob]\n" +
          'description = "A limit from a release this package predates."\n' +
          "recommended = 9\nmin = 1\nmax = 99\nvalue = 7\n",
      );
    }

    const probe = probeStage(root);
    for (const name of SERVER_LIMIT_NAMES) {
      expect(
        probe.resolved[name],
        `\`${name}\` stopped resolving because the data file named a limit from the other ` +
          `package — the two are independently upgradable and this must not happen`,
      ).toBe(probe.shipped[name]!.recommended);
    }
    // NEGATIVE — a foreign limit is not ADOPTED by having been written down.
    expect(
      probe.foreign,
      "a client limit in the server's data file must stay a programming error to resolve, not " +
        "become resolvable by appearing in the file",
    ).toBe("refused");
    expect(Object.keys(probe.shipped).sort()).toEqual([...SERVER_LIMIT_NAMES].sort());
  });
});
