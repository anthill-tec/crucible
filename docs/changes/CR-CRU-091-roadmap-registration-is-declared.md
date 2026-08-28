# CR-CRU-091 — roadmap registration is declared: release, wave and sequence

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 014, 084
- **Status**: PENDING (0.2.0) — the declared-data prerequisite for CR-078, so it ships in the same release
- **Design document — READ IT FIRST**: `/home/antonyj/Documents/data_projects/crucible/.lavish/crucible-workflow-flowchart.html` §9, §10, §11, §12 (approved 2026-08-28). Absolute path so it resolves from a worktree; it carries the declared containment model, the AXI call chain and the client-asks behaviour, editing semantics, and the dependency severities.

> The design document is the contract for this CR. Implement what it specifies — do not
> re-derive the model, the vocabulary or the look from scratch.

## Problem

The roadmap is a containment model — release ⊃ wave ⊃ CR — and not one of the three levels is
declared data on the write path.

- **The release target never reaches the server.** `parse_queue_table` reads the Wave cell with
  `re.match(r"\s*(\d+)", wave_cell)` and keeps only the leading integer
  (`clients/_crucible_axi.py:1959`), so the `(0.2.0)` / `(post-0.2.0)` qualifier the queue has
  carried for months is discarded at parse time. `queue_entries` has no release column to receive
  it either (`src/store.ts:1146-1156`).
- **An uncut release has no record at all**, so there is nothing for a CR to target.
- **The only write path is a whole-queue full replace** driven off a markdown table:
  `handleQueuePost` (`src/v2.ts:1761`) → `replaceQueue`, which DELETEs the project's rows and
  re-INSERTs the posted set (`src/store.ts:3032-3057`). There is no verb to plan one CR, order one
  wave, or kill one CR. The verb that exists, `queue-file`, is wired into **1 of 5** clients
  (`clients/python-crucible.py:1485-1492`).
- **`seq` is stored but not published.** The column exists (`src/store.ts:1154`) and is the read
  order (`src/store.ts:3083`), but `listQueue`'s projection omits it
  (`src/store.ts:3094-3104`), so the renderer re-derives `data.seq` from the array index
  (`public/app-logic.mjs:859`, consumed at `public/app.js:2739`).
- **Removal is deletion.** A CR absent from the posted set vanishes, and supersede cannot be
  distinguished from void — so a dependant of a dead CR rots silently.

## Scope

### §S1 A proposed release is its own record kind

A proposal is a milestone of type `release-proposal`, recorded through the existing
`recordMilestoneEvent` (`src/store.ts:1709`). `type` rides the generic payload column, so there is
no column and no migration for the record itself (`src/store.ts:1699-1700`).

**It is not a `release` with `releasedAt` omitted.** `public/app-logic.mjs:877-878` sorts an
undated release **OLDEST** on purpose — *"an undated tag is legacy history, and calling it the
newest would hand it the gating of every unshipped CR on a date nobody recorded"* — so an omitted
`releasedAt` parks the proposal at the **head** of the strip.

- **Ordering.** Proposals order among themselves by **version** (numeric-component compare of
  `label`), and every proposal sorts **after every shipped release**, whatever its declared target.
  Version orders the strip; a target is a plan and can slip. A target that contradicts version
  order is a planning conflict to surface, never a reason to re-sort.
- **Isolation from settled history.** `listReleases` is untouched — its filter is
  `event.type === "release"` (`src/store.ts:2152`), so a proposal cannot leak in. Proposals are
  read through a new `listReleaseProposals(projectKey)` beside it, with the same archived-project
  exclusion. **It returns LIVE proposals only** (`retired_at IS NULL`) — a consumed proposal has
  been superseded by the release that shipped it, and returning it would render the pair this
  section forbids. **It sorts ASCENDING by version** — AC1's literal order (`0.2.1`, then `0.3.0`)
  — deliberately the opposite direction from `listReleases`' newest-first, so a consumer
  concatenating "shipped, then proposed" needs no reversal. Both facts are settled here because
  §S8's routes and the strip render depend on them.
- **A revision retires its predecessor; it never edits one in place.** `release-propose` for a
  label that already holds a LIVE proposal with a DIFFERENT `targetAt` stamps that proposal's
  `retired_at` and inserts the new one, in ONE transaction — the same idiom as consumption above,
  and the reason no new column is needed. Exactly one live proposal per label ever exists, and the
  revision history stays auditable through `getEvent`. Editing the held event's payload in place
  would destroy the fact that the target moved, which is precisely the signal a slipping plan
  needs to leave behind. An identical re-post (same label, same `targetAt`) writes NOTHING and
  reports `converged: true` (§S7).
- **A live proposal is authored data and survives the retention cap.** `enforceRetention`'s
  count-cap exemption is scoped to `kind === "gate"` carrying a stored version, so without a
  change a live `release-proposal` is prunable exactly like a `release` milestone. The two are not
  alike: a pruned `release` is rebuildable from its git tag (`repair-provenance`), whereas a
  pruned proposal is authored intent with no external source and is gone for good. The exemption
  extends to `release-proposal` rows with `retired_at IS NULL`. A CONSUMED proposal is prunable
  again — the release it became now carries the fact.
- **A proposal retires no gate.** `recordMilestoneEvent` stamps gates only for
  `type === "release"` (`src/store.ts:1768-1773`); CR-CRU-073's rule stays scoped to real releases.
- **`--target` is optional and revisable**, stored as `targetAt` in **epoch SECONDS** — the same
  unit as `releasedAt` (`public/app-logic.mjs:874`; `src/store.ts:2154`; `src/types.ts:218-223`).
  `recordMilestoneEvent`'s `meta` gains `targetAt?: number`, accepted only for `release-proposal`,
  mirroring the `type === "release"` field stripping at `src/store.ts:1750-1752`; `RunEvent` gains
  `targetAt?: number` beside `releasedAt` (`src/types.ts:223`).
