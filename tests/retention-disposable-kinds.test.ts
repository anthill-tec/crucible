// CR-CRU-129 §S2 — retention has nothing structural left to reach.
//
// After §S1 the cap governs `test`, `compile` and `lifecycle` and NOTHING
// else, and the two exemption predicates (`LIVE_GATE`, src/store.ts:3072;
// `LIVE_PROPOSAL`, :3079) become unreachable — `LIVE_PROPOSAL` can never match,
// because no milestone remains in the table it queries. The CR removes them
// rather than leaving dead SQL implying a protection the schema now provides,
// and says in as many words what replaces them:
//
//   "The guard that replaces them is a test: retention may only ever reach
//    kinds on a named disposable list, and adding a structural kind to that
//    list fails."
//
// This file is that test. It therefore carries more weight than its size
// suggests: it is the ONLY thing standing between a future CR and a second
// 2026-09-13.
//
//   // the seam it is written against — src/store.ts
//   /** §S2 — the ONLY kinds retention may evict. */
//   export const RETENTION_DISPOSABLE_KINDS: ReadonlySet<string>;
//
// EXPORTED on purpose. A private constant is a promise the store makes to
// itself; this one has to be checkable from outside, because the guard's whole
// job is to fail a change made in a hurry.
//
// ── Limits are configuration, never constants (user ruling, 2026-09-13) ─────
// Nothing in this file asserts 100, 2000 or any other cap value. Every count
// expectation is derived from the cap READ BACK off the project after the
// fixture configured it. A test that hardcodes the limit it checks freezes the
// same defect from the other side.
//
// ── Where the behavioural half of "no read depends on them" lives ──────────
// tests/milestone-records-survive-retention.test.ts asserts that a VERSIONLESS
// gate, a RETIRED gate and a CONSUMED release-proposal all survive a full roll
// — the three shapes the two predicates deliberately do NOT protect today. If
// a read still depended on an exemption, those records would still vanish.
//
// ── Safety ─────────────────────────────────────────────────────────────────
// Every store here is ":memory:". The live `data/crucible.db` is never opened.
import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Store, defaultRetention } from "../src/store.ts";
import * as storeModule from "../src/store.ts";
import { retentionDisclosure } from "../src/server.ts";
import { serverConfigPath, shippedLimits } from "../src/limits.ts";
import {
  declare,
  restoreServerLimitsFixture,
  serverConfigDir,
  writeConfig,
} from "./helpers/server-limits-fixture.ts";
import type { SuiteNode } from "../src/types.ts";

const emptyTree: SuiteNode[] = [];

/**
 * The complete kind vocabulary the store can write — `test`, `compile`,
 * `lifecycle`, `gate`, `milestone` (src/store.ts:2955-2961, where `toEvent`
 * narrows a row's kind). Held here so "structural" can be computed as
 * EVERYTHING MINUS DISPOSABLE rather than listed a second time: move a kind
 * onto the disposable list and it leaves the structural set automatically,
 * which is what makes the guard below bite.
 */
const ALL_RECORDED_KINDS = ["test", "compile", "lifecycle", "gate", "milestone"] as const;

/**
 * The disposable set §S2 names: numerous, reproducible telemetry. This IS the
 * vocabulary under test, so it is written out — a vocabulary is not a limit.
 */
const DISPOSABLE = ["compile", "lifecycle", "test"] as const;

function disposableKinds(): ReadonlySet<string> {
  const mod = storeModule as { RETENTION_DISPOSABLE_KINDS?: unknown };
  const found = mod.RETENTION_DISPOSABLE_KINDS;
  if (!(found instanceof Set)) {
    throw new Error(
      "CR-CRU-129 §S2: src/store.ts exports no `RETENTION_DISPOSABLE_KINDS` set. Retention must " +
        "reach a NAMED disposable list and nothing else; an unexported predicate cannot be " +
        "guarded from outside, which is the only reason this CR exists.",
    );
  }
  return found as ReadonlySet<string>;
}

function seedProject(store: Store, retention?: number, name = "retention-scope"): string {
  const key = crypto.randomUUID();
  store.addProject({
    key,
    name,
    type: "backend",
    sutRoot: "/tmp",
    ...(retention !== undefined ? { retention } : {}),
  });
  return key;
}

/** Configure the cap through the configuration surface; return what the store
 *  actually resolved, which is what every expectation below is derived from. */
function configuredCap(store: Store, key: string, chosen: number): number {
  store.updateProject(key, { retention: chosen });
  const resolved = store.getProject(key)?.retention;
  expect(typeof resolved).toBe("number");
  return resolved as number;
}

function ingestTelemetry(store: Store, key: string, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      store.recordTestEvent(key, "agent-1", {
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
        tree: emptyTree,
      }).id,
    );
  }
  return ids;
}

/** One row of each kind the store can write, by kind name. */
function recordOfKind(store: Store, key: string, kind: string): string {
  switch (kind) {
    case "test":
      return ingestTelemetry(store, key, 1)[0]!;
    case "compile":
      return store.recordCompileEvent(key, "agent-1", { errorCount: 0, warningCount: 0 }).id;
    case "lifecycle":
      return store.recordLifecycleEvent(key, "agent-1", "registered").id;
    case "gate":
      return store.recordGateEvent(key, "agent-1", {
        intent: "ship",
        outcome: "passed",
        steps: [],
      }).id;
    case "milestone":
      return store.recordMilestoneEvent(key, "agent-1", "cr-merged", {
        label: "CR-FIXTURE-MERGED",
        commit: "merge-fixture",
      }).event.id;
    default:
      throw new Error(
        `CR-CRU-129 §S2: this guard has no way to write a '${kind}' row, so it cannot say whether ` +
          `retention may evict one. A new kind must be classified HERE before it ships.`,
      );
  }
}

