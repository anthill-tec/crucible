// CR-CRU-099 §S2/AC5 + CR-CRU-104 §S3/AC8 — THE ACCEPTED-FIELD GUARD.
//
// An accepted field the handler never reads is INDISTINGUISHABLE FROM SUCCESS
// at the call site: the caller sends it, the route answers 200, the store
// keeps nothing. That is how a declared `release` was dropped by the bulk
// queue post from the day CR-CRU-078 started declaring one — no error, no
// warning, no red test, a row that is a member of no release. §S2 says the
// defect is a CLASS, not one bug, so this file makes the next dropped column
// a test failure instead of an invisible row.
//
// CR-CRU-104 §S3 sharpened "never reads" into "never STORES". A field the
// handler validates and then leaves off the object it hands the store is
// exactly as indistinguishable from success, and that is the shape the first
// version of this guard passed — see THE NUMERATOR below for the measurement
// and for the half that was added to close it.
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
// Measured 2026-09-04: adding `owner?: string;` to that interface and nothing
// else reports `owner` by name, with no edit to this file
// (run-823c06aa-7706-4145-acf4-3c34a1429eef); deleting `release?: string;`
// instead of storing it fails the denominator anchor rather than satisfying
// the criterion (run-41ea42f3-0d7d-4fbc-8510-85f1b9ea13f3).
//
// ── THE NUMERATOR, NAMED ───────────────────────────────────────────────────
//
// TWO questions per declared key, because a field is dropped in two different
// places and only both together mean STORED:
//
//   READ — within `handleQueuePost`'s own body, with prose blanked, a
//     dereference of the posted-entry object by that key: `fields.release` or
//     `fields["release"]`. The binding name is not hardcoded — it is read off
//     the handler's own narrowing line (`const fields = raw as Record<string,
//     unknown>`), the point where untyped request JSON becomes readable, i.e.
//     §S2's "boundary where authored data enters".
//
//   FORWARD — the key is a PROPERTY of the object handed to the writer, and
//     the expression bound to it traces back to that dereference. The object
//     is located structurally, never by line number and never by the shape of
//     one field's forwarding: `store.replaceQueue(<key>, <sink>)` names the
//     array the store is handed, the `<sink>.push(` calls name the literals
//     pushed into it, and `balancedEnd` walks each argument to its own closer.
//     A property may be `key: <expr>` or the SHORTHAND `{ key }` — the shape
//     the handler actually uses for all three fields this CR is about — so the
//     bound expression is followed through the handler's own bindings, every
//     initialiser and every re-assignment of a name it reaches, to a fixpoint.
//     That chain is three hops deep for `lifecycle` today (`{ lifecycle }` ->
//     `lifecycle = {state, …}` -> `const state = declared?.state` ->
//     `const declared = … fields.lifecycle …`), which is why one hop was not
//     enough.
//
// CR-CRU-104 §S3/AC8 ADDED the second question, and this header is where the
// first one alone was admitted to be the wrong question. The two come apart
// whenever a field is named TWICE — once by a validation, once by the
// forwarding: delete only the forwarding and the field is dropped again
// silently while the validation keeps the guard green. RE-MEASURED against
// the CURRENT route on 2026-09-04, one key at a time, deleting ONLY the
// property from the pushed literal and leaving every validation and every
// local binding standing:
//   * `release` — guard GREEN 7/7 (run-9505b202-263e-41d3-89d0-2c6b67c57bad)
//   * `track` — GREEN 7/7 (run-47ae5fbd-b53f-40be-a832-14ce61f24c76)
//   * `lifecycle` — GREEN 7/7 (run-38a15191-74e8-4309-b405-ffbf7e4c4f6f)
// ALL THREE, where CR-CRU-099's 2026-09-03 measurement had `release` firing:
// that field was protected only by ACCIDENT — it carried no validation, so
// its single appearance WAS its forwarding — and CR-CRU-104 C1 removed even
// the accident by hoisting the value into a `const release` the membership
// gate reads. With the FORWARD half in place the same three mutations fire by
// name (run-26e0f165-c398-4ccf-9d02-ad3117d0e416,
// run-f7c330d9-2d7e-4ee4-900c-7f021f0291ea,
// run-4c0a440b-4c0e-4ddc-adb3-ece3bbf5e3b5).
//
// CR-CRU-104's VERIFY round CLOSED a hole this block used to leave unnamed,
// which AC11 makes a defect rather than a caveat: the forward half asked
// whether a declared key stood at property position ANYWHERE inside the
// pushed span, at any brace depth, so moving a forwarding one literal deeper
// — `...(release !== undefined ? { meta: { release } } : {})`, a genuine drop
// because `replaceQueue` then stores no release — kept the guard GREEN 10/10
// (run-12efb408) while the two behavioural suites fired 14 failures on the
// same tree (run-f5593f78). It was the plausible refactor, not a contrived
// one: this CR's own vocabulary groups the pair (`MembershipDeclaration
// { release, track }`). What is demanded now is a property OF THE ROW —
// depth 0 of the pushed literal, or of a literal a `...` spread merges into
// it, which is where all six optional fields live — and the same mutation
// FIRES by name (run-6ae45a48 in-suite, key by key).
//
// ── WHAT THIS DERIVATION CANNOT SEE, stated rather than implied ────────────
//
// 1. Shapes neither half recognises, all of them LOUD — they fail in the
//    commit that introduces them, at which point the reader either restores
//    the plain shape or teaches this guard the new one. A key read by
//    DESTRUCTURING (`const { release: posted } = fields`) or by a computed
//    key (`fields[name]`) is reported UNREAD (measured 2026-09-04: replacing
//    `release`'s dereference with a destructuring pattern, forwarding intact,
//    fires the unread finding — run-1c8964a0-4ece-4706-9f79-b80588844d9f).
//    A key forwarded under a QUOTED property name (`{ "release": release }`)
//    or a computed one (`{ [key]: value }`) is reported UNFORWARDED (measured
//    2026-09-04: quoting the property name and changing nothing else fires —
//    run-5af625cb-e7f4-4ac2-a004-5c7dbb9b484a). The quoted case is invisible
//    for a reason worth naming rather than fixing: this scan runs on the
//    live-code projection, which blanks string literals, so `"release"` is
//    whitespace by the time the pushed span is read — the same projection
//    that makes a field named in a comment or a string not count as a read.
//    The opposite direction — a read or a forwarding this scan INVENTS —
//    cannot happen, because a literal `fields.<key>` in live code IS a read
//    and a literal `key` at property position IS a property.
// 2. THE ONE REMAINING SILENT HOLE, MEASURED, NOT ASSUMED: VALUE IDENTITY is
//    not proven, and cannot be by a lexical scan. What is enforced is that
//    the key is a property of the stored object AND that that property's
//    expression closure dereferences the declared field. A handler that reads
//    the field and stores something else under its name keeps both facts
//    true. Measured 2026-09-04 against the real route, rewriting `release`'s
//    binding to `fields.release !== undefined ? "" : undefined` — the field
//    read, an empty string stored — guard GREEN 10/10
//    (run-9467329a-0153-4a2f-9ca9-265a643f9871). The boundary is exact,
//    because the neighbouring mutation IS caught: rewriting the pushed
//    property to `{ release: track }`, a closure that no longer names
//    `fields.release`, FIRES (run-15ed86c2-acf6-4b1d-ada9-15fbc567fddc). So a
//    WRONG SOURCE is caught; a wrong VALUE from the right source is not. The
//    closure is a text union rather than a dataflow graph, which is the same
//    limit seen from the other side: a dereference reached only through a
//    dead assignment of the same binding would count.
//    What covers that gap is behavioural, not lexical: AC1/AC4's round trips
//    in tests/queue-registration.test.ts post a value and require it back
//    byte-identically. This file is the FORWARD guarantee — the key nobody
//    has written a round trip for yet — and those tests are the VALUE
//    guarantee. Neither replaces the other.
// 3. A key accepted by `replaceQueue` WITHOUT being declared on the interface
//    would be invisible, because the interface is the denominator. There is
//    no such key today (the type carries no index signature).
// 4. The handler's body is delimited by its own column-0 closer. A slip in
//    that delimiter can only SHORTEN the body, which makes reads disappear
//    and the guard shout; over-running it is asserted against directly (the
//    extracted body may contain no second top-level declaration), because
//    THAT direction would hide a dropped field behind a neighbouring
//    function's code.
// 5. The WRITE SHAPE is the one this route uses and no other: a named array
//    handed to `store.replaceQueue`, filled by `push`, whose row is an object
//    literal plus `...` spreads of parenthesised conditionals. A handler that
//    built that array by `map`, or handed the store an inline literal, or
//    aliased the store, or spread a CALL or a named object into the row
//    (`...spreadOf({ release })`, `...membership`) makes the derivation THROW
//    by name — `writerSink`, `pushedObjects`, `literalInterior` and
//    `spreadLiterals` all refuse rather than pass — so the failure is "teach
//    this guard the new write shape", never a silent green. The one exception
//    is a spread of a NAMED object, which merges no literal this walk can
//    read and therefore reports its keys UNFORWARDED: the loud direction. A
//    span that over-ran its own closer is refused for the same reason and
//    asserted against directly, because that direction could show a property
//    the pushed literal never carried. Where there are SEVERAL push sites the
//    key is required in EVERY one, since each is handed to the store and a
//    push that omits it is a row missing the field; there is one site today.
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
// The two structural walks come from the same place for the same reason.
// `balancedEnd` and `unnestedEnd` were file-local to
// tests/project-namespace-tripwire.test.ts, which proved them on its
// assertion spans; §S3 needed the identical walks to find the span of the
// object handed to the store, and `unnestedEnd` is the tripwire's own
// `statementEnd` PARAMETERISED by its terminator set (`;` there, `;` or `,`
// for an object property's value) rather than copied — two bodies differing
// by one character in a character class is the CR-CRU-096 defect shape. Both
// now live beside `jsLiveCode`, and both are run ON its output, so a brace
// inside a comment or a string cannot be counted.
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

