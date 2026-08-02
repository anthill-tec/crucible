# CR-CRU-058 — Nine rust verbs emit no TOON-AXI envelope, including the pre-merge gate

**Status:** PENDING
**Type:** patch (AXI-compliance — fleet parity)
**Priority:** P1 — one of the nine is `pre-merge-gate`, the output an orchestrator reads to decide a merge
**Depends on:** CR-CRU-030 (established the fleet-wide TOON-AXI contract), CR-CRU-054 (lifted the shared verb surface these must join)
**Labels:** patch, client-fleet, rust, axi-compliance, gate-correctness
**Phase:** Wave 4
**Design reference:** CR-CRU-030 §S1 — the fleet's TOON-AXI conversion, which converted the SHARED
verb surface but left each client's own toolchain verbs untouched. The AXI manifesto's structured
-output principle (https://axi.md) is the contract being violated.

## Context
Measured on `develop` 2026-08-02, during CR-CRU-051's rust site assessment. Nine verbs defined
locally in `clients/rust-crucible.py` produce **no `axi:` block at all** — no envelope, no
`help[]`, no `context`, no `ok:` field. They print bare human lines and return an exit code:

| verb | what it prints today |
|---|---|
| `regression-ingest` | `regression: ok=… passed=… failed=…` |
| `workspace-regression` | `workspace regression: ok=… …` |
| **`pre-merge-gate`** | bare lines |
| `clippy` | `[crucible] cargo clippy exit=N errors=N warnings=N` |
| `workspace-clippy` | as above |
| `smoke-test` | bare lines |
| `docker-up` / `docker-down` / `docker-e` | bare lines |

`grep -n "axi:" clients/rust-crucible.py` returns **nothing** for any of them; the only rust verbs
carrying an envelope are the ones CR-CRU-054 lifted into `_crucible_axi.py`, which emit through the
shared implementation.

**Why it matters, concretely.** `pre-merge-gate` and `workspace-regression` are the paths an
ORCHESTRATOR runs to decide whether a CR may merge. An agent consuming that stdout gets prose it
must regex, not a structured envelope it can parse — which is precisely the failure mode
CR-CRU-030 existed to end, and the reason CR-CRU-047 and CR-CRU-049 exist (narration parsed out of
human text is fragile: both CRs were filed because a human-readable line changed shape and a gate
went blind). The other four clients emit envelopes for their equivalent verbs; rust is the outlier.

This is an ABSENCE of structure, not a wrong value — nothing rust prints today is false. It is
filed P1 rather than P0 because the gate still *works*; it just cannot be consumed the way the AXI
contract promises.

## Scope

### §S0 — BUILD THE DETECTOR FIRST (gap-analysis ruling, 2026-08-02)
**The §S4 guard moves to cycle ONE.** Reason, learned the hard way during this CR's own
gap-analysis: "which verbs emit an envelope" cannot be answered by grep. Three separate
source-pattern sweeps gave three wrong answers — the first flagged all 21 bun verbs as bare
(including `status`, which demonstrably emits); a corrected run mis-scored `arduino cmd_compile`
as bare (it emits via `_compile_gate`); and delegation chains run 2–4 hops deep
(`cmd_unit → _run_surefire_tier → _smart_ingest → _ingest_parsed`) with the emitter sometimes at
the end and sometimes absent. Post-CR-054 the fleet delegates through `_ops()`/`_axi()` as well,
which every naive pattern misses.

So the guard is not the CR's closing safety net — it is the CR's **measuring instrument**, and it
must exist before any fix is scoped. Build it to answer, mechanically and for all five clients:
*does invoking this verb produce an `axi:` envelope?* Prefer DRIVING each verb (subprocess, real
argparse) over static analysis; where a verb cannot be driven without external tooling
(cargo/docker/mvn absent), stub the toolchain rather than fall back to pattern-matching its source.

**Its first output re-scopes this CR.** The "nine rust verbs" figure in the Context below was
derived by reading four verb bodies plus their delegate helpers — solid for those, but the honest
position is that the fleet-wide count is UNKNOWN until the detector runs. The §S1 fix list is
whatever the detector reports, not what this document currently guesses.

### §S0b — THE CENSUS (detector output, 2026-08-02 — this is the CR's real scope)
118 verbs driven as subprocesses with stubbed toolchains. **40 emit no envelope.** Not nine.

| client | verbs | envelope-less |
|---|---|---|
| rust | 28 | **13** |
| mvn | 26 | **12** |
| arduino | 22 | 5 |
| bun | 21 | 5 |
| python | 21 | 5 |

**`pre-merge-gate` is bare in ALL FIVE clients** — the CR's stated top concern turns out to be
five times wider than filed. The orchestrator's merge-decision path emits no envelope in any
client.

Beyond rust's original nine (all confirmed still bare):
- **mvn** `unit`, `module`, `compile`, `e2e` never reach an emitter
  (`_run_surefire_tier → _smart_ingest → _ingest_parsed`, no emit anywhere in the chain).
- **Fleet-wide, in the SHARED module** (so CR-054 lifted a bare implementation — one fix now
  covers all five, the consolidation dividend): `milestone` never calls any emitter, only a
  stderr print.
- **A sibling asymmetry worth naming:** `cycle-activate` / `cycle-done` / `cr-close` go bare
  *specifically when the `/plans` GET fails*, because they call `open_plans()`, which does a bare
  `sys.exit()`. Their siblings `cycle-add` / `checkpoint` / `abort` use `resolve_plan_or_emit()`,
  which correctly emits on the identical failure. Two helpers, same job, opposite behaviour on
  the error path — the exact drift class CR-CRU-054 was built to end.
- **mvn `regression`** DOES emit, but an unguarded `print(f"[regression] running: …")` pollutes
  stdout before the envelope — a §S3 stdout-purity defect, not an §S1 gap. Classified separately.

Zero verbs were unmeasurable. Non-vacuity proven: `status` and `register` detect as enveloped in
all five clients even under a refused connection.

### §S1 — Every rust verb emits a TOON-AXI envelope
All nine gain an `axi:` block matching the fleet's established shape (`verb`, `ok`, verb-specific
result fields, `help[]`, `context`, `warnings[]`) via the shared emitters in `_crucible_axi.py` —
`emit_axi` / the ingest emitters — NOT a rust-local reimplementation. CR-CRU-054 made those
shared; this CR joins the stragglers to them.

