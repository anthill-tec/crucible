// CR-CRU-099 §S2/AC5 — THE ACCEPTED-FIELD GUARD.
//
// An accepted field the handler never reads is INDISTINGUISHABLE FROM SUCCESS
// at the call site: the caller sends it, the route answers 200, the store
// keeps nothing. That is how a declared `release` was dropped by the bulk
// queue post from the day CR-CRU-078 started declaring one — no error, no
// warning, no red test, a row that is a member of no release. §S2 says the
// defect is a CLASS, not one bug, so this file makes the next dropped column
// a test failure instead of an invisible row.
//
// ── THE DENOMINATOR, NAMED ─────────────────────────────────────────────────
//
// The keys this guard demands the route read are exactly the PROPERTY NAMES
// OF THE EXPORTED `QueueEntryInput` INTERFACE (src/store.ts), parsed from the
// interface body with its comments blanked. Nothing else is the denominator —
// not the fields some client happens to send, not a documented field list
// (there is none: src/hints.ts names the endpoint and no field of it), not
// the store's COLUMNS (`queue_entries` also holds `filed_at`, which no caller
// declares). §S2 chose that interface for the reason that it is the declared,
// exported, machine-readable statement of what `replaceQueue` accepts, so a
// key added to it is a key the route is thereafter obliged to forward.
//
// The denominator is deliberately NOT pinned to a number or a list. A pinned
// list would have to be edited by the same commit that adds a key — which is
// the commit that would forget it. It is checked for non-vacuity instead (a
// parse that yielded nothing would otherwise pass this guard trivially), and
// anchored on the three keys the CR is about, so the guard cannot be
// satisfied by DELETING a declaration rather than reading it.
//
// ── THE NUMERATOR, NAMED ───────────────────────────────────────────────────
//
// "The keys the handler reads" is derived as: within `handleQueuePost`'s own
// body, with comments blanked, a dereference of the posted-entry object by
// that key — `fields.release`, or `fields["release"]`. The binding name is
// not hardcoded: it is read off the handler's own narrowing line
// (`const fields = raw as Record<string, unknown>`), which is the point where
// untyped request JSON becomes readable, i.e. §S2's "boundary where authored
// data enters".
//
// ── WHAT THIS DERIVATION CANNOT SEE, stated rather than implied ────────────
//
// 1. A key read by DESTRUCTURING (`const { release } = fields`) or by a
//    computed key (`fields[name]`) is not seen, and would be reported as
//    unread. That direction is loud: it fails in the commit that introduces
//    it, at which point the reader either restores a plain dereference or
//    teaches this guard the new shape. The opposite direction — a read this
//    scan invents — cannot happen, because a literal `fields.<key>` in live
//    code IS a read.
// 2. THE ONE SILENT HOLE, MEASURED, NOT ASSUMED: a key that is READ AND THEN
//    DISCARDED — validated at the top of the loop, left off the object that
//    is pushed — satisfies this guard. So what is enforced here is that the
//    handler MENTIONS every declared key; the defect class §S2 names is that
//    it STORES every declared key, and a mentioned-but-unstored field is
//    exactly as indistinguishable from success as an unmentioned one. This
//    guard would NOT have caught this CR's own bug had the route merely
//    validated `release` and dropped it.
//    Measured against the real route on 2026-09-03, one key at a time:
//      * deleting ONLY `track`'s forwarding spread, leaving the AC4a
//        validation that reads `fields.track` — guard GREEN, 7/7
//        (run-9bb593a3-4df8-43c6-b2f8-820d62b75207);
//      * deleting that validation as well — guard FIRES by name
//        (run-ec83722b-3c38-4fa8-903f-5a6ff5c42329);
//      * `lifecycle` behaves identically (spread only: GREEN,
//        run-0f20ebdf-693c-4415-bdf6-0ac13d7d7cd5; whole handling:
//        FIRES, run-774779c2-8efe-4674-9f4a-efcb4dbd1627);
//      * `release` is the clean case only because it has no validation of
//        its own — its single appearance IS the forwarding, so deleting the
//        forwarding fires the guard (run-1c9ff695-bdbd-4bad-9c46-36a7cbd865cb).
//    A NAMED limit is worth more than a silent one, which is why it is here
//    rather than in a report nobody re-reads. What covers the gap today is
//    behavioural, not lexical: AC1/AC4's round trips in
//    tests/queue-registration.test.ts prove today's keys reach the STORE and
//    come back byte-identically. This file is the FORWARD guarantee — the
//    key nobody has written a round trip for yet — and those tests are the
//    value guarantee. Neither replaces the other, and closing this hole is a
//    decision that was referred UP (it needs the pushed object literal
//    identified structurally), not one taken here.
// 3. A key accepted by `replaceQueue` WITHOUT being declared on the interface
//    would be invisible, because the interface is the denominator. There is
//    no such key today (the type carries no index signature).
// 4. The handler's body is delimited by its own column-0 closer. A slip in
//    that delimiter can only SHORTEN the body, which makes reads disappear
//    and the guard shout; over-running it is asserted against directly (the
//    extracted body may contain no second top-level declaration), because
//    THAT direction would hide a dropped field behind a neighbouring
//    function's code.
//
// ── IT EXTENDS, IT DOES NOT REINVENT ───────────────────────────────────────
//
// The prose-vs-code discrimination comes from tests/helpers/source-scan.ts —
// `jsLiveCode`, added there by this CR as the COMPLEMENT of the inert layer
// the `jsCommentRuns` lexer in that file already walked, never as a second
// walk of the same grammar. It is load-bearing here, not decorative, and
// BOTH halves of it were bought by a failing self-test rather than assumed:
//   * `handleQueuePost` carries a comment naming `fields.release` two lines
//     above the code that reads it, so a raw-text scan would keep reporting
//     that field as read long after the read itself was deleted;
//   * a field named inside a STRING (`"send fields.track to declare a lane"`)
//     reads identically to a dereference in raw text — the first draft of
//     this guard blanked comments only and its own planted fixture caught
//     that, which is the CR-CRU-096 defect in mirror image.
// A template literal's `${...}` interiors are live code and stay standing,
// so the handler's own `${String(fields.track)}` still reads as a
// dereference — the discrimination is prose-vs-code, not quote-vs-no-quote.
// The self-test below plants both shapes and requires both to be reported
// unread.
//
// WHY A THIRD FILE, and not a `describe` bolted onto one of the two existing
// source-scanning guards: tests/docs-retired-mirror-references.test.ts owns
// "prose that cites something that no longer exists" and
// tests/project-namespace-tripwire.test.ts owns "one project's CR ids leaking
// into another's shipped surfaces". Both read the tree's COMMENTS and hold
// their own dated residue tables and carve-out vocabularies. This guard reads
// the tree's CODE, holds no residue, and its subject is a route-vs-type
// contract in `src/` — sharing a file would mean sharing an exemption
// vocabulary that means nothing here. What is shared is the machinery, which
// is the thing §S6 said to share.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT, balancedEnd, jsLiveCode, unnestedEnd } from "./helpers/source-scan";

