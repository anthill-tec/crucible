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
- The other four clients' verbs (they already emit envelopes; the §S4 guard will prove it or
  surface counter-examples, which get filed, not fixed here).
- Re-litigating CR-CRU-051's `files` placement — that CR lands first; this one gives rust's two
  regression verbs an envelope for the count to sit in.

## Risk
- **`workspace-regression` and `pre-merge-gate` are live gate paths.** Bun-side TS suites assert on
  their current human lines; changing stdout/stderr routing will move those assertions. Every one
  must be re-pointed deliberately, never loosened — the CR-CRU-054 §S4 discipline applies.
- Nine verbs at once is a wide diff in a single client. Slice by verb group (regression pair →
  gate → clippy pair → docker trio) so each slice is separately verifiable.
