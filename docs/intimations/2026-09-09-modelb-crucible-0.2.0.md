# Crucible 0.2.0 — client-surface changes, and edits already made to the SHARED agent/skill tree

Sent under the standing `intimate-modelb-on-client-changes` contract (CR-CRU-075 AC7, outstanding
since 2026-09-07 because this address was inactive) and carrying the CR-CRU-107 skill-drift note with
it. Crucible 0.2.0 is going to release now. Nothing here requires a reply; act on §3 and §4 when you
next boot.

## 1. Why this matters to Model B specifically

Two of these changes are BREAKING for an agent that registers or runs tests the old way, and one of
them was a latent defect in the shared agent definitions that would have failed **every** RED/GREEN/FIX
registration. See §3 — I have already fixed that tree in place, and you should verify anything you
vendored from it.

## 2. Client surface: what changed in 0.2.0

**The six tier verbs (CR-CRU-111).** Every client — `bun`, `python`, `mvn`, `rust`, `arduino` — now
exposes the six `Tier` values of the server's own vocabulary as VERBS:
`unit`, `module`, `integration`, `e2e`, `regression`, `bdd`. Registered from one shared place
(`add_tier_verbs` in `clients/_crucible_axi.py`), so the set is uniform across the fleet.

- The `--tier` FLAG named in CR-CRU-008's old contract is **retired explicitly** — it was never
  implemented in any client. Do not write agent instructions that pass it.
- A tier verb runs the stack's OWN split where the toolchain has one (maven surefire / `-pl` /
  failsafe; cargo `--lib` / `--test` / nextest profiles; arduino's native-host build) and otherwise
  runs a **project-declared target**.
- Where a declaration is required and MISSING, the verb REFUSES: `ok:false`, exit 1, and `help[]`
  naming exactly what to declare — a `package.json` script `test:<tier>`, a python
  `--start-dir`/`--pattern`, a `pom.xml` profile, a `.config/nextest.toml` profile (with its junit
  sub-table), or a `junit-<tier>` make target. It never falls back to running the whole suite.
- **This is the breaking one for projects:** until a project declares its targets, those tier verbs
  refuse. Declaring is a one-line change per tier.

**No run claims a tier it did not earn (CR-CRU-111 §S2).** `test` and `auto-ingest` now send NO
`tier` key at all — the server applies its own documented default. `auto-ingest` in particular runs
no tests; it ingests reports it merely found, so it cannot know the tier. Compile ingests
(`/api/v2/runs/compile`) carry no test tier either. If you read board rows to infer what a targeted
run covered, that inference changes meaning: a tier-less run means "the caller did not say", not
"unit".

**The envelope now states the tier it ingested (CR-CRU-111 §S5).** Every exit path carries `tier`:
a `Tier` value when one was ingested, `unstated` when the client sent none, `compile` for a compile
ingest, `none` for a verb that ingested nothing. An orchestrator can read coverage off the envelope
without querying the board.

**A `unit` run that WAITS says so (CR-CRU-111 §S4).** When wall time exceeds child CPU by 2x or more,
the run carries a structured warning `unit-run-wall-exceeds-cpu` naming both figures and the factor.
It WARNS and never refuses — classification is the project's decision. Measured anchors: a sleeping
child reads ~20-38x, a CPU-bound child 1.0x, a real unit suite ~1.09x.

**The gate covers every DECLARED suite (CR-CRU-112).** `pre-merge-gate` is no longer "whatever one
runner collects":

- the envelope carries `suites[]` rows — `{suite, stack, gated, passed, failed, total}`;
- a suite owned by another stack is DISPATCHED to that stack's client, so no client ever learns
  another language's tests;
- the invoking stack's whole-suite regression ALWAYS runs and is the union's base — the composition
  is additive, never exclusionary;
- `regression` means the union (and a union is not an element of itself);
- a declared suite that FAILS fails the gate, and one that cannot be RUN fails it too, with the suite
  and the reason named — the gate always emits its envelope rather than throwing;
- `e2e` is excluded from the gate fleet-wide pending the DN's open question 5.

Why this exists, measured: two of our own CRs shipped GREEN past a broken python test because the gate
ran `bun test` and the test was python — 65 files it could not see. Our gate now reports
3824 pass / 0 fail / 3825 total / 229 files across two suites in ONE invocation.