// ── THE ROW, AND WHAT COUNTS AS ONE OF ITS PROPERTIES ──────────────────────
//
// CR-CRU-104 §S3/AC11. `replaceQueue` reads the properties OF THE ROW: a name
// one literal deeper is a name it never sees. The first version of this scan
// asked whether a declared key appeared at property position ANYWHERE inside
// the pushed span, at any brace depth, which answered "forwarded" for
// `{ meta: { release } }` — a row carrying no release at all. Measured
// 2026-09-04 against the real route, that rewrite left this guard GREEN 10/10
// (run-12efb408) while the two behavioural suites fired 14 failures on the
// same tree (run-f5593f78).
//
// Depth is NOT counted in braces, because a `...` spread is transparent: the
// handler forwards all six optional fields as `...(cond ? { key } : {})`, so
// the property the store reads sits inside an inner literal that the spread
// merges into the row. What the walk below determines is which literals those
// are.

// The interior of the object literal that opens at or after `from`: from just
// past its `{` to just before the matching `}`. Refused by name when there is
// none, for the reason `writerSink` and `pushedObjects` refuse — a span this
// walk guessed at is the silent direction.
function literalInterior(text: string, from: number, what: string): Span {
  const open = text.indexOf("{", from);
  if (open === -1) {
    throw new Error(
      `${what} in ${HANDLER_NAME} (${HANDLER_FILE}) is not an object literal — this guard reads ` +
        `the properties of the row handed to \`${HANDLER_ANCHOR}\`, so another way of building ` +
        `that row must be taught to it rather than silently unchecked`,
    );
  }
  return [open + 1, balancedEnd(text, open) - 1];
}