Per-verb result fields follow what each verb actually knows: the two regression verbs carry their
`run:` block (`passed`/`failed`/`pending`/`total`/`files` — CR-CRU-051 adds `files` to their human
line and this CR gives it an envelope to live in); clippy carries `errors`/`warnings`; docker
verbs carry the compose action and its outcome.

### §S2 — `help[]` is state-derived, not canned
Per CR-CRU-048's rule: each verb's `help[]` names the concrete next action for the state actually
reached (a failing gate points at the failure, a green one at the next verb). Do not ship a fixed
string per verb.

### §S3 — Stdout purity (absorbs a CR-CRU-046 deferral)
These same verbs carry the stdout-purity defect CR-CRU-046 found and partially fixed: `cmd_clippy`
and the coverage/regression paths print `[crucible] running: …` to **stdout**, polluting the
envelope stream (`cmd_test`'s instance was fixed in CR-046; these were explicitly deferred to a
later CR — this is that CR, and they are the same functions §S1 is rewriting). Every human line
moves to stderr; stdout carries the envelope alone.

### §S4 — A fleet-wide guard
A test asserting **every** verb of **every** client emits an `axi:` block — so the next
toolchain-specific verb added to any client cannot ship envelope-less. Model it on CR-CRU-054's
drift guard: enumerate verbs from each client's argparse, assert each produces an envelope, with an
explicit justified allow-list if any verb legitimately cannot (state the reason in-file).

## Acceptance criteria
- [ ] All nine rust verbs emit an `axi:` envelope with `ok`, verb-specific fields, non-empty
      `help[]`, `context`, and `warnings[]` — asserted per verb by driving the real CLI.
- [ ] The envelopes come from the SHARED emitters, not a rust-local copy — asserted (the CR-054
      drift guard must stay green).
- [ ] `help[]` is state-derived: a failing and a passing run of the same verb produce DIFFERENT
      next-step text — asserted for at least the two gate verbs.
- [ ] No `[crucible] …` human line reaches stdout from any of the nine; stdout parses as a TOON
      envelope alone — asserted (§S3).
- [ ] The §S4 guard fails when a verb is added without an envelope — proven by adding one
      temporarily.
- [ ] Full bun regression green AND full Python regression green (client change → both gates, per
      CR-CRU-045 §S3).

## Non-goals
- Changing what any verb DOES, its flags, or its exit codes — this is output structure only.
- ~~The other four clients' verbs (they already emit envelopes)~~ — **RETRACTED at gap-analysis.**
  That assumption was never verified and is at least partly false: hand-tracing found
  `mvn cmd_unit`/`cmd_module` reaching a print-only `_ingest_parsed` with no emitter in the chain,
  while `arduino cmd_compile` DOES emit via `_compile_gate`. The picture is mixed and only §S0's
  detector can establish it. **Whatever it finds in the other four is IN SCOPE for this CR** —
  splitting a fleet-wide structural gap across five CRs by client would repeat exactly the
  five-times-the-work pattern CR-CRU-054 just spent six cycles undoing.
- Re-litigating CR-CRU-051's `files` placement — that CR lands first; this one gives rust's two
  regression verbs an envelope for the count to sit in.

## Risk
- **`workspace-regression` and `pre-merge-gate` are live gate paths.** Bun-side TS suites assert on
  their current human lines; changing stdout/stderr routing will move those assertions. Every one
  must be re-pointed deliberately, never loosened — the CR-CRU-054 §S4 discipline applies.
- Nine verbs at once is a wide diff in a single client. Slice by verb group (regression pair →
  gate → clippy pair → docker trio) so each slice is separately verifiable.
