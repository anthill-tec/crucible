# CR-CRU-005 — AXI layer: TOON subset + help hints

**Status:** PENDING
**Type:** feature
**Priority:** P1
**Depends on:** CR-CRU-004
**Labels:** axi, toon, agent-experience
**Phase:** Wave 2
**Design reference:** PRD §2 (TOON decision), storyboard artifact §axi; TOON pinning decision (queue notes 2026-07-14: pin our subset)

## Context
The agent-experience layer: token-efficient TOON on reads, contextual next-step hints
everywhere. We pin OUR documented TOON subset (producer and consumers are both our
fleet) rather than vendoring the reference serializer.

## Scope

### §S1 TOON subset serializer (`src/toon.ts`) + spec doc (`docs/research/DN-crucible-toon-subset.md`)
`toToon(obj): string` emitting exactly four constructs: scalar lines `key: value`;
nested objects by 2-space indentation; uniform object arrays as tables
`name[N]{col1,col2}:` + one comma-joined row per item; non-uniform/string arrays as
`name[N]:` + one indented line per item. Strings containing `\n : , { } [ ]` are
JSON-quoted; cells containing `" , \n` are JSON-quoted. The DN documents this subset
normatively with examples — it IS the wire spec for our fleet.

### §S2 Content negotiation
`?fmt=toon` query param OR `Accept` header containing `toon` switches the response
of every v2 **GET** route (orientation, health, projects, agents, events, event
detail, status) to `text/toon; charset=utf-8`. POST responses stay JSON (writes are
terse already). JSON remains the default everywhere.

### §S3 help[] hints
Every v2 response (JSON and TOON) ends with a contextual `help` array: after
register → ingest hint + implicit-heartbeat note + unregister reminder; after a RED
ingest → "After GREEN, re-ingest — the dashboard shows the transition" + event
detail link; after a compile ingest → panel-routing reminder; 404s → the call that
fixes them. Hints live in one module (`src/hints.ts`) so wording is reviewable.

### §S4 Truncation with pointer
Any single response body that would exceed 64 KB in TOON mode gets its largest array
truncated with a final row `… truncated — full: GET <url>?fmt=json` (and
`truncated: true` scalar). JSON mode never truncates.

## Acceptance criteria
- [x] `toToon({ok:true, n:3})` === `"ok: true\nn: 3"`.
- [x] `toToon({events:[{id:"a",n:1},{id:"b",n:2}]})` === `"events[2]{id,n}:\n  a,1\n  b,2"` (uniform table form).
- [x] `toToon({help:["do x","see y"]})` === `"help[2]:\n  do x\n  see y"`; a value containing a comma round-trips JSON-quoted.
- [x] `GET /api/v2/events?fmt=toon` → `content-type: text/toon; charset=utf-8` and the body's first line is `ok: true`; the same URL without `fmt` returns JSON.
- [x] `GET /api/v2/agents` with header `Accept: text/toon` → TOON body.
- [x] Register response JSON contains `help` whose joined text includes `"heartbeat"`; a RED-verdict runs response's `help` includes the substring `"transition"`; a 404 project error's `help` names `POST /api/v2/projects`.
- [x] A synthetic 500-event TOON response emits `truncated: true` and a line containing `fmt=json`; the JSON variant of the same call is complete.
- [x] `docs/research/DN-crucible-toon-subset.md` exists and contains one example of each of the four constructs (verified by test reading the file).
- [x] Integration: every v2 GET handler routes its response through the shared `reply()` (or equivalent) — grep for direct `Response.json(` inside `src/v2.ts` GET handlers returns 0 by VERIFY.

## Estimated size
M.

## Risk
Token-savings claims stay honest: measure once with a real 50-event payload and
record the ratio in the DN.

## Non-goals
TOON on POST bodies (requests stay JSON); vendoring upstream TOON.