const SPREAD = "...";

// The `...` spread expressions at the TOP LEVEL of one literal's interior:
// each element of the literal, split at the interior's own unnested commas,
// whose first non-space characters are `...`.
function spreadExpressions(span: string, start: number, end: number): Span[] {
  const spreads: Span[] = [];
  for (let i = start; i < end; ) {
    const next = Math.min(unnestedEnd(span, i, ","), end);
    const element = span.slice(i, next);
    const head = element.search(/\S/);
    if (head !== -1 && element.startsWith(SPREAD, head)) {
      spreads.push([i + head + SPREAD.length, next]);
    }
    i = next + 1;
  }
  return spreads;
}

// The object literals ONE spread merges into the row, as spans over `span`.
// Transparency is decided by what ENCLOSES the literal, never by brace depth:
// `...(cond ? { release } : {})` puts `release` on the row, and
// `...spreadOf({ release })` does not. A literal reached through anything but
// a GROUPING paren or a conditional's `?`/`:` therefore THROWS by name rather
// than being guessed at — a merge this walk invented could show a property
// the row never carried. A spread of a NAMED object (`...membership`) merges
// no literal this walk can see, so its keys report UNFORWARDED, which is the
// loud direction.
function spreadLiterals(span: string, from: number, to: number): Span[] {
  const merged: Span[] = [];
  for (let i = from; i < to; i++) {
    if (span[i] !== "{") continue;
    const before = span.slice(from, i).replace(/\s+$/, "");
    const previous = before[before.length - 1] ?? "";
    // A `(` is a grouping paren only when nothing callable precedes it.
    const grouping = previous === "(" && !/[A-Za-z0-9_$)\]]$/.test(before.slice(0, -1).trimEnd());
    if (!grouping && previous !== "?" && previous !== ":") {
      throw new Error(
        `${HANDLER_NAME} (${HANDLER_FILE}) spreads \`${span.slice(from, to).trim()}\` into the ` +
          `row handed to \`${HANDLER_ANCHOR}\` — this guard reads a spread of a parenthesised ` +
          `conditional and refuses to guess which properties any other spread merges, because a ` +
          `merge it invented would show a property the row never carried`,
      );
    }
    const end = balancedEnd(span, i);
    merged.push([i + 1, end - 1]);
    i = end - 1;
  }
  return merged;
}

