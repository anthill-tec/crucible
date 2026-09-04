# CR-CRU-107 — a cycle label list refuses the wrong delimiter

- **Type**: bug
- **Wave**: 5 (0.2.0)
- **Depends on**: none
- **Status**: PENDING (0.2.0) — filed 2026-09-04

## Problem

`plan-file --cycles` is documented comma-separated. Handed a SEMICOLON-separated value it files
**one** cycle whose label is the entire string — three labels wide — and reports `ok=True`.

The damage is **unrepairable**. No verb relabels a cycle: `PATCH …/plans/<planId>` is the CR close,
`PATCH …/plans/<planId>/cycles/<id>` moves state only, and `abort` destroys the record. So a
mis-delimited plan is a permanent board artifact.

Three occurrences on this project's own board — cycles 324, 328 and 340. Cycle 340's stored label is:

```
C1 the verb and its writer - route/gate/prospective-cycle/registered-subject/replace-semantics;C2 the reporting envelope and the remedy hint - warnings/unknownDependencies/hint retarget/CR-104 comment;C3 VERIFY
```

(The `C1`/`C2`/`C3` prefixes in that stored value are a SECOND operator error, corrected by the
user's ruling of 2026-09-04: `plan_cycles` holds `cycle_id` and `seq`, so the ordinal is the board's
data and a label that restates it can contradict it — as this one does, sitting at position 1 while
claiming to be three cycles. A label is a bare description. That is a convention, not a defect, and
this CR does not legislate it.)

Every occurrence was the same operator making the same substitution from memory. That is the point:
a value this obviously wrong — a "label" containing two semicolons and the substring `C2` — should
not be storable, and after three identical incidents the tooling is the thing that needs fixing.

## Scope

### §S1 — a label that is plainly a list is refused

A `--cycles` value carrying a semicolon is refused before anything is posted, naming the delimiter
the verb wants and echoing the split the caller probably meant. Per AXI principle 9 the refusal
carries the corrected call, not just a complaint.

The refusal is CLIENT-side, where the flag is parsed and where the caller can still be told what to
type. The server takes labels, not a delimited string, so it has no delimiter to police.

## Acceptance criteria

- **AC1** — `--cycles` carrying a semicolon is refused, nothing is posted, and the exit code is the
  client's existing refusal code — not a traceback and not `ok=True`.
- **AC2** — The refusal ECHOES the semicolon-split as the probable intent, so the caller can see the
  labels the verb would have filed and re-send them comma-separated. Principle 9: the corrected call
  is in the message.
- **AC3** — A legitimate comma-separated value is unaffected, including labels that contain hyphens,
  slashes and parentheses, which this project's real labels do.
- **AC4** — A label legitimately containing a semicolon has no other way to be expressed, and the
  refusal says so rather than pretending the character is forbidden everywhere. State the escape or
  state that there is none.
- **AC5** — The three existing garbled rows (324, 328, 340) are NOT rewritten. They are the evidence
  this CR exists; a data migration is a separate decision and the board's history is not edited to
  flatter it.

## Non-goals

- **A relabel verb.** Refusing the bad value at the door is what makes one unnecessary. Adding a
  mutation path for labels is a larger surface than the defect justifies.
- **Policing other delimited flags.** `--crs` and `--packages` take comma-separated lists too, and if
  the same defect is there it is the same fix — but this CR is scoped to the one that has actually
  fired three times. Widening on suspicion is how specs inflate.
