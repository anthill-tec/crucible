# CR-CRU-124 — `cycle-add` cannot target the plan it means

**Status:** PENDING (0.2.0 — born mid-release, D4)
**Type:** bugfix
**Priority:** P2
**Depends on:** CR-CRU-054 (the shared client plan-access layer this CR corrects)
**Labels:** bugfix, clients, plan-resolution
**Phase:** Wave 6 (0.2.0 — user-directed, live orchestrator session 2026-09-12)
**Design reference:** none — a client-side resolution defect, recorded as a queue candidate
2026-09-02 after its first incident and promoted to a CR after its second

## Context

Hit live twice, five weeks apart, both times blocking real orchestration:

- **2026-09-02, executing CR-CRU-095:** recorded in the queue's dated notes as a candidate patch CR.
  Worked around by folding the cycle into an existing one rather than repairing the verb.
- **2026-09-12, executing CR-CRU-122:** `cycle-add --cr CR-CRU-122` refused with
  `ok:false`, *"113 plans — ambiguous cycle-add. Pass --cr to pick one of: …"* — listing every plan
  in the project, to a caller who had passed `--cr`. The verify cycle could not be added at all; the
  orchestrator had to POST the route directly to proceed.

**Four defects, all in the shared client layer. Verified by reading the source 2026-09-12:**

**1. An aborted sibling plan makes the open plan unresolvable.** `resolve_single_plan`
(`clients/_crucible_axi.py:246-270`) filters candidates by `open_only`, then by `cr`, then demands
exactly one. `cycle-add` passes `open_only=False` (`:2447`), so for a CR carrying an aborted plan
AND an open plan both survive the filter → `"ambiguous"` → no POST. Since `abort` + re-`plan-file`
is the sanctioned recovery path (it is what the `abort` verb is FOR), any CR that has ever been
aborted can never receive a cycle through the client again. The docstring's stated rationale —
*"the SERVER is the authority on a closed plan's rejection, never a client-side pre-filter"* — is
about not pre-rejecting a **lone** closed plan, and is preserved by the fix below.

**2. The ambiguity message ignores the `--cr` it demands.** `resolve_plan_or_emit`
(`:387-392`) rebuilds its candidate list filtered by `open_only` only — never by `cr` — so it
enumerates every plan in the project and then instructs the caller to pass the flag they already
passed. **`cmd_cr_close` already does this correctly** (`:2480-2496`: filter by `args.cr` first,
build the names from the filtered list), so the fix is to make the shared helper behave the way the
one correct call site already behaves.

**3. There is no `--plan <id>` escape.** Once ambiguous, the caller has no way to name the target,
even though the route itself takes the plan id in its path and needs no resolution at all.

**4. `cycle-add` cannot say what KIND of cycle it adds.** `cmd_cycle_add` (`:2450-2451`) POSTs
`{label, agentId}` and nothing else, while the route (`handleCycleAppend`, `src/v2.ts:1533`, via
`parseCycleInput`) accepts `kind`. Every verify and fix cycle ever filed through this verb is
therefore recorded as `kind: "red-green"` — measurable on the live board across plans 124–130,
where every "verify …" cycle reads `red-green`. The board's own record of what kind of work ran is
wrong, and the workflow lens's `KIND_GLYPHS` (`public/app.js:1062`) renders the wrong glyph from it.
Proven by contrast: a direct route POST carrying `kind: "verify"` stored it correctly (cycle 431).

**Surfaces (verified 2026-09-12):** `resolve_single_plan` and `resolve_plan_or_emit`
(`clients/_crucible_axi.py:246-270`, `:364-395`), `cmd_cycle_add` (`:2434-2461`), and the five
clients' `cycle-add` subparsers. No server change: `handleCycleAppend` already accepts both the
plan id and the kind.

## Scope

**How each section reaches the five stack clients — the two tiers, stated because they are not the
same amount of work (verified 2026-09-12):**

- **§S1 and §S2 need ZERO per-client edits.** Both live in `clients/_crucible_axi.py`, the shared
  plan-access layer CR-CRU-054 §S2 lifted precisely so this logic exists once. All five clients call
  it through their thin `_resolve_plan_or_emit` delegators, so one edit reaches the whole fleet and a
  per-client change would itself be the regression.
- **§S3 and §S4 DO need the fleet touched, because `cycle-add` has NO shared registrar.** All five
  clients hand-roll their own subparser — `arduino-crucible.py:1305`, `bun-crucible.py:2244`,
  `mvn-crucible.py:2219`, `python-crucible.py:1609`, `rust-crucible.py:2849` — exactly the situation
  `plan-file` was in before CR-CRU-121 §S2. So the shared registrar must be **created** (mirroring
  the `add_plan_file_release_arg` function CR-CRU-121 added) and all five declaration sites moved
  onto it. This is not a one-line addition to something existing.


### §S1 An unambiguous open plan resolves even beside terminal siblings

`resolve_single_plan` gains one rule, applied only after the existing `cr` filter leaves more than
one candidate: **if exactly ONE candidate is `status:"open"`, that is the target.** Zero open
candidates keeps today's behaviour exactly (a lone closed/aborted plan is still handed to the
server, which owns the rejection — the docstring's contract is unchanged); two or more open
candidates is still `"ambiguous"`.

### §S2 An ambiguity message names only the candidates it means

`resolve_plan_or_emit`'s ambiguity branch filters its candidate list by the `cr` argument as well as
`open_only` — the same order `cmd_cr_close` already uses — and when `cr` was supplied the message
stops telling the caller to pass `--cr` and instead names the `--plan` escape from §S3.

