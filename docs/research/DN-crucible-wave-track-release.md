# DN — Wave, Track and Release

- **Status**: FINAL — locked by the user 2026-08-22. **Do not change this definition.**
- **Authority**: this DN is the single canonical home. Specs and code **reference** it; they never
  restate or reinterpret it.

## The definition (final)

**A wave is a container for multiple parallel or sequentially executing CRs, with sequential
ordering predicated on its `depends-on` and orchestrator-assigned order.**

**A wave can contain one or more parallel tracks, depending on the project it is executing for.**

**Waves are largely an indicator for orchestrators to synchronize their CR task workflows.**

**A wave is an abstract TEMPORAL concept; a release is a specific ACTIVITY SET.** A wave marks a
period in which coordinated work happens; a release names a concrete set of delivered activities.
Neither is derivable from the other — one is a span of time, the other a membership of things done.

**A release ALWAYS results in a package being released to the users.** That is what makes it a
release: it terminates in a published artifact users can obtain. An internal checkpoint that ships
nothing to users is not a release.

## What a release IS (user-stated, 2026-08-22)

A release is **three things at once**, and a design that captures only the first is incomplete:

1. **A grouping** — the set of CRs whose features it bundles (one or more waves' worth).
2. **A specific TYPE OF WORKFLOW** — but **not** shaped like the CR workflow unit. Clarified by the
   user 2026-08-22: the only part we actually **track** is the **no-mistakes run**, which has its
   own specific flow steps, together with a **release task set**. It is therefore *unlike* a CR's
   plan-and-cycles unit and must not be modelled as one — no RED/GREEN, no cycle ladder. The
   release workflow's tracked trace is the gate run plus its release tasks.
3. **A MILESTONE**, carrying:
   - a **release version**, and
   - a **package or packages** of the software developed so far.

The rest of the release definition lives where it already is — the **Model-B skill and memory** —
and is deliberately not duplicated here.

## The Model-B workflow ontology (user-stated, 2026-08-22)

The typical Model-B workflow is **CR-centric**, with specs pre-defined during the **design phase**:

```
DESIGN PHASE          →  CR SPECS        the most TANGIBLE specification element of the workflow
  execution           →  SOURCE CODE     the assets generated
    release workflow  →  RELEASE PACKAGES  version + package(s) delivered to users
```

- **The CR is the most tangible specification element** — the unit everything else hangs off.
- **The produced source code is the asset generated** by executing that specification.
- **The release packages follow** — the artifacts users actually receive.

So the roadmap's job is to show this chain honestly: specs (CRs) → assets (merged code) →
packages (releases). A release node is the terminal, user-facing end of that chain, which is why it
must carry its version and its package(s), not just a date.

## The three levels

```
RELEASE   bundles the features defined by the CRs of ONE OR MORE waves,
          and ALWAYS contains the features of at least one wave leading to it
  WAVE    a container of ONE OR MORE PARALLEL TRACKS — how many depends on the
          project it executes for; largely a synchronization indicator for
          orchestrators coordinating their CR task workflows
    CR    ordered by `depends-on` AND the orchestrator-assigned order
          (parallel or sequential execution)
```

## What follows from it

- **A wave is temporal and abstract; a release is concrete and user-facing.** A wave bounds *when*
  coordinated work happens; a release enumerates *what* was delivered **and ships it to users**.
  Consumers must never treat one as a restatement of the other.
- **The release workflow is already partially tracked, as a gate.** The no-mistakes run's flow
  steps are the release workflow's observable trace; a release is not a CR-shaped workflow unit and
  gains nothing from being forced into plans and cycles.
- **A release without a published package is not a release.** This is why a release is recorded at
  publish/tag time (CR-CRU-074, CR-CRU-080) rather than declared in advance: the record follows the
  artifact reaching users. For Crucible that means PyPI + npm.
- **A wave is a synchronization device, not a delivery bucket.** Its job is to let orchestrators
  coordinate the CR task workflows running concurrently. It does not represent a shipment.
- **Track count is a property of the project**, decided by its mainline orchestrator — never fixed
  or capped by Crucible. One track, ten tracks, or none declared are all valid.
- **In a single-track (trackless) project the wave concept has very little relevance.** Crucible
  itself is single-track, so waves carry almost no meaning for its own roadmap.
- **Order comes from two inputs together**: `depends-on` (hard prerequisite) and the
  **orchestrator-assigned order** — the authored queue sequence, which is editable by
  re-registering the queue. That is how a roadmap is re-sequenced when refactoring or
  reprioritisation changes the plan; nothing re-derives an order of its own.
- **A wave does not necessarily terminate in a release.** The bundling unit is the **release**, and
  its membership is a set of CRs that may span several waves. An earlier draft of this model — "a
  release is the milestone that ends a wave" — was **wrong** and is superseded here.
- **A CR's wave is mutable** (reassignable during refactoring or reprioritisation); a shipped CR's
  **release membership is settled fact**.

## Consumers

- **Release membership** is recorded per release as `crs` (CR-CRU-080): literally "the CRs this
  release bundled". This is the authoritative expression of the bundling in the definition above.
- **The roadmap graph** (CR-CRU-077) draws the release as the primary grouping, the wave as a
  container, and tracks as the lanes inside it. Storyboard **F14a** already renders exactly this —
  an active-wave cluster containing track swimlanes, lane count **data-driven** (N tracks → N
  lanes; one track → no lane chrome; no track data → no lanes, and that is not an error).
- **No release boundary may be derived from wave structure**, and nothing may render a wave as
  though it terminated in a release.

## Reading the lane during execution — the `next` decision vocabulary

Added 2026-08-28. This model was approved on the workflow flowchart
(`.lavish/crucible-workflow-flowchart.html` §13), but `.lavish/` is **gitignored**, so the design
lived nowhere a clean checkout could reach and CR-CRU-092 pointed its implementer at a file they
may not have. The visual stays the visual; the model of record is here.

A lane is a `(release, wave, track)` slice of the declared roadmap. Asking what to do next in that
lane has exactly **three** answers, and all three are ANSWERS — never a blank, never an error:

| Decision | Meaning |
|---|---|
| `NEXT` | one actionable CR, named, with the call that starts it |
| `HOLD` | the lane's front CR exists but cannot start; the CAUSE is named |
| `DRAINED` | the lane holds no actionable CR; the REASON is named |

**A CR is actionable iff it is `PENDING` on the status axis AND carries no `lifecycle`
disposition.** The two axes are independent by design (CR-CRU-091 §S2): `status` says what
happened to the work, `lifecycle` says whether the work is still wanted, and neither overrides the
other. A `VOID` or `SUPERSEDED` CR keeps its derived status, so **any consumer keyed on `status`
alone will offer abandoned work as live** — the trap CR-CRU-092's gap analysis caught before RED.

**`HOLD` always names a cause**, one of: `in-flight` (the lane already holds an `IN_PROGRESS`
entry — evaluated first, since an occupied lane holds everything behind it) · `dependency` (a
`dependsOn` CR is unmerged and still alive — waiting resolves it) · `dead-dependency` (a
`dependsOn` CR is `VOID`/`SUPERSEDED` — waiting NEVER resolves it; the roadmap must be re-pointed)
· `unknown-dependency` (a `dependsOn` CR the queue does not hold — reported, never rejected).
The `dependency` / `dead-dependency` split is the point of the vocabulary: they demand opposite
responses from the orchestrator.

**`DRAINED` always names a reason**: `wave-complete` (everything in the lane landed or was declared
dead) · `awaiting-assignment` (no entries, or no track declared yet) · `no-roadmap` (the queue is
empty).

**The reader is an oracle, not a scheduler.** It validates the declared sequence; it never
corrects one. If the front CR is blocked the answer is `HOLD` on THAT CR — never a scan past it to
something startable, which would be Crucible substituting an order of its own. That is the same
commitment CR-CRU-077 AC2 makes at the render layer and CR-CRU-091 §S5 makes on the write path.

**Track scoping is conditional, exactly as the swimlanes are** (see Consumers above): with one
track or none, the reader takes no `--track` and never prompts for one; with more than one it
refuses to guess and names the live tracks. Deriving the lane from a single-track project is not
an inference, it is the only lane there is.

## Drift found while releasing 0.2.0 (measured 2026-09-09)

Added after the 0.2.0 release ceremony exposed three gaps. **The definition above is untouched** —
every item here is drift between that locked definition and what shipped, or a decision the
definition implies that was never built. Nothing below introduces a new concept, which is why no
PRD section is owed.

### D1 — wave completion is REQUIRED, and a wave is a CONTAINER, not a union of lanes

USER RULING 2026-09-09, which settles the fork this section originally left open and corrects the
ontology a first draft of it got wrong:

- **A wave is a GROUPING (container) of CRs. A track affects ORDERING AND SCHEDULING.** The two
  are different kinds of thing. A wave is shared across tracks in a multi-track project exactly as
  it is in a solo one — it is one container either way, not a set of per-track slices that happen
  to be added together.
- **Therefore wave completion is a question about the CONTAINER'S MEMBERS ONLY.** The predicate is:
  no actionable CR carries that wave. Track does not appear in it — not as a filter, not as a
  union, not as a special case for one lane or many. A scheduling attribute has no vote in a
  membership question.
- **`wave-complete` is required in every project, solo or multi-track.** CRs are organised into
  waves even in a solo project, so the answer must exist there too. This QUALIFIES — it does not
  contradict — this DN's observation that a trackless project's waves carry little meaning: waves
  still GROUP the CRs; what a solo project lacks is lanes, not waves.
- **It is a DERIVED answer.** No record, no milestone type, no new verb. A derived state needs no
  timestamp and nothing can forget to post it.

Read "every CR finished" the way this DN already words it — *"everything in the lane landed or was
declared dead"*. A wave holding a `VOID` or `SUPERSEDED` CR can still complete; that CR is
finished in the only sense the roadmap tracks (it is no longer wanted). Literal "all COMPLETED"
would leave such a wave permanently open — wave 5 of this project included, since CR-CRU-113 was
voided.

So the two axes stay separate all the way down, which is the same separation CR-CRU-091 §S2 makes
between `status` and `lifecycle`:

```
WAVE   grouping     → which CRs belong together      → answers "is this wave complete?"
TRACK  scheduling   → which lane executes, in what order → answers "what do I do next?"
```

### D2 — what shipped instead: a scheduling attribute deciding a membership question

This DN states a lane is a `(release, wave, track)` slice. The shipped resolver
(`clients/_crucible_axi.py:1821`, `resolve_next`) filters by **track only**, and then answers the
wave question from that track-filtered set:

```python
lane = entries if wanted is None else [
    e for e in entries if canonical_track(e.get("track")) == wanted]   # a SCHEDULING filter
...
if not actionable:
    return (True, 0, _drained_answer("wave-complete", lane), warnings)  # a MEMBERSHIP claim  :1848
```

`next` accordingly takes `--track` and has no `--wave`. One defect, two faces:

1. **Solo project — unreachable.** With no track filter the set is the ENTIRE queue, so
   `wave-complete` fires only when nothing anywhere is actionable. Measured here: at the
   wave-5/wave-6 boundary `next` answered `NEXT cr=CR-CRU-015 seq=62 wave 6`. The wave ended and
   nothing said so; the orchestrator learns it only by noticing the answer names a different wave.
2. **Multi-track project — false.** A track whose own entries have all landed would report
   `wave-complete` while the wave still holds actionable CRs scheduled on another track. Latent
   today (Crucible is single-track), guaranteed the first time a second track is declared.

Both follow from the same category error: the wave answer is computed over a track-filtered set.
Correcting it means the wave predicate reads `wave` and nothing else, while `--track` keeps doing
its own job — choosing which CR is next, and in what order.

The reason vocabulary needs nothing new: `DRAINED_REASONS` at `:1523` is already
`("wave-complete", "awaiting-assignment", "no-roadmap")`, and a lane with nothing scheduled whose
wave is NOT complete is `awaiting-assignment` — which is what that reason already means.

**The fix needs no server change.** Every queue entry already publishes its `wave`
(`src/types.ts:407`), so the predicate is computable from the SAME single read the resolver already
performs — `:1498` states the contract as "ONE read (`GET …/queue`) in, ONE decision out". The
correction lives in the shared client module, where all five clients inherit it at once.

### D3 — a release's IN-FLIGHT state already has a carrier: the gate

This DN states the release workflow "is already partially tracked, **as a gate**", and that a
release is "recorded at publish/tag time rather than declared in advance". Both hold. What is
missing is not an API for "a release started" but a FIELD on the record that already exists:

- `CR-CRU-073 §S1` (`src/store.ts:2013-2016`) retires a gate by matching its first-class `version`
  to a release's `label`, "never parsed back out of the free-text intent".
- No client ever sends `version`: `post_gate` (`clients/_crucible_axi.py:4647`) posts
  `{projectKey, agentId, gate}` + optional `context` in all five clients, and `gate-report` has no
  `--version`/`--label` flag.
- Verified on a live event: `evt-1788925414091-197`, `version: <ABSENT>`, `retiredAt: <none>`.

So CR-CRU-073's retirement mechanism is unreachable through the fleet, and a gate cannot say which
release it is gating. A gate stamped with the release version IS the in-flight record this DN
intends — "no API to declare a release started" is that missing stamp, not a missing route. A
`release-started` milestone type would be a SECOND mechanism for something this DN already assigns
to the gate.

Two further defects in the gate proxy, found in the same ceremony, belong to the same contract
(`gate-run` seals a gate without first establishing the snapshot is terminal AND
release-identified):

| | defect | cite |
|---|---|---|
| a | interim POSTs guarded by `0 < nsteps < 9`, but `axi status` always emits 9 rows (unrun ones `pending`), so streaming NEVER fires | `_crucible_axi.py:4801`, `:1315` |
| b | `axi run`'s 8-minute bounded hold returns with `error:` and no `outcome`; `gate_from_axi(final=True)` falls back to `"failed" if any_failed else "passed"` and seals **`passed`** mid-run | `:1306-1310`, `:4811-4819` |

(b) put a false `outcome=passed` gate on this project's board during the 0.2.0 review, and because
of D3 that event can never be retired by the release it belongs to. `pending` and
`awaiting_approval` are not `failed`, so the fallback is structurally biased toward green, and the
`error` key the snapshot DOES carry is ignored — so "was this a real terminus?" is answerable from
data already in hand.

### D4 — every live CR names a release, and every release names its target date

**User-ruled 2026-09-10**, after the user caught `CR-CRU-117` sitting on the board scheduled but
undrawable. This one DOES touch the locked definition — additively, and only the parts already
declared there.

**The inconsistency.** `declareMembership` enforces every rule about a release a CR DOES name: the
label's shape, and that it corresponds to a live proposal or a recorded release ("so a migration
could store membership in a release nobody proposed"). It has nothing to say about naming NONE.
Absence bypasses the only gate there is. Because roadmap zone 2 is release-scoped, the result is a
CR the scheduler offers and the roadmap cannot draw — measured live, not hypothesised.

The escape hatch was deliberate: there was no release after 0.2.0 to name. That is now a data
problem with a data answer (propose the next release), not a reason to keep membership optional.

**The two rules.**

1. **A live CR's release is REQUIRED.** Declaring a CR without one is refused, not warned. Landed
   history is exempt — its provenance already lives on the release record's `crs` set, and
   retroactive repair of shipped records is a standing non-goal.
2. **A release proposal's TARGET DATE is required.** `targetAt` exists (CR-CRU-091 §S1, epoch
   seconds, deliberately the same unit as `releasedAt` — "when it was aimed for" vs "when it
   shipped") and is optional today. Making it mandatory is what turns a release from a label into a
   commitment with a burn-down axis.

**Why the existing mechanism is already the right one.** A proposal revision RETIRES its predecessor
and inserts a new row rather than editing in place, because — in the store's own words — an in-place
edit "would destroy the fact that the target MOVED, precisely the signal a slipping plan needs to
leave behind". So slippage is auditable by construction, and burn-down needs no new record kind.

**Burn-down and velocity analytics are NOT part of this decision** (user-stated 2026-09-10). What is
being fixed is the integrity rule; the analytics that consume `targetAt` come later and are cheap
precisely because the substrate already keeps its history.

### A CR can be BORN mid-release — user-stated, 2026-09-10

Recorded because the mandate must not assume otherwise. The typical Model-B flow pre-defines specs in
a design phase, but this project dogfoods itself, so release-specific features are discovered *while
the release runs*: 0.2.0 grew an entire second wave — CR-CRU-114, 115, 116, 117 — designed and
implemented **on the release branch**, in response to real-time discovery during the ceremony.

Consequences the rules must respect:

- Membership is declarable **at birth into the release already in flight**, which the live-proposal
  mechanism supports today: 0.2.0's proposal is live, so a CR discovered on its branch can name it.
- A mandate that required a CR to exist before its release was cut would forbid exactly the mode
  this project runs in. The rule is "name a release", never "name it before the branch".
- In Crucible a release is a MILESTONE (definition §3). In Model-B it is also a distinct release
  PROCESS with its own task set. D3 already routes the in-flight half to the gate; D4 routes the
  membership half to the proposal. Neither adds a record kind.

### D4's fallout — the transitional door closes, and history needs a different one

All user-ruled 2026-09-10, in the same conversation as D4.

**1. The bulk queue route is TRANSITIONAL and is deprecated.** `queue-file` → `POST …/queue` exists
because this project is simultaneously Crucible's source and its first user: the board had to be
bootstrapped from a Markdown table that predated every roadmap verb. That migration is over, and the
route's cost is now measured in incidents — TWO, both data loss: `CR-CRU-117` reached the board with
no release and no authored seq (2026-09-10), and `CR-CRU-082`'s VOID disposition was destroyed when
the board was repopulated through it (2026-08-29, recorded in that entry's own lifecycle reason).

The replacement is not new — **it shipped in CR-CRU-091 §S8 and CR-CRU-106 §S1**: five per-CR routes,
each passing the membership gate, each carrying an author, none able to erase a field it did not send.

| verb | route | declares |
|---|---|---|
| `cr-plan` | `POST …/queue/plan` | one CR's release + wave |
| `cr-depends` | `POST …/queue/depends` | one CR's whole dependency set |
| `wave-sequence` | `POST …/queue/sequence` | one wave's authored order |
| `cr-supersede` / `cr-void` | `POST …/queue/<cr>/supersede\|void` | lifecycle disposition |
| `release-propose` | `POST …/release-proposals` | the release and its target date |

Registering a CR is therefore three calls, and every failure mode the bulk door produced is
unreachable through them. Deprecation lands as a WARNING first (CR-CRU-118); REMOVAL plus a
file-driven sync that issues those per-CR calls is 0.3.0 work.

**2. CR-CRU-022's burn-down scope source must be re-based.** Its §S3 and AC2 derive scope-change
snapshots from `POST /queue` being called twice (`queue_snapshots` + a `scope-change` step). If the
bulk route retires, that source retires with it. Per-CR declaration writes are the better source
anyway — finer-grained, and each carries an author — but the re-base is a DESIGN change to a spec that
is already written, so it is recorded here rather than discovered inside that CR's gap analysis.

**3. Historical membership is a DERIVATION, not a plan — and today no door accepts it.** Measured on
this tree: `declareMembership` validates a declared label against `liveProposalLabels` alone and
answers `404 release X has no live proposal — it is not a plannable target`. A shipped release's
proposal is consumed by its own insert (`stampProposalRetired`), which that gate's own comment calls
"settled history". So `cr-plan --release 0.1.0` is refused BY DESIGN, and the bulk door shares the
gate — there is no gated way to state that a landed CR belonged to a shipped release.

The rule that opens it without opening anything else: **a declared label naming a RECORDED release is
accepted only where that release's own `crs` set already names the CR.** That is a derivation from
settled fact with a built-in self-check — it cannot add new scope to a closed release, because the
release itself has to already claim the CR. Measured: all **62** landed release-less rows are named
by a recorded release (`0.1.0` → 60, `0.1.2` → 1, `0.1.3` → 1; `0.1.1` names none, and no row needs
it). Zero not derivable.

**4. The 62 are BACK-FILLED, not exempted** (user-ruled, reversing this DN's first draft). The release
record stays the single source of truth and the queue row inherits what it already says, so the
mandate ends with zero exceptions and 0.1.x history becomes drawable. The backfill is a data step that
runs once rule 3 ships.

### What this drift section decides

- **Nothing about the locked definition** in D1–D3. Wave stays temporal and abstract; release stays a
  concrete activity set terminating in a published package; no release boundary is derived from
  wave structure.
- **A wave is a container of CRs; a track is scheduling.** Wave completion is derived from
  membership alone, required in every project, and never recorded as an event (D1, user-ruled).
- **The release's in-flight visibility is a gate-identity problem, not a new record kind** (D3).
- **D4 DOES extend the definition, additively**: membership in a release is mandatory for live work,
  and a release proposal must declare its target date. Both use mechanisms already shipped
  (`declareMembership`'s gate, CR-CRU-091's `targetAt`); neither adds a record kind, a route, or a
  migration of shipped history. Burn-down analytics are explicitly out.
- **A CR may be born mid-release** and named into the release already in flight — the mode this
  project actually runs in, and the reason the rule is "name a release", not "name it first".
- **No open questions remain in this section.** CRs may be derived from it directly.