- **One formatter for both dates.** `formatReleaseDate(epochSeconds)` is exported from
  `public/app-logic.mjs` beside `relativeTime` (`public/app-logic.mjs:20`) and takes epoch
  SECONDS. No call site constructs a date from `releasedAt` or `targetAt` itself — two conventions
  on one surface renders 1970.
- **A shipped release supersedes and consumes its proposal.** Recording a `release` whose `label`
  equals a live proposal's `label` stamps that proposal's `retired_at` in the **same transaction**
  as the release insert — the shape `recordMilestoneEvent` already uses for gate retirement
  (`src/store.ts:1770-1773`, helper `src/store.ts:1860-1873`). No new column: `retired_at`
  (`src/store.ts:1068`) already means *no longer live, still auditable*, and `listEvents` filters
  on it **unscoped** (`src/store.ts:2086`), so a consumed proposal leaves the live feed and stays
  retrievable through `getEvent`. One gate renders, never a pair.
- A proposal with zero CRs is legal — a declared intent, not an error.
- **A declared target is not the deferred forecast.** The confidence-gated P50/P80 band remains
  CR-CRU-022's, deferred past 0.2.0 (`docs/research/DN-crucible-roadmap-view.md:31`). A declared
  target is authored data and does not reopen that decision.

### §S2 `queue_entries` carries the declaration, and the read publishes it

Three additive nullable columns on `queue_entries` (`src/store.ts:1146-1156`):

- **`release TEXT`** — the declared target release label.
- **`track TEXT`** — the declared track, stored in the PRD's locked wire format **`track-<n>`**
  (PRD round 19, `docs/research/PRD-crucible-v2.md:323-324`: "tracks are numbered lanes — Track 1,
  2, 3… (wire format `track-<n>`)"). `--track` accepts `2`, `track-2` or `Track 2` and **normalises
  to `track-<n>` before storing**; a value carrying no integer is refused by name. The format is
  load-bearing rather than cosmetic: `public/app-logic.mjs:479` extracts the first integer so it
  sorts either shape, but CR-CRU-092 matches `--track` against the live `tracks` list **by value**
  (092 AC7) and CR-CRU-085 draws one lane per distinct reported track — so two clients writing `2`
  and `track-2` would produce two lanes for one track. Normalising here is what makes that
  impossible. `buildRoadmapGraph` already reads `e.track` and tolerates its absence
  (`public/app-logic.mjs:861`); nothing has ever supplied it.
- **`lifecycle_json TEXT`** — `{"state":"SUPERSEDED","by":"CR-CRU-088","at":<epoch ms>}` or
  `{"state":"VOID","reason":"…","at":<epoch ms>}`. One JSON column rather than three flat ones, the
  in-table precedent being `depends_on_json` (`src/store.ts:1151`). Projected as the exported
  `QueueLifecycle { state: "SUPERSEDED" | "VOID"; by?: string; reason?: string; at: number }`, with
  `at` in epoch **MILLISECONDS** — matching `filed_at` / `retired_at`, the two in-table neighbours
  it will be compared against. The seconds unit belongs to the git-sourced dates alone
  (`releasedAt` / `targetAt`), which is why the formatter in §S1 takes seconds and this does not.

**A defaulted `seq` beside declared ones is reported, never silently invented.** Carry-forward
preserves an explicit `seq`, and the posted array index remains the fallback for an entry that has
neither a posted nor a held value. A `queue-file` that ADDS a CR to a backlog already sequenced by
`wave-sequence` therefore mixes scales: carried values `10, 20, 30` beside a new row's index `1`,
which sorts it between `0` and `10` — deterministic, but not authored. The write emits a warning
naming every CR whose `seq` was defaulted while a sibling in the same wave carries an explicit one,
with `wave-sequence` as the remedy. This is the §S3 severity ladder's *warn-and-write* rung: the
post is not refused, because a backlog edit must not require re-authoring the order, but silence
would let an arbitrary position read as an authored one.

**Migration.** ONE new step appended to `MIGRATION_BODIES` (`src/store.ts:549`): `tableExists`
guard, then a PRAGMA-checked `ALTER TABLE queue_entries ADD COLUMN` per column — the pattern every
additive step uses (precedent `src/store.ts:761-768`) — plus a `satisfiedBy` probe asserting all
three columns are present. `SCHEMA_VERSION` is `MIGRATIONS.length` by construction
(`src/store.ts:794-801`), so it advances by **appending a step**, never by editing a number. The
base `CREATE TABLE IF NOT EXISTS` gains the three columns in their current shape, so a fresh store
never runs the retrofit.

**Read.** `QueueEntry` (`src/types.ts:355-363`) and `listQueue`'s projection
(`src/store.ts:3094-3104`) gain `seq` **always** — the stored integer, verbatim, never re-derived —
and `release` / `track` conditionally, through the projection's existing null-omits-the-key idiom.
`lifecycle` is projected as the parsed object when `lifecycle_json` is present.

**`lifecycle` is a SECOND AXIS, never folded into `status`.** `QueueStatus`
(`src/types.ts:338-341`) is `PENDING · IN_PROGRESS · COMPLETED · COMPLETED_UNTRACKED`, **derived and
never stored**, with the precedence documented at `src/store.ts:3059-3078`. The PRD locks that
derivation — "the Wave → CR sequence table with depends-on and DERIVED statuses (PENDING = no plan,
IN_PROGRESS = open plan, COMPLETED = closed + merge)" (`docs/research/PRD-crucible-v2.md:350-352`) —
so `SUPERSEDED` / `VOID` **must not** become `QueueStatus` members and must not override the derived
value: a superseded CR whose plan is open still reads `IN_PROGRESS`, because that is true. The two
axes answer different questions — `status` is *what happened to the work*, `lifecycle` is *whether
the work is still wanted*. No consumer collapses them, and neither one is defaulted when absent.
Rendering the second axis on the roadmap surface is **CR-CRU-078's** (see its AC27), and this CR
ships the data plus the write-time signal (AC15) that the CR's dependants are broken.

