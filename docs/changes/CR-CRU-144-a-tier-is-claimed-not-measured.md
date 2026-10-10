# CR-CRU-144 — a tier is claimed, never measured

**Type** fix · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-111 · **Status** VOID — voided at gap
analysis 2026-09-24 (user ruling)

> **VOID (2026-09-24).** The gap analysis measured both halves:
>
> - **§S1's premise is false.** `tests/bdd-section.test.ts` has classified **`integration`** in every
>   version since it was written (`54191c5`, `91e7aec`, `bf466f6`, `c59131e`), including at `8f8312d`,
>   the commit this spec cites, when read with that commit's own classifier. The classifier has seen
>   real-time waits since 2026-09-08: `REAL_WAIT` and `NAMED_WAIT` in `scripts/test-targets.ts`, with a
>   1 s threshold (`402eb9e`, `f943de1`). A scan of all 83 `unit` files at `a9a0ef3` finds no hidden
>   wait of 1 s or more. Its only non-literal hits are a comment, a 400 ms wait and fixture strings.
>   The "classifies `unit`" claim was never measured.
> - **§S2 is honest as it stands.** A targeted `bun-crucible.py test --tests …` files
>   `tier: unstated`, which CR-CRU-111 §S2/AC3 calls the honest answer. A caller who needs a tiered
>   run already has the declared-tier verbs (`unit` / `integration`), and the wall-vs-CPU falsifier
>   (CR-111 AC6b) already flags a `unit` run that spends its time waiting.
>
> The record below is kept as written.

## Problem

This project decides a test's tier two ways, and neither one looks at what the test actually does.

**1. The classifier reads for SPAWNS, and a tier is about DEPENDENCIES.**
`scripts/test-targets.ts`'s `INTEGRATION_MARKERS` are `chromium.launch`, `Bun.spawn`, `spawnSync`,
`Bun.serve`, `startServer` and `:3849` — every one a spawn or a listener. The DN's own rule
(`docs/research/DN-testing-tiers-in-crucible-projects.md`) names a third dependency explicitly:

> a browser, a spawned CLI, an HTTP listener, a live service — **or anything that WAITS on real
> time** (a poll tick, a debounce, a watchdog)

Nothing in the marker set can see a wait. Measured on `develop` at `8f8312d`:
`tests/bdd-section.test.ts` sleeps 6 s of real time to drive the shell's own health watchdog, and
classifies **`unit`** — so `bun run test:unit`, the FAST target, carries a 6-second real-time wait.
Found by CR-CRU-015 C2 GREEN, which produced the first test in this repo that exposes it.

**2. The bun client's targeted verb states no tier at all, and the board stores one anyway.**
`bun-crucible.py test --tests <file>` has no tier flag, so every targeted run files
`tier: unstated` — and four separate agents in CR-CRU-015's cycles flagged, unprompted, that the
board then holds their result under a tier nobody verified. CR-CRU-111 §S2/AC3 settled the reason a
file path cannot imply a tier (a path says nothing about the dependency its tests take); it did not
give a caller any way to say the true one.

Both halves matter because of a rule this project already states: a run ingested under the wrong
tier is **worse** than an unlabelled one — the board then reports coverage the project does not
have.

## Scope

### §S1 — the classifier sees a wait

A test that waits on real time classifies `integration`, whatever it spawns.

The instrument is the open question, and the CR does not prescribe it, because both candidates have
a real defect and the choice needs measuring:

- **A source marker** is consistent with how the classifier works today and needs no run, but
  `sleep` / `setTimeout` / `await new Promise` are all legitimate inside a genuine unit test, so a
  naive marker over-classifies.
- **Measured wall-vs-CPU time** is the falsifier this project's own crucible skill already names
  (*"a run claiming `unit` with wall time far above its CPU time is misclassified, not merely
  slow"*), and cannot be fooled by how the wait is spelled — but it requires a run, so it cannot
  partition files before they execute.

Pick with evidence, state the reasoning, and say plainly what the chosen instrument cannot catch.

### §S2 — a targeted run can state its tier

A caller running specific files must be able to declare the tier that run really takes, and the
board must not present an undeclared run as though a tier had been verified. `tier: unstated`
already exists and is honest; what is missing is the ability to be honest AND precise in one call.

Whether this is a flag on the targeted verb, or a derivation from the classifier of §S1, or both, is
this CR's to decide — but a caller must never be forced to choose between silence and a guess.

## Acceptance criteria

**§S1**
- [ ] `tests/bdd-section.test.ts` classifies `integration`, asserted through the project's own
      `classifyTestSource`/`partitionTestFiles` — not by a hardcoded file list.
- [ ] A test that genuinely takes no real-time dependency still classifies `unit`, including one
      that mentions a timer legitimately, so the fix cannot be a blanket re-label.
- [ ] `bun run test:unit` no longer carries a real-time wait: asserted on the partition, not on the
      target's wall clock, so the guard cannot flake.
- [ ] The instrument's blind spot is STATED in the code that implements it — what shape of waiting
      test it still misses — so the next author extends it instead of rediscovering its limit.

**§S2**
- [ ] A targeted run can declare its tier, and the declared value reaches the stored event.
- [ ] An undeclared targeted run still files `tier: unstated` — unchanged, and asserted, because
      silence remains the honest answer and CR-CRU-111 §S2/AC3 forbids inferring a tier from a path.
- [ ] Nothing in the fleet-shared `clients/_crucible_axi.py` needs the caller to know a tier it
      cannot know; the other four stack clients keep their current behaviour, asserted.

## Risk

- **Over-classification is the expensive failure.** Moving genuine unit tests into `integration`
  slows the fast target for everyone and teaches authors to distrust the partition — which is how
  the fast/slow split dies. The second AC exists for exactly that.

## Non-goals

- Re-tiering the existing suite wholesale. Only tests whose real dependency the classifier currently
  misreads change target.
- Answering DN open question 5 (who runs and gates the browser tiers).
