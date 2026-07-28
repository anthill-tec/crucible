# CR-CRU-042 — Patch: Crucible exits skills (ownership transferred to Model B)

**Status:** PENDING
**Type:** patch (ownership/contract correction)
**Priority:** P1 — 0.1.0 must not ship an installer stage that deploys what Crucible no longer owns
**Depends on:** CR-CRU-009 (built the `[skills]` install stage), CR-CRU-035 (settled the original boundary)
**Labels:** patch, installer, skills, model-b-coordination, ownership
**Phase:** Wave 4 (0.1.0 blocker)
**Design reference:** CR-CRU-035's boundary (Model-B owns hook creation, per-project deploy
and skill generation — confirmed with Model-B, msg 1334), **widened** on 2026-07-28 over
Sandesh msgs 1336 → 1337: Model B now owns the skills component in FULL — content,
bundling AND deploy. User-ratified on both sides.

## Context
CR-CRU-009's §S2 `[skills]` stage contradicts CR-CRU-009's own Non-goals and the CR-CRU-035
boundary, and the implementation followed §S2. Shipped today in `crucible_axi/install.py`:

```
STAGE_ORDER = ("server", "skills", "manifest")
SKILLS_CLI_SOURCE = "crucible-dev/crucible"   # TODO(S6): real public owner/repo source
_skills_stage -> npx skills add <src> --skill '*' --agent '*' -g -y
```

`--agent '*' -g` installs the skill set into every detected harness, globally — that is
per-harness DEPLOY, which CR-CRU-035 assigned to Model-B. It also carries an unresolved
placeholder source that could never have been correct.

Split ownership already caused a live defect: the deployed
`~/.claude/skills/crucible` (SKILL.md + 5 stack references) still carries **12 references
to `WORKFLOW_CYCLE_ID`**, which CR-CRU-036 REMOVED, and has no arduino reference. Agents in
every project load that skill, so it has been instructing them to hand-pass a variable the
server no longer accepts — the orphaned-run failure mode. Nobody owned the deployed copy.

Model B has taken full ownership to close that gap (msg 1337) and will supersede both the
stale deployed skill and the stale `~/.claude/scripts/` client mirror through their own
installer pipeline. Crucible's job is to stop shipping skills.

## Scope

### §S1 — Remove the `[skills]` stage from the installer
`STAGE_ORDER` becomes `("server", "manifest")`. Delete `_skills_stage`,
`_skills_already_installed`, the `SKILLS_CLI_SOURCE` constant (retiring its `TODO(S6)`),
and the `"skills"` entry in `DEFAULT_STAGE_RUNNERS`. The TOON-AXI envelope from
`crucible-axi install` reports exactly two stages; fail-fast sequencing and idempotency
semantics are otherwise unchanged. Update the tests that assert the three-stage order.

### §S1b — The FULL test-retirement surface (enumerated by gap-analysis 2026-07-28)
The original wording ("update the tests that assert the three-stage order") badly understated
this. Every assertion below targets content Crucible no longer owns, and once §S2 deletes
`clients/skills/` they assert against files that do not exist:

| File | Surface | Action |
|---|---|---|
| `tests/clients-skills.test.ts` | **419 lines, 22 tests** — SKILL.md v2-endpoint references per skill, no-unmarked-v1-legacy, heartbeat guidance, `WORKFLOW_CYCLE_ID` absence, example script paths | **delete the file** |
| `tests/cr009-release-bundle.test.ts` | `describe("§S3 skills Vercel-Skills conformance")` (:67–103) + `describe("§S3 arduino skill reconcile")` (:104–133) — 4 tests | delete those two describes only |
| `tests/client/test_crucible_axi_stages.py` | 4 skills-stage tests (`:267`, `:296`, `:309`, `:336`) + ~35 skills references incl. the module docstring | retire the skills cases, keep the server/manifest ones |
| `tests/client/test_crucible_axi_install.py` | **25 skills references**: 3 three-stage assertions (`:243` call-order, `:344` envelope `stage_names`, `:487` `len(stages) == 3`), the `:58` + `:233` docstrings, `_patched_server_skills_fakes` (`:416-430`), and `"skills"` keys in injected fakes at `:253`/`:283`/`:300` | retire the three-stage assertions; keep the orchestrator-framework and idempotency coverage |

**Enumeration note (2026-07-28):** the fourth file above was MISSED in the first pass because
the Dimension-6 symbol grep was piped through `head`, truncating a completeness check. Re-run
untruncated, the full set of files referencing skills is exactly: `crucible_axi/install.py`,
`tests/client/test_crucible_axi_install.py`, `tests/client/test_crucible_axi_stages.py`,
`tests/cr009-release-bundle.test.ts`.