// Every literal whose TOP-LEVEL properties are properties of the ROW: the
// pushed literal, plus the branches of every spread merged into it, to a
// fixpoint — a branch may itself spread.
function mergedLiterals(span: string): Span[] {
  const row = literalInterior(span, 0, `the object pushed into \`${HANDLER_ANCHOR}\`'s array`);
  const merged: Span[] = [row];
  const pending: Span[] = [row];
  while (pending.length > 0) {
    const [start, end] = pending.shift()!;
    for (const [from, to] of spreadExpressions(span, start, end)) {
      for (const branch of spreadLiterals(span, from, to)) {
        merged.push(branch);
        pending.push(branch);
      }
    }
  }
  return merged;
}

// A property NAMED `key` at the TOP LEVEL of one literal's interior —
// `key: <expr>`, or the SHORTHAND `key` that binds a local of the same name,
// which is the shape the handler uses for all three fields this CR is about.
// Read element by element, so a name at any other depth cannot match and a
// VALUE that happens to be an identifier of that name (`{ lane: track }`) is
// never read as one.
function propertiesNamed(interior: string, key: string): Property[] {
  const at = new RegExp(`^\\s*${escaped(key)}\\s*(?::|(?=[,}])|$)`);
  const found: Property[] = [];
  for (let i = 0; i < interior.length; ) {
    const next = Math.min(unnestedEnd(interior, i, ","), interior.length);
    const match = at.exec(interior.slice(i, next));
    if (match !== null) {
      const after = i + match[0].length;
      // The trailing comma belongs to the property: deleting or wrapping the
      // span must leave the literal's remaining properties separated as they
      // were.
      const end = next < interior.length ? next + 1 : next;
      found.push({
        start: i,
        end,
        value: match[0].endsWith(":") ? interior.slice(after, next) : key,
      });
    }
    i = next + 1;
  }
  return found;
}

// The properties of the ROW named `key`, as spans over the pushed span: what
// `replaceQueue` receives under that name, from whichever merged literal
// carries it.
function rowProperties(span: string, key: string): Property[] {
  const found: Property[] = [];
  for (const [start, end] of mergedLiterals(span)) {
    for (const property of propertiesNamed(span.slice(start, end), key)) {
      found.push({
        start: start + property.start,
        end: start + property.end,
        value: property.value,
      });
    }
  }
  return found;
}