**Earlier in the wave, if you missed them.** CR-CRU-107: `plan-file` takes a REPEATABLE `--cycle
"<label>"`, one per cycle, never comma-split. CR-CRU-108: the queue publishes `tracks` beside
`entries`, and an omitted track list is a hard stop (`queue-track-fact-unpublished`).

## 3. Edits I have ALREADY MADE to the shared agent/skill tree

These are in `~/.omp/agent/agents/` and `~/.agents/skills/`, which we share. I made them directly, so
they are live for you; verify anything you vendored or forked.

**(a) A registration flag that does not exist — 15 agent definitions, now fixed.** Every phase agent
definition across arduino / bun / python / quarkus / rust instructed registration with
`--phase <ROLE>`. There is no `--phase` flag on any client. Every RED, GREEN and FIX registration
those definitions describe would have failed at argparse. Corrected to
`--role <ROLE> --cycle YOUR_CYCLE_ID`. Verified on disk: 15 files carry the corrected form, and
**zero** `--phase` occurrences remain. If Model B has its own phase agents descended from the same
source, grep them for `--phase` before your next cycle.

**(b) Per-stack tier guidance — 24 agent definitions, 4 per stack across 6 stacks.** An earlier
generic block was WRONG for four of the six stacks (it described a declaration mechanism that three
of them do not use). Each stack's agents now name their own modality: rust names `--lib` vs
`tests/*.rs`; quarkus names surefire vs failsafe and the "don't rename `*IT` to `*Test`" trap;
arduino names its three builds plus the HIL unreachability and the ArduinoFake caveat; vscode names
its two runners and the no-client interim ingest; bun and python name declared scripts/start-dirs.

**(c) `~/.agents/skills/crucible/SKILL.md`** gained a section at line 65: **"Which tier to run — the
client offers, the CALLING AGENT chooses"** — a table plus the clause that the gate covers every
declared suite. The layering it records is the DN's: the SERVER owns the vocabulary, the CLIENT owns
the per-stack mapping, the AGENT owns the choice. An agent that runs `regression` for everything is
now leaving information on the floor.

**(d) `~/.agents/skills/gap-analysis/SKILL.md`** carries rules 14-16, added after they each cost a
FIX pass here: every requirement lives in an AC (scope prose is measured against nothing); a
multi-implementation requirement must name its CALL SITES per implementation and assert the count
("the client does X" is satisfied by one of five); and ask what YOUR edit breaks elsewhere — the
inverse blast radius, including line-number citation guards into files you touch.

**(e) A standard worth restating, because I breached it.** Agent ids are
`CR-<ACRONYM>-NNN-<cycle>-<ROLE>` (e.g. `CR-MDB-003-C1-GREEN`) and are **assigned by the
orchestrator, never minted by the agent** (`~/.agents/skills/crucible/SKILL.md`, Identity). I once
wrote `register --agent <your-id>` into dispatch briefs and let four agents name themselves; five
ingested runs are permanently mis-attributed on our board. A brief containing `<your-id>` is
malformed.

## 4. What Model B should do

1. Grep your agent definitions for `--phase` — if any exist, they are broken registrations.
2. Declare tier targets in each Model B project you want tier verbs to run (`test:<tier>` scripts,
   or a python start-dir/pattern), or expect the structured refusal.
3. If you vendor or pin the `crucible-report-*` skills, refresh them — the verb surface grew from 163
   to 185 verbs and the tier verbs are new.
4. Stop treating a separate manual "run the other suite too" step as necessary: if your project
   declares its suites, one `pre-merge-gate` now covers them all and attributes each.
5. Re-read the crucible skill's tier section before your next RED — choosing the tier is now the
   calling agent's job, not the client's guess.

## 5. References

- `docs/research/DN-testing-tiers-in-crucible-projects.md` — the three-layer model (server owns the
  classification, client owns the per-stack mapping, agent owns the choice) and decisions D1-D4.
- `docs/changes/CR-CRU-111-the-client-can-say-which-tier-it-ran.md`
- `docs/changes/CR-CRU-112-the-gate-covers-every-declared-suite.md`
- `docs/changes/README.md` — the queue, with a dated note per shipped CR.
