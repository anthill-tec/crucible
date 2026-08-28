// CR-CRU-078 §S3 / AC6 / AC7 / AC30 — what date a release GATE carries, as a
// pure resolution, decided once instead of re-decided at every render site.
//
// Scope: the resolver only. No DOM, no `state`, no fetch — the strip, the
// gates, the zones and the table are C2/C3 and are NOT touched here.
// `formatReleaseDate` itself is CR-CRU-091 C4's and is covered by
// tests/roadmap-registration-ui.test.ts; nothing here re-asserts its own
// contract, only that the resolver ROUTES THROUGH it.
//
// ── §S3, verbatim ──────────────────────────────────────────────────────────
// "A shipped gate carries its ship date (`releases[].releasedAt`, epoch
// SECONDS). A proposed gate carries its declared `--target` (CR-091,
// `targetAt`, also epoch SECONDS), or an explicit 'no target declared' empty
// state. The shared formatter ALREADY EXISTS — do not write a second one."
//
// ── AC6, verbatim ──────────────────────────────────────────────────────────
// "A shipped gate renders its ship date; a proposed gate renders its declared
// target or an explicit 'no target declared'. A date rendered as `1970-…`
// fails this AC (seconds-vs-ms)."
//
// ── AC7, verbatim ──────────────────────────────────────────────────────────
// "No forecast date renders. A release with no declared target shows the empty
// state; no estimated, interpolated or placeholder date may appear while
// CR-022 is unshipped. A *declared* target is authored data and is not a
// forecast."
//
// ── The return shape, and why it is not a string ───────────────────────────
// A bare string cannot say WHY it is empty: "no target declared" (authored
// absence — AC6's empty state) and "" out of a value the formatter refused (a
// data defect) would collapse into the same answer, and a render site would
// have to re-derive the difference from the record — which is exactly the
// per-call-site re-deciding this resolver exists to end. So the answer is
// `{ kind, field, state, date }`:
//   • `state` carries the meaning — "dated" | "absent" | "unusable";
//   • `date` is ALWAYS `formatReleaseDate(<the one field>)`, so it holds a real
//     ISO day when there is one and "" otherwise, and can never drift from the
//     formatter;
//   • `field` names WHICH field was consulted, so "the gate's date came from
//     `timestamp`" is a visible, assertable falsehood rather than an invisible
//     one.
// `kind` is a PARAMETER, not sniffed from the record: the caller iterated
// either `state.releases` or `state.releaseProposals` and already knows. A
// shape sniff cannot tell an undated pre-CR-080 release row from a proposal
// with no declared target, and those are different facts.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as AppLogic from "../public/app-logic.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_LOGIC_SRC = readFileSync(path.join(REPO_ROOT, "public/app-logic.mjs"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");

// The ambient tests/app-logic.d.ts predates this export, so cast the module to
// the boundary under test ONCE. Until GREEN adds the runtime export,
// `resolveGateDate` is `undefined` and every call below throws "is not a
// function" — the intended missing-export RED signal.
interface GateDate {
  kind: string;
  field: string | null;
  state: "dated" | "absent" | "unusable";
  date: string;
}
const Logic = AppLogic as unknown as {
  formatReleaseDate: (epochSeconds: unknown) => string;
  resolveGateDate: (record: unknown, kind: unknown) => GateDate;
};

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A shipped release, `src/v2.ts:1755-1763` shape. `releasedAt` is the measured
 *  0.1.0 ledger value CR-CRU-091's own tests pin: 2026-08-19 in SECONDS,
 *  1970-01-21 read as MILLISECONDS. The two CRs share the number on purpose. */
const SHIPPED = {
  version: "0.1.0",
  commit: "c07274c",
  releasedAt: 1787149125,
  crs: ["CR-A", "CR-B"],
  packages: [],
  timestamp: 1787149999000,
};

/** A proposal WITH a declared target, `src/v2.ts:2045-2057` shape. */
const PROPOSED_TARGETED = {
  label: "0.2.0",
  targetAt: 1790000000, // 2026-09-21
  timestamp: 1787000000,
  waves: ["7"],
};

/** A proposal with NO declared target — AC6's empty state and AC7's absence.
 *  Its `timestamp` is deliberately a value that WOULD format to a real day
 *  (2026-09-21), so "the resolver reached for `timestamp`" is a mistake this
 *  fixture can actually catch instead of one it hides. */
const PROPOSED_UNDATED = {
  label: "0.3.0",
  timestamp: 1790000000,
  waves: [],
};

const ISO_DAY = /\d{4}-\d{2}-\d{2}/;

// ── AC6 ────────────────────────────────────────────────────────────────────

