// CR-CRU-131 §S1/§S1b — a limit is CONFIGURATION, never a constant compiled
// into source (PRD §4.13, user ruling 2026-09-14). This module is where the
// SERVER's limits live, and the only place they are declared.
//
// The rule was EARNED. `DEFAULT_RETENTION = 100` was a number one author
// chose, reachable by nobody, and on 2026-09-13 it evicted every release this
// project had ever shipped (PRD §4.7). CR-CRU-129 deleted that one rather than
// resizing it; this module gives the rest of the server's limits the
// configuration channel whose absence made that defect possible.
//
// ── OWNERSHIP follows ENFORCEMENT ─────────────────────────────────────────
//
// A limit belongs to the process that ENFORCES it, because the two processes
// are not necessarily on the same machine: the server resolves its own
// database and may be installed anywhere, while a client resolves a PROJECT
// DIRECTORY and then posts over HTTP. So the server's three limits live in a
// `crucible.toml` beside its own database, found by the SAME rule that finds
// the database ({@link resolveStore}), and the clients' three display limits
// live in the project directory's `crucible.toml`, loaded by the mirror of
// this module in `clients/_crucible_axi.py`. Neither process reads the other's
// file: one schema, one loader shape, two locations.
//
// ── The four fields are DOCUMENTATION; `value` is the operator's setting ───
//
// `description`, `recommended`, `min` and `max` are IMMUTABLE documentation.
// The operator's own choice is a SEPARATE, OPTIONAL `value` in the same table.
// An operator who instead overwrote `recommended` in place would destroy, in
// the very file they read, the record of what we recommend — and would be one
// upgrade away from not knowing whose number is in front of them.
//
// Keeping the two in ONE table is also what makes the range enforceable from
// the data that documents it: the validator reads `min`/`max` off the very
// table the operator edits, so the documented bound and the enforced bound
// cannot drift into two copies.
//
// ── READ AT THE POINT OF USE, never imported ──────────────────────────────
//
// Measured on bun 1.3.14, 2026-09-14: `(await import(p)).default.limits
// .run_abandon_ms.recommended` returned the OLD number both BEFORE and AFTER
// the file was rewritten, while re-reading the path saw the new one. A static
// `import cfg from "./crucible.toml"` therefore caches the table and silently
// breaks the no-restart contract `runAbandonAfterMs()` has kept since
// CR-CRU-017. Every entry point below re-reads the file.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { resolveStore } from "./server.ts";

/**
 * §S1b — one limit as an operator meets it: four fields of documentation and,
 * only where they have set one, their own `value`.
 */
export interface LimitDeclaration {
  /** What the limit governs, in a sentence an operator can act on. */
  description: string;
  /** The value we ship and stand behind. Never rewritten to express a choice. */
  recommended: number;
  /** The floor outside which a value is not supportable. */
  min: number;
  /** The ceiling outside which a value is not supportable. */
  max: number;
  /** The OPERATOR's own setting. Absent from every shipped declaration. */
  value?: number;
}

/**
 * The limits the SERVER enforces, by their OWN names — not transliterations of
 * the retired constants, which would carry an accident of the old source into
 * the file an operator reads.
 *
 * THREE, not four: `TOON_MAX_BYTES` is deliberately absent because CR-CRU-132
 * deletes the feature it bounds (CR-CRU-131 Risk).
 */
export const SERVER_LIMIT_NAMES: readonly string[] = [
  "run_abandon_ms",
  "project_inactive_ms",
  "retention",
];

/**
 * §S1c — the PACKAGE DATA table: the last resort, readable without the
 * operator's file being present or even valid. Every `recommended` here is
 * today's compiled value, so an install with no `crucible.toml` behaves
 * EXACTLY as it did before this CR — which is the whole safety argument for a
 * configuration change of this reach.
 *
 * `min`/`max` are a SUPPORTABILITY judgement, so each states its reasoning: a
 * bound nobody can justify is the same defect as a default nobody chose.
 */