const TYPE_FILE = "src/store.ts";
const TYPE_NAME = "QueueEntryInput";
const HANDLER_FILE = "src/v2.ts";
const HANDLER_NAME = "handleQueuePost";

// Anchors that must appear inside each extracted body. They are non-vacuity
// checks, not behaviour claims: `store.replaceQueue` is the call this whole
// guard is about (a "handler body" that does not contain it is not the
// handler), and the two REQUIRED interface keys pin the interface likewise.
const HANDLER_ANCHOR = "store.replaceQueue";
const REQUIRED_KEYS = ["cr", "wave"] as const;

// The three keys this CR wired. Anchored so the guard cannot be satisfied by
// removing a declaration instead of reading it — deleting `release?` from the
// interface would otherwise make its own criterion vacuous.
const DECLARED_HALF = ["release", "track", "lifecycle"] as const;

function readSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

interface Block {
  /** Offset of the declaration's first character in the whole file. */
  start: number;
  /** The declaration through its column-0 closing brace, prose blanked. */
  body: string;
  line: number;
}

// A TOP-LEVEL declaration's text, from its opener to the `}` that starts a
// line. `src/` is hand-written and indented, so a column-0 brace inside a
// top-level declaration does not occur; the risk is handled by assertion
// rather than by trust (see blind spot 4 above and the structural tests
// below), and the residual failure mode is a body too SHORT, which reports
// more rather than less.
function blockOf(code: string, opener: RegExp, what: string): Block {
  const match = opener.exec(code);
  if (match === null) {
    throw new Error(
      `${what} was not found in the source this guard reads — the guard's subject moved or ` +
        `was renamed, so nothing was checked; re-point it rather than deleting it`,
    );
  }
  const closer = code.indexOf("\n}", match.index);
  const end = closer === -1 ? code.length : closer + 2;
  return { start: match.index, body: code.slice(match.index, end), line: lineAt(code, match.index) };
}