describe("CR-CRU-078 §S3/AC6 — a gate resolves to ITS OWN date, or to a declared absence", () => {
  test("a SHIPPED gate resolves to its ship date — the milliseconds reading (1970-01-21) FAILS", () => {
    const got = Logic.resolveGateDate(SHIPPED, "shipped");
    expect(got).toEqual({
      kind: "shipped",
      field: "releasedAt",
      state: "dated",
      date: "2026-08-19",
    });
    // The trap is live, not hypothetical: the same number read as milliseconds
    // really does land in 1970, so the assertion above is not satisfiable by
    // both units.
    expect(new Date(SHIPPED.releasedAt).toISOString().slice(0, 10)).toBe("1970-01-21");
    expect(got.date).not.toStartWith("1970");
  });

  test("a PROPOSED gate resolves to its DECLARED target — authored data, not a forecast", () => {
    expect(Logic.resolveGateDate(PROPOSED_TARGETED, "proposed")).toEqual({
      kind: "proposed",
      field: "targetAt",
      state: "dated",
      date: "2026-09-21",
    });
  });

  test("a PROPOSED gate with no declared target resolves to the EMPTY state — a state, not a string", () => {
    const got = Logic.resolveGateDate(PROPOSED_UNDATED, "proposed");
    expect(got).toEqual({
      kind: "proposed",
      field: "targetAt",
      state: "absent",
      date: "",
    });
    // The distinction the return shape exists for: a targeted and an untargeted
    // proposal differ in the RESULT, not only in the record the caller still
    // holds.
    expect(got.state).not.toBe(Logic.resolveGateDate(PROPOSED_TARGETED, "proposed").state);
  });

  test("`absent` and `unusable` are DIFFERENT answers — the trap a bare string sets", () => {
    // An authored absence is AC6's empty state and renders "no target
    // declared". A value the formatter REFUSED is a data defect, and both
    // would be "" if the resolver answered with a bare string. They are
    // separable here, so a caller cannot mistake a defect for a plan.
    const declared = Logic.resolveGateDate({ label: "0.4.0", timestamp: 1 }, "proposed");
    for (const broken of [Number.NaN, Infinity, -Infinity, "2026-08-19", {}, []]) {
      const got = Logic.resolveGateDate({ label: "0.4.0", targetAt: broken, timestamp: 1 }, "proposed");
      expect({ broken, state: got.state, date: got.date }).toEqual({
        broken,
        state: "unusable",
        date: "",
      });
      expect(got.state).not.toBe(declared.state);
    }
    // `null` is ABSENCE, not a defect: the wire omits an undeclared target
    // (`src/v2.ts:2049`), and a client that sends an explicit null means the
    // same thing.
    expect(Logic.resolveGateDate({ label: "0.4.0", targetAt: null }, "proposed").state).toBe("absent");
    expect(Logic.resolveGateDate({ label: "0.4.0", targetAt: undefined }, "proposed").state).toBe(
      "absent",
    );
  });

  test("a SHIPPED row with no `releasedAt` is an undated TAG, not an undeclared target", () => {
    // A pre-CR-080 ledger row carries no `releasedAt` at all
    // (`src/v2.ts:1759` spreads it only when defined — verified). It resolves
    // to the empty state — but tagged `shipped` / `releasedAt`, so the surface
    // can say "no ship date recorded" rather than "no target declared", which
    // would be a claim about a plan the row does not have.
    //
    // *Citation repaired 2026-08-29 by reading the target: this also cited
    // "the ship-order read at public/app-logic.mjs:907-918" as already
    // treating such a row as legacy history. There is no ship-order read any
    // more — CR-CRU-077's ascending-by-`releasedAt` sorter went with the code
    // CR-CRU-078 removed (§S9's own correction), and that line span is now a
    // cycle-count block. `resolveGateDate` (public/app-logic.mjs:80) is the
    // ONLY place that reads the field today, and it is what this test calls.*
    const got = Logic.resolveGateDate({ version: "0.0.9", crs: [], timestamp: 7 }, "shipped");
    expect(got).toEqual({ kind: "shipped", field: "releasedAt", state: "absent", date: "" });
  });

  test("a real epoch 0 is a real date — absence and the epoch stay distinguishable (AC30)", () => {
    expect(Logic.resolveGateDate({ version: "0.0.1", releasedAt: 0 }, "shipped")).toEqual({
      kind: "shipped",
      field: "releasedAt",
      state: "dated",
      date: "1970-01-01",
    });
    // …which is the ONLY way a `1970-` date may ever appear: from a stored 0,
    // never from a seconds-vs-milliseconds misread.
    expect(Logic.resolveGateDate({ label: "9.9.9", targetAt: 86400 }, "proposed").date).toBe(
      "1970-01-02",
    );
  });
});

// ── AC30 — one formatter, reached not reimplemented ────────────────────────

