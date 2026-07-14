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
