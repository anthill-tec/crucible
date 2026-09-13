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
import { readFileSync } from "node:fs";
import { Store, defaultRetention } from "../src/store.ts";
import * as storeModule from "../src/store.ts";
import { retentionDisclosure } from "../src/server.ts";
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
 * The body of a named function with comments and string CONTENTS removed, so
 * the scan reads CODE and nothing else. Without this, `CR-CRU-013` in a
 * comment and a `LIMIT ?` in SQL both read as source the guard must judge.
 *
 * Written as one pass rather than as regexes because brace-matching a body
 * requires knowing where the strings are anyway.
 */
function retentionPathCode(source: string, name: string): string {
  const decl = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:private\\s+)?(?:static\\s+)?(?:function\\s+)?${name}\\s*\\(`).exec(
    source,
  );
  if (decl === null) {
    throw new Error(
      `CR-CRU-129 §S2: src/store.ts declares no \`${name}\`. The constructional guard against a ` +
        `hardcoded cap is scoped to the retention path BY NAME; a renamed function must be ` +
        `re-named here, or the scan silently stops guarding anything.`,
    );
  }
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
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++;
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

function capLiteralsIn(code: string): string[] {
  const found: string[] = [];
  const literal = /(?<![\w$.])(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/g;
  for (const match of code.matchAll(literal)) {
    const before = code.slice(Math.max(0, match.index - 8), match.index);
    if (COMPARISON_OPERAND.test(before)) continue;
    const from = Math.max(0, match.index - 40);
    found.push(code.slice(from, match.index + match[0].length + 20).replace(/\s+/g, " ").trim());
  }
  return found;
}

describe("CR-CRU-129 §S2 — retention reaches only the disposable kinds", () => {
  const restoreEnv: Array<[string, string | undefined]> = [];

  afterEach(() => {
    while (restoreEnv.length > 0) {
      const [name, value] = restoreEnv.pop()!;
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function setEnv(name: string, value: string): void {
    restoreEnv.push([name, process.env[name]]);
    process.env[name] = value;
  }

  /** The UNCONFIGURED state — the one AC6 is about, and the one an inherited
   *  environment would otherwise hide. */
  function clearEnv(name: string): void {
    restoreEnv.push([name, process.env[name]]);
    delete process.env[name];
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
  // below it already has one ($CRUCIBLE_RUN_ABANDON_MS, src/store.ts:696-700,
  // "read per sweep, not cached: the deadline is operational configuration").
  // Same rule, same mechanism, and this test pins no value of its own: it
  // configures one and asserts the store honoured THAT.
  // ─────────────────────────────────────────────────────────────────────────
  test("a project that configures no cap of its own takes the operator's configured default, not a constant compiled into the source", () => {
    setEnv("CRUCIBLE_DEFAULT_RETENTION", "9");
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
    setEnv("CRUCIBLE_DEFAULT_RETENTION", "9");
    const store = new Store(":memory:");
    const key = seedProject(store);
    ingestTelemetry(store, key, 40);

    setEnv("CRUCIBLE_DEFAULT_RETENTION", "4");
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
    const bodies = RETENTION_PATH.map((name) => retentionPathCode(source, name));
    for (const [index, body] of bodies.entries()) {
      expect(body.length, `${RETENTION_PATH[index]} scanned as empty`).toBeGreaterThan(40);
    }
    expect(capLiteralsIn("const cap = project.retention ?? 100;")).not.toEqual([]);

    const offenders = RETENTION_PATH.flatMap((name, index) =>
      capLiteralsIn(bodies[index]!).map((context) => `${name}: ${context}`),
    );
    if (offenders.length > 0) {
      throw new Error(
        `CR-CRU-129 §S2: a numeric literal is standing in for a retention cap in the retention ` +
          `path — ${offenders.join(" | ")}. A limit is CONFIGURATION, never a constant in ` +
          `source: the per-project value is \`projects.retention\` and its fallback is ` +
          `$CRUCIBLE_DEFAULT_RETENTION. \`DEFAULT_RETENTION = 100\` was deleted rather than ` +
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
    clearEnv("CRUCIBLE_DEFAULT_RETENTION");
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
    expect(disclosure).toContain("CRUCIBLE_DEFAULT_RETENTION");
    expect(disclosure).toContain(store.getProject(key)!.name);
    // It describes the sweep the store actually performs, rather than a
    // vocabulary copied into a message and left to drift.
    for (const kind of disposableKinds()) {
      expect(disclosure, `the disclosure does not name '${kind}'`).toContain(kind);
    }
  });

  test("the operator's configured fallback silences the disclosure — it is a warning, not a banner line", () => {
    clearEnv("CRUCIBLE_DEFAULT_RETENTION");
    const store = new Store(":memory:");
    const key = seedProject(store);
    // Non-vacuity: this very store DOES warn while nothing is configured, so
    // the silence below is the fallback's doing and not an inert function.
    expect(retentionDisclosure(store)).not.toBeNull();

    setEnv("CRUCIBLE_DEFAULT_RETENTION", "9");
    expect(defaultRetention()).toBe(9);
    expect(retentionDisclosure(store)).toBeNull();
    // And the project it would have named is genuinely still uncapped of its
    // own accord — the fallback is what quietened it.
    expect(store.getProject(key)?.retention).toBeUndefined();
  });

  test("a project that configures its own cap is not named, and a board where every project has one stays silent", () => {
    clearEnv("CRUCIBLE_DEFAULT_RETENTION");
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
