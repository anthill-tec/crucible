# CR-CRU-053 — Test files still point readers at the retired `~/.claude/scripts` client mirror

**Status:** PENDING
**Type:** patch (documentation hazard — comments only, no behaviour change)
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

**Enumerated — `grep -rn '\.claude/scripts' tests/` gives 8 hits in 5 files:**

| file:line | reads | verdict |
|---|---|---|
| `tests/clients-rust-mvn-crucible.test.ts:10-16` | "only the LIVE v1 scripts at `~/.claude/scripts/*.py` exist" | ✅ FIXED in CR-050 (`e1cbc8d`) |
| `tests/clients-bun-crucible.test.ts:11` | "only `~/.claude/scripts/bun-crucible.py`, the LIVE v1 script" | **fix** — same trap |
| `tests/clients-python-arduino-crucible.test.ts:13` | "scripts at `~/.claude/scripts/*.py` exist — copied into clients/" | **fix** — same trap |
| `tests/client/test_bun_crucible_context.py:9` | "project-agnostic client script at `~/.claude/scripts/bun-crucible.py`" | **fix** — present tense, no caveat |
| `tests/client/test_bun_crucible_context.py:22` | "(confirmed: `grep -n "_run_context" ~/.claude/scripts/bun-crucible.py` finds…)" | **fix FIRST** — see below |
| `tests/client/test_bun_crucible_lifecycle.py:36` | "OWN, not the deployed `~/.claude/scripts` mirror" | leave — reinforces the rule |
| `tests/client/test_bun_crucible_lifecycle.py:126` | "…`~/.claude/scripts` mirror. Same technique as the sibling" | leave — reinforces the rule |
| `tests/client/test_bun_crucible_gates.py:42` | "directly (REPO_ROOT-relative), NOT the `~/.claude/scripts` mirror" | leave — reinforces the rule |

**`test_bun_crucible_context.py:22` is the sharpest and should be fixed first.** The other hits are
prose a reader might believe; this one is an **executable command** offered as a verification step,
against the retired path. Following the file's own instructions runs the mirror.

## Scope

### §S1 — Correct the four misleading references
Rewrite the four marked `fix` entries to state the current reality: the in-repo `clients/*.py` are
the source of truth and what the tests drive; the `~/.claude/scripts` mirror is retired and must
not be run, referenced as the client source, or used as a verification target — **because running
it orphans Crucible runs.** Give the reason, not just the prohibition; a rule without its cost is
the one people talk themselves out of.

Follow the pattern already applied in `tests/clients-rust-mvn-crucible.test.ts:1-20` (CR-050
`e1cbc8d`): correct the tense and the facts, keep the CR-CRU-008 attribution and any still-true
description, and preserve the RED-phase history in a parenthetical explicitly labelled as history
rather than deleting it.

### §S2 — Leave the three correct references alone
`test_bun_crucible_lifecycle.py:36`/`:126` and `test_bun_crucible_gates.py:42` name the mirror only
to say *don't use it*. They reinforce the rule and must not be swept up in a blanket edit. Confirm
in the report that they were checked and deliberately kept.

## Acceptance criteria
- [ ] The four marked references state the current reality and carry the do-not-use with its
      reason (orphaned runs) — asserted by reading each.
- [ ] `test_bun_crucible_context.py:22` no longer offers a command that targets
      `~/.claude/scripts` — the highest-priority item.
- [ ] The three reinforcing references are unchanged — confirmed, not assumed.
- [ ] `grep -rn '\.claude/scripts' tests/` returns only references that tell the reader NOT to use
      the mirror. No reference presents it as the client source.
- [ ] The diff is comments/docstrings ONLY — zero assertion, fixture, helper or import changes.
      Evidence: filtering the diff to exclude comment lines returns nothing.
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
