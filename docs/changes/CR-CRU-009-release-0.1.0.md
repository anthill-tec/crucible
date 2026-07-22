# CR-CRU-009 — Release 0.1.0: distro-agnostic installer + multi-harness skill bundle

**Status:** PENDING — **RE-SCOPED 2026-07-22.** Supersedes the original vendored
`install.sh` bundle: v0.1.0 ships a **distro-agnostic, staged installer** — a Python
(PyPI) primary orchestrator installed via **`uv`**, delegating to stack-appropriate
sub-installers (`npx` for the bun/node server, the **Vercel Skills** CLI for the
multi-harness skill set), plus a discovery manifest for Model-B.
**Type:** feature
**Priority:** P2
**Depends on:** CR-CRU-007, CR-CRU-008, CR-CRU-011, CR-CRU-012, CR-CRU-013, CR-CRU-016 (+ CR-CRU-035's STATUS-CONTRACT, CR-CRU-030's fleet clients)
**Labels:** release, packaging, installer, distro-agnostic, skill-bundle, vercel-skills, cross-project, model-b-coordination
**Phase:** Wave 4
**Design reference:** PRD §2 (deployment target) / §6 (rollout); the AXI install model
(gh-axi + `axi-sdk-js` — `npx -y <tool>` on-demand distribution, `SKILL.md` generated
from `--help`); the Vercel **Skills** open agent-skills ecosystem (skills.sh — `npx skills
add`, 70+ harnesses); user direction 2026-07-22.

## Context
Crucible is two stacks: a **bun/node server** and a **Python client** (the
`*-crucible.py` scripts are Python toolchain variants of one client, not five language
stacks). v0.1.0 must install BOTH stacks + the skill set on any Linux distro and any
agentic harness, mirroring how the AXI tools distribute (the runtime's on-demand runner,
not heavyweight OS packaging) and how Vercel Skills fans a skill out across harnesses.
The unifying outer layer is a Python primary installer that delegates to the
ecosystem-native sub-installer for each technology.

## Scope

