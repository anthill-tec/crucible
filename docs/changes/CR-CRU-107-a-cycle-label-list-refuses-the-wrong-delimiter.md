# CR-CRU-107 — a cycle plan is filed one label per flag

- **Type**: bug
- **Wave**: 5 (0.2.0)
- **Depends on**: none
- **Status**: PENDING (0.2.0)
- **Design reference**: `docs/changes/CR-CRU-030-fleet-toon-axi-compliance.md` §S13 (structured errors on stdout, AXI principle 6) and §S15 (`help[]` next-step templates, principle 9).

## Problem

`plan-file` takes its cycle labels as ONE delimited string, `--cycles "a,b,c"`. A label is free
text, so the delimiter collides with the content, in both directions, and both have fired on this
project's own board:

- **Wrong delimiter → too few cycles.** A semicolon-separated value files ONE cycle whose label is
  the entire string and reports `ok=True`. Four occurrences: cycles **281** (six labels in one),
  **324**, **328**, **340**.
- **Right delimiter inside a label → too many cycles.** Filing CR-CRU-078, the label
  `"C1 data + authored order - proposals read, formatter wiring, seq verbatim"` became cycles
  296/297/298 — three cycles nobody planned, `ok=True`, no warning.

Neither is repairable once the cycle leaves `pending`. A relabel route exists —
`PATCH …/plans/<planId>/cycles/<id>` accepts `{label}` and `Store.editCycleLabel` performs it — but
it refuses an `active` cycle (`locked`) and anything terminal (`immutable history`), and no client
verb exposes it. All four garbled rows are `done` or `skipped`. Cycle 281's plan was recovered the
only way left: `abort` plus a re-file, which costs a `--user-approved` gate and destroys the record.

The operator's own workarounds are the evidence that the delimiter is the defect: labels on this
board use `·` and ` + ` where a comma belongs (cycles 281–286), and one cycle plan filed this
release deliberately reads `(§S2 + §S3)` to avoid a comma.

Policing the delimiter cannot fix this. Measured over all 416 cycles on the board: **14 labels
contain a semicolon and only 4 are the defect** — the other ten use it as ordinary punctuation
(`S1 inventory + classification (deliverable; no code moves)`;
`C3 labels carry the CR id + status and no title; track rides the node`). A refusal on the character
would have rejected ten legitimate filings; the narrowest rule that still catches all four
(`≥2 semicolons and no comma`) rejects three.

## Scope

### §S1 One label per flag

`plan-file` gains a repeatable `--cycle`: one occurrence per cycle, in order. A label passed this
way is never split, so it may contain commas, semicolons, or any other character, and there is no
delimiter to get wrong.

`--cycle` is the canonical form. It is what `plan-file --help` shows first, and what the `next`
verb's start template emits (`_next_start_help`, which today prints `--cycles "<c1,c2>"`).

`--cycles` keeps working, unchanged: comma-split, same order, same payload. It is documented as the
legacy form. Its splitting is deliberately NOT policed — the measurement above shows every available
character rule refuses labels this project legitimately files, and with `--cycle` available the
mistake no longer needs making.

The two are mutually exclusive: a call passing both is refused before anything is posted, because
the intended cycle list would be ambiguous.

### §S2 The refusals are structured

Both new refusals — both flags together, and neither flag given — emit an `ok:false` TOON-AXI
envelope on stdout with a `help[]` carrying the corrected call, and exit non-zero, via the fleet's
existing hard-stop route (a typed exception from the shared verb, converted by `run_verb`, which all
five clients already dispatch every verb through).

The existing `--cycles`-is-empty refusal (`sys.exit("[crucible] ERROR: --cycles must name at least
one cycle")`) is converted to the same shape. It is in the function this CR edits, it is the same
defect class, and a bare `sys.exit` string violates principle 6.

## Acceptance criteria

- **AC1** — `plan-file --cycle "a" --cycle "b" --cycle "c"` files three cycles with labels `a`, `b`,
  `c` in that order, and posts `cycles: [{label:"a"},{label:"b"},{label:"c"}]`. Asserted per client,
  five for five (`arduino-`, `bun-`, `mvn-`, `python-`, `rust-crucible.py`).
- **AC2** — a single `--cycle` value containing commas AND semicolons files exactly ONE cycle whose
  label is that value byte-for-byte. Use the four historical labels as the fixture, including cycle
  281's six-segment string and the CR-CRU-078 comma label; each files one cycle.
- **AC3** — `--cycles "a,b"` still files two cycles, labels `a` and `b`, byte-identical payload to
  today. Existing `--cycles` tests pass unchanged; a diff that edits their expectations fails this
  AC.