const SHIPPED: Readonly<Record<string, LimitDeclaration>> = {
  run_abandon_ms: {
    description:
      "Milliseconds an OPEN run may live before the sweep settles it as `abandoned`. Raise it " +
      "when a legitimate suite runs longer than the deadline; lower it to clear ghost runs off " +
      "the board sooner.",
    recommended: 1_800_000,
    // A one-second deadline abandons every live run, so the floor is more than
    // "positive": a minute is shorter than any suite this fleet reports on.
    min: 60_000,
    // A day. Past it an open run is not "still going", it is a row nobody will
    // ever settle.
    max: 86_400_000,
  },
  project_inactive_ms: {
    description:
      "Milliseconds of silence after which a project with no live agent reads INACTIVE on the " +
      "board's project list. Raise it to keep occasional projects visible; lower it to retire " +
      "finished ones from the default view sooner.",
    recommended: 3_600_000,
    // The default agent TOMBSTONE horizon (`DEFAULT_LIVENESS`, src/types.ts): a
    // window shorter than that would call a project inactive while its own
    // agents still read as live, which is a verdict the board cannot honour.
    min: 300_000,
    // Thirty days, past which "inactive" has stopped distinguishing anything.
    max: 2_592_000_000,
  },
  retention: {
    description:
      "Events kept per project for projects that declare no `retention` of their own. NOTE the " +
      "documented exception: with NO crucible.toml at all there is NO cap and the boot banner " +
      "names the uncapped projects — this number applies only once the table exists.",
    // The value this fleet actually runs at, carried forward from CR-CRU-129's
    // close-out rather than invented, so adopting the file changes no cap.
    recommended: 5_000,
    // Ten events still leaves one run's own history readable; beneath that a
    // board evicts what it has only just ingested.
    min: 10,
    // A million rows for one project is where disk, not usefulness, binds.
    max: 1_000_000,
  },
};

/** The server's own configuration file, beside the database it already resolves. */
export function serverConfigPath(): string {
  return path.join(path.dirname(resolveStore().path), "crucible.toml");
}

interface ConfigRead {
  /** The file the server would read, whether or not it is there. */
  file: string;
  /**
   * The `[limits.*]` tables, or `null` when the file is ABSENT or does not
   * parse — which is the operator having configured NOTHING. Only retention
   * treats that differently from a legal-but-unset limit (§S1b).
   */
  tables: Record<string, unknown> | null;
}

/** One read of the file, at the point of use. Never cached — see the header. */
function readServerConfig(): ConfigRead {
  const file = serverConfigPath();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { file, tables: null };
  }
  try {
    const parsed = Bun.TOML.parse(text) as { limits?: unknown };
    const limits = parsed?.limits;
    return {
      file,
      tables:
        typeof limits === "object" && limits !== null ? (limits as Record<string, unknown>) : {},
    };
  } catch {
    return { file, tables: null };
  }
}

/**
 * One limit as the file leaves it: the shipped declaration with whichever
 * fields the operator's table actually supplies laid over it. A field of the
 * wrong TYPE is ignored rather than obeyed — a `min` that is a string is a
 * bound nothing can enforce.
 */
function declaredFrom(shipped: LimitDeclaration, table: unknown): LimitDeclaration {
  const out: LimitDeclaration = { ...shipped };
  if (typeof table !== "object" || table === null) return out;
  const t = table as Record<string, unknown>;
  if (typeof t.description === "string") out.description = t.description;
  if (typeof t.recommended === "number" && Number.isFinite(t.recommended)) {
    out.recommended = t.recommended;
  }
  if (typeof t.min === "number" && Number.isFinite(t.min)) out.min = t.min;
  if (typeof t.max === "number" && Number.isFinite(t.max)) out.max = t.max;
  if (typeof t.value === "number" && Number.isFinite(t.value)) out.value = t.value;
  return out;
}

/**
 * §S1b — the refusal an out-of-range `value` owes its operator: the limit, the
 * offending value, the range it crossed and the setting that is running
 * instead. REFUSED, never clamped — a clamp leaves the operator's stated
 * intent and the running behaviour different with nothing saying so.
 */
function refusalLine(name: string, d: LimitDeclaration, file: string): string {
  return (
    `[crucible] WARNING: ${file} sets \`${name}\` to ${d.value}, outside the range ` +
    `[${d.min}, ${d.max}] declared beside it — the value is REFUSED, not clamped, so ` +
    `\`${name}\` runs at its recommended ${d.recommended} until the file is corrected.`
  );
}

/**
 * What a file could not be read at all costs the operator to know. Named by
 * PATH: told only that "a config file is broken", on a machine carrying two of
 * them, an operator learns nothing.
 */
