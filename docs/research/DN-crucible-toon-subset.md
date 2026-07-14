# DN — Crucible TOON Subset (Normative Wire Spec)

**Author:** Antony John
**Co-author:** crucible orchestrator
**Status:** PINNED (CR-CRU-005 §S1)
**Producer/consumers:** the crucible fleet only

This document IS the wire spec for the TOON responses emitted by `src/toon.ts`
(`toToon(obj, indent = 0)`). The subset has exactly FOUR constructs. It is pinned:
producer and consumers are both our fleet — revisit only if third-party TOON
tooling arrives.

## Construct 1 — Scalar line

`key: value`. Numbers, booleans, and `null` render bare. Strings render bare
unless they contain a special character (see quoting table).

```
ok: true
n: 3
note: null
```

## Construct 2 — Nested object

`key:` followed by the child's own lines, indented 2 spaces per level.

```
store:
  path: crucible.db
  open: true
```

## Construct 3 — Uniform object array (table form)

Applies only when every item is a plain object with the SAME key-set in the SAME
order and scalar-only values. Header `name[N]{col1,col2}:`, then one 2-space-
indented, comma-joined row per item.

```
events[2]{id,n}:
  a,1
  b,2
```

## Construct 4 — List array

Everything else: `name[N]:` + one 2-space-indented line per item (scalars bare or
quoted; object items as nested indented blocks WITHOUT a `{cols}` header). Empty
arrays are just the header `items[0]:` with no body lines.

```
help[2]:
  do x
  see y
```

## Quoting rules

| Context | JSON-quote when the string contains | Otherwise |
|---|---|---|
| Scalar line / list item | any of `\n : , { } [ ]` | bare |
| Table cell | any of `" , \n` | bare |
| Numbers / booleans / null | never quoted | bare |

Quoting is `JSON.stringify` of the single string value — consumers un-quote with
`JSON.parse` when a value or cell starts with `"`.

## Measured token-ratio (Risk — CR-CRU-005)

Measured 2026-07-15: 50-event `GET /api/v2/events` listing (live-server probe,
`ratio-agent` fixture, each event carrying an `id/agentId/kind/tier/timestamp`
scalar set plus a nested `summary` object) — JSON 9067 bytes, TOON 9516 bytes,
**TOON = 105.0% of JSON bytes** (TOON was LARGER, not smaller, for this shape).
Root cause: a per-event `summary` sub-object disqualifies the array from
Construct 3's uniform-table form (table cells must be scalar), so it falls
back to Construct 4's per-item nested block, which repeats each key on its
own indented line — verbose compared to compact single-line JSON objects.
Flat/uniform payloads (e.g. `agents[]`, `projects[]` with no nested objects)
are expected to compress well under Construct 3; nested-object listings like
`events[]` do not, until callers request `?depth=suites`-style flattening or
the events payload is reshaped to hoist `summary` fields to top-level scalars.
