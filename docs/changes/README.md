# Crucible — CR Queue

Single source of truth for implementation scheduling. Pick the next `PENDING` row by
phase + dependency order. Conventions: `~/.claude/memory/cr-prd-dn-conventions.md`.

**Design contract:** [../research/PRD-crucible-v2.md](../research/PRD-crucible-v2.md)
**Evidence base:** [../research/DN-crucible-api-reconstruction.md](../research/DN-crucible-api-reconstruction.md)
**Target release:** 0.1.0

| CR | Title | Type | Status | Depends on | Wave |
|---|---|---|---|---|---|
| [CR-CRU-001](CR-CRU-001-domain-core-storage.md) | Domain core + SQLite storage | feature | COMPLETED | — | 1 |
| [CR-CRU-002](CR-CRU-002-codec-layer.md) | Codec translation layer | feature | COMPLETED | 001 | 1 |
| [CR-CRU-003](CR-CRU-003-v1-shim.md) | v1 compatibility shim + contract tests | feature | COMPLETED | 001, 002 | 1 |
| [CR-CRU-004](CR-CRU-004-v2-api.md) | Clean v2 API + SSE | feature | COMPLETED | 003 | 2 |
| [CR-CRU-005](CR-CRU-005-axi-toon.md) | AXI layer: TOON subset + help hints | feature | COMPLETED | 004 | 2 |
| [CR-CRU-006](CR-CRU-006-spa-shell.md) | Dashboard shell (Mission Control + workspace + navigation) | feature | COMPLETED | 004 | 3 |
| [CR-CRU-007](CR-CRU-007-timeline-drill-in.md) | Run timeline + density-adaptive drill-in | feature | COMPLETED | 006 | 3 |
| [CR-CRU-008](CR-CRU-008-cli-fleet-upgrade.md) | crucible-axi CLI + client-fleet upgrade | feature | COMPLETED | 005, 007, 011 | 4 (after 011) |
| [CR-CRU-009](CR-CRU-009-release-0.1.0.md) | Release 0.1.0: distro-agnostic installer + multi-harness skill bundle | feature | COMPLETED | 007, 008, 011, 012, 013, 016 | 4 |
| [CR-CRU-010](CR-CRU-010-codec-path-interface-hardening.md) | Codec path-parsing interface + shim regression hardening | maintenance | COMPLETED | 006 | 3 (after 006, before 007) |
| [CR-CRU-016](CR-CRU-016-inpane-drill-in.md) | In-pane drill-in: run detail inside the Run Timeline pane | feature | COMPLETED | 007 | 4 (first after 007) |
| [CR-CRU-019](CR-CRU-019-patch-workflow-tweaks.md) | Patch: workflow-review tweak accumulator | patch | COMPLETED | 011 | 4 (after 011) |
| [CR-CRU-011](CR-CRU-011-workflow-lens.md) | Cycle plans + workflow lens + agent runtimes | feature | COMPLETED | 007 | 4 (after 016) |
| [CR-CRU-020](CR-CRU-020-patch-workflow-history-refinements.md) | Patch: workflow history view refinements | patch | COMPLETED | 011, 019 | 4 (after 019) |
| [CR-CRU-021](CR-CRU-021-patch-workflow-primary-tab.md) | Patch: Workflow as the primary workspace tab | patch | COMPLETED | 020 | 4 (after 020) |
| [CR-CRU-023](CR-CRU-023-patch-pane-min-width-scroll.md) | Patch: gate-review defects — pane scroll floor · vitals trend chart · timer restart semantics | patch | COMPLETED | 021 | 4 |
| [CR-CRU-012](CR-CRU-012-projects-manager.md) | Projects manager: add + edit project parameters | feature | COMPLETED | 004, 007 | 4 (before 009) |
| [CR-CRU-013](CR-CRU-013-gate-events.md) | Workflow events: gates (no-mistakes) + milestones | feature | COMPLETED | 008, 011 | 4 |
| [CR-CRU-031](CR-CRU-031-wave-classification-fix.md) | Wave-classification fix: server wave-backfill + `plan-file --wave` + CR-021 correction | patch | COMPLETED | 011, 013 | 4 (right after 013) |
| [CR-CRU-030](CR-CRU-030-fleet-toon-axi-compliance.md) | Fleet-wide TOON-AXI conversion + mandatory classification context (all crucible clients) | patch | COMPLETED | 013 | 4 (before 009) |
| [CR-CRU-036](CR-CRU-036-patch-client-axi-transition-fixes.md) | Patch: client TOON-AXI transition fixes (§S9 server-active-cycle + CR-008 test retarget + fleet coverage-uniformity) | patch | COMPLETED | 030 | 4 |
| [CR-CRU-037](CR-CRU-037-patch-workflow-card-correctness.md) | Patch: workflow-card correctness (parallel-agent liveness dimming + plan-title guard/fallback) | patch | COMPLETED | 011, 008 | 4 |
| [CR-CRU-038](CR-CRU-038-patch-run-detail-controls.md) | Patch: run-detail drill-in controls — minimized error tree, raw-output toggle, header-relocated controls | patch | COMPLETED | 016, 034 | 4 |
| [CR-CRU-035](CR-CRU-035-ambient-context-session-hooks.md) | Ambient-context read-path contract (AXI principle 7) — coordinated Crucible↔Model-B | feature | COMPLETED | 030 | 4 |
| [CR-CRU-024](CR-CRU-024-patch-cycle-activation-guards.md) | Patch: plan-cycle activation guards + AXI invalid-action responses | patch | COMPLETED | 011 | 4 |
| [CR-CRU-025](CR-CRU-025-cycle-run-boundary-navigation.md) | Cycle ↔ run-boundary navigation (bidirectional, with locate blink) | feature | COMPLETED | 011, 012 | 4 |
| [CR-CRU-026](CR-CRU-026-patch-workspace-plan-scoping.md) | Patch: workspace plan scoping — navigation refetch + render guard | patch | COMPLETED | 011, 021 | 4 |
| [CR-CRU-027](CR-CRU-027-patch-coverage-trend-fidelity.md) | Patch: coverage-trend mock fidelity (F8 vitals sparkline) | patch | COMPLETED | 023 | 4 |
| [CR-CRU-033](CR-CRU-033-coverage-by-day-series.md) | Date-keyed coverage-by-day series (CR-028 data prerequisite) | feature | COMPLETED | 023, 032 | 4 |
| [CR-CRU-028](CR-CRU-028-patch-coverage-trend-semantics.md) | Coverage trend: auto-coarsening health hierarchy (DN-locked) | feature | COMPLETED | 033, 027 | 4 |
| [CR-CRU-029](CR-CRU-029-patch-dual-axis-scroll-visibility.md) | Patch: dual-axis scroll always operable in narrow viewports | patch | COMPLETED | 023 | 4 |
| [CR-CRU-034](CR-CRU-034-patch-drilldown-dual-axis-scroll.md) | Patch: run-detail drill-down inherits CR-029 dual-axis operability | patch | COMPLETED | 029, 007, 016, 023 | 4 |
| [CR-CRU-032](CR-CRU-032-runs-boundary-anchor-fetch.md) | Patch: Runs-window governance + project-settings integrity | patch | COMPLETED | 025, 012, 008 | 4 |
| [CR-CRU-039](CR-CRU-039-python-regression-discovery.md) | Patch: python-client `regression` discovers 0 tests (silent gate gap) | patch | COMPLETED | 036 | 4 |
| [CR-CRU-040](CR-CRU-040-python-coverage-tooling.md) | Patch: python-client coverage tooling (gate can't produce coverage) | patch | COMPLETED | 039 | 4 |
| [CR-CRU-041](CR-CRU-041-release-mechanism.md) | Release mechanism: branch-gated driver + publishable server package | feature | COMPLETED | 009 | 4 |
| [CR-CRU-042](CR-CRU-042-exit-skills-ownership.md) | Patch: Crucible exits skills (ownership transferred to Model B) | patch | COMPLETED | 009, 035 | 4 |
| [CR-CRU-043](CR-CRU-043-installed-db-path.md) | Patch: installed server misplaces its database (CWD-relative default) | patch | COMPLETED | 009 | 4 |
| [CR-CRU-044](CR-CRU-044-phase-as-first-class-data.md) | Agent phase must be declared data, not an agentId naming convention | patch | COMPLETED | 030, 036 | 4 |
| [CR-CRU-045](CR-CRU-045-coverage-shadow-regression.md) | Patch: the `coverage/` shadow test over-specifies its contract | patch | COMPLETED | 036, 040 | 4 |
| [CR-CRU-046](CR-CRU-046-toon-conformance.md) | Adopt the official TOON libraries on both stacks; retire our hand-written codecs | patch | COMPLETED | 005, 030, 009 | 4 |
| [CR-CRU-047](CR-CRU-047-narration-gate-integrity.md) | Bun gate integrity: narration tests fail deterministically + an unexplained test-count drop | patch | COMPLETED | 038, 039 | 4 |
| [CR-CRU-048](CR-CRU-048-state-derived-help-and-close-guard.md) | AXI `help[]` must be state-derived, and `cr-close` must refuse an incomplete plan | patch | COMPLETED | 011, 024, 030, 036 | 4 |
| [CR-CRU-049](CR-CRU-049-mvn-narration-hardening.md) | Harden `mvn-crucible.py` narration: real-format fixtures + pinned output mode | patch | COMPLETED | 008, 047 | 4 |
| [CR-CRU-050](CR-CRU-050-skip-folds-into-passed.md) | Skipped/todo tests are counted as PASSED in the ingest envelope | patch | COMPLETED | 039, 047 | 4 |
| [CR-CRU-051](CR-CRU-051-files-count-fleet-parity.md) | Propagate the run-envelope `files` count to the other four clients | patch | COMPLETED | 047, 050 | 4 |
| [CR-CRU-052](CR-CRU-052-project-teardown.md) | Projects can be created but never deleted; seeded fixtures leave permanent dead state | feature | COMPLETED | 012, 032 | 4 |
| [CR-CRU-060](CR-CRU-060-e2e-harness-identity-drift.md) | The e2e harness predates the registered-caller hard stop; 19 scenarios fail against it | patch | COMPLETED | 056, 052 | 4 |
| [CR-CRU-061](CR-CRU-061-tag-derived-versioning.md) | Bare-SemVer tags, and the npm version DERIVED from the tag instead of hand-bumped | patch | COMPLETED | 041 | 4 |
| [CR-CRU-062](CR-CRU-062-ci-runs-the-gates.md) | CI publishes but never tests: no workflow runs the suite | feature | COMPLETED | 041, 052, 060 | 4 |
| [CR-CRU-053](CR-CRU-053-retired-mirror-references.md) | Test files still point readers at the retired `~/.claude/scripts` client mirror | patch | COMPLETED | 008, 009, 042 | 4 |
| [CR-CRU-054](CR-CRU-054-client-fleet-dry.md) | The client fleet is 44 functions copy-pasted five times | maintenance | COMPLETED | 030 | 4 |
| [CR-CRU-055](CR-CRU-055-ai-agent-quieting-strip.md) | Patch: bun env-quieting strip misses `AI_AGENT` (narration + failure-marrying die in agent sessions) | patch | COMPLETED | 047, 038 | 4 |
| [CR-CRU-056](CR-CRU-056-ambiguous-auto-attach-throws.md) | Agent registration binds its cycle EXPLICITLY; server-side auto-attach guessing is DELETED | patch | COMPLETED | 036, 024, 044 | 4 |
| [CR-CRU-057](CR-CRU-057-phase-survives-the-agent.md) | Patch: phase must survive the agent — persist it on events, delete the name fallback | patch | COMPLETED | 044, 011 | 4 |
| [CR-CRU-058](CR-CRU-058-rust-axi-envelope-parity.md) | 40 of 118 client verbs emit no TOON-AXI envelope, including the pre-merge gate in all five clients | patch | COMPLETED | 030, 054 | 4 |
| [CR-CRU-059](CR-CRU-059-identity-source-validation.md) | The registration identity contract: rename `phase` → `role` fleet-wide, and validate `identity.source` | patch | COMPLETED | 044, 054, 056, 057 | 4 |
| [CR-CRU-063](CR-CRU-063-ci-provisions-the-toolchain.md) | CI runs the gates but provisions no toolchain: 102 bun + 9 python failures on a real runner | patch | COMPLETED | 062 | 4 |
| [CR-CRU-064](CR-CRU-064-toolchain-starved-runs-emit-no-envelope.md) | A toolchain-starved run emits no envelope: seven no-report fallbacks return an exit code and nothing machine-readable | patch | COMPLETED (0.1.0 · release prerequisite) | 030, 054, 058, 063 | 4 |
| [CR-CRU-065](CR-CRU-065-cause-selection-fits-maven.md) | The no-report cause is selected by "last non-empty line", which fits python and node but not maven | patch | COMPLETED (0.1.0 · release prerequisite) | 064 | 4 |
| [CR-CRU-066](CR-CRU-066-install-provisions-not-runs-plus-serve.md) | `crucible-axi install` hangs (runs the server) and exposes no run command; provision-and-exit + a `serve` verb + bun guarantee | bugfix | COMPLETED (0.1.2 · release blocker) | 009, 041 | 4 |
| [CR-CRU-014](CR-CRU-014-execution-roadmap.md) | Execution roadmap: queue registration + Wave/CR sequence table | feature | COMPLETED (0.2.0) | 011, 013 | 5 (0.2.0) |
| [CR-CRU-015](CR-CRU-015-bdd-harness.md) | BDD harness: Crucible executes Playwright for frontend projects | feature | PENDING | 004, 007 | 6 (post-0.2.0) |
| [CR-CRU-017](CR-CRU-017-run-lifecycle.md) | Run lifecycle: start/end events + the Aborted state | feature | COMPLETED (0.2.0) | 008, 011 | 5 (0.2.0) |
| [CR-CRU-018](CR-CRU-018-responsive-mobile.md) | Responsive Crucible: mobile + tablet media support | feature | PENDING | 016, 093 | 6 (post-0.2.0) |
| [CR-CRU-022](CR-CRU-022-roadmap-analytics.md) | Roadmap analytics: velocity + burndown + forecast | feature | PENDING | 011, 014, 091 | 6 (post-0.2.0) |
| [CR-CRU-098](CR-CRU-098-the-plan-pointer-has-no-publisher.md) | the plan pointer has no publisher | feature | PENDING (post-0.2.0) | 095 | 6 |
| [CR-CRU-068](CR-CRU-068-server-discloses-its-store.md) | The server never says which store it opened | bugfix | COMPLETED (0.2.0) | 043, 066 | 5 (0.2.0) |
| [CR-CRU-069](CR-CRU-069-uninstall-inverts-install.md) | Install has no inverse: `crucible-axi uninstall` + `install.sh` teardown | feature | COMPLETED (0.2.0) | 009, 066 | 5 (0.2.0) |
| [CR-CRU-070](CR-CRU-070-systemd-user-unit.md) | systemd `--user` unit: install script provisions and reverses it | feature | COMPLETED (0.2.0) | 066, 069 | 5 (0.2.0) |
| [CR-CRU-071](CR-CRU-071-in-place-upgrade-safe-migration.md) | In-place upgrade: versioned, backed-up, refusable DB migration | feature | COMPLETED (0.2.0 — incl. AC8 upgrade gate + AC9 daemon restart, absorbed from 072) | 001, 043, 068 | 5 (0.2.0) |
| [CR-CRU-072](CR-CRU-072-installer-upgrades-in-place.md) | The installer cannot upgrade: bare `uv tool install` no-ops on an existing install | bugfix | COMPLETED (0.2.0 — AC5 → 071 AC8, AC7 → 071 AC9) | 066, 069, 071 | 5 (0.2.0) |
| [CR-CRU-074](CR-CRU-074-releases-are-first-class.md) | Crucible has never been told a release happened | feature | COMPLETED (0.2.0) | 013 | 5 (0.2.0) |
| [CR-CRU-073](CR-CRU-073-gate-events-expire-at-release.md) | Finished releases keep showing their gate: no-mistakes events outlive their release | bugfix | COMPLETED (0.2.0) | 013, 071, 074 | 5 (0.2.0) |
| [CR-CRU-076](CR-CRU-076-roadmap-first-tab.md) | Roadmap is first in the workspace tab band | patch | COMPLETED (0.2.0) | 014, 021 | 5 (0.2.0) |
| [CR-CRU-080](CR-CRU-080-release-ceremony-cannot-report.md) | the release ceremony cannot report a release (no agent identity) | bugfix | COMPLETED (0.2.0) | 074 | 5 (0.2.0) |
| [CR-CRU-082](CR-CRU-082-wave-targets-a-release.md) | a wave declares the release it targets | feature | VOID | 014, 074 | 5 (0.2.0) |
| [CR-CRU-081](CR-CRU-081-release-provenance-uses-ancestry.md) | release provenance must use commit ancestry, not merge subjects | bugfix | COMPLETED (0.2.0) | 080 | 5 (0.2.0) |
| [CR-CRU-086](CR-CRU-086-repair-must-not-erase-provenance.md) | the provenance repair must never erase provenance | bugfix | COMPLETED | 081 | 5 |
| [CR-CRU-083](CR-CRU-083-derived-status-cannot-say-done.md) | derived status conflates "never started" with "done before tracking existed" | bugfix | COMPLETED | 014, 081 | 5 |
| [CR-CRU-087](CR-CRU-087-ci-bun-is-unpinned.md) | CI floats to the newest bun, so a format-parsing test flips and blocks every publish | bugfix | COMPLETED (0.2.0) | — | 5 |
| [CR-CRU-088](CR-CRU-088-failure-detail-marries-the-wrong-leaf.md) | a failure detail printed after its own leaf is attributed to the NEXT test | bugfix | COMPLETED | 087 | 5 |
| [CR-CRU-090](CR-CRU-090-install-lays-the-fleet-down.md) | `install` never lays the client fleet down, so every manifest path is dead | hotfix | COMPLETED (0.1.3 · shipped) | — | 5 |
| [CR-CRU-084](CR-CRU-084-release-records-its-packages.md) | a release records the package(s) it delivered | feature | COMPLETED | 080, 081 | 5 |
| [CR-CRU-077](CR-CRU-077-roadmap-graph-is-the-execution-dag.md) | the roadmap graph is the execution DAG, not a relationship web | feature | COMPLETED (0.2.0) | 014, 076, 080, 083, 084 | 5 (0.2.0) |
| [CR-CRU-091](CR-CRU-091-roadmap-registration-is-declared.md) | roadmap registration is declared: release, wave and sequence | feature | COMPLETED (0.2.0) | 014, 084 | 5 (0.2.0) |
| [CR-CRU-092](CR-CRU-092-next-validates-the-sequence.md) | `next`: the orchestrator validates its sequence during execution | feature | COMPLETED (0.2.0) | 091 | 5 (0.2.0) |
| [CR-CRU-078](CR-CRU-078-roadmap-graph-and-table-together.md) | the roadmap is a release-paged flowchart with its scoped table | feature | COMPLETED (0.2.0) | 077, 084, 091 | 5 (0.2.0) |
| [CR-CRU-095](CR-CRU-095-seq-scales-collide.md) | two seq scales collide, so `next` recommends deferred work | patch | COMPLETED (0.2.0) | 091, 092 | 5 (0.2.0) |
| [CR-CRU-096](CR-CRU-096-zone-2-drifts-from-the-approved-design.md) | zone 2 drifts from the approved flowchart design | patch | COMPLETED (0.2.0) | 078, 095 | 5 (0.2.0) |
| [CR-CRU-097](CR-CRU-097-project-independence-is-not-asserted.md) | project independence is claimed but never asserted | patch | PENDING (0.2.0) | — | 5 (0.2.0) |
| [CR-CRU-079](CR-CRU-079-roadmap-deep-link-and-drill-through.md) | roadmap deep-link parity and active-CR drill-through | feature | PENDING (0.2.0) | 078 | 5 (0.2.0) |
| [CR-CRU-085](CR-CRU-085-roadmap-multi-track-lanes.md) | multi-track swimlanes inside a wave | feature | PENDING (0.2.0) | 078 | 5 (0.2.0) |
| [CR-CRU-093](CR-CRU-093-project-rail-collapses.md) | the project rail collapses, giving every workspace view its width back | feature | PENDING (0.2.0) | 006 | 5 (0.2.0) |
| [CR-CRU-075](CR-CRU-075-queue-file-fleet-parity.md) | queue-file fleet parity + AXI verb-surface census enforcement | patch | PENDING (0.2.0) | 014, 091, 092, 095 | 5 (0.2.0) |
| [CR-CRU-094](CR-CRU-094-agent-participation-is-recorded.md) | agent participation is recorded, not inferred | feature | PENDING (0.2.0) | 056 | 5 (0.2.0) |

## Deferred — post-0.2.0

- **Primary architecture document** (design effort, NOT a CR, NOT in 0.2.0). Crucible has
  `PRD-crucible-v2.md` and 10 DNs but no Architecture document at the top of the chain, so per the
  Model-B ontology (Architecture → PRDs for complex features / DNs for micro features → CR → source
  → release packages) the supporting docs currently support a document that does not exist. It will
  be produced **later**, by **distilling the entire Lavish storyboard together with the other design
  docs** — a specific set of design tasks in its own right, deliberately out of the 0.2.0 release.
  - **How the design survives:** `.lavish/` is gitignored deliberately — the storyboard is a
    working design surface, not a repo artifact. Durability comes from **distilling decisions into
    DNs**, which is the tracked path: the roadmap-view decisions are already captured in
    `DN-crucible-roadmap-view.md`, and the wave/track/release model in
    `DN-crucible-wave-track-release.md`. The architecture-document effort distils the remaining
    frames the same way.

- **The provenance repair may still drop a shipped CR's release membership** (candidate CR, raise at
  the next SCRUM). CR-086 §S1/§S2 stopped the empty-set overwrite and the unregistered-queue write,
  but §S3 still *permits* a shrink that removes ids ancestry cannot place — and the measured case is
  nine CRs (`CR-CRU-001`–`007`, `010`, `016`) that demonstrably shipped in `0.1.0`. Per
  `DN-crucible-wave-track-release.md` a shipped CR's release membership is **settled fact**, and
  per the user's 2026-08-23 rule an implemented CR cannot be edited, so a repair that deletes those
  ids edits settled fact. CR-083 AC9 pins the derivation side (an implemented CR never reads back
  `PENDING`); the write-side guard — refuse the removal, or require it to be explicit per id — has
  no CR yet.