**Coexistence with the full replace.** `replaceQueue` (`src/store.ts:3032`) keeps DELETE-then-INSERT
and keeps dropping a CR absent from the posted set, but it must not destroy a declaration it was
never handed. Inside the same transaction, **before** the DELETE, it snapshots each existing row's
`release`, `track`, `seq` and `lifecycle_json` and carries them forward for any `cr` present in both
the stored and the posted set; a posted entry that declares a value overrides the snapshot. Without
this, one `queue-file` erases the whole roadmap.

### §S3 The verbs

Five new verbs. The implementation lands **once** in `clients/_crucible_axi.py` (the CR-CRU-054 DRY
rule); each of the five clients wires the subparser and delegates, exactly as `queue-file` does
(`clients/python-crucible.py:1485-1492` → `clients/python-crucible.py:1100-1104`).

| Verb | Effect |
|---|---|
| `release-propose --label <v> [--target <date>]` | Records or revises the `release-proposal` milestone (§S1). The super container must exist before a CR can target it. |
| `cr-plan --cr <id> --release <v> --wave <n> --title <brief>` | Per-CR **upsert** of one `queue_entries` row: `release`, `wave`, `title`. Re-running with different values is a legitimate re-plan, not an error. Moving a CR out of a wave leaves that wave's remaining `seq` dense — the gap closes and only that CR moves. |
| `wave-sequence --release <v> --wave <n> --crs A,B,C [--track <t>]` | §S4. |
| `cr-supersede --cr X --by Y` | Writes `lifecycle_json` state `SUPERSEDED` with `by`. The work still happens, elsewhere. |
| `cr-void --cr X --reason …` | Writes `lifecycle_json` state `VOID` with `reason`. The work is not happening. |

Neither `cr-supersede` nor `cr-void` deletes a row; the CR stays visible carrying its declaration.
Both are **refused, naming the release**, when the CR is a member of any cut release's `crs` —
settled fact is immutable.

**ORCHESTRATOR only.** Each route passes the existing caller-auth seam `requireRegisteredCaller`
(`src/v2.ts:221-236` — 409 + state-derived `help[]`), then a new sibling that refuses a caller whose
stored role is not `ORCHESTRATOR` (`Agent.role`, `src/types.ts:69`; `AGENT_ROLES`,
`src/types.ts:53`; read via `store.getAgent`, `src/store.ts:1483`). An agent row carrying **no**
role — pre-CR-044 rows carry none, and it is never fabricated (`src/types.ts:65-69`) — is refused,
not assumed.

