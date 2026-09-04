# CR-CRU-105 — the e2e scenario declares membership through the approved verb

- **Type**: bug
- **Wave**: 5 (0.2.0) — release membership is the user's call
- **Depends on**: none — `cr-plan` has carried `--release` since CR-CRU-091
- **Status**: PENDING (0.2.0) — filed 2026-09-04
- **Found by**: the user, on discovering the orchestrator had been loading the roadmap through an
  interface the approved design does not contain: *"I remember approving an API specifically in the
  Lavish editor for this. I haven't asked you to implement your own interfaces without asking ME."*

## Problem

`tests/e2e/features/roadmap-graph.feature:38` declares release membership through the **bulk queue
post**:

```gherkin
And a release "0.2.0" is proposed for that project
And a CR queue registering cr "CR-RG-200" titled "Graph CR" in wave "5" for release "0.2.0" is posted for that project
```

The approved design's §12 ordered call chain declares membership with **`cr-plan`** (step 2) and
order with **`wave-sequence`** (step 3). It contains no bulk queue post at all. The bulk path is the
orchestrator's own migration tooling — built to move this project's existing README-table roadmap
onto the board — and per the user's 2026-09-04 ruling it stays available **for migration**, while our
own scenarios use the approved verbs.

So the product's flagship end-to-end scenario currently demonstrates the wrong interface. Worse, it
is the reason the bulk post was TAUGHT to declare membership in the first place: CR-CRU-096 `AC28a`
recorded that this scenario had never passed because `handleQueuePost` never read `fields.release`,
and CR-CRU-099 closed that by making the bulk route a declaring path. Had the scenario used
`cr-plan`, that whole chain would not have been needed.

## Scope

### §S1 — the scenario declares through `cr-plan`

The step that registers the CR's membership targets the approved per-CR verb. The scenario's
SUBJECT is unchanged: zone 2 draws the focused release's wave, the node's tap is inert while
PENDING, and it swaps to the Workflow tab once a filed plan makes it IN_PROGRESS. Only the interface
it declares through changes.

The existing `release-propose` step stays — it already matches step 1 of the approved chain.

### §S2 — the step definitions follow

`tests/e2e/steps/` gains or re-points whatever step implements the declaration. If a bulk-post step
definition has no remaining user after this change, it goes; if it is still used by a scenario that
legitimately exercises the migration door, it stays and says so.

## Acceptance criteria

- **AC1** — The scenario declares membership through `cr-plan`, and passes. Proven by running the
  e2e suite, not by inspection.
- **AC2** — The scenario's assertions are unchanged in substance: the wave holds its node, the
  PENDING tap is inert, and the IN_PROGRESS tap swaps to Workflow. A step changing interface may not
  quietly change what the scenario proves.
- **AC3** — No remaining e2e scenario declares release membership through the bulk post, or any that
  does is a DELIBERATE migration-door scenario and says so in its own text.
- **AC4** — The `release-propose` step is untouched; it already matches the approved chain's step 1.
- **AC5** — CR-CRU-096 `AC28a`'s record stands: it documented that this scenario had never passed,
  and this CR does not edit that shipped text. The correction is recorded HERE.

## Non-goals

- **Removing the bulk post's ability to read `release`.** The user ruled the migration door stays
  (CR-CRU-104's "Why both doors stay", as corrected). This CR changes what OUR scenario uses, not
  what the route accepts.
- **Editing CR-CRU-078's or CR-CRU-099's spec text.** Both shipped; both records.
- **The README-table bootstrap command.** It is migration tooling, to be phased out as Crucible
  becomes able to author a whole roadmap through the AXI clients and the backend. Not this CR.
