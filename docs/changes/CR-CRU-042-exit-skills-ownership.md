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

### §S2 — Freeze `clients/skills/`, pending Model B's import confirmation
Model B copies the current 8-bundle package into the model-b repo as the new canonical
source. Until they confirm that import on the Sandesh thread, `clients/skills/` stays in
place and unmodified — **it must not be deleted in this CR**. Mark it frozen (a short
`clients/skills/README.md` stating the package is superseded, owned by Model B, and not to
be edited here), so no future cycle "fixes" a file that is no longer ours.

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
- [ ] `clients/skills/` is unchanged and carries a README marking it frozen and
      Model-B-owned.
- [ ] Full Python regression green with coverage on `crucible_axi` + `clients`.

## Coordination
- Model B confirmed full skills ownership and the one-time handover (Sandesh 1337). They
  will intimate on that thread when the `clients/skills/` import is complete.
- **Deleting `clients/skills/` is a FOLLOW-UP**, gated on that intimation — deliberately
  not in this CR, so a Model-B delay cannot block the 0.1.0 installer correction.

## Non-goals
- Editing `~/.claude/skills/crucible` or `~/.claude/scripts/` — shared chezmoi-managed
  config, and now Model B's to supersede. Crucible does not patch either in place.
- Rewriting or re-validating skill CONTENT against client `--help` — no longer our scope.
- The release mechanism (CR-CRU-041) and the release ceremony itself (CR-CRU-009 §S6).

## Risk
- The `[server]` and `[manifest]` stages must remain correct once the middle stage is
  removed — fail-fast ordering and the envelope shape are covered by existing tests, which
  this CR must update rather than weaken.
- If Model B's import stalls, `clients/skills/` lingers as frozen dead weight in the 0.1.0
  sdist. It ships as inert package data and is harmless; the follow-up deletion removes it.
