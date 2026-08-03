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
is right: `test_toon.py` does not exist (CR-046 RETIRED it — see the §S4b correction below; it was
not a rename), and `lifecycle.py:54` is a *mirror* reference, not a
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

### §S4b — AMENDED mid-execution (2026-08-03): two more instances of the SAME defect
GREEN found, two lines from a line §S2 was already fixing in
`tests/client/test_bun_crucible_gates.py`:
- `:48` — *"This matches **test_toon.py**'s own REPO_ROOT-relative loading convention exactly."*
  `test_toon.py` does not exist. ⚠ **This line originally said CR-046 "renamed" it — that is
  WRONG, and the error was caught during execution.** Git shows the successor
  `test_cr046_official_toon_roundtrip.py` was ADDED separately in `aa2702f` (the CR-046 RED commit)
  and `test_toon.py` DELETED in `987b331` ("subset-parity test retired"). Two files, two commits,
  different subjects — a narrow 4-construct subset pin versus a full official-spec conformance
  suite. The correct narration is "retired by CR-046, successor X", never "renamed to X".
  Recorded because a spec that says "renamed" would seed a fresh wrong fact into every docstring
  copied from it — this CR's own defect class, committed by this CR's own text.
  Identical defect class to §S2, just a different dead filename.
- `:47` — *"(the home mirror is not yet re-synced past the C4 GREEN commit)"* — a present-tense
  claim implying the mirror is synced at all.

Both are fixed here rather than deferred: they are comment lines in a file this CR already edits,
and they are the exact hazard it exists to remove. **The §S2 guard is generalised accordingly** —
from "no docstring cites `test_bun_crucible_context.py`" to "no docstring cites a `tests/` file that
does not exist". A guard hardcoded to one dead filename would have missed this one, which is the
CR's own lesson applied to its own guard.

### §S4c — USER-DECIDED 2026-08-03: the dangling-citation guard is WHOLE-TREE
§S4b's generalised guard, run across the tree, found **9 live dangling citations** (11 hits) —
comments that send a reader to a test file which no longer exists, with nothing marking it as gone.
They are the same defect as §S2, just with different dead filenames, and they sit outside the
mirror topic this CR started from.

The user's call, taken explicitly rather than assumed: **fix all nine, and let the guard assert
zero live dangling citations tree-wide.** This is a deliberate third expansion of a CR that began
as a two-header comment patch; it is recorded here as a decision, not absorbed silently. It
supersedes the Non-goal *"other stale CR-era narration not involving the mirror"* for the specific
case of citations pointing at non-existent files — narration that merely reads oddly stays out of
scope; narration that sends a reader to a file that is not there does not.

Sites (RE-DERIVE every location at execution time):
`tests/agent-lifecycle.test.ts` · `tests/client/test_bun_crucible_gates.py` ·
`tests/client/test_cr046_official_toon_roundtrip.py` · `tests/client/test_crucible_axi_shared.py` ·
`tests/e2e/steps/harness.ts` (×2) · `tests/f13-fidelity.test.ts` · `tests/plans.test.ts` ·
`tests/toon-conformance.test.ts` · `tests/v2-runs-events.test.ts` (×2)

**HISTORY carve-out stands:** a citation narrated as retired/renamed/archived within its OWN citing
file is legal and must NOT be swept up — that is the same "preserve history, labelled as history"
rule §S1 mandates. The rule is evaluated PER CITING FILE: one file correctly narrating a name's
retirement does not legalise a different file's undisclosed live citation of it.

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
- [ ] `grep -rna '\.claude/scripts' tests/ docs/research/` returns only references that tell the
      reader NOT to use the mirror. No reference presents it as the client source. (`-a`, and
      disregard `__pycache__` — stale `.pyc` of deleted files carry old docstrings.)
      **Scope note:** `docs/changes/` is deliberately EXCLUDED, matching the guard and the
      `docs-registration-binding.test.ts` precedent — the CR archive is an immutable point-in-time
      record and must keep saying what was true when written. AC originally read `docs/`, which was
      looser than the guard it describes; tightened at VERIFY.
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

## Implementation Notes
- **This CR grew three times, each recorded rather than absorbed.** It began as two header comments.
  Gap analysis added the DN (§S3) and the guard (§S4) after finding the DN carried the same false
  claim and that four `docs-*.test.ts` guards already existed to model. Execution added §S4b (two
  more same-class instances two lines from one being fixed) and then §S4c, the user's explicit call
  to make the dangling-citation guard whole-tree and fix all nine live sites. Final surface: 15
  files.
- **🚨 The guard snapshotted the defect TWICE before it became a contract.** First it pinned the real
  trap prose so it classified as `trap`; then it asserted the live-citation list EQUALS the eleven
  sites on disk. Both read green, both would have inverted the moment the fix landed, and both
  carried comments claiming "BORN RED" while the run said otherwise. Caught only because an agent's
  own numbers failed to reconcile — it reported the guard red on nine sites while reporting a single
  failure. **A guard that asserts current state is worse than no guard: it passes CI and inverts on
  repair.** The final form is `expect(liveFormatted).toEqual([])` with the residual-site list in the
  failure message, and the file now documents this history so a fourth attempt does not repeat it.
- **The spec seeded a wrong fact and execution caught it.** §S4b said CR-046 "renamed"
  `test_toon.py`. Git disagrees: the successor was ADDED in `aa2702f` and the original DELETED
  separately in `987b331` ("subset-parity test retired"), pinning different subjects. GREEN wrote
  "retired … successor X" instead of copying the spec, which prevented a false fact from being
  stamped into thirteen docstrings. Corrected in `6826b2a`.
- **The `(×2)` hits were a reporting artefact.** The scanner resolves provenance with
  `indexOf(cited)` — the FIRST occurrence — so a file citing a dead name twice prints one line
  twice. `harness.ts` cites at :216 and :241; `v2-runs-events.test.ts` at :72 and :92. Fixing only
  the printed line would have left the second live against a still-red guard.
- **The `.py` blind spot was closed, not documented away.** Extraction originally saw only module
  docstrings and `#` lines, so two citations hid in FUNCTION docstrings. FIX replaced the regex with
  a ~35-line lexer over the string-literal layer, validated against `ast.get_docstring` ground truth
  across all 48 test modules — 412/412 docstrings captured, zero extra blocks, and the
  `(file, cited, verdict)` set unchanged (24→26 hits, both new ones history, live stayed 0).
  Widening extraction is monotone here: extra occurrences can only flip live→history.
- **Two limitations remain, stated rather than papered over.** (1) A Python docstring written with a
  NON-triple-quoted literal is not scanned — at statement position a plain `"..."` is
  indistinguishable from a wrapped argv element, so collecting them would drag fixture literals back
  in. Zero such docstrings exist under `tests/` today. (2) `#`-comment extraction is still
  line-oriented, so a line starting with `#` INSIDE a fixture string counts as a comment. The new
  lexer makes this precisely fixable, but the fix is a REMOVAL from citable text and could
  reclassify a site, so it was flagged rather than actioned.
