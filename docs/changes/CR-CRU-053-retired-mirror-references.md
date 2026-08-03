# CR-CRU-053 — Test files still point readers at the retired `~/.claude/scripts` client mirror

**Status:** PENDING
**Type:** patch (documentation hazard — comments/docstrings + one guard test)
**Priority:** P2 — no code is wrong; the risk is that an agent orienting itself is walked into a
known failure mode
**Depends on:** CR-CRU-008 (authored the headers), CR-CRU-009 (the installer that made the mirror
obsolete), CR-CRU-042 (Model B took skills ownership; the mirror was retired 2026-07-28)
**Labels:** patch, tests, documentation, agent-safety, client-fleet
**Phase:** Wave 4
**Design reference:** the standing project rule that agents use the in-repo `clients/*-crucible.py`
and NEVER the `~/.claude/scripts` mirror — running the mirror ORPHANS Crucible runs. Found
2026-07-28 by the CR-CRU-050 C3 FIX round, which fixed one instance and enumerated the rest.

## Context
Several test files carry CR-CRU-008-era headers written during that CR's RED phase, when the
in-repo clients did not yet exist and the mirror was the only copy. They are still phrased in the
**present tense**, so they now assert two false things: that `clients/*.py` does not exist, and
that `~/.claude/scripts/*.py` is where the client lives.

This is not stale prose — it is a **trap**. The mirror is retired, and the documented consequence
of running it is orphaned Crucible runs. A future agent reading a header to orient itself is
pointed straight at the failure mode the project rule exists to prevent.

CR-CRU-050's FIX round fixed `tests/clients-rust-mvn-crucible.test.ts` (commit `e1cbc8d`) because
that file was already being rewritten by that CR. The remaining instances were deliberately left
for this CR rather than growing CR-050's scope.

**Enumeration RE-MEASURED on develop 2026-08-03** (the original table was written 2026-07-28 and has
since drifted — `test_bun_crucible_context.py` was deleted and every line number moved). Running
the spec's own command, `grep -rna '\.claude/scripts' tests/`, now gives **6 source hits in 4
files** (plus `__pycache__/*.pyc` noise — see below):

| file:line | reads | verdict |
|---|---|---|
| `tests/clients-rust-mvn-crucible.test.ts:14` | "mirror is RETIRED: do NOT run it, point tests at…" | ✅ FIXED in CR-050 (`e1cbc8d`) |
| `tests/clients-bun-crucible.test.ts:11` | "only `~/.claude/scripts/bun-crucible.py`, the LIVE v1 script" | **fix** — same trap |
| `tests/clients-python-arduino-crucible.test.ts:13` | "scripts at `~/.claude/scripts/*.py` exist — copied into clients/" | **fix** — same trap |
| `tests/client/test_bun_crucible_lifecycle.py:54` | "OWN, not the deployed `~/.claude/scripts` mirror" | leave — reinforces the rule |
| `tests/client/test_bun_crucible_lifecycle.py:144` | "…`~/.claude/scripts` mirror. Same technique as the sibling" | leave — reinforces the rule |
| `tests/client/test_bun_crucible_gates.py:42` | "directly (REPO_ROOT-relative), NOT the `~/.claude/scripts` mirror" | leave — reinforces the rule |

**The `fix` list is now TWO, not four.** Both remaining entries are the same trap: a present-tense
RED-phase claim that `clients/*.py` does not exist and the mirror is where the client lives.

**The two sharpest items in the original spec are already gone** — `test_bun_crucible_context.py`
was deleted from develop (see Scope), taking with it both its `~/.claude/scripts` grep command and
its `WORKFLOW_CYCLE_ID` sentence. Re-verified: `grep -rn WORKFLOW_CYCLE_ID tests/` returns hits ONLY
in `tests/docs-registration-binding.test.ts`, which is the guard test *asserting* the variable's
absence — correct, not drift. The third false fact the original spec called "arguably the worst" has
no surviving instance.

**But the deletion left DANGLING references, and the original spec located them wrongly.** It said
they were at `tests/client/test_toon.py:37` and `test_bun_crucible_lifecycle.py:54 + :60`. Neither
is right: `test_toon.py` does not exist (CR-046 renamed it to
`test_cr046_official_toon_roundtrip.py`), and `lifecycle.py:54` is a *mirror* reference, not a
deleted-file one. The actual dangling references to the deleted file are:

| file:line | reads |
|---|---|
| `tests/client/test_bun_crucible_gates.py:43` | "sibling harnesses (test_bun_crucible_lifecycle.py / **test_bun_crucible_context.py**)" |
| `tests/client/test_bun_crucible_lifecycle.py:72` | "this repo has never made a live-server call (**test_bun_crucible_context.py** is…" |
| `tests/client/test_bun_crucible_lifecycle.py:78` | "Invocation (matches **test_bun_crucible_context.py**'s documented convention)" |

A sweep keyed on the original spec's list would have missed all three. This is the same lesson the
CR already states, turned on the CR itself: **a location recorded in prose decays.** Locations here
are re-derived at execution time, not trusted.

**`__pycache__` noise, for the record:** stale `.pyc` files for the deleted `test_bun_crucible_context`
and renamed `test_toon` still embed the old docstrings, so the raw grep returns 10 extra hits. They
are untracked and gitignored — out of scope, but named here because they polluted this very
enumeration and will pollute the next one.