- **Nothing distinguishes a mainline orchestrator from a track one** (candidate CR, raised by
  CR-091's gap analysis 2026-08-28, no CR filed). `AGENT_ROLES` (`src/types.ts:53`) is
  `RED · GREEN · FIX · VERIFY · ORCHESTRATOR · report`: there is **no MAINLINE role**, and a track
  orchestrator registers as `ORCHESTRATOR` exactly as the mainline one does. The PRD's hierarchy —
  "MAINLINE ORCHESTRATOR (widest: allocates lanes, launches waves, gates boundaries) → ORCHESTRATOR
  (track scope: one lane's CR queue)" (`PRD-crucible-v2.md:310-316`) — is therefore a **convention
  Crucible does not model as data**. Consequence, stated plainly in CR-091 §S3: its role gate stops
  RED/GREEN/FIX/VERIFY/report and unregistered callers, and **cannot** stop a track orchestrator
  from re-planning the roadmap. Closing it needs either a new stored role or an identity check
  (schema + registration surface), which is why CR-091 refused to smuggle it in. Not required for
  0.2.0: the roadmap verbs work correctly when used as intended, and the gap is authority
  enforcement, not correctness.

- **`public/app-logic.mjs` is classified as BINARY, so pattern search silently skips it**
  (candidate patch CR, found during CR-CRU-091 C4 2026-08-28). The file holds **five literal NUL
  bytes (0x00)** — raw characters, not `\u0000` escapes — used as composite-key separators in
  template literals (lines 230, 523, 530: `` `${event.projectKey}\x00${stemKey(event.agentId)}` ``).
  `file` reports `data`; `grep`/`rg` and the harness search tool report no matches for ANY pattern
  in the file. Consequence: every agent that greps this 1000-line core module gets a false
  negative, and "not found" reads as "absent". It already bit twice in one session — C4 had to
  work around it, and an orchestrator search of the same file came back empty. The fix is five
  bytes, replacing each raw NUL with the `\u0000` escape: the runtime string is byte-identical
  (still U+0000), only the SOURCE becomes text. Deliberately NOT folded into CR-CRU-091 — it is
  unrelated to roadmap registration and the repo rule is a patch CR over an inline scope edit.

- **`tsc` does not type-check `public/`** (candidate, same origin). `tsconfig.json`'s `include` is
  `[src, cli, tests, playwright.config.ts]`, `allowJs` is unset, and `tests/app-logic.d.ts`'s
  `declare module "../public/app-logic.mjs"` SHADOWS the real file — so `public/app-logic.mjs`'s
  body is never checked and `public/app-logic.d.mts` sits outside `include`. A clean
  `bunx tsc --noEmit` therefore says nothing about the frontend logic module, which is where
  `buildRoadmapGraph` and the renderer's shared helpers live. Not a CR-CRU-091 defect — it is the
  standing state for all of `public/` — but 091 added code there, so the gap is now load-bearing
  for a shipped feature.

- **`cr-supersede` and `cr-void` are ONE computation under two key names** (candidate DN, raised by
  CR-CRU-091's VERIFY 2026-08-28). `src/v2.ts:2328-2338` computes `dependants` once
  (`entries.filter(e => e.dependsOn.includes(cr))`) and emits the identical array as
  `resolvedDependants` for supersede or `brokenDependants` for void. The successor is not involved:
  `by` is never validated to exist or to be planned (`store.setQueueLifecycle` just stringifies it,
  `src/store.ts:3673`), and no dependant's `dependsOn` is re-pointed at it. So "resolved THROUGH the
  successor" is a LABEL on the same list, not a modelled relationship. CR-CRU-091 AC15's literal
  wording is met and the client mirrors the split honestly, so this is not a defect of that CR —
  but **CR-CRU-078 AC27 is about to render the two states distinguishably**, and rendering
  "resolved" implies a resolution that did not happen. Decide the model before that ships: either
  validate `by` and re-point dependants, or rename the field to what it actually is (the CR's
  dependants, listed).

- **CR-CRU-091 ships a store surface no HTTP client can reach** (note, not a defect).
  `QueueEntryInput.release` / `.track` / `.lifecycle` are unreachable from every route:
  `handleQueuePost` forwards only `cr/title/wave/dependsOn/size/seq` (`src/v2.ts:1848-1859`), and
  the five new routes go through `upsertQueueEntry` / `sequenceQueueWave` / `setQueueLifecycle`
  rather than `replaceQueue`. Consequently `replaceQueue`'s own `track` normalisation and refusal
  (`src/store.ts:3362-3373`) and its `entry.lifecycle` branch are exercised by tests alone. This is
  consistent with §S8 (the per-entry `seq` is "the one wire addition beyond the five-route table"),
  and the carry-forward path those fields feed IS reachable and load-bearing — but the write side
  of them is dead until something wires it.

- **`plan-file --cycles` splits silently on a comma inside a label** (candidate patch CR, hit
  2026-08-28 filing CR-CRU-078). `--cycles` is comma-delimited, so a label containing a comma —
  `"C1 data + authored order - proposals read, formatter wiring, seq verbatim"` — became THREE
  cycles (296/297/298) instead of one, with `ok: true` and no warning. The board silently gained
  two cycles nobody planned. `--help` does say "Comma-separated cycle labels", so the input was
  mine; the defect is that a delimiter collision inside a value is unreportable on this surface,
  and the only repair verb (`abort`) is gated on `--user-approved` — so a filing typo costs a user
  approval to undo. Candidate fixes: accept a repeatable `--cycle` flag so labels may hold commas,
  or warn when a resulting label is suspiciously short or the count exceeds a plausible bound.
  Not folded into 078 — unrelated to the roadmap surface, and the repo rule is a patch CR over an
  inline scope edit. Worked around by adopting the finer granularity rather than aborting the plan:
  destroying a board record to fix a label is the worse trade.

- **`cycle-add` / `checkpoint` / `abort` cannot target a CR that has an aborted plan** (candidate
  patch CR, hit 2026-09-02 executing CR-CRU-095). They resolve via
  `resolve_plan(..., open_only=False)` (`clients/_crucible_axi.py:1731+`), so after `abort` +
  `plan-file` the aborted plan and the open one BOTH match `--cr` and the verb refuses as ambiguous —
  with no `--plan <id>` escape. Compounding it, the ambiguity message at
  `clients/_crucible_axi.py:375-379` filters candidates by `open_only` but NOT by the `--cr` the
  caller passed, so it says "80 plans — pass --cr to pick one" to a caller who already did. Fix:
  prefer the single open plan when `--cr` matches one open and N non-open plans (or take
  `open_only=True` for `cycle-add`), and list only the `--cr`-matching candidates. Worked around
  in 095 by folding the client cycle into cycle 305 rather than hand-rolling the POST.
- **`queue-file` drops lifecycle dispositions on import** (candidate patch CR, hit 2026-09-02).
  Repopulating a cleared board via `queue-file` resurrected `CR-CRU-082` (VOID in the README) as
  `PENDING` with `lifecycle: null`, so it read as actionable. VOID/supersede are `cr-void` /
  `cr-supersede` dispositions, not statuses the table carries, and the import neither carries them
  nor warns that the README's status column disagrees with the board. Re-recorded via `cr-void`;
  no other README VOID was affected. A patch should at least WARN on a README-vs-board lifecycle
  disagreement at import.

- **CHECKED AND FOUND CORRECT — the unregistered-caller 409 is not misleading. Do not re-file it.**
  2026-08-28: the orchestrator was refused three times in one session
  (`agent vidushi is not registered with this project`) after long dispatches pruned its
  registration for silence, and a draft of CR-CRU-094 asserted the refusal's `help[]` "gives the
  wrong first instruction". **That was false.** `src/hints.ts:325` already reads *"has no live
  registration in this project (never registered, unregistered, or pruned) — nothing was stored or
  changed"* — it declines to guess which of the three applies and offers the recovery that is
  correct for all three. The drafted AC was deleted rather than filed, and CR-CRU-094 §S2 records
  the same conclusion in the spec itself. The three 409s were operational friction — re-register and
  continue — not a diagnostic defect. What IS real is the participation record being destroyed by
  pruning as well as by `unregister`, and that is CR-CRU-094 §S2's scope.

- 2026-09-02 — **a run that STARTS and never ingests cannot be reaped.** Found dogfooding
  CR-CRU-096 C2: the RED agent's first client invocation hung (see the `toEqual` trap below) and was
  killed at 600 s after the server had already created the run row, leaving
  `run-06c470a7-6d5b-405a-af2a-1fc0392c6bb3` started-but-never-finished. There is no verb for it:
  `stop` is project-level checkpointing (`clients/_crucible_axi.py:1656`, POST
  `…/projects/<key>/stop`, "no plan targeting"), and `abort` targets PLANS. So an orphaned run
  stays open forever and every "runs on this cycle" count is quietly wrong. Adjacent to
  CR-CRU-094's scope (participation recorded, not inferred) but NOT the same defect — that CR is
  about the agent/cycle binding, this is about run lifecycle. Needs its own CR if it recurs.
- 2026-09-02 — **`expect(<array of live DOM elements>).toEqual([])` never returns.** bun's deep-equal
  walks the node's circular parent/child graph; it hung a suite past 600 s and burned the orphaned
  run above. Assert on `.length` or on an array of extracted attributes, never on element arrays.
  Comment left at the site in `tests/roadmap-wave-rows.test.ts`.
- 2026-08-27 — **0.1.3 shipped**: CR-CRU-090, PyPI + npm both at 0.1.3. Pre-flight every tag via a
  PR — push-triggered CI only runs on `develop`/`master`, and a red suite silently skips the publish.
- 2026-08-27 — `develop` RED narrowed to ONE test: `CR-CRU-088 AC4 (E2E)` in
  `tests/clients-bun-crucible.test.ts`. Cause is bun 1.4.0's JUnit reporter, not its console stream;
  remedy is frozen bytes, as already done for §S2c. The `npm pack` half no longer reproduces.
- 2026-08-27 — deferred: the `[fleet]` uninstall inverse (CR-CRU-090 Non-goals); `STAGE_ORDER` has
  four stages, `UNINSTALL_STAGE_ORDER` three.
- 2026-08-28 — roadmap design **approved** (`.lavish/crucible-workflow-flowchart.html` §1–§14): release-paged
  flowchart, no dependency edges drawn, whole containers only. CR-078 re-based, 079/085/075/022/018 re-scoped,
  091/092/093 filed. CR-082's VOID stands — release targeting returns on the CR, not the wave.
- 2026-08-28 — the development board is **empty by intent**: queue rows AND the four 0.1.x release records were
  cleared so the user can dogfood the CR-091 API to populate it properly, as the last step before the 0.2.0
  release. Provenance is exported to `docs/release-provenance-0.1.x.json` (tracked) with its replay command —
  `commit`/`releasedAt` are re-derivable from tags but 0.1.0's 60-id `crs` is **not** (nine ids landed with no
  naming merge commit). DB snapshots: `data/crucible.db.pre-roadmap-clear-1787893879`,
  `…pre-release-clear-1787897137` (`data/` is gitignored — the JSON is the durable copy).
- CI runs an unpinned bun deliberately. Pinning was tried in CR-087 and **reverted** (`93f42f7`): `packageManager` makes npm provision through corepack (958 ms → 13082 ms on the npm-pack test). The both-orderings fixtures catch a console-format flip instead. [CR-CRU-089](CR-CRU-089-pin-bun-without-telling-npm.md) is VOID; revisit only if a flip recurs.
- The bun failure-detail mis-attribution (a leaked async throw landing on the next leaf) is
  **fixed** by [CR-CRU-088](CR-CRU-088-failure-detail-marries-the-wrong-leaf.md) §S1: a detail block
  is attributed to the test its source echo NAMES, falling back to the positional rule only when
  the echo names no resolvable test. Guarded in `tests/client/test_cr088_failure_detail_names_its_leaf.py`
  (the rule plus the six declaration shapes) and `tests/client/test_cr087_console_failure_attribution.py`
  (`ForwardMarryingGuardTest`, which the CR promoted from a characterisation to a real assertion).

## Notes
- 🚀 **2026-08-19 — Crucible v2 SHIPPED its first public release (0.1.0 + hotfix 0.1.1).**
  `crucible-axi` on PyPI: **0.1.0** then **0.1.1** (OIDC trusted publishing, pending publisher
  auto-converted on first upload). `@anthill-tec/crucible-server` on npm: **0.1.1**
  (`--provenance`, signed to Sigstore). Lockstep from bare-SemVer tags via `release.sh finish`.
  Two release-day failures, both fixed and recorded in `RELEASING.md`: (1) npm `EOTP` — a
  write-enabled granular token enforces 2FA by DEFAULT (npm's late-2025 change), so it must be
  created with **Bypass 2FA checked** even though the account is authorization-only (the doc's old
  claim that auth-only + unchecked works was wrong). (2) npm `E422 "Failed to validate repository
  information"` — `package.json` had no `repository` field, which `--provenance` requires; hotfix
  0.1.1 added it. npm 0.1.0 never published (both failures preceded it), so npm starts at 0.1.1
  while PyPI has 0.1.0+0.1.1 — lockstep holds from here. **Remaining follow-up (optional, maintainer):**
  configure the npm OIDC trusted publisher now that the package exists, then delete `NPM_TOKEN` —
  the bypass token is a stopgap npm is deprecating. Model-B intimated (Sandesh msg 1354).
- ✅ **2026-08-18 (release-readiness — the "still pending setup" line is SUPERSEDED, verified against CI + repo).** The 2026-08-03 note below ("Remaining 0.1.0 gate items: … the `@anthill-tec` npm org (human prerequisite)") was stale and got re-quoted for weeks without anyone reading `release.yml`. Ground truth now: `release.yml` publishes PyPI + TestPyPI via **OIDC trusted publishing** (no token) and npm with `--provenance` (`NPM_TOKEN`-gated, skips only if absent); `gh` confirms the repo `anthill-tec/crucible` carries all three deploy environments (`pypi` · `testpypi` · `npm`) and both secrets (`NPM_TOKEN`, `RELEASE_PAT`, set 2026-08-13); the PyPI/TestPyPI trusted publishers are registered under Anthill (user-confirmed). **Nothing remains to SET UP.** The release is an execution step, not a setup gap: branch → no-mistakes → TestPyPI rehearsal (`workflow_dispatch`) → tag push → CI publishes → verify from the registries. The Model-B intimation is a post-release courtesy, never a publish prerequisite.
- 2026-08-18 (SCRUM filing) — **CR-CRU-065 filed** on user direction, carrying CR-CRU-064's C3
  recorded follow-up: the shared `no_report_warning` picks the LAST non-empty line as the cause,
  which is right for python/node and wrong for maven. Design call (mine, overrulable): an additive
  `cause=` override so SELECTION becomes per-stack while COMPOSITION (prefix, 500-char bound,
  never-empty) stays in the shared helper — a maven-shaped heuristic inside that helper would put
  stack knowledge in the one place that must stay stack-agnostic. Proposed 0.2.0, membership
  unconfirmed: mvn's envelope is CORRECT today (right code, right exit, a true line), just
  uninformative, so it is fidelity work rather than a shipping defect.
- 🚨 **2026-08-18 (CR-CRU-064 verification gap — CLOSED by measurement, recorded for the process
  rule it broke).** Its C4 cycle was committed as `test(cr-cru-064): C4 RED …` and ingested under
  `CR-CRU-064-C4-RED`, but it **never had a RED**: the commit is test-only (32 lines added to the
  existing bun fixture `tests/clients-python-arduino-crucible.test.ts`) and the behaviour it asserts
  had already shipped in **C2 (`ecf0fe5`)**, so the assertions passed on first execution. The board
  shows it: TWO ingests of 32/32 passing under a `-RED` id (also a run-spam breach of
  evidence-only-ingest — one final evidence run per contract file). **Mutation kill, run 2026-08-18
  to supply the missing evidence:** baseline `bun test tests/clients-python-arduino-crucible.test.ts`
  → 32 pass / 0 fail; with python `cmd_test`'s `_emit_axi` no-report call replaced by a bare stderr
  print → **1 fail** (`:1016`, the starved-toolchain test) / 31 pass; reverted → 32 pass, tree clean.
  So the C4 assertions are real guards and the delivery is sound — what was missing was PROOF, not
  value. Rule this establishes: **a test written after its production code cannot go RED.** Write it
  in the cycle that ships the behaviour, or label the cycle a BACKFILL and prove it with a mutation
  kill — never name it `-RED`.
- 2026-07-14 — Project kickoff: PRD + evidence DN landed. Kickoff design review (lavish)
  locked six decisions: A+B hybrid dashboard (Mission Control home + project workspace
  drill-in); TOON on agent-facing reads first; REST AXI + `crucible-axi` npx CLI; hybrid
  UI stack (VanJS/VanX + Tailwind 4 browser runtime + DaisyUI 5, forge as custom theme);
  clean v2 API at `/api/v2/*` with a thin v1 shim on legacy `/api/*` + client-fleet
  upgrade (shim retires post-migration). Plus: codec translation layer (canonical
  RunSchema, failure detail preserved), ingest-as-implicit-heartbeat, configurable
  liveness thresholds, tombstoned agents, server self-health, BDD harness (later wave).
  Persistence: bun:sqlite (skill-bundle portability); retention rollup.
- 2026-07-14 (later) — Q4 RE-DECIDED during storyboard review: **CR wave first** — no
  pre-built walking skeleton; implementation starts with specs + RED/GREEN/VERIFY
  dispatch per the orchestration flow.
- 2026-07-14 (storyboard close) — Design phase COMPLETE: navigation model approved;
  density verdicts (ideas 1–5, 7 in 0.1.0; filter bar post-0.1.0); run context
  {git, wave, orchestrator} all-optional/graceful; retention 100 + wave rollups; TOON
  subset pinned; BDD harness approved for a later wave. Spike code deleted from tree
  (vendor libs kept). **Queue filed (9 CRs, 4 waves) — specs only; Wave 1 dispatch
  awaits user go.** Post-0.1.0 backlog (not yet filed): filter bar, BDD harness +
  playwright/vitest/tap codecs, shim retirement, coverage-trend deep views.
- 2026-07-15 — Wave 1 executing. CR-CRU-001 shipped (VERIFY CONFIRMED, 12/12 ACs,
  49 tests, 100% fn / 97.6% ln coverage). Scope move at CR-CRU-002 gap-analysis:
  minimal `POST /api/ingest` + `POST /api/ingest/compile` routes move from CR-CRU-003
  into CR-CRU-002 (the codecs' production seam); CR-CRU-003 hardens them to the full
  DN quirk contract + remaining endpoints + contract tests. Deferred register:
  removeAgent no-op change-event (RESOLVED in 003); CLI-bootstrap smoke test (→ 009);
  dataPath-bypasses-registry (→ BDD wave codec interface); per-branch 400 assertions;
  dedicated v1→v2 cross-surface regression test.
- 2026-07-15 (Wave 2 close) — CR-CRU-004 + CR-CRU-005 shipped; 219 tests. WAVE-3-OPEN
  DECISION POINT (user-directed): reshape `eventBrief` (hoist summary scalars) so
  TOON's uniform-table form applies to events[] — measured ratio currently 105% of
  JSON for nested shape (DN-crucible-toon-subset §Measured token-ratio); decide
  together with the SPA's consumption of the same payload in CR-CRU-006/007.
- 2026-07-15 (design iteration, post CR-010) — board micro design iteration APPROVED
  (final round): agents render nested under their project everywhere (⌁ glyph, heat
  tint; tombstones too); workspace Agents tab dropped; home top bar simplified (logo +
  slogan + filter-by pulldown + health — no project chips); Projects-pane rows drill
  down to the workspace (never filter); `← projects` breadcrumb workspace-only. PRD
  §4.11 + nav model synced; the whole set folds into CR-CRU-007 (spec §S5, re-baselined
  same day). Process rule recorded: micro design iterations run between CRs on develop,
  no active feature flow.
- 2026-07-15 (design iteration rounds 8–11) — drill-in mode: tier-contextual default
  (regression/e2e → Density; focused cycle tiers → Detail) + manual override per tier
  group, never test-count; compile drill-ins carry no mode switch; compile reporting
  agent-agnostic. Terminology locked: RED→GREEN pair = Cycle, CR groups cycles, Wave
  groups CRs; marker labeled via additive `context.cycle` (fleet sends in CR-008).
  Round-11: workflow lens USER-SCHEDULED INTO v0.1.0 → CR-CRU-011 filed (Wave 4,
  before 009; 009 now depends on 011). Backwards audit of the agent API found the
  lifecycle gap (unregister hard-deletes firstSeen/lastSeen → runtime lost) — closed
  by CR-011 §S1 lifecycle events.
- 2026-07-15 (during CR-007 execution) — §S2 markers re-baselined to STREAK-based
  pairing (live view showed marker proliferation; declared plans supersede the
  heuristic in CR-011 — orchestrator todo-complete IS the boundary). Storyboard
  100%-compliance locked as the acceptance bar (fidelity batch running in C5).
  USER-APPROVED: post-0.1.0 this project shifts to the MULTI-TRACK model —
  0.2.0 = Wave 5 running CR-014 (track-1) ∥ CR-015 (track-2, BDD harness, filed
  with full ACs incl. the multi-track dog-food AC); CR-011's commit-boundary
  query added (closed plans expose mergeCommit + run-commit range).
- 2026-07-15 (design iteration rounds 25–31, close) — roles-vs-tool correction
  (`WORKFLOW_*` env vars; `CRUCIBLE_*` = tool config only); role hierarchy
  (Mainline Orchestrator → Orchestrator → RED/GREEN/VERIFY/FIX, authority follows
  scope); Model B in one sentence (actions by actors with roles); product
  definition locked (Crucible = the tracking system for the Model-B workflow);
  roadmap navigation resolved (/p/<key>/roadmap slide-over); nav map finalized.
  The whole ontology is consolidated in
  [DN-model-b-language.md](../research/DN-model-b-language.md) (user-directed,
  round 31 — "document so we don't lose context").
- 2026-07-15 (design iteration rounds 23–24) — milestones folded into CR-013
  (renamed "Workflow events: gates + milestones"): gap-analysis / design-review /
  stage-flip entries on the PROJECT WORKSPACE timeline only (home stays a
  cross-project run feed; compact gate entry is the exception). Execution roadmap
  (Wave→CR table, derived statuses PENDING/IN_PROGRESS/COMPLETED) user-scheduled
  to 0.2.0 → CR-CRU-014 filed now with the schema + a BINDING forward-compat
  contract on 0.1.0 (plans.cr = verbatim stable join key; queue table additive).
  Storyboard gained F13 (Workflow tab) + F14 (roadmap, 0.2.0-badged); F8/F11 tab
  rows show the Workflow tab.
- 2026-07-15 (design iteration rounds 16–22) — cycle kinds (verify/fix identical
  rules); tracks = numbered lanes, CR always within a track (plan `track`, auto from
  `WORKFLOW_ROLE`); containment hierarchy locked (Project → mainline
  [vidushi] → spawns track orchestrators; orchestrator = special agent); wave =
  sync boundary, no dedicated track UI, wave state inferred; no-mistakes runs at
  wave boundaries ingested as `gate` events → CR-CRU-013 filed (boundary card,
  gate drill-in, Workflow-tab no-mistakes pane, gate-report verb, `gated` wave
  state); CR-011 §S3 restructured to a dedicated Workflow tab (live per-CR todo
  view + gate pane, history lens below). Order: 007 → 011 → 008 → 012 → 013 → 009.
- 2026-07-15 (design iteration rounds 14–15) — CR-012 gained §S1b archive/unarchive
  (user: in 0.1.0). Cycle-plan API user-locked: orchestrator FILES the cycle plan
  (todo list) → server-assigned numeric cycle ids → agents attach `context.cycleId`;
  a cycle's span completes when the ORCHESTRATOR confirms the GREEN (`done`); the CR
  closes on feature MERGE (`closed` + commit); plan verbs encoded in the python/fleet
  clients (CR-008). Plan API folded into CR-011 (renamed "Cycle plans + workflow
  lens"; lens is plan-first, inferred fallback; planless projects unchanged).
  REORDERED: 011 before 008 → execution order 007 → 011 → 008 → 012 → 009.
- 2026-07-15 (design iteration round 13) — project activity rule locked: active while
  ≥1 live agent; inactive after the system-wide configurable timeout
  (`CRUCIBLE_PROJECT_INACTIVE_MS`, default 1 h) from last activity; v2 projects
  listing gains additive `active`+`lastActivity` (CR-007 §S5). Missing surface filed:
  CR-CRU-012 Projects manager (⚙ manage chip → /manage slide-over; add + edit
  name/type/sutRoot/liveness overrides/retention; key immutable; additive
  `PATCH /api/v2/projects/<key>`) — Wave 4 before 009; 009 depends on it. Storyboard
  gained frame F12.
- 2026-07-15 (post-merge review) — no-mistakes hardening landed on develop after the
  CR-CRU-006 merge: ingest parse/`dataPath` failures now return 400 `{ok:false, error}`
  on BOTH surfaces (v1 `/api/ingest` + v2 `/api/v2/runs`, shared `parseRunBody` core —
  never a plain-text 500); server binds loopback `127.0.0.1` by default (`CRUCIBLE_HOST`
  / `hostname` opt override); SPA guards against duplicate `EventSource` connections;
  retention fold+delete is one transaction; `Store.hasAgent` backs the v2 `changed`
  flags. CR-CRU-010's Context re-baselined (the `parseJunitPath` special-case now lives
  in `parseRunBody`, not `src/server.ts`/`src/v2.ts`).
- 2026-07-21 — CR-CRU-034 filed (P1 regression, Wave 4, before 030). Eyes-on the
  dog-food run detail (`crucible_drilldown.jpg`) surfaced a CR-CRU-029 regression:
  the run-detail drill-down kept its CR-CRU-007 §S4 item 4 inner `.app-tree-scroll`
  (`max-height:60vh`) while CR-029 made `pane-scroll` flex-fill the viewport — so a
  run with ≥2 failures traps the vertical scroll in a cramped inner box, leaves
  ~290px dead space below the footer, and (on shorter viewports) hides the footer.
  034 unifies the run-detail body onto CR-029's one-bounded-scroller-owns-both-axes
  model while PRESERVING CR-029's horizontal contract (user directive: the vertical
  fix must match the narrow-viewport horizontal requirement).
- 2026-07-21 (later) — CR-CRU-034 gap analysis (verdict SPEC_UPDATE_NEEDED): corrected
  provenance (the virtualized `tree-scroll`+60vh is CR-007 §S4 item 4, not CR-028 §S4.4;
  the footer-jump focus-model is CR-016 §S2, not CR-028 §S2) → Depends-on now 029/007/016/023;
  §S1 mechanism pinned (pane-scroll owns both axes, virtualization re-sources off pane-scroll);
  added a ≥2-failing-suites AC. Confirmed the fix completes CR-029 §S1's own mechanism (a) and
  scroll-restore already targets pane-scroll (§S2 stays green). Retarget contained to
  `density.test.ts` §S4 item 4 (no e2e coupling). Ready for feature branch + RED.
- 2026-07-21 (merge) — CR-CRU-034 shipped on develop (merge 8c2bdc0): pane-scroll is the
  run-detail body's sole bounded dual-axis scroller (60vh `.app-tree-scroll` trap retired;
  CR-007 §S4 virtualization re-sourced off pane-scroll via `handlePaneScroll` + per-suite
  offset windowing; covers home RunDetail + WorkspaceRunDetail); CR-029 horizontal contract
  preserved. VERIFY APPROVE; 979/979 unit · e2e 40/40 · lines 85.8% · tsc 0; cycles 81-82.
  Follow-up (VERIFY suggestion, non-blocking, NOT filed as a CR): `handlePaneScroll` runs an
  un-debounced `querySelectorAll('[data-testid="tree-scroll"]')` per scroll tick — harmless at
  realistic suite counts; revisit only if a run ever auto-expands dozens of failing suites.
- 2026-07-21 (CR-030 gap analysis + AXI expansion) — verdict SPEC_UPDATE_NEEDED (no
  blocker, no prerequisite CR — server routes for §S4/§S6/§S7 exist). Corrected framing:
  the net-new verbs (§S4 cycle-add, §S6 status/plans, §S7 checkpoint/stop/abort, §S8
  prefer-gate-run warning, §S9 auto-attach) + the AXI-CLI conventions are ABSENT even in
  the bun "reference" — built in a NEW shared module `clients/_crucible_axi.py` (the 5
  clients don't currently share code; user decision), bun reference first, then the other
  four; bun's own gaps fixed here too (user directive). Checked the fleet against the AXI
  manifesto (https://axi.md, 10 principles) — added §S10–§S15 for principles 2,3,4,5,6,8,9
  (minimal schemas/--fields, truncation/--full, aggregates+empty-states, structured
  errors on stdout+exit codes, content-first no-arg dashboard, help[] next-steps). Size
  re-estimated M–L → L. Principle 7 (ambient-context session hooks) SPLIT to CR-CRU-035,
  a coordinated Crucible↔Model-B effort: Crucible builds core python scripts (`setup` +
  interface contract) → intimates Model-B → Model-B owns hook templates + generation
  (shared responsibilities negotiated at handoff).
- 2026-07-23 (WAVE 4 CLOSE — every 0.1.0 CR is COMPLETED) — CR-CRU-009 shipped the
  release machinery (curl→uv→`crucible-axi install` staged installer, 8 skills conformed +
  new arduino skill, `crucible-server` bin shim, RUNBOOK, consolidated
  `.github/workflows/release.yml` with PyPI OIDC + Test-PyPI dry-run + npm provenance).
  Its close-out gate then exposed TWO silent Python-gate defects, filed and shipped as
  patches the same day: **CR-CRU-039** — `regression` discovered 0 tests (all tests live
  under `tests/client/`, which was not a package, so `discover -s tests` never recursed);
  a zero-discovery run was misreported as a "compile" ingest. Fixed by making the suite
  discoverable + emitting a definitive `no-tests-discovered` AXI error instead of a false
  green. **CR-CRU-040** — even once running, coverage was unobtainable: `coverage.py` was
  not a declared/installed dev dependency and `--cov-source` defaulted to a nonexistent
  `app` package. Fixed by declaring the `dev` extra and defaulting the source to
  `crucible_axi,clients` (both `regression` and `pre-merge-gate`); the obsolete
  `PYTHONSAFEPATH=1` guard was dropped since it leaked into grandchild test subprocesses.
  Net: the Python close-out gate went from silently running NOTHING to 382 tests with
  real coverage-on-green.
  **The 0.1.0 RELEASE CEREMONY is NOT started** — it is a distinct, human-gated phase
  (CR-009 §S6: release branch → no-mistakes gate + QC → version 0.1.0 → tag → CI publish,
  Test PyPI first; also requires open-sourcing the repo + publish credentials). It must
  never be inferred from a CR completing; it needs its own explicit go.

- 2026-07-28 (CR-CRU-050 gap analysis) — verdict SPEC_UPDATE_NEEDED; no prerequisite CR. Two
  material corrections. **(1) The CR reuses `pending`, it does not add `skipped`.** PRD:121 fixes
  `summary {total, passed, failed, pending, duration_ms}` and PRD:179 already mandates the mapping
  verbatim — *"skipped → pending"*. It is implemented end to end (`types.ts:49/55/66`,
  `store.ts:299/1014/1065`) and rendered end to end (`app.js:3324/3310/3251/3347/3026`), and
  `mvn-crucible.py:641` already populates it correctly. The draft's new `skipped` field would have
  forked terminology against the PRD, the DB column, the dashboard and the one correct client.
  **(2) Scope is four clients across five parse sites, not one** — bun `:506`, python `:518`,
  arduino `:357`, rust `:762` AND `:1306`; all hardcode `"pending": 0`. Added §S1b: the tree LEAF
  status is wrong too (a skipped test is emitted as `"pass"`, so the drill-in paints it green) —
  count-only ACs would pass while the visible defect remained. §S4 closed as already-decided: no
  server/schema/UI work is in scope. Reproduced live from artifacts in the tree: bun `junit.xml`
  `tests="1061" skipped="1"` ingested as `passed=1061`, and a python report `tests="2" skipped="2"`
  (an entire class where nothing ran) ingested as `passed=2` — so this project's own published
  gate figures are inflated, the failure mode CR-039/CR-047 exist to prevent.
- 2026-08-02 (**STRATEGY CHANGE — user decision**) — **the SERVER and CLIENT packages are
  INSTALLED TOGETHER by uv: one operation, one version.** Wording precision (user-corrected):
  "bundled" does NOT mean a single merged artifact — the **server stays a bun/npm package**
  (`@anthill-tec/crucible-server`), the **client stays a Python/PyPI package** (`crucible-axi`,
  carrying the `*-crucible.py` fleet). Two registries, two natures, ONE version-locked install,
  deployable at local scope. The CR-CRU-041 composite-lockstep machinery (one `vX.Y.Z` tag,
  `crucible-axi` pinning `@anthill-tec/crucible-server@<version>`) is therefore promoted from a
  packaging detail to the PRIMARY delivery model. Rationale: the client↔server contract is ONE
  contract — "they're closely matched" — so installing the halves separately invites the version
  skew this project keeps paying for. **Model-B owns the SKILLS only** (the skills that reference
  Crucible's capabilities); they no longer bundle our client scripts. **Intimation cadence: ONCE
  PER RELEASE, after that release's CRs are complete** — never per client change, and no CR merge
  is gated on Model-B reachability. Supersedes the per-change intimation timing recorded on
  2026-07-28; the accumulated owed-items list becomes the CONTENT of that single release
  intimation.
- 2026-08-02 (CR-CRU-051 C2 finding — **FILED as CR-CRU-058** on user direction; the follow-up
  audit widened it from two verbs to NINE, including `pre-merge-gate`) — two rust verbs emit no
  TOON-AXI envelope at all.** `regression-ingest` and `workspace-regression` print a bare
  `print(f"regression: ok=…")` and never call `_emit_axi`/`_emit_ingest_axi`, so an agent consuming
  their stdout gets no structured envelope, no `help[]`, no `context` — the AXI contract CR-CRU-030
  established fleet-wide. `workspace-regression` is the PRE-MERGE-GATE path, so this is the gate
  output an orchestrator reads. Found while measuring where `files` could go (CR-051 §S3); NOT
  absorbed there — adding envelopes to two verbs is AXI-compliance scope (CR-030 lineage), not
  count-parity scope.
- 2026-08-02 (CR-CRU-054 C4 finding — deferred, needs scheduling) — **the server does not validate
  `identity.source` on agent registration.** The clients document `--source
  {claude-md,package-json,git-repo,manual}`, yet rust/mvn/arduino hardcoded `"openclaw"` — a value
  outside that enum — at five sites, and the server stored it without complaint. CR-054 fixes the
  CLIENT half (all five now send `claude-md`); the server-side validation gap is a different stack
  and contract, deliberately NOT absorbed into a client-refactor CR. Same class as the CR-044 phase
  enum, which the server DOES validate — this field simply never got the same treatment.
- 🚨 **2026-08-13 (CR-CRU-063 — the first real CI push) — TWO FOLLOW-UPS FILED HERE, NOT DELIVERED.**
  CR-CRU-062's carry-forward item 1 fired on the first push of `develop` and CI came back RED
  (run 31677479804: `test-bun` 102 fail + 4 err, `test-python` 673 discovered / 7 fail / 2 err).
  Root cause was provisioning — the jobs installed no project toolchain — and CR-CRU-063 fixed it
  (`uv` on both client-driving jobs; `unittest-xml-reporting` added to the `dev` extra, which was
  declared NOWHERE despite `python-crucible.py:442` shelling out to `python -m xmlrunner` for every
  `test`/`regression`/`pre-merge-gate`; it only ever passed locally via user site-packages). Two
  items were deliberately NOT absorbed:
  **(a) the no-XML fallback emits no envelope — a real CR-CRU-030 §S1 breach.**
  `python-crucible.py:682-685` and `_regression_run` `:761-765` (and the same shape at
  `bun-crucible.py:796-803`) `_ingest_compile` and return, printing to stderr only: an agent with a
  missing toolchain gets an exit code and nothing machine-readable. Fleet-wide across all five
  clients ⇒ needs a RED-first CR (CR-030/058 lineage), with the census / stdout-purity suites
  extended to drive a toolchain-starved interpreter. Measured during CR-063 C3: fixing it would have
  greened 2 of the 5 residual tests (`test_toolchain_verb_envelopes.py:430`, `:514`) but for the
  wrong reason, leaving three red — so it is a separate defect, not this CR's fix.
  **(b) `test_docker_e2e_gate_emits_envelope_with_run_block` depends on AMBIENT FREE DISK.**
  `test_toolchain_verb_envelopes.py:284` drives `docker-e2e-gate` with no `--min-free-g`, unlike its
  rust siblings at `:480`/`:483`/`:490`/`:493`, so it inherits `rust-crucible.py:2180`'s **80 GB**
  floor (guard `:1331`). It failed on the baseline run with `disk-guard-abort` and went green later
  only because those runners had the space. It now sits inside a `needs:`-wired, publish-blocking
  gate: a busier runner re-reds `test-python` and blocks a release for a reason unrelated to any CR.
  **Release-setup learnings from the same day** (all now corrected in `RELEASING.md`): classic npm
  tokens no longer exist (granular only, since Nov 2025); environment protection rules need a public
  repo or a paid plan; and `npm publish --provenance` REQUIRES a public repo — a latent release-day
  failure that nobody had listed, silently fixed when the repo was made public.
- 2026-08-14 (SCRUM filing) — **CR-CRU-063's two follow-ups are now CR-CRU-064**, filed together
  because both land in `tests/client/test_toolchain_verb_envelopes.py` and both block the same
  publish-wired gate. Re-measured on `develop` `f7f826d` before filing: the envelope-less no-report
  branch is **seven sites, not the three CR-063 named** — `python-crucible.py:682-685` / `:761-765` /
  `:787-790`, `bun-crucible.py:796-803` / `:852-855`, `arduino-crucible.py:505-507` / `:659-662`.
  Two of them are the bodies `pre-merge-gate` runs as its regression step (bun `cmd_regression`,
  python `_regression_run`), so the merge-decision verb is exactly what goes silent on a starved
  toolchain. rust (`_no_junit_help:360`) and mvn (inlined in `_emit_compile_fallback_axi:894` — no
  named helper; the `"no-test-reports"` literal has exactly one occurrence fleet-wide) already emit
  and are DUPLICATES of one concept — CR-064 lifts one `no_report_help`/`no_report_warning` pair into
  `_crucible_axi.py` (CR-054 drift class); rust's local helper is deleted, mvn's emitter survives as a
  thin caller.
  🚨 **User-decided 2026-08-14: CR-CRU-064 is a 0.1.0 PREREQUISITE, above the release boundary** —
  0.1.0 is what puts these clients in users' hands, where an incomplete toolchain is the NORMAL
  first-run state, so an envelope-less exit is a shipping defect, not a follow-up. The boundary's
  "every prerequisite closed" no longer holds until CR-064 merges. (My filing put it below the
  boundary with membership unassigned — wrong; membership was the user's to decide and the answer
  is 0.1.0.)
- ✅ **2026-08-03 (CR-CRU-060 close) — THE E2E RELEASE-GATE ITEM IS CLOSED. Zero items remain.**
  The re-baseline the entry below anticipated is done, and the outcome was better than forecast.
  Fixing the identity drift took the suite from **19 failed / 11 passed / 10 blocked** to
  **40 passed / 0 failed / 0 blocked** — independently re-run twice (orchestrator and VERIFY),
  57.2s, with the 10 previously-blocked scenarios confirmed to genuinely EXECUTE (real varied
  durations, not skip-stubs) rather than being reported green while skipped.
  **ZERO genuine product defects were hiding behind the drift.** The forecast below said the
  inventory might GROW once the 19 stopped cascading, because those 10 had never been measured in
  the project's history. They ran for the first time and all passed. There is no defect list to
  enumerate — §S5's deliverable is this sentence.
  Nothing under `src/` was touched: `requireRegisteredCaller` is byte-identical to develop. The
  server guard was correct the whole time; only the harness was stale.
  **Remaining 0.1.0 gate items: the single per-release Model-B intimation, and the `@anthill-tec`
  npm org (human prerequisite). No e2e item.**
- 🚨 **2026-08-03 (CR-CRU-052) — THE "THREE E2E FAILURES" ITEM BELOW IS REFUTED. Read this first.**
  That count was measured against a POLLUTED database. CR-CRU-052 found that every default e2e run
  since CR-CRU-043 had been writing to `~/.local/share/crucible/crucible.db` (79 projects / 259
  events of accumulated fixtures), because `resolveDbPath` falls through a `mkdtempSync` scratch cwd
  to the user-level path. Different scenarios failed for different residue reasons on each run;
  "three" was noise. **On a genuinely isolated DB it is 19 failed / 11 passed / 10 blocked**,
  reproduced three times and confirmed independently by CR-052's VERIFY. All 19 share ONE cause —
  the harness predates the registered-caller hard stop (`filePlan` sends no `agentId`; the ingest
  helpers send unregistered ones), so `requireRegisteredCaller` correctly refuses them. **Zero UI or
  layout assertions fail.** The `workspace-plan-scoping`/CR-026 attribution below was therefore also
  wrong. Filed as **CR-CRU-060**; the release gate re-baselines when it lands, and the 10 blocked
  scenarios have never been measured, so the inventory may grow.
- ~~2026-08-02 (user scheduling decision)~~ — **SUPERSEDED, see above.** ~~the THREE pre-existing
  e2e failures (`workspace-plan-scoping.feature`, CR-CRU-026 §S0 family, `toBeVisible`;
  baseline-proven on develop, independent of CR-046/055/056) are deferred until the current Wave-4
  CR queue is complete, and fixed BEFORE the 0.1.0 release.~~ The DEFERRAL decision stands (it is a
  release-gate item, not a merge gate); only the COUNT and the ATTRIBUTION were wrong. They are a release-gate item, not a
  merge-gate item for the CRs in flight. Model-B intimation for the CR-044/046/056 client-surface
  changes is likewise **held until their Sandesh address is active** (it has been inactive all
  session); the owed set is queued in project memory.
- 2026-08-01 (CR-CRU-046 close) — deferred register: **(a)** rust stdout-purity siblings —
  `cmd_clippy` (`clients/rust-crucible.py:994`) and the coverage/regression verb (`:1288`) still
  print `[crucible] running:` to stdout (the `cmd_test` instance was fixed in-CR after the strict
  conformant decoder exposed it; no failing test covers these two yet — candidates for CR-CRU-054's
  DRY sweep or a micro-patch). **(b)** compile-ingest events carry no `cycleId` (silent
  non-attachment) — input for CR-CRU-056's §S2 auto-attach-consumer enumeration. **(c)** ~~THREE pre-existing e2e failures on develop~~ — **SUPERSEDED 2026-08-03: the count and the
  attribution were both artefacts of the polluted user-level DB; the real figure is 19, one cause,
  now CR-CRU-060. See the top of these Notes.**
- 2026-07-28 (CR-CRU-045 §S3 — **cross-stack gate rule for the client fleet**) — a change to
  `clients/*-crucible.py` requires **BOTH** the Python gate and the bun gate before close-out.
  Those clients are Python programs whose observable contract is asserted by **bun** tests
  (`tests/clients-*.test.ts` drive them as subprocesses against a real server), so a
  single-stack gate is not sufficient evidence for a client change. CR-CRU-040 gated on Python
  only (382/0) and left `tests/clients-python-arduino-crucible.test.ts` red; that went
  unnoticed until the CR-CRU-041 C1 orchestrator gate several CRs later. The same lineage had
  already produced CR-039 (regression discovered 0 tests) and CR-040 (coverage unobtainable) —
  each caught by the NEXT CR's gate rather than its own. Run both gates.