The `§S1/§S4/§S5` describes in `cr009-release-bundle.test.ts` (install.sh, release.yml, docs)
are unaffected and must stay green. `crucible_axi/__init__.py:4`'s docstring mentions
"server/skills/manifest" and must be corrected to the two-stage order.

### §S2 — DELETE `clients/skills/` (gate lifted 2026-07-28)
Model B has confirmed the import: byte-identical at commit `74018ea`, now Model-B-canonical,
with our cleanup explicitly green-lit (Sandesh 1342). The earlier freeze-instead-of-delete
instruction is therefore **superseded** — remove `clients/skills/` outright. No frozen-marker
README is needed; a deleted directory cannot be edited by mistake.

**Hand the knowledge over, do not just delete it.** The 22 retired tests encode contracts Model
B now owns but has no equivalent guard for — that skills must cite v2 endpoints, must never
mention the removed `WORKFLOW_CYCLE_ID`, and must invoke real client script paths. Offer
`tests/clients-skills.test.ts` to them on the Sandesh thread so they can carry it forward.
Knowledge evaporating at a handover boundary is precisely what produced the 12 stale
`WORKFLOW_CYCLE_ID` references this handover just cleaned up.

### §S3 — Retire the skills clauses of CR-CRU-009
Record in the queue that CR-CRU-009 §S3 (Vercel-Skills conform + the `--help`-generated
command lists) and the skills portion of §S4 (skills.sh listing / `skills add` source) are
**VOID** — they are Model B's scope now. The corresponding CR-CRU-009 acceptance criteria
covering the skills stage and multi-harness install no longer apply to 0.1.0.

## Acceptance criteria
- [ ] `crucible_axi.install.STAGE_ORDER == ("server", "manifest")` — asserted.
- [ ] `grep -c 'SKILLS_CLI_SOURCE\|_skills_stage\|TODO(S6)' crucible_axi/install.py` is 0.
- [ ] `run_install` returns a TOON-AXI envelope with exactly the `server` and `manifest`
      stages, each carrying its `~`-abbreviated installed path; re-running converges
      (idempotency preserved) — asserted.
- [ ] No stage in `crucible-axi install` shells out to `npx skills` — asserted by
      inspecting the invoked command set, so a re-introduction fails the suite.
- [ ] `clients/skills/` no longer exists; `grep -rn "clients/skills" tests/ crucible_axi/`
      finds no live reference.
- [ ] `tests/clients-skills.test.ts` is deleted (all 22 tests), and the two `§S3` describes are
      gone from `tests/cr009-release-bundle.test.ts` while its `§S1/§S4/§S5` describes stay green.
- [ ] The 4 skills-stage tests in `tests/client/test_crucible_axi_stages.py` are retired; the
      server/manifest cases in that file still pass.
- [ ] `crucible_axi/__init__.py`'s docstring no longer says "server/skills/manifest".
- [ ] Full Python regression green AND full bun regression green — this CR deletes bun tests
      and touches a client-adjacent package, so both gates apply (CR-CRU-045 §S3).
- [ ] `python -m build` still produces a wheel containing the client fleet after the `skills/`
      subtree is removed (`pyproject.toml` force-includes `clients`).

## Coordination
- Model B confirmed full skills ownership (Sandesh 1337) and then confirmed the IMPORT is
  complete (Sandesh 1342): `clients/skills/` is byte-identical at commit `74018ea`, now
  Model-B-canonical, and our cleanup is explicitly green-lit. **The deletion gate has lifted**,
  which is why §S2 deletes rather than freezes.
- **Offer `tests/clients-skills.test.ts` to Model B** on that thread as part of this CR — they
  own the content but inherit no guard for it. This is also a standing-contract item: client and
  skill changes are intimated to them so their bundle does not drift.

## Non-goals
- Editing `~/.claude/skills/crucible` or `~/.claude/scripts/` — shared chezmoi-managed
  config, and now Model B's to supersede. Crucible does not patch either in place.
- Rewriting or re-validating skill CONTENT against client `--help` — no longer our scope.
- The release mechanism (CR-CRU-041) and the release ceremony itself (CR-CRU-009 §S6).

## Risk
- The `[server]` and `[manifest]` stages must remain correct once the middle stage is
  removed — fail-fast ordering and the envelope shape are covered by existing tests, which
  this CR must update rather than weaken.
- **Deleting 22 tests plus a whole skill package is a large negative diff**, and a large
  deletion is exactly where an unrelated assertion gets removed by accident. The ACs pin what
  must SURVIVE (`cr009-release-bundle.test.ts`'s `§S1/§S4/§S5` describes, the server/manifest
  stage tests) precisely so the diff can be checked for over-reach.
- `pyproject.toml` force-includes `clients` as package data; confirm the wheel still builds and
  ships the client fleet once the `skills/` subtree is gone.