/**
 * THE RETENTION PATH, by name — the two functions that between them decide
 * what a cap IS and who it evicts. Named rather than scanned for, because a
 * whole-file scan of `src/store.ts` would be a false-positive machine (the
 * module is full of legitimate numbers) and would be silenced within a week.
 *
 * If either name moves, the scan below FAILS rather than passing over a
 * function it can no longer find: a guard that quietly stops looking is worse
 * than no guard.
 */
const RETENTION_PATH = ["enforceRetention", "defaultRetention"] as const;

/**
 * The CONFIGURATION SEAM each of those two functions must do its work through
 * — the call whose presence means the body resolved a cap from somewhere an
 * operator can reach, instead of deciding one itself.
 *
 * CR-CRU-131 §S1b — this REPLACES a `body.length > 40` floor that stood here
 * as the scan's non-vacuity check. The floor was never the property worth
 * asserting: it was a stand-in for "this body does its work through the seam",
 * and it held only while the bodies happened to be long. Retiring the
 * environment override made `defaultRetention` a PURE DELEGATE — `{ return
 * configuredRetention(); }`, 35 characters — which is the CORRECT shape for a
 * resolver under §S1b ("each resolver reads the file and nothing else"), and
 * the only ways to clear 41 characters were to pad the body or to inline
 * src/limits.ts into the store. A guard satisfiable only by making the code
 * worse is a broken guard, so the guard changed.
 *
 * DO NOT restore the length floor on the grounds that it looks stricter. A
 * character count penalises brevity, which this design rewards; naming the
 * seam fails a stub, fails a body that resolves a cap on its own, and cannot
 * be defeated by a body getting SHORTER.
 */
const CONFIGURATION_SEAM: Record<(typeof RETENTION_PATH)[number], string> = {
  // The per-project cap, falling back on the fleet's — never a number of its own.
  enforceRetention: "defaultRetention",
  // The fleet's cap, read off the server's `crucible.toml` (src/limits.ts).
  defaultRetention: "configuredRetention",
};

/**
 * The body of a named function with comments and string CONTENTS removed, so
 * the scan reads CODE and nothing else. Without this, `CR-CRU-013` in a
 * comment and a `LIMIT ?` in SQL both read as source the guard must judge.
 *
 * Written as one pass rather than as regexes because brace-matching a body
 * requires knowing where the strings are anyway.
 */
function tsDeclaration(source: string, name: string, file: string): RegExpExecArray {
  const decl = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:private\\s+)?(?:static\\s+)?(?:function\\s+)?${name}\\s*\\(`).exec(
    source,
  );
  if (decl === null) {
    throw new Error(
      `CR-CRU-129 §S2: ${file} declares no \`${name}\`. The constructional guard against a ` +
        `hardcoded cap is scoped to the retention path BY NAME; a renamed function must be ` +
        `re-named here, or the scan silently stops guarding anything.`,
    );
  }
  return decl;
}

/**
 * CR-CRU-131 §S3 — `file` and `keepStrings` are the EXTENSION points, and both
 * default to what CR-CRU-129 asserted, so the retention-path scan below is
 * byte-for-byte the scan it always was. `file` lets the same walker read
 * `src/v2.ts`'s resolver without the refusal naming the wrong module;
 * `keepStrings` yields the SEAM projection, in which a call keeps the limit
 * name it passes (`resolveLimit("run_abandon_ms")`) so a site can be asked
 * which limit it actually resolves. The literal scan keeps running on the
 * default projection, where a number inside a message is not code.
 */
function retentionPathCode(
  source: string,
  name: string,
  file = "src/store.ts",
  keepStrings = false,
): string {
  const decl = tsDeclaration(source, name, file);
  let i = decl.index + decl[0].length - 1;
  // Step over the parameter list, then to the body's opening brace.
  let parens = 0;
  for (; i < source.length; i++) {
    if (source[i] === "(") parens++;
    else if (source[i] === ")" && --parens === 0) break;
  }
  i = source.indexOf("{", i);
  expect(i, `no body found for ${name}`).toBeGreaterThan(-1);

  const code: string[] = [];
  let depth = 0;
  for (; i < source.length; i++) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (c === "/" && next === "*") {
      i = source.indexOf("*/", i) + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const open = i;
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++;
      if (keepStrings) code.push(source.slice(open, Math.min(i + 1, source.length)));
      continue;
    }
    if (c === "`") {
      for (i++; i < source.length; i++) {
        if (source[i] === "\\") i++;
        else if (source[i] === "`") break;
        else if (source[i] === "$" && source[i + 1] === "{") {
          // Re-enter code for the interpolation, balanced on its own braces.
          let inner = 0;
          for (i++; i < source.length; i++) {
            if (source[i] === "{") inner++;
            else if (source[i] === "}" && --inner === 0) break;
            else code.push(source[i]!);
          }
        }
      }
      continue;
    }
    code.push(c);
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) break;
  }
  return code.join("");
}