### §S1 Distro-agnostic outer entry — `uv` bootstrap
- One-line bootstrap `curl -fsSL <crucible>/install.sh | sh`: ensure **`uv`** (Astral;
  a single static distro-agnostic binary that brings its own Python — installed via
  astral's own `curl … astral.sh/uv/install.sh | sh` if absent), then
  `uv tool install crucible-axi`. Only prereq is `curl`+`sh` — no `apt`/`dnf`/`pacman`,
  no pre-existing system Python/Node.
- **`crucible-axi`** (published to **PyPI**) is the PRIMARY orchestrator and ships the
  Python client fleet (`_crucible_axi.py` + `{bun,python,rust,mvn,arduino}-crucible.py`
  + `STATUS-CONTRACT.md`). `uvx crucible-axi …` is the on-demand form (the `npx` analog).

### §S2 Staged sub-installer delegation — `crucible-axi install`
`crucible-axi install` runs stack-appropriate STAGES, each delegating to the
ecosystem-native sub-installer, idempotent, reporting a **TOON-AXI envelope** (ok + each
stage's installed path, `~`-abbreviated):
- **[server]** `npx -y <crucible-server-npm-pkg>` fetches + runs the bun/node server;
  bootstrap Bun via `curl -fsSL https://bun.sh/install | bash` if absent; print the start
  line (loopback default; `CRUCIBLE_PORT`/`CRUCIBLE_HOST`).
- **[skills]** delegate to the Vercel Skills CLI:
  `npx skills add <crucible-skills-source> --skill '*' --agent '*' -g -y` — installs the
  Crucible skill set into EVERY detected harness (Claude Code, Codex, Cursor, OpenCode,
  …), global scope, non-interactive.
- **[manifest]** write `crucible-clients.json` — the stable, machine-readable
  **discovery manifest** (per-stack installed client path) that Model-B's installer
  captures at pre-flight (deferred from CR-035, msg 1334 §2c).
- Idempotent + scope-parameterized; never overwrites unmanaged files without `--force`.

### §S3 Skill package — Vercel-Skills-compatible, multi-harness
Conform the Crucible skill set (`clients/skills/*`: `agent-protocol`, `crucible-register`,
`crucible-report-{bun,java,python,rust,vscode}` — **reconciled**: add
`crucible-report-arduino` for the arduino client; keep `crucible-report-vscode` as the
documented clientless case) to the Vercel Skills `SKILL.md` format (frontmatter per
`npx skills init`: `name`, outcome-focused `description` trigger, `user-invocable`,
`metadata`) and expose it as a fetchable `skills add` **source** (a repo/subdir, listed
on **skills.sh**). Each report skill's command list is **generated from / validated
against the client's own `--help`** (the gh-axi no-drift model), and the skills are
AXI-compliant (TOON examples, content-first, self-explanatory).

### §S4 Publishing targets
- Python client fleet + `crucible-axi` CLI → **PyPI**.
- Bun/node server → **npm** (an `npx`-runnable package).
- Skill set → a **Vercel Skills source** (repo, listed on skills.sh).
- (0.1.0 may stage via a local/test index; the release ceremony pins the public publish —
  human-gated credentials.)

### §S5 Docs
`README.md` (what Crucible is; quick start = the one-line `curl … | sh` bootstrap; version
0.1.0 + link scheme); `docs/RUNBOOK.md` (start/stop, db path, corrupt-db behavior,
retention, health, port/bind config — loopback-only default).

### §S6 Version + release ceremony
`pyproject.toml`/`package.json` version `0.1.0`; git-flow release per house workflow
(release branch → master + tag `0.1.0` → back-merge develop); README version + tag link
updated on the release branch.

## Acceptance criteria
- [ ] **Distro-agnostic bootstrap:** on a scratch env with only `curl`+`sh` (no
      `apt`/`dnf`, no system Python/Node), `curl … install.sh | sh` provisions `uv` +
      `crucible-axi`; `crucible-axi install` self-provisions the server (Bun via its
      curl-installer) and runs the skills stage; `GET /api/health` → 200 within a bounded
      time.
- [ ] **Staged idempotency:** re-running `crucible-axi install` converges (no duplicate
      installs) and returns a TOON-AXI envelope with `ok` + each stage's installed path
      (`~`-abbreviated).
- [ ] **Skills stage (multi-harness):** `npx skills add <crucible-skills> -s '*' -a '*'
      -g -y` installs the reconciled skill set into ≥2 harness dirs (e.g. `claude-code` +
      `codex`); each installed `SKILL.md` is Vercel-Skills-format-valid + AXI-compliant;
      each report skill's command list matches the client `--help`.
- [ ] **Discovery manifest:** `crucible-clients.json` exists with a stable schema mapping
      each stack to its installed client path (the Model-B pre-flight contract).
- [ ] **Fresh-install smoke:** `register` + `ingest <bundled fixture>` against the fresh
      instance return `ok:true`.
- [ ] **CLI-bootstrap smoke** (deferred-register fold-in, user-approved 2026-07-15): a
      test spawns `bun run src/server.ts` as a real subprocess (exercising
      `import.meta.main` + the file-db mkdir path), polls `GET /api/health` to 200 within
      5 s, then kills it — the coverage-orphaned line ranges get automated contact.
- [ ] `README.md` quick start = the one-line bootstrap; stated version matches `0.1.0`.
- [ ] `git tag 0.1.0` exists on master after the ceremony; develop has the back-merge.

## Coordination
- **On implementation, INTIMATE Model-B** (Sandesh, continuing the thread): Model-B's
  OVERARCHING installer + scaffold system CALLS Crucible's installer (the
  `curl … | sh` bootstrap / `crucible-axi install`) when Crucible is not present in the
  ecosystem. Provide (a) the invocation entrypoint, (b) a detection convention ("is
  Crucible installed" — e.g. `crucible-axi --version` / the `crucible-clients.json`
  manifest presence), so their scaffold can conditionally provision us.
- The client-discovery manifest (deferred from CR-035) LANDS here (`crucible-clients.json`).

## Non-goals
- Model-B's overarching installer/scaffold internals; hook installation + skill
  GENERATION/per-project deploy (Model-B — Crucible only PROVIDES the Vercel-Skills
  package + the `status` contract; Model-B's scaffold decides per-project wiring).
- Shim removal, BDD harness, filter bar, coverage-trend deep views (post-0.1.0).

## Risk
- **Networked install (deliberate):** unlike the superseded vendored bundle, the staged
  install FETCHES (`uv`, `npx`, `skills`, Bun) — the prior "fully offline" AC is DROPPED;
  this is an ecosystem-integrated installer by design. An air-gapped/vendored fallback
  path is a possible post-0.1.0 follow-up.
- **External publishing:** PyPI / npm / skills.sh publishing needs credentials + is a
  human-gated, release-branch step; 0.1.0 may validate against a local/test index first.
- `install.sh` / global skill install touching a shared harness config — idempotent +
  managed-marker + `--force`-gated, never clobbering unmanaged entries.

## Implementation notes (gap-analysis 2026-07-23)
- **Version:** the first public release is **0.1.0** (user-decided); reconcile the internal
  `2.0.0-alpha.1` marker → `0.1.0` in `package.json` + the new `pyproject.toml`, tag `0.1.0`.
- **Build vs human-gated (publish is credentialed):** these cycles BUILD + unit-test the
  `crucible-axi` package + `install` orchestrator (stage sequencing, idempotency, TOON-AXI
  stage envelopes), the `crucible-clients.json` manifest, the skills-conform + arduino skill,
  the server `bin`, and docs — with the external tools (`uv`/`npx`/`skills`/Bun) and the
  registries **MOCKED / dry-run** in tests. The ACTUAL PyPI/npm/skills.sh PUBLISH, the real
  end-to-end networked install, the git-flow release ceremony (tag `0.1.0`), and the Model-B
  intimation are **HUMAN-GATED** release steps run post-merge with credentials — not in the
  build cycles.
- **Skills conform is small:** the report skills already carry `name` + trigger-`description`
  (vercel/skills core); conform = add the `metadata:` (author/version) block + add
  `crucible-report-arduino`.
</content>