- **AC4** — `--cycle` and `--cycles` together are refused: nothing is posted, stdout carries an
  `ok:false` envelope whose `error` names both flags, `help[]` shows the corrected `--cycle` call,
  and the exit code is **2** (the fleet's hard-stop code, as `emit_agent_identity_hard_stop`
  returns). Asserted per client, five for five.
- **AC5** — neither flag given is refused the same way, with the same envelope shape and exit 2.
  `--cycles` is no longer `required=True` in any client, since `--cycle` may carry the plan; the
  requirement moves into the shared verb so one rule covers both flags. Asserted per client.
- **AC6** — the empty-`--cycles` refusal emits an `ok:false` envelope on stdout and exits 2, not a
  bare `sys.exit` string on stderr. Asserted per client.
- **AC7** — `plan-file --help` on each of the five clients shows `--cycle` as repeatable and names
  it before `--cycles`, and `--cycles`' own help says it is the legacy comma-split form. The five
  help strings are byte-identical to each other, as they are today.
- **AC8** — `_next_start_help`'s emitted template uses `--cycle`, so the `next` verb's `help[]`
  hands back a call that cannot be mis-delimited. Asserted on the shared function and on the `next`
  envelope of at least one client.
- **AC9** — the four garbled rows (281, 324, 328, 340) are unchanged. They are `done`/`skipped`,
  which `Store.editCycleLabel` refuses as immutable history, so this is a statement of fact rather
  than a choice — asserted by leaving them out of every fixture, not by a test that pins live board
  data.

## Risk

`--cycles` appears in ~40 test call sites across nine suites, including
`tests/clients-bun-crucible.test.ts`, which the merge gate DOES run (the python client suites are
not in the gate — see the queue notes). AC3 keeps those green by keeping `--cycles` behaviour
identical; a change that breaks them is a scope error, not a test problem.

`clients/python-crucible.py`'s `plan-file` block is a GUARDED citation:
`tests/client/test_cr092_next_decision_resolver.py`'s `NextBlockCitationsTest` pins it at
`:1422-1436`, bracketed by `sub.add_parser("plan-file"` and `set_defaults(func=cmd_plan_file)`.
Adding a flag inside that block moves the tail. Re-pin it in this CR.

Adding a flag and help text to five clients plus the shared module moves
`PROSE_CITATIONS.clients` (687 at this CR's baseline). Re-record it ONCE, by measurement, as a
close-out step. `src` and `public` must not move.

`.lavish/crucible-workflow-flowchart.html:697` shows a `--cycles` call and is served as a fixture by
`tests/roadmap-visual-grammar.test.ts`. If it is updated, that suite re-runs.

Two user-authored skills teach `--cycles` — `~/.agents/skills/crucible/SKILL.md` and
`~/.agents/skills/model-b/SKILL.md`. This CR does not edit them; the legacy form keeps working, so a
dispatched agent reading them stays correct. **User direction 2026-09-07: they are updated AFTER this
CR ships**, in one pass that carries `--cycle` together with the drift already measured against the
shipped client — `--phase` (retired by CR-CRU-059 in favour of `--role`, with its enum
`RED|GREEN|FIX|VERIFY|ORCHESTRATOR|report`), the server-driven `resolve_attach_cycle` /
`no-active-cycle` withhold (deleted by CR-CRU-056 in favour of an explicit `register --cycle <id>`,
which TDD roles MUST pass), "agents never pass a cycle id" (now false), `--orchestrator` (retired),
`lastRunCr` (now `lastClosedCr`), `queue-file` as python-only (fleet-wide since CR-CRU-075), the
missing verbs (`cycle-add`, `checkpoint`, `stop`, `abort`, `status`/`plans`, `queue`, `queue-file`,
`release-propose`, `cr-plan`, `wave-sequence`, `cr-supersede`, `cr-void`, `cr-depends`, `next`,
`gate-run`, `plan-backfill`), the CR-CRU-094 pre-flight `no-cycle` warning, and a `~/.claude/skills/`
path that is now `~/.agents/skills/`.

## Non-goals

- **Retiring `--cycles`.** It has ~40 call sites, the `next` template, five client declarations and
  two out-of-repo skill files behind it. Making `--cycle` canonical removes the need for the
  delimiter without a fleet-wide break.
- **Policing the `--cycles` delimiter.** Measured: no character rule separates the four bad rows
  from the ten legitimate semicolon labels without refusing correct input.
- **A relabel client verb.** The route exists and is pending-only; exposing it is a separate CR with
  its own decision about the window.
- **Rewriting the four garbled rows.** They are immutable history and they are this CR's evidence.
- **Other delimited flags.** `--crs` and `--packages` take comma lists too; if the same defect
  matters there it is the same fix, filed separately.