Whoever takes this CR should read each flagged docstring WHOLE rather than patching the matched
line, and report any further stale claim found the same way. The lesson generalises: these files
accumulated RED-phase narration that was true for one commit and has been quietly wrong ever
since.

## Scope

**Executed early (user order 2026-08-01):** `tests/client/test_bun_crucible_context.py` was
DELETED from develop ahead of this CR — its `SCRIPT_PATH` targeted the retired mirror directly,
so its whole class had been silently skipping on every run (surfaced as the python envelope's
`pending=2` once CR-050 stopped counting skips as passes), and the behaviour it pinned
(`WORKFLOW_CYCLE_ID` context) was itself removed by CR-036. Stale docstring mentions of the deleted
file remain for this CR's sweep — **three of them, and not where this note originally said**; the
re-derived locations are in Context and are handled by §S2.

### §S1 — Correct the two misleading references
Rewrite the two marked `fix` entries to state the current reality: the in-repo `clients/*.py` are
the source of truth and what the tests drive; the `~/.claude/scripts` mirror is retired and must
not be run, referenced as the client source, or used as a verification target — **because running
it orphans Crucible runs.** Give the reason, not just the prohibition; a rule without its cost is
the one people talk themselves out of.

Follow the pattern already applied in `tests/clients-rust-mvn-crucible.test.ts:1-20` (CR-050
`e1cbc8d`): correct the tense and the facts, keep the CR-CRU-008 attribution and any still-true
description, and preserve the RED-phase history in a parenthetical explicitly labelled as history
rather than deleting it.

### §S2 — Repair the three DANGLING references to the deleted file
`test_bun_crucible_context.py` was deleted from develop, but three docstrings still cite it as a
live sibling harness: `tests/client/test_bun_crucible_gates.py:43`,
`tests/client/test_bun_crucible_lifecycle.py:72` and `:78`. Re-point or relabel each so no docstring
directs a reader to a file that does not exist. Locations RE-DERIVED at execution time — the
original spec recorded these wrongly (see Context).

### §S3 — Correct the DN, which carries the same false claim
`docs/research/DN-crucible-api-reconstruction.md:206` states, in the present tense, that *"the live
`~/.claude/scripts/` copies sync via CR-CRU-009's install step."* That DN is **ACTIVE and
normative**. The mirror is retired and no install step syncs it; under the standing delivery model
the server and client ship as one uv-installed, version-locked pair. Correct that clause and label
the superseded model as history. Leave DN:10 alone — it names the mirror as the *v1 evidence
source*, which is true history, not a live claim.

### §S4 — Add ONE guard test so this cannot decay a fourth time
Following the established `tests/docs-*.test.ts` precedent (`docs-registration-binding.test.ts` is
the closest analogue — it asserts no stale `WORKFLOW_CYCLE_ID` survives in the PRD), add a single
guard asserting that every surviving `~/.claude/scripts` reference in `tests/` and `docs/` is a
do-NOT-use warning, never a presentation of the mirror as the client source. This CR's enumeration
has now decayed twice; a one-time grep in an AC does not hold a line.

### §S5 — Leave the three correct references alone
`test_bun_crucible_lifecycle.py:36`/`:126` and `test_bun_crucible_gates.py:42` name the mirror only
to say *don't use it*. They reinforce the rule and must not be swept up in a blanket edit. Confirm
in the report that they were checked and deliberately kept.

## Acceptance criteria
- [ ] The two marked references state the current reality and carry the do-not-use with its
      reason (orphaned runs) — asserted by reading each.
- [ ] No docstring cites the deleted `test_bun_crucible_context.py` as a live sibling (§S2).
- [ ] `docs/research/DN-crucible-api-reconstruction.md:206` no longer presents the mirror as a
      live, install-synced copy; DN:10's v1-history mention is untouched (§S3).
- [ ] The three reinforcing references are unchanged — confirmed, not assumed.
- [ ] `grep -rna '\.claude/scripts' tests/ docs/` returns only references that tell the reader NOT
      to use the mirror. No reference presents it as the client source. (`-a`, and disregard
      `__pycache__` — stale `.pyc` of deleted files carry old docstrings.)
- [ ] A guard test enforces the line above, on the `tests/docs-*.test.ts` precedent (§S4).
- [ ] The diff is comments/docstrings ONLY, **plus the single new guard test of §S4** — zero
      change to any existing assertion, fixture, helper or import. AC amended from
      "comments-only" at gap analysis: a fix with no guard is why this enumeration decayed twice.
- [ ] Full bun regression green. A Python gate IS required here (unlike CR-050's FIX rounds)
      because `tests/client/*.py` files change — even though only docstrings move, per CR-CRU-045
      §S3's rule that evidence beats reasoning about what "cannot" break.

## Non-goals
- Changing any test behaviour, fixture or assertion.
- The `clients/*.py` production clients — they already resolve in-repo paths correctly; this is
  purely about what the test files TELL a reader.
- Deleting the mirror from disk, or anything about its retirement beyond how tests describe it.
- Other stale CR-era narration not involving the mirror.

## Risk
- A blanket find-and-replace would damage the three references that correctly warn against the
  mirror, inverting their meaning. §S2 exists to prevent exactly that — the edit must be
  per-instance and read in context.
- Deleting the RED-phase history instead of relabelling it loses the explanation of why these
  files are shaped as they are. Preserve it as history, as CR-050 did.