// WHERE `key` is a property of the object handed to the writer, as spans over
// `handlerCode`: one site per pushed literal that names it. The two mutations
// below share this walk rather than each carrying its own — two bodies
// differing by one character is the CR-CRU-096 defect shape.
function forwardingSites(handlerCode: string, key: string): Span[] {
  const block = handlerBlock(jsLiveCode(handlerCode));
  const sink = writerSink(block.body);
  const sites: Span[] = [];
  for (const [start, end] of pushedObjects(block.body, sink)) {
    for (const property of rowProperties(block.body.slice(start, end), key)) {
      sites.push([block.start + start + property.start, block.start + start + property.end]);
    }
  }
  if (sites.length === 0) {
    throw new Error(
      `\`${key}\` is not a property of the object ${HANDLER_NAME} (${HANDLER_FILE}) hands to ` +
        `\`${HANDLER_ANCHOR}\`, so there is no forwarding of it to mutate — the field these ` +
        `mutations exist to drop is already dropped`,
    );
  }
  return sites;
}

// Removes `key` as a PROPERTY of the object handed to the writer, and nothing
// else: every validation of it, every local binding of it and every other
// property stay exactly where they were. This is §S3's mutation — the
// deletion that dropped a declared field again while this guard stayed green
// — applied to the REAL handler source, so the claim is made about the code
// that ships. Offset-safe because the live-code projection the spans are
// found in is byte-for-byte as long as the file it came from.
function withoutForwardingOf(handlerCode: string, key: string): string {
  let mutated = handlerCode;
  for (const [start, end] of [...forwardingSites(handlerCode, key)].reverse()) {
    mutated = mutated.slice(0, start) + mutated.slice(end);
  }
  return mutated;
}

// The wrapper the mutation below nests a forwarding under. Its own name, and
// no key any interface declares, so the row it builds carries the declared
// key at no depth the store can read.
const NESTED_UNDER = "meta";

// Moves `key`'s forwarding one literal DEEPER — `{ release }` becomes
// `{ meta: { release } }` — and changes nothing else. This is AC11's
// mutation: the field is still read, still named at property position, still
// traced to its dereference, and `replaceQueue` stores NOTHING under that
// name, because a row's `release` is a property of the row and not of some
// object inside it. It is the plausible refactor, not a contrived one: this
// CR's own vocabulary groups the pair (`MembershipDeclaration { release,
// track }`), so `membership: { release, track }` inside the pushed literal is
// the shape a future reader would reach for.
function withNestedForwardingOf(handlerCode: string, key: string): string {
  let mutated = handlerCode;
  for (const [start, end] of [...forwardingSites(handlerCode, key)].reverse()) {
    const site = handlerCode.slice(start, end);
    // The trailing comma, when the property carried one, belongs to the
    // WRAPPER: it separates the row's properties, not the nested one's.
    const comma = site.endsWith(",");
    const property = comma ? site.slice(0, -1) : site;
    mutated =
      mutated.slice(0, start) +
      ` ${NESTED_UNDER}: {${property} }` +
      (comma ? "," : "") +
      mutated.slice(end);
  }
  return mutated;
}

// Every identifier a piece of code names. The closure below expands them and
// does not care which are locals: a name with nothing bound to it in the
// handler contributes nothing to expand.
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

// Every right-hand side `id` is assigned from, anywhere in the handler body:
// a `const`/`let`/`var` initialiser, its optional type annotation skipped, or
// a bare RE-ASSIGNMENT — which is how the handler builds the one declared
// field that is a STRUCTURE (`let lifecycle: QueueLifecycle | undefined;`
// followed by `lifecycle = { … }` inside the shape check). The `=` must be an
// assignment: not `==`, not `=>`, not the tail of `!==`.
function assignedFrom(handlerBody: string, id: string): string[] {
  const at = new RegExp(`\\b${escaped(id)}\\b[ \\t]*(?::[^=;\\n]*)?=(?![=>])`, "g");
  const values: string[] = [];
  for (const match of handlerBody.matchAll(at)) {
    const equals = match.index! + match[0].length - 1;
    if (/[=!<>+\-*/%&|^~]/.test(handlerBody[equals - 1] ?? "")) continue;
    values.push(handlerBody.slice(equals + 1, unnestedEnd(handlerBody, equals + 1, ",;")));
  }
  return values;
}