**What the gate can and cannot enforce — do not invent a role.** `AGENT_ROLES` (`src/types.ts:53`)
is `RED · GREEN · FIX · VERIFY · ORCHESTRATOR · report`: there is **no MAINLINE role**, and a track
orchestrator registers as `ORCHESTRATOR` exactly as the mainline one does. The PRD's hierarchy —
"MAINLINE ORCHESTRATOR (widest: allocates lanes, launches waves, gates boundaries) → ORCHESTRATOR
(track scope: one lane's CR queue)" (`docs/research/PRD-crucible-v2.md:310-316`) — is a **scope
convention Crucible does not model as data**, and the design document asks only for
`register --role ORCHESTRATOR` (§10). So this gate stops RED/GREEN/FIX/VERIFY/report and
unregistered callers, and that is the whole of its reach. "Only mainline re-plans the roadmap"
stays a workflow convention; enforcing it needs a new stored role or an identity check and is a
**separate CR**, not a smuggled schema change here.

**The gap not to repeat:** `queue-file` reaches python only (`clients/python-crucible.py:1486`; the
name is absent from `bun-`, `rust-`, `mvn-` and `arduino-crucible.py`). Roadmap registration is
stack-agnostic orchestrator work, so all five verbs reach all five clients.

### §S4 `wave-sequence` is ONE call carrying the whole ordered list

The array position of `--crs` becomes `seq`, because **the order is the payload** — sending CRs one
at a time makes their sequence an accident of arrival.

- `seq` already exists (`src/store.ts:1154`), is already the read order (`src/store.ts:3083`), and
  is already consumed as `data.seq` by the renderer (`public/app.js:2739`, emitted at
  `public/app-logic.mjs:859`); CR-CRU-077 AC2 committed the graph to authored order over its own.
- The call **replaces** the `seq` assignment of exactly the named `(release, wave)` and touches no
  other container. The resulting `seq` is dense and strictly increasing across that wave, and
  globally ordered so a wave's block sits after every earlier wave of the same release.
- **Insert and reorder are the same call**: re-send the list. There is no `--after X` and no
  `--move-to N` — a positional API is stateful and cannot express "the order I did not intend".
- A CR in `--crs` with no `cr-plan` row, or whose planned `(release, wave)` differs from the call's,
  is **refused by name**. Sequencing never plans.
- `--track` applies to every CR in the list.

### §S5 Dependency validation severities

This **extends existing law** rather than competing with it: `handleQueuePost` already accepts an
unresolvable dependency and flags it, never rejects it (`src/v2.ts:1755-1759`, computed at
`src/v2.ts:1807-1812`).

| Finding | Response |
|---|---|
| **Cycle** — A depends on B depends on A | **hard refusal** (409), the cycle's members named in order, nothing written |
| **Unknown dependency** — a dep naming no known CR | flagged in `unknownDependencies`, **never rejected** |
| **Out-of-order** — B precedes its own dependency A | `warnings[]` naming every offending `[dependant, dependency]` pair; the sequence **stands, stored as authored** |
| **Cross-wave backwards** — a CR depends on one in a *later* wave | `warnings[]` naming **both containers** (`release/wave` → `release/wave`), not the two CRs |

Validation runs on `cr-plan` and `wave-sequence`. The cycle is the only finding that refuses.
**Crucible never substitutes an order of its own** — the same commitment CR-CRU-077 AC2 makes about
the render layer, applied to the write path.

### §S6 The client asks (AXI P5 / P6 / P7 / P9)

A `cr-plan` missing `--release` or `--wave` is neither accepted nor failed blankly. The client
resolves it **before** posting — nothing reaches the server — and emits an `ok:false` envelope on
stdout with exit **2**, the fleet's usage code
(`docs/changes/CR-CRU-030-fleet-toon-axi-compliance.md:236-238`), carrying:

- `needs=[release, wave]` — exactly the undeclared fields (P6).
- `releases[n]{label,status,waves}` — the live candidate proposals and the waves already planned
  against each, read from the server (P7).
- `help[n]` — pre-filled next-step templates (P9): one `cr-plan` line per candidate
  release/wave with the caller's own `--cr` and `--title` already substituted, plus a
  `release-propose --label <v>` line for the case where the intended release does not exist yet.

It **never guesses**, including when exactly one release or exactly one wave is open — silent
inference is the failure class this design removes. With **no** proposal recorded at all the
envelope is a definitive empty state (P5) whose only `help[]` entry is `release-propose --label <v>`.

**Division of labour** holds: the server stays plain functional REST — idempotent writes, structured
records, referential refusals that name the state found, using the existing `hints` `help[]`
convention on failures. It emits no templates and no prompting. The asking is entirely the
client's, so no business rule lives in a client and no two clients can decide differently.

### §S7 Idempotency

Every verb's envelope carries **`converged: true|false`**, reusing the fleet's existing convergence
contract: `converged` is true only when the stored state already equals what a fresh write would
produce — `manifest.run_manifest_stage` (`crucible_axi/manifest.py:105-118`), the shape
`install.run_fleet_stage` mirrors (`crucible_axi/install.py:941-991`).

- `release-propose` — converged when a live proposal with the same `label` **and** the same
  `targetAt` is already held.
- `cr-plan` — converged when the row's `release`, `wave` and `title` already match. A converged
  upsert writes nothing, including `filed_at`.
- `wave-sequence` — converged when the stored `seq` order and `track` for that `(release, wave)`
  already equal the posted list.
- `cr-supersede` / `cr-void` — converged when the same `lifecycle` state and reference are stored.

A converged call writes nothing and emits no warning it did not earn.

### §S8 The wire — the five routes, named

This table is the contract between the two halves, and the only thing either half may assume about
the other. Paths follow the established project-scoped dispatch (`src/v2.ts:2268-2301`:
`/api/v2/projects/` sliced into `segments`, matched on `segments.length` + `segments[1]` + method),
so all five land in the same `startsWith` block as `queue`, `releases`, `archive` and `stop`.

| Verb | Method + path | Request body | Response |
|---|---|---|---|
| `release-propose` | `POST …/projects/<key>/release-proposals` | `{label, targetAt?}` | `{ok, converged, proposal:{label,targetAt?}}` |
| `cr-plan` | `POST …/projects/<key>/queue/plan` | `{cr, release, wave, title}` | `{ok, converged, entry, warnings[]}` |
| `wave-sequence` | `POST …/projects/<key>/queue/sequence` | `{release, wave, crs[], track?}` | `{ok, converged, entries[], warnings[]}` |
| `cr-supersede` | `POST …/projects/<key>/queue/<cr>/supersede` | `{by}` | `{ok, converged, entry, resolvedDependants[]}` |
| `cr-void` | `POST …/projects/<key>/queue/<cr>/void` | `{reason}` | `{ok, converged, entry, brokenDependants[]}` |

- **`GET …/projects/<key>/release-proposals`** is the read §S6's `releases[]` candidate list is
  built from — the client cannot ask without it, and `listReleases` must not be repurposed (§S1).
- Every body also carries the caller identity fields `requireRegisteredCaller` already reads
  (`src/v2.ts:221-236`); the role gate is applied on top (§S3).
- Failure envelopes reuse the existing `fail(status, message, {help})` + `hints` convention — 409
  for a cycle (§S5) and for an unregistered/wrong-role caller, 404 naming the unproposed release
  (AC6), 400 naming the offending field and index as `handleQueuePost` does (`src/v2.ts:1756-1758`).
- **No PATCH, no PUT, no DELETE.** Re-planning and re-sequencing are re-POSTs (§S4), and neither
  lifecycle verb deletes a row (§S3).

**Settled during C2 (the server half is built; these are now contract, not choices).** C3's clients
assert against this list, so nothing here may be re-decided in a client:

- **Status is `200` on EVERY success, converged or not** — `handleQueuePost`'s shape, not
  `handleMilestones`' `201`/`200` split. A client keys on `ok` + `converged`, never on the code. A
  client asserting `201` for `release-propose` is wrong.
- **`warnings[]` members are STRUCTURED objects**, never prose: `{code, message, crs?, containers?}`.
  Codes in use: `out-of-order`, `cross-wave-backwards`, `defaulted-seq`, `unsequenced-members`.
  Five clients must render a warning without parsing English, and AC10's "names the pair" is a
  structural requirement.
- **`unknownDependencies` rides `cr-plan` and `wave-sequence`** under the key `handleQueuePost`
  already uses. AC9 requires it; it is additive to the table above.
- **`GET …/release-proposals`** answers `{ok, proposals:[{label, targetAt?, timestamp, waves[]}],
  totalCount}`. `waves` is joined SERVER-side so five clients cannot join it differently. No
  `status` field is emitted — every returned proposal is live by construction, so a status would be
  fabricated; the client labels them.
- **The bulk queue POST accepts a per-entry integer `seq`**, refused by name AND index when
  non-integer. `QueueEntryInput.seq` existed after C1 but no route fed it, and `wave-sequence`
  only ever produces dense values — so an explicitly sparse order (AC23's `10, 20, 30`) is
  expressible only here. This is the one wire addition beyond the five-route table.
- **`cr-plan` against a SHIPPED release label is refused `404`**, identically to an unproposed one:
  §S1 consumes a proposal when its release ships, so a shipped label is settled history and no
  longer a plannable target.
- **AC7's two refusals are both `404`** — a `cr` the container does not hold, and a `cr` that sits
  in a different container (the latter naming BOTH containers).
- **A cycle refusal outranks convergence.** A `cr-plan` that would be converged is still refused
  `409` when its `cr` sits in a dependency cycle, because §S5's check precedes the write. Both
  outcomes write nothing.
- **Warn-and-write, not refusal, in three places**: `wave-sequence` when the wave holds members the
  posted list omits (they keep their relative order and are appended after the authored block);
  `cr-void` when dependants exist (AC15 requires the CR to END UP void with its dependants named,
  so the list is a report); and AC23's defaulted `seq`.
- **The `seq` container is the WAVE, not `(release, wave)`** — a strided block per wave
  (`WAVE_SEQ_STRIDE`), which is what makes "dense within a wave", "wave blocks ordered" and
  "touches no other wave" simultaneously satisfiable. Sound because a wave has belonged to exactly
  one release since CR-CRU-014 (`Wave 5 (0.2.0)`); two releases sharing a wave number would share a
  block. Not refused, documented at the constant. Declaring a release on a CR that stays in its
  wave therefore moves no `seq`.

**Settled during C3 (the client half is built; these bind the fleet).**

- **Request bodies are the named fields plus `agentId`, and NOTHING else** — no `context` block.
  The body column above is the contract and lists none; the server's `eventContext()` treats it as
  optional. Asserted strictly (exact-dict), so adding one later must be a decision rather than a
  drift.
- **`--target` input format.** §S1 fixes the WIRE unit (epoch SECONDS) but named no CLI format.
  `--target` accepts an ISO-8601 **date** (read as midnight **UTC**, so the stored value is
  machine-independent), an ISO-8601 **datetime**, or a bare **epoch-seconds integer**. Anything
  else is refused BY NAME with exit `2` and no POST. A local-timezone reading is specifically
  rejected: the same command on two machines must not record two different targets.
- **`--fields` NARROWS on these five verbs**, deliberately diverging from `status`, where the flag
  is ADDITIVE (a base column set plus requested extras). A roadmap row is already the minimal
  record the write produced, so an additive flag would have nothing to add and P2 would be
  unsatisfiable. The divergence is intentional and documented at the selector.
- **`totalCount` rides EVERY roadmap envelope**, not only obviously list-bearing ones: the list
  length for a list answer, `1` for a single-record answer, `0` for a failure. Uniform and never
  meaningless — and it settles the "is `unknownDependencies` a list answer?" argument by not
  having it.
- **`requiredRole: ORCHESTRATOR` rides every FAILURE envelope.** AC16 requires BOTH refusals to
  name the required role, but the shared caller-auth seam's unregistered-caller 409 does not carry
  one, so the client discloses it. It is disclosure of a fixed fact, not a client-side decision.
- **A refusal LIFTS the server's own `help[]`; it never re-derives it.** The client parses the
  server's structured error and surfaces that `help[]` verbatim. This is what keeps §S9 honest —
  AC6's help entry is `roadmapHints.unproposedRelease`'s, not a second copy of the same rule living
  in a client — and it means changing a server hint reaches all five clients for free.

**Settled during C5 (VERIFY found `wave-sequence` writing outside its own scope; these correct the
contract, and two are externally visible).**

- **`wave-sequence` touches only `(release, wave)` and only the CRs it names.** As first built its
  member query was `WHERE project_key = ? AND wave = ?` — **wave alone** — so a CR of a DIFFERENT
  release sharing the wave number was renumbered AND stamped with the posted `track`; and `--track`
  was applied to omitted members too, so it landed on CRs the caller never listed. Both were
  reproduced live. The query is now scoped to `(release, wave)`, and `track` is written only for
  `input.crs` while omitted members keep theirs. §S4's "touches no other container" and AC8's "no
  row in any other wave or release changes any field" are about MUTATION, and that is what is now
  enforced. This mattered beyond tidiness: `track` is the field CR-CRU-085 draws one lane per
  distinct value from and CR-CRU-092 matches by value, so a silently re-tracked CR is the same
  one-track-two-lanes failure §S2's normalisation exists to prevent, arriving through another door.
- **The tolerated consequence, now pinned.** With the query scoped, two releases sharing a wave
  number densify from the SAME base and can therefore hold the same `seq` VALUE. That is §S8's
  existing concession ("would share a block. Not refused, documented at the constant"), and it is
  strictly better than what it replaces — before the fix the collision was avoided only by one
  release's call rewriting the other's rows. No read compares `seq` across releases. A test pins
  the equal values so changing it must be a decision, not a drift.
- **A wave overflowing its `seq` block is REFUSED (new 400).** `WAVE_SEQ_STRIDE` is 1000, so a wave
  carries at most 999 CRs before colliding with the next wave's block. `wave-sequence` now refuses
  a call whose resulting membership would reach the stride, naming the wave, the count and the
  limit, with a `roadmapHints.waveOverflow` next step. Silent corruption became a named refusal.
  *Known residual:* `cr-plan` appends with no ceiling, so a wave can still be walked to 1000 one
  CR at a time; `wave-sequence` then correctly refuses to re-author it and the hint names the way
  out. Closing that fully is a refusal on a second verb that no AC covers, and is deliberately not
  smuggled in here.
- **The `defaulted-seq` warning now fires on an observable SCALE MISMATCH, not on any second CR.**
  Its first form warned whenever a `cr-plan` moved a CR into a non-empty wave, and its message
  claimed a sibling carried an "authored" `seq` — false whenever that sibling's value was itself
  `cr-plan`-assigned, which is the common case. It fired on nearly every plan and five clients
  rendered the false claim verbatim. It is now gated on a sibling sitting OUTSIDE the wave's block
  (`seq <= base || seq >= base + WAVE_SEQ_STRIDE`), which is exactly the interleave AC23 exists to
  surface — reachable via a bulk post declaring an explicit out-of-block `seq`. Dropping the
  warning outright, the obvious fix, would have traded a false positive for real silence on that
  case. Gating it on "this wave was authored by `wave-sequence`" would have been INVERTED: an
  authored wave is the harmless in-block case.

### §S9 Division of labour — which half owns which file

Two halves, one wire (§S8). Neither half may change that table unilaterally.

**Client half — the Python fleet implements the new AXI verb surface.** It owns argument parsing,
the asking behaviour (§S6), `track-<n>` normalisation (§S2), exit codes, and the envelope on stdout.
It holds **no business rule**: it never decides an order, never infers a release, never validates a
dependency — it POSTs and renders what came back.

- `clients/_crucible_axi.py` — the five verbs land **once** here (CR-CRU-054 DRY rule).
- `clients/{bun,python,rust,mvn,arduino}-crucible.py` — subparser + delegation each, the shape
  `queue-file` uses (`clients/python-crucible.py:1485-1492` → `:1100-1104`). AC13 counts 5.

**Server half — the Crucible server owns the REST routes AND the UI.** Every rule lives here:
validation severities (§S5), convergence (§S7), the role gate (§S3), ordering (§S1), carry-forward
(§S2).

- `src/store.ts` — three columns + migration step, `listReleaseProposals`, proposal consumption,
  `replaceQueue` carry-forward, `listQueue` publishing `seq`/`release`/`track`/`lifecycle`.
- `src/types.ts` — `QueueEntry`, `QueueEntryInput`, `RunEvent.targetAt`. `QueueStatus` is
  **unchanged** (§S2's second-axis rule).
- `src/v2.ts` — the five routes + the role-gate sibling.
- `public/app-logic.mjs` — `formatReleaseDate` (§S1) and consuming the published `seq` (AC18).
  This is UI, and **UI is the server's half**.

The roadmap surface itself — graph, table, lifecycle rendering, paging — is **CR-CRU-078**.

### §S10 AXI conformance is a requirement, not a style note

The clients ARE the agent-facing interface, so the five verbs conform to the **full AXI standard
(P1–P10, https://axi.md)** — the user's standing fleet requirement (2026-07-21), not a per-CR
choice. Conformance is achieved by **reusing the fleet's existing machinery**, never by
re-implementing it per verb:

| P | Requirement | Reused mechanism |
|---|---|---|
| P1 | token-efficient TOON envelope on **stdout** | `emit_axi` (`clients/_crucible_axi.py:220-229`) |
| P2 | minimal schema + `--fields` | the fleet's existing `--fields` selection |
| P3 | truncation + `--full` | `wave-sequence` / proposal lists truncate by default |
| P4 | pre-computed aggregates | `totalCount` on every list-bearing envelope |
| P5 | definitive empty state | §S6: zero proposals is an ANSWER, never a blank |
| P6 | structured errors on stdout, exit `0/1/2`, idempotent | §S6 exit 2 + §S7 `converged` |
| P7 | ambient context | the existing `context` block `emit_axi` always writes |
| P8 | content-first | no-arg invocation shows live data, per CR-CRU-030 |
| P9 | contextual disclosure — `help[]` next-step templates | §S6, **state-derived** per `clients/_crucible_axi.py:709-713` |
| P10 | consistent `--help` | the subparser shape every fleet verb uses |

`warnings[]` (§S5) and `converged` (§S7) ride this envelope rather than a bespoke one. A verb that
prints prose, returns JSON, writes its errors to stderr, or invents its own envelope is
non-conformant regardless of whether its writes are correct.

## Acceptance criteria

> **A note on AC1–AC3's render clauses, corrected 2026-08-28 after VERIFY.** As first written these
> three ACs asserted properties of the roadmap SURFACE — strip order, a rendered gate, a rendered
> date. That surface is explicitly **CR-CRU-078's** (§S9, Non-goals), so this CR is forbidden to
> build the thing those clauses measure, and each passed only because nothing renders proposals or
> either date at all — satisfied vacuously rather than exercised. The render halves are re-scoped
> to CR-CRU-078 (its AC28/AC29/AC30); what remains here is the DATA contract, which is what this CR
> actually owns and what a consumer needs to get the render right.

- **AC1** — **a proposal never sorts before a shipped release, and proposals order by version.**
  `listReleaseProposals` returns proposals ASCENDING by version — proposing `0.3.0` then `0.2.1`
  reads back `0.2.1`, `0.3.0` — and the order is unaffected by any `--target`, including a
  `--target` **predating** the shipped release's `releasedAt`, which is the direction that could
  break it and must be the fixture's value. `listReleases` returns zero proposals, so the two
  sequences cannot interleave, and §S1's ASCENDING contract is what lets a consumer concatenate
  "shipped, then proposed" with no reversal. A proposal modelled as a dateless `release` fails this
  AC (`public/app-logic.mjs:887-892` sorts it first). *The strip ORDER itself is CR-CRU-078 AC28.*
- **AC2** — **a proposal is invisible to the release machinery, and a shipped release consumes it.**
  `store.listReleases(key)` returns zero events of type `release-proposal` after any number of
  `release-propose` calls, while `listReleaseProposals(key)` returns them all. A live gate at
  `version 0.2.0` still has `retired_at IS NULL` after `release-propose --label 0.2.0`. After the
  real `milestone --type release --label 0.2.0 --commit <sha>`: that gate is retired, the
  proposal's `retired_at` is non-null, it is absent from `listEvents` yet still returned by
  `getEvent`, **exactly one live `0.2.0` record exists at the data layer** (a live pair fails this
  AC), and a proposal for any other label is untouched. *That exactly-one record RENDERING as one
  gate is CR-CRU-078 AC29.*
- **AC3** — **one formatter exists for both dates, and nothing else may construct them.**
  `formatReleaseDate(epochSeconds)` is exported from `public/app-logic.mjs` and reachable through
  the `window` bridge; for `releasedAt = 1787149125` it yields 2026-08-19, and a milliseconds
  reading yields 1970 and fails this AC; absent input yields `""` while a real `0` still yields
  1970-01-01, so absence and the epoch stay distinguishable. An executable scan proves **no other
  date construction is applied to `releasedAt` or `targetAt` anywhere** in `public/`, with a
  positive control proving the scan is non-vacuous. **The formatter ships with zero production call
  sites — deliberately, as the seam CR-CRU-078 renders through.** It is covered by tests but
  unexercised by any surface, and that is the honest state of it on this branch, not an oversight.
  *Routing both fields through it at a call site is CR-CRU-078 AC30.*
- **AC4** — **schema, migration and published fields.** `PRAGMA table_info(queue_entries)` lists
  `release`, `track` and `lifecycle_json`; `SCHEMA_VERSION === MIGRATIONS.length` and has advanced
  by exactly one; a store written by the previous build opens, migrates, loses no queue row, and
  the new step's `satisfiedBy` returns true afterwards. `GET /api/v2/projects/<key>/queue` publishes
  `seq` on **every** entry and `release`/`track` only where declared. `seq` is read from the column,
  not the response index: with a fixture row's `queue_entries.seq` set to a value that differs from
  its position, the response carries the stored value.
- **AC5** — **a full replace does not erase a declaration.** After `cr-plan` and `wave-sequence`
  have declared `release`, `wave`, `seq` and `track`, a `queue-file` POST re-posting the same CR ids
  and carrying neither `release` nor `track` leaves all four values intact for every re-posted CR; a
  CR absent from the posted set is still dropped.
- **AC6** — **`cr-plan` against an unknown release fails by name.** `cr-plan --release 9.9.9 …`
  returns `ok:false` with a non-zero exit, an error naming `9.9.9` as unproposed, a `help[]`
  entry `release-propose --label 9.9.9`, and no `queue_entries` row created or modified.
- **AC7** — **`wave-sequence` naming an unplanned CR fails by name.** With `CR-CRU-100` never
  planned, `wave-sequence --crs CR-CRU-092,CR-CRU-100` refuses, names `CR-CRU-100`, and leaves
  `CR-CRU-092`'s `seq` unchanged — nothing is partially applied. A CR planned into a *different*
  `(release, wave)` refuses the same way, naming both containers.
- **AC8** — **re-sending with two CRs swapped changes only their `seq`.** Sequence `A,B,C,D` then
  `A,C,B,D`: `B` and `C` exchange `seq`; `A` and `D` keep theirs; no row in any other wave or
  release changes any field. Re-sending as `A,B,X,C,D` shifts `C` and `D` by one and touches no
  other wave.
- **AC9** — **a cycle is refused while an unknown dep is only flagged.** A declaration where A
  depends on B and B on A is refused with 409, the cycle's members named in order, and no row
  written. In the same test, a CR depending on the nonexistent `CR-CRU-999` is **accepted** and that
  id appears in `unknownDependencies`. One severity serving both fails this AC.
- **AC10** — **an out-of-order sequence is stored as authored, with a warning.** Sequencing `B,A`
  where B depends on A succeeds, `warnings[]` names the pair `[B, A]`, and `B` holds the lower
  `seq`; a response that reordered to `A,B` fails this AC. A wave-4 CR depending on a wave-5 CR is
  stored and warns naming **both containers**, not the two CRs.
- **AC11** — **the client asks instead of guessing.** `cr-plan --cr <id> --title "…"` with no
  `--release`/`--wave` exits **2**, emits `ok:false` with `needs` exactly `[release, wave]`, lists
  every live proposal with its already-planned waves, and carries a `help[]` template with `--cr`
  and `--title` substituted. With exactly one proposal **and** exactly one planned wave it still
  exits 2 and still writes nothing — an implementation that infers the single candidate fails this
  AC. With zero proposals the only `help[]` entry is `release-propose --label <v>`. Nothing is
  POSTed in any of these cases.
- **AC12** — **running the whole generation twice converges and mutates nothing.** A script issuing
  `release-propose`, N × `cr-plan` and M × `wave-sequence`, run end to end twice: every verb in the
  second run reports `converged: true`, and every `queue_entries` row (`filed_at` included) plus
  every milestone event is byte-identical before and after that second run. Any verb reporting
  `converged: false` on the second run fails this AC.
- **AC13** — **the verbs exist in all five clients.** For each of `bun-`, `python-`, `rust-`,
  `mvn-` and `arduino-crucible.py`: `--help` lists `release-propose`, `cr-plan`, `wave-sequence`,
  `cr-supersede` and `cr-void`, and `<client> cr-plan --help` exits 0. The count of clients exposing
  each verb is **5** — not the 1 that `queue-file` reaches today.
- **AC14** — **supersede and void are refused on a CR inside a cut release.** With `CR-CRU-080`
  named in a recorded release's `crs`, both `cr-supersede --cr CR-CRU-080 --by …` and
  `cr-void --cr CR-CRU-080 --reason …` return `ok:false` naming that release's label, and the row's
  `lifecycle_json` stays NULL.
- **AC15** — **void names the broken dependants; supersede resolves through the successor.** With C
  and D both depending on X: `cr-void --cr X --reason "…"` responds with the broken dependants
  `[C, D]` **named in the response**, and X remains present with `lifecycle.state === "VOID"`.
  `cr-supersede --cr X --by Y` responds with C and D resolving through `Y` and **no** broken-dependant
  list, and X remains present with `lifecycle.state === "SUPERSEDED"` and `by === "Y"`. An
  implementation collapsing both into one "removed" response fails this AC.
- **AC16** — **ORCHESTRATOR only.** For each of the five routes: an unregistered caller gets 409
  (existing seam); a caller registered as `RED` is refused with an error naming the required role;
  an agent row with no stored role is refused rather than assumed to be an orchestrator; a caller
  registered `ORCHESTRATOR` succeeds. Nothing is written on any refusal.
- **AC17** — **`track` is stored in one format, `track-<n>`.** `wave-sequence --track 2`,
  `--track track-2` and `--track "Track 2"` all store the identical value `track-2`, and the queue
  read publishes that value; `--track main` (no integer) is refused naming the value. A build
  storing the caller's spelling verbatim fails this AC — the fixture asserts one distinct `track`
  value across the three calls, which is what stops CR-CRU-085 drawing two lanes for one track.
- **AC18** — **the published `seq` is consumed, not re-derived, by its only in-tree consumer.**
  `buildRoadmapGraph` (`public/app-logic.mjs:847-863`) emits `data.seq` equal to the entry's
  published `seq`. Fixture: entries whose stored `seq` values are `10, 20, 30` yield `data.seq`
  `10, 20, 30` — the surviving `seq: index` derivation (`public/app-logic.mjs:859`) yields
  `0, 1, 2` and fails this AC. This closes the loop the CR opens: CR-CRU-092 forbids `next` from
  copying that derivation (092 §Input) but repairs nothing, and CR-CRU-078 AC13 only defeats a
  *dependency-walk* re-ordering — because `listQueue` is `ORDER BY seq`, the index derivation
  preserves authored ORDER and so survives every other AC in this release while making `seq` mean
  two different numbers on one surface. That is the same failure class AC3 exists to prevent for
  dates.
- **AC19** — **all five verbs are AXI-conformant in all five clients (§S10).** Asserted by extending
  the two EXISTING harnesses, never a parallel checker: verb **presence** in
  `tests/client/test_cr054_fleet_inventory.py` (the frozen fleet set, whose count CR-CRU-075 moves
  to 49) and **envelope conformance** in `tests/client/test_client_fleet_envelope_census.py`
  (CR-CRU-058's detector). For each of the 25 (verb × client) pairs: stdout parses as a TOON
  envelope carrying `verb`, `ok`, `context` and `warnings` (P1/P7); `--help` exits 0 and lists the
  verb (P10); a refusal writes its structured error to **stdout** and exits `2` for a usage failure
  or `1` for a transport failure, never bare prose on stderr (P6); `--fields` narrows the envelope
  and `--full` defeats truncation (P2/P3); every list-bearing envelope carries `totalCount` (P4);
  and every failure envelope carries a **state-derived** `help[]` (P9). A verb emitting JSON, or
  printing prose, or routing its error to stderr fails this AC even when its write is correct.
- **AC20** — **the two halves meet exactly at §S8.** Each of the five client verbs POSTs the method,
  path and body named in §S8 — asserted against a recording stub, so a client that invents a path
  fails without needing a live server — and the server answers those five paths while returning 404
  for the neighbouring shapes a guess would produce (`…/queue/cr-plan`, `…/proposals`,
  `PATCH …/queue/<cr>`). No PATCH/PUT/DELETE route is added (§S8).
- **AC21** — **a revision retires its predecessor, in one transaction, and there is exactly ONE
  write path that can create a proposal.** Proposing `0.4.0` with a target, then re-proposing
  `0.4.0` with a DIFFERENT target, leaves exactly ONE live proposal for `0.4.0` carrying the new
  target; the previous one is retired, absent from `listReleaseProposals` and from the live feed,
  and still returned by `getEvent`. Re-proposing with the SAME target writes nothing and reports
  `converged: true`. `listReleaseProposals` returns live rows only, ascending by version — a
  fixture proposing `0.3.0` then `0.2.1` reads back `0.2.1, 0.3.0`, and a consumed proposal never
  appears. **The invariant is enforced by the dedicated writer, and the generic milestone writer
  is kept out of reach rather than duplicated:** `recordMilestoneEvent` does NOT enforce
  one-live-proposal-per-label, and the only reason that is safe is that `release-proposal` is
  absent from `MILESTONE_TYPES` (`src/v2.ts:1111-1118`), so `POST /api/v2/milestones` refuses the
  type with a `400`. That refusal is asserted as a TRIPWIRE: adding the type to that set would open
  a second, unguarded write path, and the test must fail rather than let the invariant regress
  silently. A fixture may not post one label twice through the store's generic path and call the
  result two live proposals — that is the shape this AC forbids.
- **AC22** — **a live proposal outlives the retention cap; a consumed one does not.** With the
  count cap driven below the event total, a live `release-proposal` survives pruning exactly as a
  versioned `gate` does, while a CONSUMED proposal is pruned like any other retired record. The
  test asserts the surviving row is still readable through `listReleaseProposals`, because a
  proposal has no git tag to rebuild it from.
- **AC23** — **a defaulted `seq` is named in a warning, and the write still lands.** Posting a
  queue whose entries carry `seq` `10, 20, 30`, then re-posting with a NEW CR declaring no `seq`:
  the post succeeds, the three carried values are unchanged, and the envelope carries a warning
  naming the new CR and offering `wave-sequence`. A post where NO entry carries an explicit `seq`
  emits NO such warning — index-only is the ordinary case, not a defect.

## Estimated size

L — three additive columns and a migration step, five server routes plus a role gate, five verbs
wired across five clients, four validation severities, and a new milestone record kind with its own
ordering and consumption rules.

## Risk

The full-replace carry-forward (§S2) is the sharpest edge. `replaceQueue` owns the entire queue
today, so a carry-forward that misses one field means a single `queue-file` silently erases part of
the roadmap — the exact class of silent membership loss CR-CRU-086 exists because of. AC5 asserts
it field by field.

Reusing `retired_at` for a consumed proposal borrows a column CR-CRU-073 introduced for gates. It is
correct because the live-feed filter is unscoped (`src/store.ts:2086`) while the gate-specific query
is already scoped to `kind = 'gate'` (`src/store.ts:2409`); a future query reading `retired_at` as
gate-only would break proposals, so that scoping is load-bearing rather than incidental.

Version comparison for proposal ordering is new code on a surface that has only ever sorted numbers.
A non-semver `--label` must order deterministically rather than throw.

## Non-goals

- The `next` verb and execution-time sequence validation — **CR-CRU-092** (design §13).
- Paging and the collapsible release rail — **CR-CRU-093** (design §14).
- Rendering the roadmap surface — graph, table, selection, row grammar — **CR-CRU-078**.
- The P50/P80 forecast band — **CR-CRU-022**, deferred past 0.2.0.
- Retiring `queue-file` or the markdown queue table; it stays as the bulk bootstrap and coexists
  under §S2's carry-forward rule. `queue-file`'s own fleet parity and the standing verb-surface
  census are **CR-CRU-075**, sequenced behind this CR so parity is done once on the final verb
  surface — AC13 covers only the five verbs this CR introduces.
- Any change to `listReleases`, to release dedup identity `(type, label, commit)`, or to
  `repairProvenance`.
- Validating a declared `--target` against reality, or warning when a target contradicts version
  order — surfacing that conflict is a render concern, not this write path's.
