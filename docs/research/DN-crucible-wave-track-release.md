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