function unreadableLine(file: string): string {
  return (
    `[crucible] WARNING: no readable configuration at ${file} — it is absent or does not parse, ` +
    `so every bound this server enforces runs at the value the build recommends. Create the ` +
    `file (or correct its TOML) to configure them.`
  );
}

/** The value a declaration resolves to, and the refusal it owes, in one pass. */
function effective(
  name: string,
  d: LimitDeclaration,
  file: string,
): { value: number; refusal: string | null } {
  if (d.value === undefined) return { value: d.recommended, refusal: null };
  if (d.value >= d.min && d.value <= d.max) return { value: d.value, refusal: null };
  return { value: d.recommended, refusal: refusalLine(name, d, file) };
}

function assertServerLimit(name: string): void {
  if (!SERVER_LIMIT_NAMES.includes(name)) {
    throw new Error(
      `CR-CRU-131 §S1b: \`${name}\` is not a limit this server enforces ` +
        `(${SERVER_LIMIT_NAMES.join(", ")}). A limit is owned by the process that ENFORCES it, ` +
        `and the clients are not necessarily on this machine — the display limits resolve from ` +
        `the PROJECT's crucible.toml through clients/_crucible_axi.py, never from here.`,
    );
  }
}

/**
 * §S1c — the shipped declarations, as data. Fresh copies, so a caller cannot
 * edit the package's own documentation by accident.
 */
export function shippedLimits(): Record<string, LimitDeclaration> {
  const table: Record<string, LimitDeclaration> = {};
  for (const name of SERVER_LIMIT_NAMES) table[name] = { ...SHIPPED[name]! };
  return table;
}

/**
 * The declarations in EFFECT: the operator's file where it parses, the shipped
 * table otherwise. A table for a limit this server does not enforce is IGNORED
 * rather than adopted — the ownership split is enforced in both directions.
 */
export function limitDeclarations(): Record<string, LimitDeclaration> {
  const { tables } = readServerConfig();
  const table = shippedLimits();
  if (tables === null) return table;
  for (const name of SERVER_LIMIT_NAMES) table[name] = declaredFrom(table[name]!, tables[name]);
  return table;
}

/**
 * §S1/§S1b — the number a limit RUNS at: the operator's `value` when the range
 * beside it admits one, its `recommended` otherwise.
 *
 * Throws only for an unknown or FOREIGN limit name, which is a programming
 * error rather than an operator error. A bad FILE never throws: the server has
 * to boot on a machine whose `crucible.toml` someone has just mistyped.
 */
export function resolveLimit(name: string): number {
  assertServerLimit(name);
  const { tables, file } = readServerConfig();
  const shipped = SHIPPED[name]!;
  const d = tables === null ? { ...shipped } : declaredFrom(shipped, tables[name]);
  return effective(name, d, file).value;
}

/**
 * §S1b — everything the current file owes its operator: one line per refused
 * `value`, or one line naming a file that could not be read at all.
 *
 * Stateless and recomputed from the file, mirroring `retentionDisclosure()`
 * (src/server.ts) rather than inventing a drainable buffer: a disclosure that
 * had to be drained would be a disclosure that could be missed.
 */
export function limitDisclosures(): string[] {
  const { tables, file } = readServerConfig();
  if (tables === null) return [unreadableLine(file)];
  const lines: string[] = [];
  for (const name of SERVER_LIMIT_NAMES) {
    const { refusal } = effective(name, declaredFrom(SHIPPED[name]!, tables[name]), file);
    if (refusal !== null) lines.push(refusal);
  }
  return lines;
}

/**
 * §S1b — retention's DOCUMENTED exception, and the distinction is sharp.
 *
 * An ABSENT or MALFORMED file means the operator configured NOTHING, so
 * retention keeps CR-CRU-129's semantics: `undefined` — NO cap — and the boot
 * disclosure names the uncapped projects. Keeping more events costs disk, and
 * unbounded is the honest answer when nobody has asked for a cap.
 *
 * An OUT-OF-RANGE `value` is a different fact: the operator configured
 * something ILLEGAL. That is refused, falls back to `recommended`, and is
 * disclosed — exactly like the other two. The other two have no such split.
 */
export function configuredRetention(): number | undefined {
  const { tables, file } = readServerConfig();
  if (tables === null) return undefined;
  const table = tables.retention;
  if (typeof table !== "object" || table === null) return undefined;
  return effective("retention", declaredFrom(SHIPPED.retention!, table), file).value;
}