describe("CR-CRU-078/AC30 — the resolver CALLS `formatReleaseDate`; it does not reimplement it", () => {
  test("the resolved date EQUALS the formatter's answer for the same field, so the two cannot drift", () => {
    // Asserted as an equality against the formatter rather than against
    // hard-coded strings: if `formatReleaseDate` ever changes its day form,
    // this test follows it instead of pinning a stale second opinion.
    const SECONDS = [1787149125, 1787151205, 1787233524, 1790000000, 0, 86400, 253402300799];
    for (const at of SECONDS) {
      expect(Logic.resolveGateDate({ version: "v", releasedAt: at }, "shipped").date).toBe(
        Logic.formatReleaseDate(at),
      );
      expect(Logic.resolveGateDate({ label: "v", targetAt: at }, "proposed").date).toBe(
        Logic.formatReleaseDate(at),
      );
    }
    // Both KINDS route through the one function: same number, same day, and
    // the field consulted is the only difference.
    expect(Logic.resolveGateDate({ version: "v", releasedAt: 1790000000 }, "shipped").date).toBe(
      Logic.resolveGateDate({ label: "v", targetAt: 1790000000 }, "proposed").date,
    );
  });

  test("the resolver reaches the nomodule shell through the same bridge the formatter does", () => {
    expect(typeof Logic.resolveGateDate).toBe("function");
    // app.js consumes logic only through `window.CrucibleLogic`, so a resolver
    // absent from that list is a resolver C2's render can never call.
    expect(/^\s+resolveGateDate,$/m.test(APP_LOGIC_SRC)).toBe(true);
  });

  test("no SECOND date construction is introduced — CR-CRU-091 AC3's scan, still clean", () => {
    // The same executable scan tests/roadmap-registration-ui.test.ts holds,
    // re-run at this seam: the resolver must add a CALL SITE, not a rival
    // formatter. `* 1000`, a `new Date` off either field, an ISO/locale render
    // reached off one — none may appear in code.
    const CONSTRUCTIONS = [
      /new\s+Date\s*\([^;\n]*\b(?:releasedAt|targetAt)\b/,
      /\b(?:releasedAt|targetAt)\b[^;\n]*\*\s*1000/,
      /\b(?:releasedAt|targetAt)\b[^;\n]*\.\s*to(?:ISOString|LocaleDateString|LocaleString)/,
      /\b(?:releasedAt|targetAt)\b[^;\n]*\bDate\s*\.\s*(?:parse|UTC)\b/,
    ];
    const offenders: string[] = [];
    for (const [name, src] of [
      ["public/app-logic.mjs", APP_LOGIC_SRC],
      ["public/app.js", APP_JS_SRC],
    ] as const) {
      const body = codeOnly(src);
      for (const pattern of CONSTRUCTIONS) {
        const hit = pattern.exec(body);
        if (hit !== null) offenders.push(`${name}: ${hit[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
    // Non-vacuity: the scan really does catch the bug it guards against.
    expect(CONSTRUCTIONS.some((p) => p.test("const d = new Date(rel.releasedAt);"))).toBe(true);
  });
});

/** Comment prose names these fields and this vocabulary freely; only CODE is
 *  under test. Mirrors the filter tests/roadmap-registration-ui.test.ts uses. */
const codeOnly = (src: string): string =>
  src
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join("\n");

// ── AC7 ────────────────────────────────────────────────────────────────────

describe("CR-CRU-078/AC7 — NO forecast date, asserted as an ABSENCE", () => {
  test("nothing in an undated proposal's surroundings becomes its date", () => {
    // Every number the payload offers is a temptation to guess with, and
    // `timestamp` — the RECORD's creation instant — is the most plausible
    // wrong answer available. PROPOSED_UNDATED's `timestamp` would format to
    // 2026-09-21, so reaching for it produces a date this assertion sees.
    const got = Logic.resolveGateDate(PROPOSED_UNDATED, "proposed");
    expect(got.date).toBe("");
    expect(Logic.formatReleaseDate(PROPOSED_UNDATED.timestamp)).toBe("2026-09-21"); // the trap is live
    expect(got.date).not.toBe("2026-09-21");
    expect(got.field).not.toBe("timestamp");
    // Proven as an absence, not as a placeholder string: NO ISO day appears
    // ANYWHERE in the answer, so there is no slot for a guess to hide in.
    expect(JSON.stringify(got)).not.toMatch(ISO_DAY);
  });

  test("`timestamp` is never the gate's date for a SHIPPED release either", () => {
    // The ship-order read already records why: `timestamp` is the ingest
    // instant, `releasedAt` is the tag's own commit date.
    const got = Logic.resolveGateDate(
      { version: "0.1.0", releasedAt: 1787149125, timestamp: 1790000000 },
      "shipped",
    );
    expect(got.date).toBe("2026-08-19");
    expect(got.field).toBe("releasedAt");
    // And with the date REMOVED, the surviving `timestamp` still yields none.
    const undated = Logic.resolveGateDate({ version: "0.1.0", timestamp: 1790000000 }, "shipped");
    expect(undated.date).toBe("");
    expect(JSON.stringify(undated)).not.toMatch(ISO_DAY);
  });

  test("no undated record, however surrounded, yields a date", () => {
    // A matrix of the shapes a forecast would key off: a neighbour's shipped
    // date, wave membership, a version label that interpolates, a creation
    // instant, a full CR list. None is a declared target, so none is a date.
    const UNDATED_RECORDS: Record<string, unknown>[] = [
      { label: "0.2.0" },
      { label: "0.2.0", timestamp: 1790000000, waves: ["7", "8"] },
      { label: "0.2.0", targetAt: null, timestamp: 1787149125, waves: ["7"] },
      { label: "0.2.0", crs: ["CR-A", "CR-B"], previousReleasedAt: 1787149125 },
      { label: "0.2.0", releasedAt: 1787149125 }, // a proposal is NOT shipped: its `releasedAt` is not its target
      {},
    ];
    for (const record of UNDATED_RECORDS) {
      const got = Logic.resolveGateDate(record, "proposed");
      expect({ record, state: got.state, date: got.date }).toEqual({
        record,
        state: "absent",
        date: "",
      });
      expect(JSON.stringify(got)).not.toMatch(ISO_DAY);
    }
  });

  test("an unrecognised kind consults NO field and produces no date", () => {
    // Totality without invention: an unknown kind has no authored field to
    // read, so the truthful answer is the empty state with `field: null` —
    // the mistake stays VISIBLE in the result instead of being answered with
    // a guess.
    for (const kind of ["forecast", "", undefined, null, "SHIPPED"]) {
      const got = Logic.resolveGateDate({ releasedAt: 1787149125, targetAt: 1790000000 }, kind);
      expect({ kind, field: got.field, state: got.state, date: got.date }).toEqual({
        kind,
        field: null,
        state: "absent",
        date: "",
      });
    }
  });

  test("no forecasting machinery exists in public/ at all — CR-CRU-022 is unshipped", () => {
    // AC7's real content is that the CODE has no such path, and the P50/P80
    // confidence band is CR-CRU-022, deferred past 0.2.0. Scanned rather than
    // reasoned about, so a later cycle cannot quietly add one.
    const FORECASTING = /\b(?:forecast|estimated|estimate|interpolat\w*|p50|p80|eta)\b/i;
    const offenders: string[] = [];
    for (const [name, src] of [
      ["public/app-logic.mjs", APP_LOGIC_SRC],
      ["public/app.js", APP_JS_SRC],
    ] as const) {
      const hit = FORECASTING.exec(codeOnly(src));
      if (hit !== null) offenders.push(`${name}: ${hit[0]}`);
    }
    expect(offenders).toEqual([]);
    // Non-vacuity.
    expect(FORECASTING.test("const eta = forecastTarget(rel);")).toBe(true);
  });
});

// ── Purity ─────────────────────────────────────────────────────────────────

describe("CR-CRU-078 §S3 — the resolver is PURE: a record in, an answer out", () => {
  test("it neither reads nor mutates anything outside its arguments", () => {
    const record = { label: "0.2.0", targetAt: 1790000000, timestamp: 1787000000, waves: ["7"] };
    const before = JSON.stringify(record);
    const first = Logic.resolveGateDate(record, "proposed");
    const second = Logic.resolveGateDate(record, "proposed");
    expect(JSON.stringify(record)).toBe(before); // the input is untouched
    expect(second).toEqual(first); // and the answer is stable
    // No DOM, no `state`, no fetch: the resolver runs under `bun test` with no
    // document at all, which the calls above already prove — and it must not
    // reach for the render-cycle state slices C2 owns.
    const body = codeOnly(APP_LOGIC_SRC);
    const fn = body.slice(body.indexOf("export function resolveGateDate"));
    const scoped = fn.slice(0, fn.indexOf("\n}\n") + 3);
    expect(scoped).not.toBe("");
    for (const forbidden of ["document", "window", "fetch", "state."]) {
      expect(scoped).not.toContain(forbidden);
    }
  });

  test("a nullish record is answered, not thrown at", () => {
    // The strip iterates a live payload; a hole in it must not take the tab
    // down. An answer with no date is the safe degradation.
    for (const record of [undefined, null]) {
      expect(Logic.resolveGateDate(record, "proposed")).toEqual({
        kind: "proposed",
        field: "targetAt",
        state: "absent",
        date: "",
      });
    }
  });
});