// The text an expression can reach through the handler's own bindings: the
// expression itself, plus the right-hand side of every binding it names,
// transitively, to a fixpoint.
//
// This is what makes the SHORTHAND property shape readable. `{ lifecycle }`
// names a local, and the dereference that fills it is three hops away
// (`lifecycle = {state, …}` -> `const state = declared?.state` ->
// `const declared = … fields.lifecycle …`); one hop would have covered
// `release` and `track` and missed `lifecycle` entirely.
//
// `binding` — the posted-entry object — is the SOURCE and is never expanded,
// so the chain that produced it (`raw`, `rawEntries`, `body`) cannot drag
// unrelated dereferences into the closure.
function tracedFrom(handlerBody: string, expression: string, binding: string): string {
  let text = expression;
  const seen = new Set<string>([binding]);
  const pending = [...expression.matchAll(IDENTIFIER)].map((match) => match[0]);
  while (pending.length > 0) {
    const id = pending.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const value of assignedFrom(handlerBody, id)) {
      text += `\n${value}`;
      for (const match of value.matchAll(IDENTIFIER)) pending.push(match[0]);
    }
  }
  return text;
}

// Whether `key`'s value REACHES the object handed to the writer: the key is a
// property OF THE ROW every push hands the store — at depth 0 of the pushed
// literal or of a literal a spread merges into it, never a name one literal
// deeper (AC11) — and at least one expression bound to it traces back to a
// dereference of the posted entry by that key.
//
// EVERY push, because each one is handed to the store and a push that omits
// the key is a row missing it. At least ONE bound expression, because a key
// written twice in one row is written once per branch, and either branch
// reaching the store is a forwarding.
function forwardsField(handlerBody: string, binding: string, key: string, sink: string): boolean {
  for (const [start, end] of pushedObjects(handlerBody, sink)) {
    const properties = rowProperties(handlerBody.slice(start, end), key);
    if (properties.length === 0) return false;
    if (
      !properties.some((property) =>
        readsField(tracedFrom(handlerBody, property.value, binding), binding, key),
      )
    ) {
      return false;
    }
  }
  return true;
}

export interface UnforwardedField {
  key: string;
  /** Which half failed: the handler never read it, or never stored what it read. */
  stage: "read" | "forward";
  message: string;
}

