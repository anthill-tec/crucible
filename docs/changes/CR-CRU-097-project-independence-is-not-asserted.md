# CR-CRU-097 — project independence is claimed but never asserted

- **Type**: patch
- **Wave**: 5 (0.2.0) — one leak is a user-visible string in a shipped surface. Release membership
  is the user's call.
- **Depends on**: none — every change is local to a string, a help line, or a fixture.
- **Status**: PENDING (0.2.0) — filed 2026-09-02
- **Found by**: the user, on reading CR-CRU-096's gap analysis. The analysis had reported the
  AC fixtures as *stale* (they decay on every merge) and filed that as a spec-update. The user
  named the actual defect: a project-INDEPENDENT product cannot take the dogfood project's backlog
  as its contract. Decay was the symptom; coupling is the disease.

## Problem

Crucible is developed to run against any project. Nothing enforces that, so our own CR namespace
has leaked into three surfaces — one of them user-visible.

### §S1 — the UI names our backlog to every project

`public/app.js:2354`, the BDD pane's empty state, renders verbatim:

```
BDD run results already stream into the Runs timeline —
the dedicated BDD surface lands in CR-CRU-015 (0.2.0)
```

Any project running Crucible is told about *our* unshipped CR and *our* release number. The
information is true of Crucible-the-project and meaningless — actively confusing — on any other
board. An empty state may say the surface is not built yet; it may not cite the builder's backlog.

### §S2 — the CLI teaches our id namespace

`--cr` help reads `CR id, e.g. CR-CRU-008.` in **four** clients. A CR id is a free-text key the
caller owns; the example tells every user their ids should look like ours. `CR-<PROJECT>-<n>` is
not a format Crucible validates, so the example is not even documenting a constraint.

### §S3 — the regression contract replicates our live board

Three test files build fixtures that are not arbitrary ids but a **snapshot of our own queue**:

| file | `CR-CRU-` refs |
| --- | --- |
| `tests/queue-canonical-order.test.ts` | 63 |
| `tests/queue-registration.test.ts` | 64 |
| `tests/queue-default-into-wave-block.test.ts` | 35 |

`queue-canonical-order.test.ts` encodes `CR-CRU-015 wave 6 seq 62`, `CR-CRU-090 wave 5 seq 81`,
`CR-CRU-095 seq 5022`, `096 → 5023`, `079 → 5024` — our authored positions, as the expected values.

**The distinction this CR draws, because it is the whole point:**

- A **reproduction** may use real data. CR-095's C1 RED had to reproduce "`next` recommends
  `CR-CRU-015`" — that WAS the reported defect, and a synthetic id would have made the
  reproduction a fiction. This is legitimate and stays.
- A **contract** may not. When the real ids become the asserted expectation, the product's
  guarantee is only true while our backlog holds that shape. CR-096's draft AC10 stated the
  contract as `095, 096, 079, 085, 093`; by the time it was read, 095 had merged and the fixture
  asserted the opposite of its own AC9.

The remedy is not to purge the ids. It is to make the reproduction SAY it is one: a real-board
fixture becomes a named, commented snapshot constant, and the assertions that state the product's
rule run on synthetic rows.

**The convention already exists and is already used** — `CR-A`, `CR-B`, `CR-NEW-5`, `CR-W1-A`,
`CR-AGG-1..5`, `CR-Q-n`, and `roadmap-graph.feature`'s `CR-RG-200`. Sub-agents reached for it
unprompted. Only orchestrator-authored specs and fixtures broke it.

## Scope

### §S4 — the two shipped strings

The empty state states the capability, not the plan: BDD results stream into the Runs timeline and
a dedicated surface does not exist yet. The `--cr` help example becomes namespace-neutral.

### §S5 — the board-replica fixtures

Per file: assertions that state a RULE move to synthetic rows; rows that exist to REPRODUCE a real
defect move into one named constant per file, commented with the board and date it was taken from,
so a reader can tell a reproduction from a requirement at a glance.

### §S6 — a tripwire, so this cannot return silently

A test asserts that no `CR-CRU-` literal appears in a user-visible string or a CLI help line in
`public/` or `clients/`, and that no test file outside a named snapshot constant asserts on one.
Provenance comments and docstrings are exempt: they are how this codebase records design lineage
(CR-CRU-030, CR-CRU-056 and dozens more), and stripping them would destroy the record. The
tripwire targets **behaviour and contract**, never provenance.

## Acceptance criteria

- **AC1** — The BDD empty state names no CR and no release version; it states the capability and
  that the dedicated surface does not exist yet.
- **AC2** — No `--cr` help string in any of the five clients names a `CR-CRU-` id.
- **AC3** — No user-visible string in `public/` contains a `CR-CRU-` literal. (Comments exempt.)
- **AC4** — In each of the three files in §S3, every assertion that states a product RULE runs on
  synthetic ids.
- **AC5** — Rows kept for reproduction live in one named constant per file, commented with the
  source board and the date, and the tests reading it assert the reproduction, not the rule.
- **AC6** — CR-095's reproductions still reproduce: the `next`-recommends-a-deferred-CR case and
  the overlapping-seq case both still fail against pre-095 ordering.
- **AC7** — The tripwire fails when a `CR-CRU-` literal is introduced into a user-visible string,
  a CLI help line, or an assertion outside a snapshot constant; it passes on provenance comments
  and docstrings.
- **AC8** — Provenance is intact: the count of `CR-CRU-` references in comments and docstrings
  across `src/`, `public/` and `clients/` is unchanged by this CR.

## Non-goals

- **Validating CR id format.** A CR id is caller-owned free text and stays that way.
- **Purging provenance.** Design lineage in comments is the record; it is exempt by AC8.
- **Renaming our own CRs or board data.** The dogfood board is a real board; that is the point of
  dogfooding.
- **Auditing the specs in `docs/changes/`.** Those describe Crucible-the-project and may name its
  CRs freely. Only ACs — the product's guarantees — must be synthetic, and CR-096 AC29 states that
  rule for CRs authored from now on.

## Notes

**Every check was green and none of them looked for this.** Gates are green on both stacks, CR-095
ran a four-cycle VERIFY that read the fixtures line by line, and its FIX round amended three of
them — while the coupling was the thing to see. The checks all asked "does the code match the
spec?"; nothing asked "does the spec describe a product, or a project?" Identical shape to CR-096's
own root cause, one level up: there, every check tested the implementation against the spec, and
the spec was what had drifted.

**The orchestrator wrote the coupled fixtures; the sub-agents wrote synthetic ones.** Agents given
"write failing tests for this contract" reached for `CR-A`/`CR-NEW-5` unprompted, because a
contract stated abstractly invites an abstract fixture. The coupled ones came from ACs that handed
them a concrete list to encode. A fixture inherits the abstraction level of the criterion above it.