/**
 * A numeric literal is a CAP unless it is an operand of a COMPARISON. That is
 * the whole rule, and it is the narrowest one that still bites: `overflow <= 0`
 * and `raw > 0` are boundary tests, while anything a cap could be ASSIGNED
 * from — `?? 100`, `= 100`, `return 100`, `? raw : 100` — is a limit compiled
 * into the source, which is exactly what this CR deleted.
 */
const COMPARISON_OPERAND = /(?:<|>|<=|>=|==|===|!=|!==)\s*$/;

/**
 * CR-CRU-131 §S3 — the SECOND exemption, and the only one the extension adds:
 * a literal that ADJUSTS a value already resolved is an offset, not a bound.
 *
 * Measured, not anticipated. `no_report_warning`
 * (`clients/_crucible_axi.py`) resolves `error_detail_chars` through the seam
 * and then spends one character of the room it was given on the ellipsis it
 * prepends — `cause[-(room - 1):]`. That `1` is not a limit anybody could
 * configure; it is the width of `…`. Flagging it would demand the production
 * code be contorted to satisfy a guard, which is the failure C2 retired the
 * length floor for.
 *
 * NARROW on purpose: an IDENTIFIER or a closing bracket must sit immediately
 * before the operator, so `= -1` (an operator writing a sentinel cap) is still
 * a cap, while `room - 1` and `detail_max - 1` are not.
 */
const ADJUSTMENT_OPERAND = /[\w$)\]]\s*[-+]\s*$/;