interface Declared {
  key: string;
  line: number;
}

// Every property name declared by the interface: an indented `name:` or
// `name?:` at the start of a line of the interface body. Prose is already
// blanked when this runs, so a JSDoc line that happens to spell `release?:`
// contributes nothing — the blanking leaves whitespace, which cannot match.
// A nested object-typed member would be read as a key of its own, which
// over-reports and therefore fails loudly; the interface has none today.
const DECLARED_KEY = /^[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)\??[ \t]*:/gm;

function declaredKeys(typeCode: string): Declared[] {
  const block = blockOf(
    typeCode,
    new RegExp(`^export interface ${TYPE_NAME} \\{`, "m"),
    `interface ${TYPE_NAME} (${TYPE_FILE})`,
  );
  const keys: Declared[] = [];
  for (const match of block.body.matchAll(DECLARED_KEY)) {
    keys.push({ key: match[1]!, line: lineAt(typeCode, block.start + match.index!) });
  }
  const missing = REQUIRED_KEYS.filter((key) => !keys.some((k) => k.key === key));
  if (missing.length > 0) {
    throw new Error(
      `the parse of interface ${TYPE_NAME} (${TYPE_FILE}) yielded ${keys.length} key(s) and is ` +
        `missing ${missing.map((k) => `\`${k}\``).join(", ")} — an empty or partial denominator ` +
        `would make this guard pass trivially, so it refuses to run on one`,
    );
  }
  return keys;
}

// The handler's own name for the posted entry object, read off the line where
// untyped request JSON becomes readable. Derived rather than hardcoded so the
// failure of a rename is a NAMED failure here instead of nine phantom
// "unread" findings.
const FIELDS_BINDING = /const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*raw\s+as\s+Record<\s*string\s*,\s*unknown\s*>/;

function handlerBlock(handlerCode: string): Block {
  const block = blockOf(
    handlerCode,
    new RegExp(`^(?:export )?async function ${HANDLER_NAME}\\(`, "m"),
    `${HANDLER_NAME} (${HANDLER_FILE})`,
  );
  if (!block.body.includes(HANDLER_ANCHOR)) {
    throw new Error(
      `the extracted body of ${HANDLER_NAME} (${HANDLER_FILE}:${block.line}) does not contain ` +
        `\`${HANDLER_ANCHOR}\` — the delimiter stopped short of the handler's own closer, so a ` +
        `field read beyond that point would be invisible to this guard`,
    );
  }
  return block;
}

function fieldsBinding(handlerBody: string): string {
  const match = FIELDS_BINDING.exec(handlerBody);
  if (match === null) {
    throw new Error(
      `${HANDLER_NAME} (${HANDLER_FILE}) no longer narrows the posted entry with ` +
        `\`raw as Record<string, unknown>\`, so this guard cannot tell which object a field is ` +
        `read from; teach it the new narrowing rather than letting it report every key unread`,
    );
  }
  return match[1]!;
}

// A read of `key` off the posted entry: dot access or a quoted index. Both
// spellings, because either one IS a read and a guard that recognised only
// the first would be satisfiable by re-spelling the drop.
function readsField(handlerBody: string, binding: string, key: string): boolean {
  const dot = new RegExp(`\\b${binding}\\.${key}\\b`);
  const indexed = new RegExp(`\\b${binding}\\[\\s*(['"])${key}\\1\\s*\\]`);
  return dot.test(handlerBody) || indexed.test(handlerBody);
}