// THE CHECKER, as a pure function of the two source texts, so the self-tests
// below can plant a shape without touching a real file and the mutation tests
// can delete a read or a forwarding without touching `src/`.
//
// Two questions per declared key, in the order a reader needs them: a field
// that is never read is reported as unread rather than as unstored, because
// sending that reader looking for a forwarding when the dereference itself is
// gone is the wrong sentence.
export function unforwardedAcceptedFields(
  typeCode: string,
  handlerCode: string,
): UnforwardedField[] {
  const type = jsLiveCode(typeCode);
  const handler = jsLiveCode(handlerCode);
  const block = handlerBlock(handler);
  const binding = fieldsBinding(block.body);
  const sink = writerSink(block.body);
  const where = `${HANDLER_NAME} (${HANDLER_FILE}:${block.line})`;
  const findings: UnforwardedField[] = [];
  for (const declared of declaredKeys(type)) {
    const declares = `${TYPE_NAME} declares \`${declared.key}\` (${TYPE_FILE}:${declared.line})`;
    if (!readsField(block.body, binding, declared.key)) {
      findings.push({
        key: declared.key,
        stage: "read",
        message:
          `${declares} but ${where} never reads \`${binding}.${declared.key}\` — the route ` +
          `accepts that field, answers 200 and drops it, which is indistinguishable from ` +
          `success at the call site`,
      });
      continue;
    }
    if (forwardsField(block.body, binding, declared.key, sink)) continue;
    findings.push({
      key: declared.key,
      stage: "forward",
      message:
        `${declares} and ${where} READS \`${binding}.${declared.key}\`, but that value never ` +
        `reaches \`${sink}\`, the object handed to \`${HANDLER_ANCHOR}\` — the field is ` +
        `validated and then discarded, which is exactly as indistinguishable from success at ` +
        `the call site as never reading it, and leaves a validation standing to keep this ` +
        `guard green`,
    });
  }
  return findings;
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

describe("CR-CRU-099 §S2/AC5 + CR-CRU-104 §S3/AC8 — the bulk queue route STORES every field its input type declares", () => {
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
    "AC5/AC8 — no key the input type declares is unforwarded by the handler: a field the route " +
      "accepts and then never reads, or reads and never stores, is reported by name with the " +
      "handler named beside it",
    () => {
      // The findings, not their count: a failure prints the sentence a reader
      // needs — which key, which type, which handler, which line.
      expect(unforwardedAcceptedFields(typeCode, handlerCode).map((f) => f.message)).toEqual([]);
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
      const baseline = unforwardedAcceptedFields(typeCode, handlerCode).map((f) => f.key);
      const caught: Record<string, string[]> = {};
      const expected: Record<string, string[]> = {};
      for (const key of keys) {
        caught[key] = unforwardedAcceptedFields(
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
      const planted = unforwardedAcceptedFields(
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
      expect(unforwardedAcceptedFields(PLANTED.type, PLANTED.handler).map((f) => f.key)).toEqual([
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
      expect(unforwardedAcceptedFields(PLANTED.type, PLANTED.handler).length).toBe(2);
    },
  );

  test(
    "CR-CRU-104 §S3/AC8+AC11 — the ROW handed to the writer is located STRUCTURALLY: the writer " +
      "call names the array, the pushes into that array name the literal, the spreads merged into " +
      "it name the rest, and each such span carries the two REQUIRED keys at the row's own depth " +
      "without swallowing the writer call itself",
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
        // The row literal plus every literal a spread merges into it — the
        // handler forwards its six optional fields that way, so a walk that
        // found only the pushed literal would report them all unforwarded.
        expect(mergedLiterals(span).length).toBeGreaterThan(1);
        for (const key of REQUIRED_KEYS) {
          expect(rowProperties(span, key).map((property) => property.value.length > 0)).toEqual([
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
      const baseline = unforwardedAcceptedFields(typeCode, handlerCode).map((f) => f.key);
      const caught: Record<string, string[]> = {};
      const expected: Record<string, string[]> = {};
      for (const key of keys) {
        caught[key] = unforwardedAcceptedFields(typeCode, withoutForwardingOf(handlerCode, key)).map(
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
      const finding = unforwardedAcceptedFields(typeCode, dropped).find((f) => f.key === "track");
      expect(finding).toBeDefined();
      expect(finding!.message).toContain("`track`");
      expect(finding!.message).toContain(HANDLER_NAME);
      expect(finding!.message).toContain(HANDLER_ANCHOR);
    },
  );

  test(
    "CR-CRU-104 §S3/AC11 sensitivity, key by key — NESTING a declared key's forwarding one " +
      "literal deeper (`{ meta: { release } }`) adds exactly that key to this guard's findings: " +
      "what is enforced is a property of the ROW, not a property NAME somewhere inside the pushed " +
      "span, because `replaceQueue` stores nothing under a name it never sees at the top",
    () => {
      const keys = declaredKeys(jsLiveCode(typeCode)).map((declared) => declared.key);
      // The same DELTA form as the two sensitivity claims above.
      const baseline = unforwardedAcceptedFields(typeCode, handlerCode).map((f) => f.key);
      const caught: Record<string, string[]> = {};
      const expected: Record<string, string[]> = {};
      for (const key of keys) {
        caught[key] = unforwardedAcceptedFields(
          typeCode,
          withNestedForwardingOf(handlerCode, key),
        ).map((f) => f.key);
        expected[key] = keys.filter((k) => k === key || baseline.includes(k));
      }
      expect(caught).toEqual(expected);
      // And it is the FORWARD half that reports it: the field is still read,
      // still at property position, still traced to its dereference — the
      // only thing that changed is the depth at which the row carries it.
      const nested = withNestedForwardingOf(handlerCode, "release");
      const finding = unforwardedAcceptedFields(typeCode, nested).find((f) => f.key === "release");
      expect(finding?.stage).toBe("forward");
    },
  );
});