**Ruled 2026-09-12, and CORRECTED the same day (RED escalation E1).** §S1's rule is worded as applying once the `cr` filter leaves more than one candidate, which left open what happens when NO `--cr` was passed (the filter is then a no-op). The ruling is that the open-plan preference fires **only when `--cr` was supplied**. With no `--cr`, two or more candidates keep refusing exactly as they do today.

The first ruling said the opposite — that the preference fires either way — and it was wrong: `tests/client/test_bun_crucible_cycle_add.py:273` has pinned the no-`cr` path since CR-CRU-030, over the board `[closed, open]`, with the assertion message *"ambiguous (2 plans, no --cr) must be non-zero, not a guess"*. That is a deliberate safety contract for THIS verb — refuse rather than target a plan the caller never named — and a convenience win is not a reason to retire it. The cost is accepted knowingly: a caller on a 121-plan board with exactly one open plan must pass `--cr` (or, after §S3, `--plan`), and `cycle-add` stays deliberately stricter than `cr-close`, which does resolve the lone open plan flagless. GREEN caught the collision before committing; the first ruling had been made without grepping the no-`cr` path for existing pins.

### §S3 `--plan <id>` targets a plan directly

`cycle-add` accepts an optional `--plan <planId>`, declared once in a shared registrar reaching all
five clients (the pattern CR-CRU-121 §S2 established for `plan-file --release`). When given, the
plans GET and all resolution are SKIPPED — the route takes the plan id in its path, so there is
nothing to resolve. `--plan` and `--cr` together, naming a plan whose `cr` differs, is refused
client-side before any POST.

**Ruled 2026-09-12 (RED escalation E2).** AC2 and AC3 below cannot both be read strictly — a client cannot know a plan's `cr` without reading the board. The resolution: `--plan` ALONE skips the plans GET entirely (nothing needs resolving); `--plan` TOGETHER WITH `--cr` MAY issue the GET, because validating the pair requires it. AC2's zero-GET claim therefore applies to `--plan` alone, and AC3 claims only `ok:false` with zero POSTs, never zero reads.

### §S4 `cycle-add --kind` reaches the route

`cycle-add` accepts `--kind <red-green|verify|fix>` (same shared registrar), forwarded in the POST
body. Absent, the body omits `kind` and the server's existing default applies — today's behaviour
byte-identical for every existing caller.

## Acceptance criteria

**§S1**
- [ ] `resolve_single_plan` with `open_only=False`, `cr="X"`, and candidates `[{X, aborted},
      {X, open}]` returns the OPEN plan and `reason=None` — the exact shape that refused on
      2026-09-12.
- [ ] Same call with candidates `[{X, aborted}, {X, closed}]` (zero open) returns
      `(None, "ambiguous")` — unchanged, the server still owns terminal-plan rejection.
- [ ] Same call with candidates `[{X, open}, {X, open}]` returns `(None, "ambiguous")` — two live
      plans is a real ambiguity and must stay one.
- [ ] A single closed plan with no open sibling still resolves to that closed plan and is still
      POSTed (regression pin on the docstring's stated contract — the client pre-filters nothing).

**§S2**
- [ ] With `cr="X"` supplied and 113 plans on the board of which 3 carry `cr="X"`, the ambiguity
      message names exactly those 3, never all 113.
- [ ] With `cr` supplied, the message does NOT contain "Pass --cr"; it names `--plan <id>` instead.
- [ ] With `cr` absent, the message keeps today's "Pass --cr to pick one of: …" wording verbatim
      (regression pin — that path is correct today).

**§S3**
- [ ] A fleet census asserts all 5 stack clients' `cycle-add` accepts `--plan`, declared at ONE
      shared registrar call site (count the declaration sites, assert exactly one).
- [ ] `cycle-add --plan <id>` issues NO plans GET (asserted by counting requests) and POSTs to
      `…/plans/<id>/cycles` — proving resolution is skipped, not merely satisfied.
- [ ] `cycle-add --plan <id> --cr <other-cr>` where the plan's `cr` differs is refused with
      `ok:false` and NO POST fires.
- [ ] `cycle-add --plan <id>` succeeds against a CR with an aborted sibling plan — the live
      2026-09-12 case, end to end.

**§S4**
- [ ] `cycle-add --kind verify` results in a stored cycle whose `kind` reads `verify` — asserted by
      reading the plan back, not from the POST response.
- [ ] Each of `red-green`, `verify`, `fix` round-trips; an unrecognised value is refused by the
      server's existing `parseCycleInput` and surfaced in the client's `ok:false` envelope.
- [ ] `cycle-add` with NO `--kind` omits the field from the body entirely (asserted on the request
      body) — today's behaviour unchanged for every existing caller.
- [ ] The fleet census covers `--kind` on all 5 clients at the same single registrar site.

## Estimated size

S — one cycle. Two small corrections in one shared pure function plus its message branch, and two
optional flags through one shared registrar reaching five clients. No server change.

## Risk

- **§S1 changes a resolution rule three verbs share** (`cycle-add`, `checkpoint`, `abort`). The
  latter two pass `open_only=True`, which already restricts candidates to open plans, so the new
  rule cannot fire for them — but they must be regression-pinned, because the change is in shared
  code and "cannot fire" is a claim to be tested, not assumed.
- **§S4 corrects data going forward only.** The already-mislabelled verify cycles on plans 124–130
  are not retro-fixed; a cycle's kind is settled history and this CR does not rewrite it.

## Non-goals

- Retro-correcting the `kind` of cycles already stored (settled history).
- Any change to `handleCycleAppend`, `parseCycleInput`, or any server route — all four defects are
  client-side.
- Changing `abort`/`checkpoint`'s `open_only=True` behaviour.
- Adding `--plan` to verbs other than `cycle-add` (the two that need it already restrict to open
  plans; widening the surface without a demonstrated need is out of scope).