// Every name this file interpolates into a regex — a declared key, the fields
// binding, the writer's own dotted call — comes from the source being
// scanned, so it is escaped rather than trusted: `$` is legal in an
// identifier and `.` is the whole point of `store.replaceQueue`.
function escaped(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── THE OBJECT HANDED TO THE WRITER, LOCATED STRUCTURALLY ──────────────────
//
// CR-CRU-104 §S3. Never by line number and never by the shape of one field's
// forwarding: the writer call names the array it is handed, the pushes into
// that array name the literals, and the lifted `balancedEnd` walks each
// argument to its own closer.

// The array `replaceQueue` is handed. Read off the call rather than
// hardcoded, for the same reason the fields binding is: a rename must be a
// NAMED failure here, not nine phantom findings.
const WRITER_CALL = new RegExp(
  `${escaped(HANDLER_ANCHOR)}\\(\\s*[A-Za-z_$][A-Za-z0-9_$]*\\s*,\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\)`,
);

function writerSink(handlerBody: string): string {
  const match = WRITER_CALL.exec(handlerBody);
  if (match === null) {
    throw new Error(
      `${HANDLER_NAME} (${HANDLER_FILE}) no longer hands \`${HANDLER_ANCHOR}\` a named array of ` +
        `entries, so this guard cannot tell which object reaches the store; teach it the new ` +
        `write shape rather than letting it report every key forwarded`,
    );
  }
  return match[1]!;
}

type Span = [number, number];

// Every object literal pushed into that array, as spans over `handlerBody`.
// Both directions of a mis-derivation are refused rather than trusted: a span
// that swallowed the writer call has OVER-RUN its closer, which is the silent
// direction (it would show a property the pushed literal never had), and a
// body with no push site at all is not a handler this guard can read.
function pushedObjects(handlerBody: string, sink: string): Span[] {
  const opener = new RegExp(`\\b${escaped(sink)}\\.push\\(`, "g");
  const spans: Span[] = [];
  for (const match of handlerBody.matchAll(opener)) {
    const open = match.index! + match[0].length - 1;
    const end = balancedEnd(handlerBody, open);
    const span: Span = [open + 1, end - 1];
    if (handlerBody.slice(span[0], span[1]).includes(HANDLER_ANCHOR)) {
      throw new Error(
        `the extracted span of \`${sink}.push(...)\` in ${HANDLER_NAME} (${HANDLER_FILE}) ` +
          `contains \`${HANDLER_ANCHOR}\` — it over-ran the argument's own closer, so a property ` +
          `the pushed object never carried could stand in for a forwarded field`,
      );
    }
    spans.push(span);
  }
  if (spans.length === 0) {
    throw new Error(
      `${HANDLER_NAME} (${HANDLER_FILE}) pushes nothing into \`${sink}\`, the array it hands ` +
        `\`${HANDLER_ANCHOR}\` — this guard reads the pushed object literal, so a different ` +
        `way of filling that array must be taught to it rather than silently unchecked`,
    );
  }
  return spans;
}

interface Property {
  /** Offset within the span, leading whitespace included. */
  start: number;
  /** Offset just past it, a trailing comma included. */
  end: number;
  /** What the key is bound to: the value expression, or the key itself when shorthand. */
  value: string;
}

// A property NAMED `key` in an object-literal span — `key: <expr>`, or the
// SHORTHAND `key` that binds a local of the same name, which is the shape the
// handler uses for all three fields this CR is about. Anchored on the `{` or
// `,` that can precede a property NAME so a VALUE that happens to be an
// identifier of that name (`{ lane: track }`) is never read as one.
function propertiesNamed(span: string, key: string): Property[] {
  const at = new RegExp(`(?<=^|[{,])\\s*${escaped(key)}\\s*(?::|(?=[,}])|$)`, "g");
  const found: Property[] = [];
  for (const match of span.matchAll(at)) {
    const start = match.index!;
    const after = start + match[0].length;
    if (!match[0].endsWith(":")) {
      found.push({ start, end: after, value: key });
      continue;
    }
    const close = unnestedEnd(span, after, ",;");
    const rest = span.slice(close).search(/\S/);
    const end = rest !== -1 && span[close + rest] === "," ? close + rest + 1 : close;
    found.push({ start, end, value: span.slice(after, close) });
  }
  return found;
}

// Removes `key` as a PROPERTY of the object handed to the writer, and nothing
// else: every validation of it, every local binding of it and every other
// property stay exactly where they were. This is §S3's mutation — the
// deletion that dropped a declared field again while this guard stayed green
// — applied to the REAL handler source, so the claim is made about the code
// that ships. Offset-safe because the live-code projection the spans are
// found in is byte-for-byte as long as the file it came from.
function withoutForwardingOf(handlerCode: string, key: string): string {
  const block = handlerBlock(jsLiveCode(handlerCode));
  const sink = writerSink(block.body);
  const cuts: Span[] = [];
  for (const [start, end] of pushedObjects(block.body, sink)) {
    for (const property of propertiesNamed(block.body.slice(start, end), key)) {
      cuts.push([block.start + start + property.start, block.start + start + property.end]);
    }
  }
  if (cuts.length === 0) {
    throw new Error(
      `\`${key}\` is not a property of the object ${HANDLER_NAME} (${HANDLER_FILE}) hands to ` +
        `\`${HANDLER_ANCHOR}\`, so there is no forwarding of it to delete — the field this ` +
        `mutation exists to drop is already dropped`,
    );
  }
  let mutated = handlerCode;
  for (const [start, end] of [...cuts].reverse()) {
    mutated = mutated.slice(0, start) + mutated.slice(end);
  }
  return mutated;
}

export interface UnreadField {
  key: string;
  message: string;
}

// THE CHECKER, as a pure function of the two source texts, so the self-tests
// below can plant a shape without touching a real file and the mutation tests
// can delete a read without touching `src/`.
export function unreadAcceptedFields(typeCode: string, handlerCode: string): UnreadField[] {
  const type = jsLiveCode(typeCode);
  const handler = jsLiveCode(handlerCode);
  const block = handlerBlock(handler);
  const binding = fieldsBinding(block.body);
  const unread: UnreadField[] = [];
  for (const declared of declaredKeys(type)) {
    if (readsField(block.body, binding, declared.key)) continue;
    unread.push({
      key: declared.key,
      message:
        `${TYPE_NAME} declares \`${declared.key}\` (${TYPE_FILE}:${declared.line}) but ` +
        `${HANDLER_NAME} (${HANDLER_FILE}:${block.line}) never reads ` +
        `\`${binding}.${declared.key}\` — the route accepts that field, answers 200 and drops ` +
        `it, which is indistinguishable from success at the call site`,
    });
  }
  return unread;
}

// Removes every read of `key` from a handler text — the mutation that stands
// in for "the field was dropped again", applied to the REAL handler source so
// the sensitivity claim is made about the code that ships, not about a
// fixture. The replacement keeps a dereference of the same binding (so the
// narrowing line and the surrounding grammar are untouched) and spells a name
// no interface declares.
function withoutReadsOf(handlerCode: string, binding: string, key: string): string {
  return handlerCode
    .replace(new RegExp(`\\b${binding}\\.${key}\\b`, "g"), `${binding}.__dropped__`)
    .replace(new RegExp(`\\b${binding}\\[\\s*(['"])${key}\\1\\s*\\]`, "g"), `${binding}.__dropped__`);
}

// PLANTED SOURCES — the self-test's input. Deliberately NOT the real files:
// the two shapes that matter here (a key named only in a comment, a key named
// only in a string literal) do not both occur in `src/`, and planting them is
// the only way to assert that the classifier this guard rests on is the thing
// deciding. Every name below is this fixture's own.
const PLANTED = {
  type: [
    `export interface ${TYPE_NAME} {`,
    "  cr: string;",
    "  wave: string;",
    "  /**",
    "   * A JSDoc line that spells a property that is NOT declared:",
    "   * phantom?: string;",
    "   */",
    "  release?: string;",
    "  track?: string;",
    "}",
    "",
  ].join("\n"),
  handler: [
    `async function ${HANDLER_NAME}(store, key, req) {`,
    "  const fields = raw as Record<string, unknown>;",
    "  // The comment shape: fields.release is named here and read nowhere.",
    '  const help = "send fields.track to declare a lane";',
    "  entries.push({ cr: fields.cr, wave: String(fields.wave), help });",
    "  store.replaceQueue(key, entries);",
    "}",
    "",
  ].join("\n"),
  // `release` is named only by a comment, `track` only inside a string: both
  // are dropped fields, and a raw-text scan would call both of them read.
  unread: ["release", "track"],
} as const;

describe("CR-CRU-099 §S2/AC5 — the bulk queue route reads every field its input type declares", () => {
  const typeCode = readSource(TYPE_FILE);
  const handlerCode = readSource(HANDLER_FILE);

  test(
    "the denominator is the exported input interface, parsed and non-vacuous — it still declares " +
      "the three keys of CR-CRU-091's declared half, so this guard cannot be satisfied by " +
      "deleting a declaration instead of reading it",
    () => {
      const keys = declaredKeys(jsLiveCode(typeCode)).map((declared) => declared.key);
      // Deny the vacuous parse from both ends: a plausible interface, and the
      // three keys whose loss this CR was filed for.
      expect(keys.length).toBeGreaterThanOrEqual(5);
      expect(keys).toEqual([...new Set(keys)]);
      for (const key of DECLARED_HALF) {
        expect(keys).toContain(key);
      }
    },
  );

  test(
    "the handler body is delimited at its own closer: it contains the store call this guard is " +
      "about and no second top-level declaration, so no neighbouring function's code can stand " +
      "in for a field read",
    () => {
      const block = handlerBlock(jsLiveCode(handlerCode));
      expect(block.body).toContain(HANDLER_ANCHOR);
      // Over-run is the silent direction — a body that swallowed the next
      // function could show a `fields.<key>` the handler never had.
      expect(block.body.slice(1).match(/\n(?:export )?(?:async )?(?:function|interface|class) /)).toBeNull();
      expect(fieldsBinding(block.body)).toBe("fields");
    },
  );

  test(
    "AC5 — no key the input type declares is unread by the handler: a field the route accepts " +
      "and never reads is reported by name, with the handler named beside it",
    () => {
      // The findings, not their count: a failure prints the sentence a reader
      // needs — which key, which type, which handler, which line.
      expect(unreadAcceptedFields(typeCode, handlerCode).map((f) => f.message)).toEqual([]);
    },
  );

  test(
    "AC5 sensitivity, key by key — removing ANY declared key's read from the real handler adds " +
      "exactly that key to this guard's findings, so the field this CR restored cannot be " +
      "dropped again silently, and neither can the eight beside it",
    () => {
      const binding = fieldsBinding(handlerBlock(jsLiveCode(handlerCode)).body);
      const keys = declaredKeys(jsLiveCode(typeCode)).map((declared) => declared.key);
      // Stated as a DELTA over whatever the handler reads today, not as an
      // absolute. Under a clean handler the two are the same claim; under a
      // handler that has genuinely dropped a field they are not, and this
      // test then keeps asserting sensitivity while the AC5 test above is the
      // ONE place a live defect is reported. Measured RED (2026-09-03) with
      // `release`'s read deleted from the route: the absolute form failed
      // here too and printed the same defect a second time as eight lines of
      // noise, which is how a reader learns to distrust a guard.
      const baseline = unreadAcceptedFields(typeCode, handlerCode).map((f) => f.key);
      const caught: Record<string, string[]> = {};
      const expected: Record<string, string[]> = {};
      for (const key of keys) {
        caught[key] = unreadAcceptedFields(
          typeCode,
          withoutReadsOf(handlerCode, binding, key),
        ).map((f) => f.key);
        // Findings arrive in declaration order, so the expectation is built
        // in that order too rather than sorted into a shape nothing produces.
        expected[key] = keys.filter((k) => k === key || baseline.includes(k));
      }
      expect(caught).toEqual(expected);
    },
  );

  test(
    "the failure message names the unread key AND the handler that ignores it, so a future " +
      "reader learns what broke without reading this test",
    () => {
      const binding = fieldsBinding(handlerBlock(jsLiveCode(handlerCode)).body);
      // Selected by key rather than by position, for the same reason the
      // sensitivity claim above is a delta: a live defect elsewhere must not
      // turn this message assertion into a second report of it.
      const planted = unreadAcceptedFields(
        typeCode,
        withoutReadsOf(handlerCode, binding, "release"),
      ).find((finding) => finding.key === "release");
      expect(planted).toBeDefined();
      // The four facts a reader needs without opening this file: the type
      // that declares the key, the key, the handler that ignores it, and
      // where that handler lives.
      expect(planted!.message).toContain(TYPE_NAME);
      expect(planted!.message).toContain("`release`");
      expect(planted!.message).toContain(HANDLER_NAME);
      expect(planted!.message).toContain(`${HANDLER_FILE}:`);
    },
  );

  test(
    "a key named only in a comment, or only inside a string literal, is NOT a read — the lifted " +
      "comment classifier is what decides, and this guard would be worthless without it",
    () => {
      expect(unreadAcceptedFields(PLANTED.type, PLANTED.handler).map((f) => f.key)).toEqual([
        ...PLANTED.unread,
      ]);
      // The same fixture over RAW text — the scan this guard refuses to be —
      // finds nothing, which is precisely the silent pass the helper prevents.
      expect(
        declaredKeys(PLANTED.type)
          .map((declared) => declared.key)
          .filter((key) => !readsField(PLANTED.handler, "fields", key)),
      ).toEqual([]);
    },
  );

  test(
    "AC5 — the guard consumes tests/helpers/source-scan.ts rather than walking the tree itself: " +
      "its own source imports the helper's exports, and the checker's verdict changes when that " +
      "classifier is the thing deciding",
    () => {
      const own = readSource("tests/queue-accepted-field-guard.test.ts");
      // Read on RAW text, and anchored at column 0, deliberately: a module
      // SPECIFIER is itself a string literal, so the live-code projection
      // blanks the very bytes that name the helper. The anchor is what a
      // comment cannot fake — `// import { ... }` does not start a line at
      // column 0 — which is the property the projection would otherwise buy.
      const imported = /^import \{([^}]+)\} from "\.\/helpers\/source-scan";$/m.exec(own);
      expect(imported).not.toBeNull();
      expect(imported![1]!.split(",").map((name) => name.trim())).toEqual([
        "REPO_ROOT",
        "balancedEnd",
        "jsLiveCode",
        "unnestedEnd",
      ]);
      // And it DECIDES: the same planted fixture is silent when the
      // classifier is bypassed (asserted above) and reports two dropped
      // fields when it is not.
      expect(unreadAcceptedFields(PLANTED.type, PLANTED.handler).length).toBe(2);
    },
  );

  test(
    "CR-CRU-104 §S3/AC8 — the object handed to the writer is located STRUCTURALLY: the writer " +
      "call names the array, the pushes into that array name the literal, and each such span " +
      "carries the two REQUIRED keys without swallowing the writer call itself",
    () => {
      const block = handlerBlock(jsLiveCode(handlerCode));
      const sink = writerSink(block.body);
      const spans = pushedObjects(block.body, sink);
      // Non-vacuity from both ends, and it is asserted HERE rather than inside
      // the derivation on purpose: the mutations below delete a required key's
      // forwarding, and a derivation that refused to run on that input could
      // not be measured by them.
      expect(spans.length).toBeGreaterThan(0);
      for (const [start, end] of spans) {
        const span = block.body.slice(start, end);
        expect(span).not.toContain(HANDLER_ANCHOR);
        for (const key of REQUIRED_KEYS) {
          expect(propertiesNamed(span, key).map((property) => property.value.length > 0)).toEqual([
            true,
          ]);
        }
      }
    },
  );

  test(
    "CR-CRU-104 §S3/AC8 sensitivity, key by key — deleting ONLY a declared key's FORWARDING, " +
      "with every validation and every local binding of it left standing, adds exactly that key " +
      "to this guard's findings: what is enforced is that the value REACHES the object handed to " +
      "the writer, not that the handler mentions the field somewhere",
    () => {
      const keys = declaredKeys(jsLiveCode(typeCode)).map((declared) => declared.key);
      // The same DELTA form as the read-sensitivity claim above, for the same
      // reason: a live defect elsewhere must not be reported a second time
      // here as nine lines of noise.
      const baseline = unreadAcceptedFields(typeCode, handlerCode).map((f) => f.key);
      const caught: Record<string, string[]> = {};
      const expected: Record<string, string[]> = {};
      for (const key of keys) {
        caught[key] = unreadAcceptedFields(typeCode, withoutForwardingOf(handlerCode, key)).map(
          (f) => f.key,
        );
        expected[key] = keys.filter((k) => k === key || baseline.includes(k));
      }
      expect(caught).toEqual(expected);
    },
  );

  test(
    "CR-CRU-104 §S3/AC8 — the diagnostic of a dropped FORWARDING says which failure it is: the " +
      "key is still READ, so a message about a missing read would send the reader looking for " +
      "something that is still there",
    () => {
      // `track` is the sharpest case: its AC4a validation reads `fields.track`
      // and stays, so the field is mentioned by the handler and stored by
      // nothing.
      const dropped = withoutForwardingOf(handlerCode, "track");
      const binding = fieldsBinding(handlerBlock(jsLiveCode(dropped)).body);
      expect(readsField(handlerBlock(jsLiveCode(dropped)).body, binding, "track")).toBe(true);
      const finding = unreadAcceptedFields(typeCode, dropped).find((f) => f.key === "track");
      expect(finding).toBeDefined();
      expect(finding!.message).toContain("`track`");
      expect(finding!.message).toContain(HANDLER_NAME);
      expect(finding!.message).toContain(HANDLER_ANCHOR);
    },
  );
});