function capLiteralsIn(code: string): string[] {
  const found: string[] = [];
  const literal = /(?<![\w$.])(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/g;
  for (const match of code.matchAll(literal)) {
    const before = code.slice(Math.max(0, match.index - 8), match.index);
    if (COMPARISON_OPERAND.test(before)) continue;
    if (ADJUSTMENT_OPERAND.test(before)) continue;
    const from = Math.max(0, match.index - 40);
    found.push(code.slice(from, match.index + match[0].length + 20).replace(/\s+/g, " ").trim());
  }
  return found;
}

describe("CR-CRU-129 §S2 — retention reaches only the disposable kinds", () => {
  // ── The fleet cap moved from the environment to a FILE (CR-CRU-131 §S1b) ──
  //
  // These tests used to drive the fallback through `$CRUCIBLE_DEFAULT_RETENTION`.
  // C2 retires that variable: a limit read from the environment carries no
  // `description`, no `recommended` and no supportable range, which is the
  // condition PRD §4.13 exists to end. What each test PROVES is unchanged —
  // the fallback is configuration, read per sweep, and an unconfigured cap is
  // no cap at all — only the surface it configures through has moved.

  let configDir: string | undefined;

  afterEach(() => {
    configDir = undefined;
    restoreServerLimitsFixture();
  });

  /** The server's own configuration directory for THIS test — created once, so
   *  two writes inside one test edit the SAME file (which is what the
   *  read-per-sweep proof needs). Every retired variable is cleared on the way
   *  in, so nothing here can pass on a value an inherited environment supplied. */
  function serverDir(): string {
    configDir ??= serverConfigDir();
    return configDir;
  }

  /**
   * The operator's file, setting the FLEET cap to `chosen` — §S1b's
   * `[limits.retention]` table, with the four documentation fields untouched
   * and their own `value` beside them.
   *
   * `min` is RE-STATED beside the value, and legitimately: the shipped floor
   * is a supportability judgement for a real fleet, while these fixtures
   * ingest tens of rows, and §S1b's validator reads `min` off the VERY TABLE
   * the operator edits — so a bound moved in the file is configuration, not a
   * bypass of it.
   */
  function configureFleetCap(chosen: number): void {
    writeConfig(serverDir(), {
      retention: declare(shippedLimits().retention!, chosen, { min: chosen }),
    });
  }

  /** The UNCONFIGURED state — the one AC6 is about, and the one an inherited
   *  environment would otherwise hide: no file at all, which §S1b defines as
   *  the operator having configured NOTHING. */
  function nothingConfigured(): string {
    const dir = serverDir();
    const file = join(dir, "crucible.toml");
    expect(existsSync(file), "nothing may be configured here").toBe(false);
    return file;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AC — the named disposable set, and the refusal to grow it.
  // ─────────────────────────────────────────────────────────────────────────
  test("the disposable set retention may evict is exactly {test, compile, lifecycle} — adding a structural kind to it FAILS here", () => {
    const kinds = [...disposableKinds()].sort();
    const structural = ALL_RECORDED_KINDS.filter((kind) => !disposableKinds().has(kind));

    const intruders = kinds.filter((kind) => !(DISPOSABLE as readonly string[]).includes(kind));
    if (intruders.length > 0) {
      throw new Error(
        `CR-CRU-129 §S2: ${intruders.join(", ")} was added to RETENTION_DISPOSABLE_KINDS. ` +
          `Retention may only reach TELEMETRY — kinds that are numerous, reproducible and ` +
          `exactly what a capped buffer is for. A \`${intruders[0]}\` is a RECORD: something ` +
          `that happened once and stays true, with no external source to rebuild it from. ` +
          `Putting one on this list is how this project lost every release it had ever shipped ` +
          `on 2026-09-13 — its own test ingests evicted its history. Give the kind a table, ` +
          `not a place on this list.`,
      );
    }
    expect(kinds).toEqual([...DISPOSABLE].sort());
    // ... and the complement is not empty, so the assertion above cannot be
    // satisfied by a disposable set that swallowed the whole vocabulary.
    expect(structural.sort()).toEqual(["gate", "milestone"]);
  });

  test("the set is not just a declaration: every disposable kind is actually evicted by a sweep, and every structural kind is not", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    const cap = configuredCap(store, key, 20);

    const disposable = [...disposableKinds()];
    const structural = ALL_RECORDED_KINDS.filter((kind) => !disposableKinds().has(kind));
    // Non-vacuity: both halves have something in them, so neither loop below
    // can pass by iterating over nothing.
    expect(disposable.length).toBeGreaterThan(0);
    expect(structural.length).toBeGreaterThan(0);

    const seeded = new Map<string, string>();
    for (const kind of [...disposable, ...structural]) {
      seeded.set(kind, recordOfKind(store, key, kind));
    }
    for (const [kind, id] of seeded) {
      expect(store.getEvent(id), `${kind} was not seeded`).not.toBeNull();
    }

    // Roll the whole buffer with ordinary telemetry — TWICE the configured
    // cap, so every seeded row is older than the surviving window.
    const telemetry = ingestTelemetry(store, key, cap * 2);
    // The sweep RAN: the oldest telemetry row is gone.
    expect(store.getEvent(telemetry[0]!)).toBeNull();

    const wronglyKept: string[] = [];
    for (const kind of disposable) {
      if (store.getEvent(seeded.get(kind)!) !== null) wronglyKept.push(kind);
    }
    const wronglyLost: string[] = [];
    for (const kind of structural) {
      if (store.getEvent(seeded.get(kind)!) === null) wronglyLost.push(kind);
    }
    expect(wronglyLost).toEqual([]);
    expect(wronglyKept).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC — telemetry still prunes. Without this the CR could "pass" by
  // switching retention off altogether.
  // ─────────────────────────────────────────────────────────────────────────
  test("a project past its cap still sheds test events, and the surviving count FOLLOWS the configured cap rather than any constant", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);

    const wide = configuredCap(store, key, 30);
    const ids = ingestTelemetry(store, key, wide * 3);
    const afterWide = store.listEvents(key, ids.length * 10).filter((e) => e.kind === "test");
    expect(afterWide.length).toBe(wide);
    // The sweep genuinely shed rows rather than the fixture under-seeding.
    expect(ids.length).toBeGreaterThan(wide);
    expect(store.getEvent(ids[0]!)).toBeNull();

    // RE-CONFIGURE, and the cap follows the configuration — this is what
    // proves the number is resolved from the project and not compiled in.
    const narrow = configuredCap(store, key, 7);
    expect(narrow).not.toBe(wide);
    ingestTelemetry(store, key, 1);
    const afterNarrow = store.listEvents(key, ids.length * 10).filter((e) => e.kind === "test");
    expect(afterNarrow.length).toBe(narrow);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // User ruling, 2026-09-13: NO HARDCODED LIMITS IN CODE. The per-project cap
  // is already configuration (`projects.retention`); its FALLBACK is not —
  // `DEFAULT_RETENTION = 100` (src/store.ts:688) is a magic number with no
  // configuration channel at all, while the abandon deadline two declarations
  // below it already has one (`runAbandonAfterMs`, src/store.ts, "read per
  // sweep, not cached: the deadline is operational configuration").
  // Same rule, same mechanism, and this test pins no value of its own: it
  // configures one and asserts the store honoured THAT.
  //
  // CR-CRU-131 §S1b — that channel is now the server's own `crucible.toml`,
  // not `$CRUCIBLE_DEFAULT_RETENTION`. The rule this test defends is the same
  // one it always defended; only the surface has moved.
  // ─────────────────────────────────────────────────────────────────────────
  test("a project that configures no cap of its own takes the operator's configured default, not a constant compiled into the source", () => {
    configureFleetCap(9);
    const store = new Store(":memory:");
    // No `retention` — this project falls back on purpose.
    const key = seedProject(store);
    expect(store.getProject(key)?.retention).toBeUndefined();

    const ids = ingestTelemetry(store, key, 40);
    const surviving = store.listEvents(key, ids.length * 10).filter((e) => e.kind === "test");

    expect(surviving.length).toBe(9);
    expect(store.getEvent(ids[0]!)).toBeNull();
  });

  test("the fallback is read per sweep, so an operator's change takes effect without a restart", () => {
    configureFleetCap(9);
    const store = new Store(":memory:");
    const key = seedProject(store);
    ingestTelemetry(store, key, 40);

    // The operator EDITS the same file. Same process, same module graph — a
    // loader that cached the table at import would still be capping at 9.
    configureFleetCap(4);
    const ids = ingestTelemetry(store, key, 1);
    const surviving = store.listEvents(key, 400).filter((e) => e.kind === "test");

    expect(surviving.length).toBe(4);
    expect(store.getEvent(ids[0]!)).not.toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC — `LIVE_GATE` and `LIVE_PROPOSAL` are REMOVED. Their behavioural
  // replacement is asserted in the survival suite (see the header); what is
  // left to assert is the removal itself, which is a fact about the source and
  // nowhere else. The DECLARATION is matched, not any wording, so a comment
  // recording why they went is free to stay.
  // ─────────────────────────────────────────────────────────────────────────
  test("neither exemption predicate is still declared — retention protects records by not reaching them, not by excusing them one kind at a time", () => {
    const source = readFileSync("src/store.ts", "utf8");
    const declared = ["LIVE_GATE", "LIVE_PROPOSAL"].filter((name) =>
      new RegExp(`const\\s+${name}\\b`).test(source),
    );
    expect(declared).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC — "No retention limit is a literal in source ... Asserted by
  // CONSTRUCTION: a test scans the retention path for a numeric literal
  // standing in for a cap and fails on one, so the next author cannot quietly
  // reintroduce it."
  //
  // The behavioural tests above cannot do this job. Each of them CONFIGURES a
  // cap (9, 4, 30, 7) and asserts the store honoured it — so a literal
  // reintroduced as the UNCONFIGURED fallback (`?? 100`) is never on any path
  // they walk, and every one of them stays green while the defect is back.
  // This test is the only thing that reads the source itself.
  // ─────────────────────────────────────────────────────────────────────────
  test("the retention path contains no numeric literal standing in for a cap — the fallback resolves from configuration or resolves to nothing", () => {
    const source = readFileSync("src/store.ts", "utf8");
    // Non-vacuity: the scan really did read code, and really can see a number.
    // Each body must do its work THROUGH its configuration seam — a stub, or a
    // body that decided a cap on its own, names nothing (see CONFIGURATION_SEAM).
    const bodies = RETENTION_PATH.map((name) => retentionPathCode(source, name));
    for (const [index, body] of bodies.entries()) {
      const name = RETENTION_PATH[index]!;
      const seam = CONFIGURATION_SEAM[name];
      expect(
        body.includes(seam),
        `${name} does not resolve its cap through \`${seam}\` — it was scanned as ${JSON.stringify(body)}`,
      ).toBe(true);
    }
    expect(capLiteralsIn("const cap = project.retention ?? 100;")).not.toEqual([]);

    const offenders = RETENTION_PATH.flatMap((name, index) =>
      capLiteralsIn(bodies[index]!).map((context) => `${name}: ${context}`),
    );
    if (offenders.length > 0) {
      throw new Error(
        `CR-CRU-129 §S2: a numeric literal is standing in for a retention cap in the retention ` +
          `path — ${offenders.join(" | ")}. A limit is CONFIGURATION, never a constant in ` +
          `source: the per-project value is \`projects.retention\` and its fallback is the ` +
          `\`[limits.retention]\` table in the server's own crucible.toml (CR-CRU-131 §S1b). ` +
          `\`DEFAULT_RETENTION = 100\` was deleted rather than ` +
          `resized because a literal nobody configured is a cap nobody was told about, and on ` +
          `2026-09-13 that cap evicted every release this project had ever shipped. An ` +
          `unconfigured cap must resolve to NO CAP (and say so at boot), not to a number.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC — "An unconfigured cap means NO cap, AND SAYS SO." Both halves, because
  // half of this AC is silent by nature: deleting the literal made retention
  // OPT-IN, and an opt-in nobody is told about is how the next silent growth
  // starts. On the live board today `Model B` and `Sandesh` both carry
  // `retention: null` and prune nothing, and nothing anywhere says so.
  //
  // Asserted in BOTH directions on purpose: a disclosure that is always
  // printed discloses nothing, so the silence when a cap DOES resolve is as
  // load-bearing as the warning when none does.
  // ─────────────────────────────────────────────────────────────────────────
  test("with no cap configured anywhere, retention evicts NOTHING and the boot discloses it, naming the setting that would bound it", () => {
    nothingConfigured();
    const store = new Store(":memory:");
    const key = seedProject(store);
    expect(store.getProject(key)?.retention).toBeUndefined();
    expect(defaultRetention()).toBeUndefined();

    // Half one — nothing is evicted. The count is the fixture's own, not a
    // cap: every row ingested is still there.
    const ids = ingestTelemetry(store, key, 40);
    const surviving = store.listEvents(key, ids.length * 10).filter((e) => e.kind === "test");
    expect(surviving.length).toBe(ids.length);
    expect(store.getEvent(ids[0]!)).not.toBeNull();

    // Half two — the boot SAYS SO, on the banner channel, naming the setting
    // an operator would reach for and the project that is unbounded.
    const disclosure = retentionDisclosure(store);
    expect(disclosure).not.toBeNull();
    // CR-CRU-131 §S1b — the setting that would bound it is the `retention`
    // limit in the server's own file, named BY PATH. It used to be
    // `$CRUCIBLE_DEFAULT_RETENTION`; that variable is retired, and advice
    // naming it would send an operator to a lever that moves nothing.
    expect(disclosure).toContain(serverConfigPath());
    expect(disclosure).toContain(store.getProject(key)!.name);
    // It describes the sweep the store actually performs, rather than a
    // vocabulary copied into a message and left to drift.
    for (const kind of disposableKinds()) {
      expect(disclosure, `the disclosure does not name '${kind}'`).toContain(kind);
    }
  });

  test("the operator's configured fallback silences the disclosure — it is a warning, not a banner line", () => {
    nothingConfigured();
    const store = new Store(":memory:");
    const key = seedProject(store);
    // Non-vacuity: this very store DOES warn while nothing is configured, so
    // the silence below is the fallback's doing and not an inert function.
    expect(retentionDisclosure(store)).not.toBeNull();

    configureFleetCap(9);
    expect(defaultRetention()).toBe(9);
    expect(retentionDisclosure(store)).toBeNull();
    // And the project it would have named is genuinely still uncapped of its
    // own accord — the fallback is what quietened it.
    expect(store.getProject(key)?.retention).toBeUndefined();
  });

  test("a project that configures its own cap is not named, and a board where every project has one stays silent", () => {
    nothingConfigured();
    const store = new Store(":memory:");
    const capped = seedProject(store, undefined, "has-its-own-cap");
    const uncapped = seedProject(store, undefined, "bounded-by-nothing");
    configuredCap(store, capped, 12);

    const withOneUncapped = retentionDisclosure(store);
    expect(withOneUncapped).not.toBeNull();
    // NAMED: the one that is unbounded. The capped one is NOT, or the warning
    // would indict a project that did the right thing and become noise.
    expect(withOneUncapped).toContain(store.getProject(uncapped)!.name);
    expect(withOneUncapped).not.toContain(store.getProject(capped)!.name);

    // `0` is a DECLARED cap, not an absent one (`??`, never `||`) — so
    // configuring it silences the last warning rather than leaving it.
    store.updateProject(uncapped, { retention: 0 });
    expect(store.getProject(uncapped)?.retention).toBe(0);
    expect(retentionDisclosure(store)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// CR-CRU-131 §S3 — the rule is enforced by EXTENDING this scan.
//
// The rule CR-CRU-129 earned for ONE limit is categorical: a limit is
// CONFIGURATION, never a constant compiled into source. Five more limits now
// resolve from a `crucible.toml`, and nothing stops the next author putting a
// number back beside any of them.
//
// This is an EXTENSION of the cap-literal scan above, not a third walker —
// the discipline CR-CRU-128 §S2 established. It reuses that scan's predicate
// (`capLiteralsIn`), its exemption rule (`COMPARISON_OPERAND`), its body
// walker (`retentionPathCode`) and, above all, its SCOPING: BY NAME, to the
// function that resolves the limit. A whole-file scan is a false-positive
// machine — these modules are full of legitimate numbers and a SQL `LIMIT ?`
// is not a limit in this sense. C3's RED measured the cost of the other shape
// on a related predicate: "a file containing a numeric literal at least as
// large as the shipped retention recommendation" selects 118+ files, because
// millisecond constants are everywhere.
//
// TWO grammars, ONE predicate. Three of the six limits are enforced by the
// CLIENTS, in `clients/_crucible_axi.py`, and a scan that read only `src/`
// would hold the rule over half the fleet while reporting green for all of
// it. So the TS walker gains a `file` argument and a Python span reader sits
// beside it; both feed `capLiteralsIn`, which stays the single judge of what
// a cap literal is.
//
// The limit SET is derived from the DECLARATIONS — the package data each
// distribution ships — rather than typed here, so a seventh limit is covered
// the day it is declared. Its count is asserted too: a limit declared with no
// resolution site named below fails, instead of passing unnoticed.
// ═════════════════════════════════════════════════════════════════════════

/** Where the limits are DECLARED: one data file per enforcing process, which
 *  is what the ownership split means in packaging terms. */
const DECLARATION_FILES = ["src/crucible.toml", "clients/crucible.toml"] as const;

interface ResolutionSite {
  /** The file that ENFORCES the limit — repo-root relative. */
  file: string;
  /** The function that produces the limit's number, scoped BY NAME. */
  fn: string;
  language: "ts" | "py";
  /** The configuration call the body must actually MAKE (live code). */
  callee: string;
  /** …resolving THIS limit and not some other one (the call with its name). */
  seam: string;
}

/**
 * The SIX resolution sites, one per declared limit. Named rather than searched
 * for, so a renamed resolver fails here loudly instead of quietly leaving the
 * scan with nothing to read.
 */
const RESOLUTION_SITES: Record<string, ResolutionSite> = {
  run_abandon_ms: {
    file: "src/store.ts",
    fn: "runAbandonAfterMs",
    language: "ts",
    callee: "resolveLimit",
    seam: `resolveLimit("run_abandon_ms")`,
  },
  project_inactive_ms: {
    file: "src/v2.ts",
    fn: "projectInactiveMs",
    language: "ts",
    callee: "resolveLimit",
    seam: `resolveLimit("project_inactive_ms")`,
  },
  // Retention resolves through its own named door rather than by string,
  // because its UNCONFIGURED answer is `undefined` — NO cap — and that
  // exception is a documented behaviour, not a value a generic resolver could
  // return.
  retention: {
    file: "src/store.ts",
    fn: "defaultRetention",
    language: "ts",
    callee: "configuredRetention",
    seam: "configuredRetention()",
  },
  truncate_field_chars: {
    file: "clients/_crucible_axi.py",
    fn: "truncate_field",
    language: "py",
    callee: "resolve_limit",
    seam: `resolve_limit("truncate_field_chars")`,
  },
  error_detail_chars: {
    file: "clients/_crucible_axi.py",
    fn: "no_report_warning",
    language: "py",
    callee: "resolve_limit",
    seam: `resolve_limit("error_detail_chars")`,
  },
  roadmap_list_rows: {
    file: "clients/_crucible_axi.py",
    fn: "truncate_rows",
    language: "py",
    callee: "resolve_limit",
    seam: `resolve_limit("roadmap_list_rows")`,
  },
};

function sourceOf(file: string): string {
  return readFileSync(file, "utf8");
}

/** Every limit NAME the two distributions declare, in declaration order. */
function declaredLimitNames(): string[] {
  const names: string[] = [];
  for (const file of DECLARATION_FILES) {
    const parsed = Bun.TOML.parse(sourceOf(file)) as { limits?: unknown };
    const limits = parsed.limits;
    const tables =
      typeof limits === "object" && limits !== null ? (limits as Record<string, unknown>) : {};
    names.push(...Object.keys(tables));
  }
  return names;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
  return line;
}

/**
 * A module-level Python function as TEXT, from its `def` line to the dedent
 * that ends it.
 *
 * The SIGNATURE is deliberately inside the span: `limit=TRUNCATE_LIMIT`, bound
 * as a default argument at `def` time, is exactly the shape §S1 deleted from
 * two of these three functions, and it is invisible to a scan that starts at
 * the body.
 */
function pythonFunctionSpan(
  source: string,
  name: string,
  file: string,
): { index: number; text: string } {
  const decl = new RegExp(`(?:^|\\n)def\\s+${name}\\s*\\(`).exec(source);
  if (decl === null) {
    throw new Error(
      `§S3: ${file} declares no module-level \`${name}\`. This scan is scoped to the resolvers BY ` +
        `NAME; a renamed resolver must be re-named here, or the scan silently stops guarding it.`,
    );
  }
  const index = decl.index + (source[decl.index] === "\n" ? 1 : 0);
  const lines = source.slice(index).split("\n");
  const span: string[] = [lines[0]!];
  for (let n = 1; n < lines.length; n++) {
    const line = lines[n]!;
    // A non-blank line at column 0 is the next module-level statement.
    if (line.length > 0 && !/^\s/.test(line)) break;
    span.push(line);
  }
  return { index, text: span.join("\n") };
}

/**
 * Python's answer to `retentionPathCode`: `#` comments dropped and string
 * literals dropped (or KEPT, for the seam projection), so the predicate reads
 * CODE and nothing else.
 *
 * Stripping strings is not tidiness here, it is measured: `truncate_field`'s
 * own docstring says "(200)" and `truncate_rows`'s says "(20)", both narrating
 * the constants this CR family deleted. A scan over raw text would report
 * those two forever, and a guard that is always red is a guard nobody reads.
 */
function pythonCodeOnly(text: string, keepStrings: boolean): string {
  const code: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "#") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      code.push("\n");
      continue;
    }
    if (c === '"' || c === "'") {
      const close = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + close.length;
      for (; j < text.length; j++) {
        if (text[j] === "\\") {
          j++;
          continue;
        }
        if (text.startsWith(close, j)) break;
        if (close.length === 1 && text[j] === "\n") break;
      }
      const end = Math.min(j + close.length, text.length);
      if (keepStrings) code.push(text.slice(i, end));
      i = end - 1;
      continue;
    }
    code.push(c);
  }
  return code.join("");
}

interface ScannedResolver {
  /** The resolver as CODE — comments and string contents gone. */
  code: string;
  /** The resolver with its strings intact, so the call it makes still names
   *  the limit it resolves. */
  named: string;
  /** The line the resolver is declared on, so a report is navigable. */
  line: number;
}

function scanResolver(site: ResolutionSite, source: string): ScannedResolver {
  if (site.language === "ts") {
    const decl = tsDeclaration(source, site.fn, site.file);
    const at = decl.index + (source[decl.index] === "\n" ? 1 : 0);
    return {
      code: retentionPathCode(source, site.fn, site.file),
      named: retentionPathCode(source, site.fn, site.file, true),
      line: lineAt(source, at),
    };
  }
  const span = pythonFunctionSpan(source, site.fn, site.file);
  return {
    code: pythonCodeOnly(span.text, false),
    named: pythonCodeOnly(span.text, true),
    line: lineAt(source, span.index),
  };
}

/** A number no limit in this fleet could plausibly be, so a detection is
 *  unambiguous and no real value can produce it by coincidence. */
const REINTRODUCED = 424242;

/** The source as it would read if the next author gave a resolver a literal
 *  fallback again — the defect, planted in memory and never written to disk. */
function withReintroducedLiteral(source: string, site: ResolutionSite): string {
  const at = source.indexOf(site.seam);
  expect(
    at,
    `${site.file} does not contain \`${site.seam}\`, so the mutation has nothing to plant against`,
  ).toBeGreaterThan(-1);
  const planted =
    site.language === "ts"
      ? `(${site.seam} ?? ${String(REINTRODUCED)})`
      : `(${site.seam} or ${String(REINTRODUCED)})`;
  return source.slice(0, at) + planted + source.slice(at + site.seam.length);
}

describe("§S3 — no numeric literal stands in for a configured limit, in either tree", () => {
  test("the limit set is DERIVED from what the two distributions declare, and each of the six has a named resolution site", () => {
    const declared = declaredLimitNames();

    // SIX — the five surviving constants plus retention, whose literal was
    // deleted before this CR and whose FALLBACK this CR moved. Asserted as a
    // count, so a seventh limit declared later fails here rather than shipping
    // with no coverage at all.
    expect(declared.length).toBe(6);
    // Ownership: no limit is declared by both distributions, or "one source
    // per enforcer" would already be two copies.
    expect(new Set(declared).size).toBe(declared.length);

    expect([...Object.keys(RESOLUTION_SITES)].sort()).toEqual([...declared].sort());

    // BOTH trees are covered: three of the six are enforced by the clients,
    // and a scan that read only the server's would report green for a rule it
    // never applied to half the fleet.
    const trees = new Set(Object.values(RESOLUTION_SITES).map((site) => site.file.split("/")[0]!));
    expect([...trees].sort()).toEqual(["clients", "src"]);
  });

  test("no numeric literal stands in for any of the six limits where it is resolved — each site resolves through its configuration seam instead", () => {
    const offenders: string[] = [];
    const scanned: string[] = [];

    for (const [name, site] of Object.entries(RESOLUTION_SITES)) {
      const source = sourceOf(site.file);
      const resolver = scanResolver(site, source);
      const at = `${site.file}:${String(resolver.line)} ${site.fn}`;
      scanned.push(name);

      // NON-VACUITY, per site and in both directions. The body must CALL the
      // configuration seam — a stub, or a body that decided a number for
      // itself, calls nothing — and the call must name THIS limit, so a
      // resolver cannot be wired to another limit's setting and still pass.
      expect(
        resolver.code.includes(site.callee),
        `${at} does not call \`${site.callee}\` — it was read as ${JSON.stringify(resolver.code)}`,
      ).toBe(true);
      expect(
        resolver.named.includes(site.seam),
        `${at} does not resolve \`${name}\`: the call it makes is not \`${site.seam}\``,
      ).toBe(true);

      for (const context of capLiteralsIn(resolver.code)) {
        offenders.push(`${at} (${name}) — ${context}`);
      }
    }

    // The walk was not empty: every declared limit was actually opened.
    expect(scanned.sort()).toEqual([...declaredLimitNames()].sort());

    if (offenders.length > 0) {
      throw new Error(
        `§S3: a numeric literal is standing in for a configured limit — ${offenders.join(" | ")}. ` +
          `A limit is CONFIGURATION, never a constant in source: each of these resolves from the ` +
          `\`[limits.<name>]\` table of the crucible.toml its own process owns, and the shipped ` +
          `default lives in that distribution's package data. A literal nobody configured is a ` +
          `limit nobody was told about, and one of those evicted every release this project had ` +
          `ever shipped.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  test("the scan can SEE a literal in either grammar, and reads code rather than the prose beside it", () => {
    // ── TypeScript ────────────────────────────────────────────────────────
    const tsPlanted = `function probe(): number {\n  return 1800000;\n}\n`;
    expect(capLiteralsIn(retentionPathCode(tsPlanted, "probe", "probe.ts"))).not.toEqual([]);

    const tsResolved =
      `function probe(): number {\n` +
      `  // 1800000 was the compiled default this CR family deleted.\n` +
      `  return resolveLimit("run_abandon_ms");\n}\n`;
    expect(capLiteralsIn(retentionPathCode(tsResolved, "probe", "probe.ts"))).toEqual([]);
    // …and the SEAM projection still knows which limit that body resolved,
    // which is the half a comment alone could otherwise fake.
    expect(retentionPathCode(tsResolved, "probe", "probe.ts", true)).toContain(
      `resolveLimit("run_abandon_ms")`,
    );

    // ── Python ────────────────────────────────────────────────────────────
    const pyCode = (text: string): string =>
      pythonCodeOnly(pythonFunctionSpan(text, "probe", "probe.py").text, false);

    expect(capLiteralsIn(pyCode(`def probe():\n    return 500\n`))).not.toEqual([]);
    // The default-argument shape §S1 deleted is inside the span, not beyond it.
    expect(capLiteralsIn(pyCode(`def probe(value, limit=200):\n    return limit\n`))).not.toEqual(
      [],
    );

    const pyResolved =
      `def probe(value):\n` +
      `    """It was 200, bound at def time, so no operator could reach it."""\n` +
      `    # 200 again, this time in a comment.\n` +
      `    return resolve_limit("truncate_field_chars")\n`;
    expect(capLiteralsIn(pyCode(pyResolved))).toEqual([]);
    expect(pythonCodeOnly(pythonFunctionSpan(pyResolved, "probe", "probe.py").text, true)).toContain(
      `resolve_limit("truncate_field_chars")`,
    );
  });

  test("a literal reintroduced at ANY ONE of the six sites is reported, naming the file, the line and the resolver — proved per limit", () => {
    const detected: string[] = [];

    for (const [name, site] of Object.entries(RESOLUTION_SITES)) {
      const mutated = withReintroducedLiteral(sourceOf(site.file), site);
      const resolver = scanResolver(site, mutated);
      const found = capLiteralsIn(resolver.code);
      if (found.some((context) => context.includes(String(REINTRODUCED)))) {
        detected.push(name);
        continue;
      }
      throw new Error(
        `§S3: a literal fallback planted at ${site.file}:${String(resolver.line)} \`${site.fn}\` ` +
          `(${name}) was NOT reported. The scan is reading ${JSON.stringify(resolver.code)}, so ` +
          `the rule does not hold over that limit and a reintroduced constant would ship green.`,
      );
    }

    // PER LIMIT: every declared limit was mutated, and every mutation was seen.
    expect(detected.sort()).toEqual([...declaredLimitNames()].sort());
  });
});
