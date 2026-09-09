# Crucible — CR Queue

Single source of truth for implementation scheduling. Pick the next `PENDING` row by
phase + dependency order. Conventions: `~/.claude/memory/cr-prd-dn-conventions.md`.

**Design contract:** [../research/PRD-crucible-v2.md](../research/PRD-crucible-v2.md)
**Evidence base:** [../research/DN-crucible-api-reconstruction.md](../research/DN-crucible-api-reconstruction.md)
**Target release:** 0.2.0

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
| [CR-CRU-015](CR-CRU-015-bdd-harness.md) | BDD harness: Crucible executes Playwright for frontend projects | feature | PENDING | 004, 007 | 7 (post-0.2.0) |
| [CR-CRU-017](CR-CRU-017-run-lifecycle.md) | Run lifecycle: start/end events + the Aborted state | feature | COMPLETED (0.2.0) | 008, 011 | 5 (0.2.0) |
| [CR-CRU-018](CR-CRU-018-responsive-mobile.md) | Responsive Crucible: mobile + tablet media support | feature | PENDING | 016, 093 | 7 (post-0.2.0) |
| [CR-CRU-022](CR-CRU-022-roadmap-analytics.md) | Roadmap analytics: velocity + burndown + forecast | feature | PENDING | 011, 014, 091 | 7 (post-0.2.0) |
| [CR-CRU-098](CR-CRU-098-the-plan-pointer-has-no-publisher.md) | the plan pointer has no publisher | feature | PENDING (post-0.2.0) | 095 | 7 (post-0.2.0) |
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
| [CR-CRU-097](CR-CRU-097-project-independence-is-not-asserted.md) | project independence is claimed but never asserted | patch | COMPLETED (0.2.0) | — | 5 (0.2.0) |
| [CR-CRU-099](CR-CRU-099-a-declared-release-is-dropped-on-queue-post.md) | a declared release is dropped on queue post | bug | COMPLETED (0.2.0) | — | 5 (0.2.0) |
| [CR-CRU-100](CR-CRU-100-a-test-asserts-an-invariant-over-live-data.md) | a test asserts an invariant over live data | bug | COMPLETED (0.2.0) | — | 5 (0.2.0) |
| [CR-CRU-101](CR-CRU-101-suite-integrity-contradicts-scoped-runs.md) | the suite-integrity corroboration contradicts scoped runs | bug | COMPLETED (0.2.0) | — | 5 (0.2.0) |
| [CR-CRU-102](CR-CRU-102-dependency-annotations-return-to-the-designs-bare-form.md) | dependency annotations return to the design's bare form | patch | COMPLETED (0.2.0) | — | 5 (0.2.0) |
| [CR-CRU-103](CR-CRU-103-the-delivered-card-and-the-spine-terminals.md) | the delivered summary card and the spine's terminals follow the design | patch | COMPLETED (0.2.0) | 102 | 5 (0.2.0) |
| [CR-CRU-104](CR-CRU-104-one-membership-rule-two-entry-points.md) | release membership has one rule, not one per entry point | bugfix | COMPLETED (0.2.0) | 099 | 5 (0.2.0) |
| [CR-CRU-106](CR-CRU-106-a-dependency-is-declared-by-its-own-verb.md) | a dependency is declared by its own verb | feature | COMPLETED (0.2.0) | — | 5 (0.2.0) |
| [CR-CRU-107](CR-CRU-107-a-cycle-label-list-refuses-the-wrong-delimiter.md) | a cycle plan is filed one label per flag | bug | COMPLETED (0.2.0) | — | 5 (0.2.0) |
| [CR-CRU-105](CR-CRU-105-the-e2e-scenario-declares-through-the-approved-verb.md) | the e2e scenario declares membership through the approved verb | bug | COMPLETED (0.2.0) | — | 5 (0.2.0) |
| [CR-CRU-079](CR-CRU-079-roadmap-deep-link-and-drill-through.md) | roadmap deep-link parity and active-CR drill-through | feature | COMPLETED (0.2.0) | 078 | 5 (0.2.0) |
| [CR-CRU-085](CR-CRU-085-roadmap-multi-track-lanes.md) | multi-track swimlanes inside a wave | feature | COMPLETED (0.2.0) | 078 | 5 (0.2.0) |
| [CR-CRU-093](CR-CRU-093-project-rail-collapses.md) | the project rail collapses, giving every workspace view its width back | feature | COMPLETED (0.2.0) | 006 | 5 (0.2.0) |
| [CR-CRU-075](CR-CRU-075-queue-file-fleet-parity.md) | queue-file fleet parity + AXI verb-surface census enforcement | patch | COMPLETED (0.2.0) | 014, 091, 092, 095 | 5 (0.2.0) |
| [CR-CRU-094](CR-CRU-094-agent-participation-is-recorded.md) | agent participation is recorded, not inferred | feature | COMPLETED (0.2.0) | 056 | 5 (0.2.0) |
| [CR-CRU-108](CR-CRU-108-one-published-track-fact.md) | one published multi-track fact | patch | COMPLETED (0.2.0) | 085, 092, 097 | 5 (0.2.0) |
| [CR-CRU-109](CR-CRU-109-a-wave-row-annotation-fits-its-box.md) | a wave row's dependency annotation fits the box it is drawn in | patch | COMPLETED (0.2.0) | 096, 102 | 5 (0.2.0) |
| [CR-CRU-110](CR-CRU-110-the-printed-help-test-cannot-be-starved.md) | the printed-help test answers the same way whatever ran before it | bug | COMPLETED (0.2.0) | 097 | 5 (0.2.0) |
| [CR-CRU-111](CR-CRU-111-the-client-can-say-which-tier-it-ran.md) | the client can say which tier it ran | feature | COMPLETED (0.2.0) | 016, 075 | 5 (0.2.0) |
| [CR-CRU-112](CR-CRU-112-the-gate-covers-every-declared-suite.md) | the gate covers every declared suite | patch | COMPLETED (0.2.0) | 047, 111 | 5 (0.2.0) |
| [CR-CRU-116](CR-CRU-116-only-one-wave-is-active.md) | only one wave is active, and Crucible refuses the alternative | feature | COMPLETED (0.2.0) | 091, 104 | 6 (0.2.0) |
| [CR-CRU-114](CR-CRU-114-the-lane-knows-its-release-and-wave.md) | the lane knows its release and wave | feature | COMPLETED (0.2.0) | 091, 092, 116 | 6 (0.2.0) |
| [CR-CRU-115](CR-CRU-115-a-gate-names-the-release-it-gates.md) | a gate names the release it gates, and never seals a run that is still going | bugfix | PENDING (0.2.0) | 013, 073 | 6 (0.2.0) |
| [CR-CRU-117](CR-CRU-117-an-in-flight-gate-is-not-a-seal.md) | an in-flight gate is not a seal | bugfix | PENDING | 013, 115 | 6 |

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

- **CLOSED by CR-CRU-099 (2026-09-03) — CR-CRU-091's unreachable store surface is now wired.**
  The note read: *"`QueueEntryInput.release` / `.track` / `.lifecycle` are unreachable from every
  route: `handleQueuePost` forwards only `cr/title/wave/dependsOn/size/seq`, and the five new routes
  go through `upsertQueueEntry` / `sequenceQueueWave` / `setQueueLifecycle` rather than
  `replaceQueue` … the write side of them is dead until something wires it."* CR-CRU-099 §S1 wired
  all three through `handleQueuePost`, so `replaceQueue`'s `track` normalisation and its
  `entry.lifecycle` branch now have wire coverage, and both refusals are asserted at the route
  (AC4a, AC4b). The note's `src/v2.ts:1848-1859` citation was also stale before it closed — a
  seventh instance of citation drift, and the reason the closing text quotes itself rather than
  pointing at a line.
  **What was NOT a defect stays recorded**: the surface was deliberate. CR-CRU-091 §S8 called the
  per-entry `seq` *"the one wire addition beyond the five-route table"*, so this is a boundary
  MOVED by a later requirement (CR-CRU-078 rewrote the e2e scenario to declare a release through
  that route), not an oversight repaired.

- **An AC may not require editing a shipped CR — and one did** (recorded 2026-09-03, CR-CRU-099
  cycle 322 VERIFY). CR-CRU-099 AC8 was written as *"the ACs that cite the e2e suite as in-cycle
  corroboration are corrected"*. Those ACs are CR-CRU-096 AC28 / AC28a, and 096 is SHIPPED, so the
  AC demanded breaking the standing rule that an implemented CR is never edited. VERIFY found it
  **unperformed**, and the honest reason is that it was **unperformable as written**. Reworded to
  discharge on the recording surfaces the rule allows (the fixing CR's own scope section, a
  line-cited reference, and this register). **The check to run when writing an AC:** does satisfying
  it require a commit to a CR that has already shipped? If yes, the AC is aimed at the wrong
  artifact. Adjacent to CR-CRU-094's lesson that a record must survive its author, this one is that
  a record must not be REWRITTEN by a later author either.

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

- **`GET …/queue` takes ~1.4 s for 108 entries** (candidate patch CR, measured 2026-09-07).
  Measured post-CR-108 as a smoke test, then A/B'd against `5c73302` (pre-CR-108 `develop`) on the
  SAME `crucible.db` with a second server on :3851: **1.53 / 1.40 / 1.44 s before, 1.53 / 1.40 /
  1.43 s after** — byte-identical timing, and the payload grows by exactly the 10 bytes of the new
  `tracks` field, so CR-CRU-108 is NOT the cause and `declaredTracks` (one O(n) pass over an
  in-memory array) cannot be. The slowness is pre-existing and unattributed: 21 KB for 108 rows
  should not cost 1.4 s, so the suspicion is per-row derivation inside `listQueue`/`deriveQueueStatus`
  rather than the read itself. Also recorded because it produced a false alarm worth not repeating:
  the first readings after a board restart were **7.6 / 12.8 / 11.1 s** under machine contention,
  which reads exactly like a regression until it is A/B'd against the parent commit. A latency
  claim needs the same discipline as a count: measure both sides, on the same data, when the
  machine is quiet.

- **~41 `src/store.ts:<line>` citations were ALREADY stale before CR-CRU-108** (candidate patch CR,
  measured 2026-09-07). CR-CRU-108's VERIFY reported "103 citations that were accurate on develop
  now point 25 lines short" after §S1 inserted 25 lines at `src/store.ts:364-388`. That figure did
  not survive a per-citation check: line-content equality is uninformative in the tail, because
  `head[k] == develop[k-25]` for every k ≥ 389 BY CONSTRUCTION, so a mechanical "+25 shift" test
  reports a false positive for the whole tail. Re-measured by locating the construct each citation
  NAMES: exactly **one** was accurate on develop and shifted (`tests/queue-canonical-order.test.ts:59`,
  365 → 390, re-pinned), one was already re-pinned correctly (`clients/_crucible_axi.py:1418`,
  4073 → 4098), 14 cite lines below the insertion and are unaffected, and **41 cite a line that did
  not hold the named construct on develop either** — most by hundreds of lines (`store.ts` has grown
  ~1000 lines since much of that prose was written): e.g. `tests/queue-registration.test.ts:719`
  cites `deriveQueueStatus` at `:3052` where develop holds `const id = this.nextCycleId(…)`, 1021
  lines off; `public/app-logic.mjs:1243` cites `waveNumber` at `:411`, 14 off. Spot-checked both
  independently against `git show develop:src/store.ts`. A blanket `+25` would have INVENTED 41 new
  wrong numbers, which is why the ruling was per-construct verification and why the 41 were reported
  rather than touched. The lesson generalises: a citation guard that compares line CONTENT cannot
  distinguish "shifted by my edit" from "stale for a year", and only the named-construct check can.

- 2026-09-07 — **a cycle can legitimately have no GREEN phase.** CR-CRU-108's §S3 (cycle 371, AC6
  cross-surface predicate + AC7 scope guards) landed as declared pass-on-arrival guards, because
  §S1 and §S2 had already removed the divergence they measure — the four-vs-two track disagreement
  lived in the python client's copy of the rule, which §S2 deleted. Non-vacuity was proven by
  MUTATION rather than argued: stripping the server's `.trim()` fails exactly 3 tests, stripping the
  browser's fails 3, and mutating both in step still fails 3 (the per-case classification is spelled
  in the fixture); swapping the table column to project scope fails exactly the new AC7 arm and no
  pre-existing lane test. Re-verified independently by the orchestrator before acceptance. Recorded
  on the board as a custom milestone, not manufactured into a fake red — the same disposition
  CR-CRU-075's cycle 364 took.

- 2026-09-07 — **RELEASE-TIME OBLIGATION: intimate Model B of this release's client changes.** Two
  notes are drafted and undelivered because `Mainline - ModelB` has been `inactive` in the Sandesh
  addressbook since 2026-08-27 (`sandesh send` refuses an inactive recipient). User direction: send
  them at RELEASE, not per CR. (1) CR-CRU-075's AC7 — `queue-file` is now a fleet-wide client verb
  through a shared registrar. (2) CR-CRU-107 — `plan-file` takes a repeatable `--cycle`, plus the
  drift in the Model-B-owned bundled skills measured 2026-09-07: all five `crucible-report-<stack>`
  bundles still say `--phase` (renamed `--role` fleet-wide by CR-CRU-059, clean break, so their
  register line fails as written) and `crucible-report-vscode` still teaches the server-side
  auto-attach that CR-CRU-056 §S3 deleted. Also worth carrying: `lastClosedCr` (was `lastRunCr`),
  and the `no-cycle` pre-flight warning. The release CR owns delivery.

- 2026-09-07 — **`plan-backfill` is not fleet-wide** (candidate patch CR, measured while updating the
  `crucible` skill after CR-CRU-107 shipped). The verb exists on `bun`, `python` and `rust` only;
  `mvn` and `arduino` do not expose it, so on those two stacks a plan filed with no wave must be
  re-filed rather than backfilled. Same defect class `queue-file` had before CR-CRU-075 — and
  **CR-075's derived registrar-parity check does NOT catch it**, because `plan-backfill` is
  hand-rolled in each client's own `main()` rather than registered through a shared registrar in
  `clients/_crucible_axi.py`. The derived rule only sees registrar-registered verbs, which is the
  honest limit of what it guards; closing this one means either adding `add_plan_backfill_verb` and
  wiring five clients (CR-075's shape) or accepting the two-stack gap deliberately.

- 2026-09-07 — **the pre-merge gate does not run the python client suites at all** (candidate patch
  CR, found executing CR-CRU-094). `pre-merge-gate` is `check` (tsc) → `regression --coverage`, and
  `regression` is `bun test` — which collects `tests/**/*.test.ts`. The **65 files in
  `tests/client/*.py`** (1,300+ tests: the whole five-client fleet surface, every AXI envelope
  assertion, the citation guards) are collected by NOTHING the gate runs. Consequences measured
  today, both on `develop`: (1) `tests/client/test_cr092_next_decision_resolver.py` was **already
  failing on `develop`** — verified in a throwaway `develop` worktree — with a drifted
  `LANDED_STATUSES` citation into `src/store.ts:3961`, and three green gates have passed over it
  since, because the gate never collected the file; (2) CR-CRU-094 is a client-heavy CR whose entire
  §S3/§S4 surface is python, so every one of its counts had to be measured by hand, per suite, by
  the orchestrator and its agents — the gate would have reported 2156/0 with the client fleet
  untouched. The bun-side equivalent (`bun test` finding a broken TS suite) is guarded; the python
  side is not, on the stack that ships to PyPI. Fix is a gate step, not a new harness: the python
  fleet already has a runner (`python-crucible.py regression`, which ingests) — the gate should
  chain it, or `pre-merge-gate` should refuse to claim a verdict it did not measure. Note the
  asymmetry is invisible from the envelope: the gate prints `files: 152` and says nothing about the
  65 it never looked at.

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

- 2026-09-03 — **an out-of-order `cycle-activate` prescribes a transition no client can perform.**
  `cycle-activate 319` on a plan with 316 still pending refuses with
  `help[]: ["activate cycle 316 first — cycles activate in ascending order", "or transition cycle
  316 pending→skipped, then retry this activation"]`. The second instruction is unreachable from the
  fleet: `cycle-done` takes only a cycle id and `--agent` (no `--status`), and `abort` targets
  PLANS, so no client exposes a pending→skipped transition. The refusal is correct and its first
  instruction works; the second names an operation that exists only server-side, if at all. Same
  family as CR-CRU-099 AC6 — a message citing a consumer that cannot corroborate it. Candidate
  patch CR; worked around by folding the out-of-order cycle's content into an earlier cycle and
  recording the label offset.

- 2026-09-03 — **`python-crucible.py test` emits no `runId`; `bun-crucible.py` does.** Found by
  CR-CRU-097's C1 agent, which could report bun run ids and could not report python ones:
  `runId` has ZERO hits in `clients/python-crucible.py`, while the bun client prints it per
  CR-CRU-017's run lifecycle. A python-stack ingest is therefore identifiable only by
  `agentId` + `cycleId` + its pass/fail shape, so no report, brief or commit message can cite a
  python run by id — and the orchestrator cannot verify a claimed python run at all. Adjacent to
  CR-CRU-094 (participation recorded, not inferred) but distinct: that CR is about the agent/cycle
  binding, this is about the run's own identity being unpublished on one stack of five.

- 2026-09-06 — **FILED as [CR-CRU-109](CR-CRU-109-a-wave-row-annotation-fits-its-box.md) (user-directed,
  filed immediately rather than held for the SCRUM):
  a wave row's dependency annotation has no bound, so the wave box overflows the design's ~300px on
  real data.** Measured on the live board while CR-093 was in flight: the box holds **332.4px**
  against `BUDGET.wave = 300` (`tests/roadmap-visual-grammar.test.ts`, CR-CRU-096 AC20/AC4's
  live-board probe), because `CR-CRU-075` renders `pending next · deps 014, 091, 092, 095` — the
  first row ever to carry the `next` marker AND a four-dependency list. Isolated by experiment: the
  pre-CR-085 tree fails identically at 333px with the same board, so no shipped code caused it; the
  trigger was execution state (activating CR-093's plan moved `next` onto the four-dep row).
  **Approved remedy — cap the COUNT, do not widen the budget** (widening postpones it: one more
  declared dependency overflows any new figure). The row states the first **TWO** bare ids then a
  remainder count (`deps 014, 091 +2`), the remainder being a count and never an ellipsis;
  `entry.dependsOn` keeps every full id (CR-CRU-102 AC3 — display-only), and zone 3's `deps` column
  still states the whole set.
  **Corrected 2026-09-07 — the cap is TWO, not three.** This entry first recorded the approved
  remedy as three ids, which the gap analysis then refuted by measurement: injecting each candidate
  into the running board's own DOM read the wave box at **332.4px** uncapped, **321.0px** at a
  three-id cap (STILL over the ~300px budget) and **292.5px** at two — so three would have shipped
  the CR without fixing the failure it exists to fix. Two is also what the approved artifact draws
  (`deps 091, 092`). The shipped constant is `DEPENDENCY_ANNOTATION_CAP = 2`
  (`public/app-logic.mjs`), and the live box now measures **293.1px**. The ruling, the table and the
  supersessions live in CR-CRU-109 §S1; this log carries the number so a reader who stops here is
  not told the rejected one. *Found by CR-CRU-109's VERIFY, which read this log against the spec.*
  **It is a NEW CR, not a change to 096 — correcting an orchestrator suggestion made 2026-09-06.**
  The orchestrator proposed "folding it into CR-CRU-096's lineage"; that was wrong and the user
  caught it. `CR-CRU-096` is **COMPLETED (0.2.0), shipped 2026-09-03**, and the standing rule
  recorded below from CR-CRU-099's cycle 322 VERIFY is explicit: an AC may not require editing a
  shipped CR. The new CR therefore CITES 096 and 102 as lineage and edits neither: 096 set the
  budget and owns the probe that measures it; CR-CRU-102 bounded each id's LENGTH while its own
  comment says "this is the ONLY thing that abbreviates", leaving the COUNT unbounded — a
  contradiction legible from the two specs with no test run.
  Recorded in the `gap-analysis` skill as Dimension 3's bounded-surface check so the next one is
  caught at design time rather than by a RED agent mid-implementation.

- 2026-09-06 — **FILED as CR-CRU-108 §S4, SPLIT OUT 2026-09-07 to
  [CR-CRU-110](CR-CRU-110-the-printed-help-test-cannot-be-starved.md)
  (user-directed at the SCRUM after CR-CRU-085 merged) — `CR-CRU-097 §S2/AC2`'s printed-help test
  HANGS when the Chromium suite runs before it in the same bun process.**
  `tests/project-namespace-tripwire.test.ts:626` drives every client verb's `--help` for real —
  **168** surfaces (5 root + 163 verbs, re-measured 2026-09-08) behind a 180 s cap. Standalone it
  takes **3.1 s**; run as
  `bun test tests/roadmap-visual-grammar.test.ts tests/project-namespace-tripwire.test.ts` it hits
  the cap exactly (180002 ms) and nothing else in either file changes timing. **Pre-existing, not
  CR-085's**: the same two-file pairing reproduces on `1f5498c`, develop's head at that branch cut
  (96 pass / 1 fail, 180001 ms). **The cause stated at filing — "a browser suite leaves subprocess
  spawning unusable for the rest of the run" — was DISPROVED by measurement on 2026-09-07**:
  `Bun.spawn` latency is 10.8 / 10.7 / 10.9 ms before, during and after a real `chromium.launch()`;
  32 spawns inside `bun test` right after the Chromium suite take 344 ms, identical to alone; and a
  faithful replica of the collection loop (5 clients, 163 verbs) runs in that same post-Chromium
  process in 2.28 s with 0 fail. The failing pairing is `real 3m22s` against `user 14s / sys 4s` —
  the process WAITS, it does not work. Trigger is Chromium-specific (a non-Chromium pairing is
  63 pass / 0 fail in 3.4 s); mechanism unidentified, which is why the split CR diagnoses before it
  remedies. It is ORDER-DEPENDENT, which is why one gate run of
  the identical tree passed it at 2.5 s and two others timed out — the same tree answered 2122/1,
  2122/1 and 2123/0, with every other slow test's duration identical to the millisecond
  (26113/22062/15006 ms). **A gate that answers differently on re-run cannot gate**, which is why
  this became a CR rather than staying a note (CR-110 AC5 measures three consecutive gate runs).
  Also reproduced live on 2026-09-07 at `5c73302`: 110 pass / 1 fail, so CR-CRU-093's Chromium
  hardening did not fix it.

- 2026-09-06 — **FILED as [CR-CRU-108](CR-CRU-108-one-published-track-fact.md)
  §S1–§S3 (user-directed, same SCRUM) — the multi-track rule is computed twice and reconciled by
  nobody.** CR-CRU-092 §S3 defines it once (sorted distinct non-null `entry.track`; multi-track iff
  `len(tracks) > 1`) and implements it in `clients/_crucible_axi.py` (`queue_tracks` → `resolve_next`);
  the browser re-implements the same predicate in `public/app-logic.mjs` (`declaredLabel` /
  `distinctLabels`), read by CR-CRU-078 AC12's `track` column and CR-CRU-085 §S2's lanes. They agree
  by inspection, not construction — `queue_tracks` skips a falsy value, `declaredLabel` trims and
  drops an empty string — and `handleQueueGet` publishes `{ok, entries}` with no track fact at all,
  so the server that OWNS the normalisation (`normalizeTrack`, `TRACK_LANE_RULE`) is the one surface
  that never answers the question its own rule defines. Same defect on the track axis that
  CR-CRU-104 §S1 settled for release membership: one rule, reached by every entry point. Design §11
  permits the fix — publishing a DERIVED fact is not a declaration.

- 2026-09-03 — **a green pre-merge gate does not mean develop is green: anything reading git
  history relative to `HEAD` changes meaning at the merge.** CR-CRU-096's non-vacuity block
  captured its "pre-CR" build with `git merge-base develop HEAD`
  (`tests/roadmap-visual-grammar.test.ts:739`), which resolves the pre-CR commit only while the
  branch is unmerged. After `feature finish`, `HEAD` IS develop, so the merge-base became the
  merged commit: the "before" build became the "after" build, AC26 compared a render against
  itself, and four pre-CR counterfactuals inverted. **Five of develop's six failures were this
  one line.** The pre-merge gate could not see it — I ran the full suite on the branch, where the
  base still resolved correctly, so the tests were green for the last time at the moment I read
  them green. Fixed by pinning `PRE_CR_COMMIT` (`761c253`). Two standing rules follow: a
  before/after comparison must name its before-state as settled fact rather than derive it, and
  **the regression gate must be re-run ON develop after the merge**, not only on the feature
  branch. The user asking "are there tests now failing?" is what surfaced it.

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

- 🔬 **2026-09-10 — CR-CRU-115 gap analysis: §S2 SPLIT OUT to CR-CRU-117, three ACs rescoped.**
  Measured, not reasoned. (1) Repairing the interim guard client-only would **permanently false-gate
  waves**: the interim outcome is `checks-passed`, and `workflowLens` (`public/app-logic.mjs`) flips a
  wave to `gated` on `passed` OR `checks-passed` from a Set nothing removes from — so a two-second-old
  in-flight snapshot gates a wave, and a later `failed` seal cannot undo it. There is no legal
  "in progress" outcome (`checks-passed, passed, failed, cancelled`), so the interim/seal distinction
  needs a reader change → CR-CRU-117. (2) `no-mistakes axi status` on this project's own release run
  resolves **`outcome: passed-with-skips`**, which is in NO vocabulary — not the server's
  `GATE_OUTCOMES`, not the client tuple, not the renderer's gating rule — so today's fallback silently
  rewrites it to `passed`. CR-115 now maps it by an explicit pass-family table and reports the raw
  value; making it first-class is a **candidate CR** (three trees: `src/v2.ts`, the client tuple,
  `public/app-logic.mjs` + `public/app.js`). (3) The integration AC named `cmd_gate_*`, which are
  single-statement delegators — the identical trap that forced CR-CRU-114's AC to be rescoped; the
  greppable seam is each client's `_post_gate`. (4) Recorded consequence: stamping `version` makes a
  gate retention-protected (`LIVE_GATE` in `src/store.ts`), so a release that never ships leaves a
  permanently live gate. (5) The fleet's existing interim fixtures (3/6/8 growing rows across four
  client suites) encode a shape the real tool never emits — that agreement between fixture and guard
  is why the fault reached a release.
- ❓ **2026-09-10 — USER DECISION OWED: CR-CRU-117's release membership.** Filed with `release`
  undeclared. It repairs a fault measured during 0.2.0's own release ceremony, but unlike CR-115 it
  touches `public/` (and possibly `src/`), so it is not a client-only patch. 0.2.0 or post-0.2.0 is
  the user's call.
- 🌊 **2026-09-09 — WAVE 6 IS 0.2.0's SECOND WAVE; the release-machinery CRs land on the release
  branch without the feature ceremony (user rulings).** Three decisions, taken on the Lavish
  proposal `.lavish/crucible-in-release-waves.html`, after the 0.2.0 release ceremony exposed the
  defects behind them. (1) **Wave 6 carries 0.2.0's release-machinery CRs** — CR-CRU-114 and
  CR-CRU-115 — and `015, 018, 022, 098` move to **wave 7**, release still undeclared. A release
  bundles the CRs of one or more waves, so a second wave inside 0.2.0 is the model's own shape, not
  a workaround; renumbering keeps wave order monotonic with release order so `next` behaves until
  CR-CRU-114 ships. (2) **A wave with no release stays invisible on the roadmap** — membership is
  declared, never inferred; no backlog zone, the visual contract keeps its three zones. (3) **0.2.0's
  in-release scope is CR-CRU-114 + CR-CRU-115 + the `cr-close` wording task**; the **release task
  set** the wave/track/release DN names is DEFERRED past 0.2.0 and recorded, not dropped — it is what
  would make the ceremony itself trackable, and it is why this release was invisible to the board
  between the proposal and the tag. **Execution mode:** plans and cycles exactly as normal —
  `plan-file` → `cycle-activate` → RED/GREEN/VERIFY → `pre-merge-gate` → `cr-close` — but **no
  `git flow feature start/finish`**: commits land directly on `release/0.2.0`, which merges to master
  AND develop at `finish`. The cycle machinery never touches git, so nothing in Crucible changes for
  this mode.
- 🌊 **2026-09-09 — USER REQUIREMENT: only ONE wave is active at any time, and Crucible PLACES that
  constraint.** Not a convention orchestrators are trusted to keep — a refusal the server issues.
  Filed as **CR-CRU-116**, which lifts the rule that already exists one container down:
  `transitionCycle` refuses a second active sibling (`code: "already-active"`,
  `src/store.ts:3241-3249`) and refuses activating ahead of a seq-earlier pending sibling
  (`code: "out-of-order"`, `:3255-3263`). The wave-scope refusals reuse both codes verbatim rather
  than mint new vocabulary. Activeness stays DERIVED — a wave is active while it holds an open plan
  or an `IN_PROGRESS` CR; no wave record, no `wave-activate` verb, consistent with wave completion
  being derived too. **CR-CRU-116 is the only wave-6 CR that touches `src/`**, which is what keeps
  CR-CRU-114's and CR-CRU-115's "empty `src`/`public` diff" ACs honest. CR-CRU-114 is the READ side
  of the same rule and now says so.
- 🎨 **2026-09-09 — USER DECISION OWED: the workflow flowchart's first wave panel depicts a rule
  CR-CRU-116 abolishes.** `.lavish/crucible-workflow-flowchart.html:175-184` draws a marked wave
  (`Wave 5 · active`) holding five `cr pend` rows and NO runner — under §S4 a wave with nothing
  `IN_PROGRESS` carries no marker. The panel is right about geometry and wrong only about the marker.
  It could not be reconciled by changing the code: CR-CRU-096 AC11a makes a runner ADDITIVE
  (`scheduled = actionable.slice(0,5)` plus every `IN_PROGRESS`), so a marked live board draws SIX
  rows against AC27's `rowCount === 5` comparison — measured, not argued. CR-CRU-116 therefore deletes
  AC27's two marker lines and leaves the artifact untouched, because refreshing an approved design
  surface is the user's call. **Nothing is blocked by this**; it is a design-refresh item.
- 🔧 **2026-09-09 — TASK, not a CR: `cr-close` and `cr-merged` assume a merge.** `--commit`'s help
  reads "Merge commit sha" and the closing milestone is typed `cr-merged`; under the mode above a CR
  lands as an ordinary commit. The data is already correct (any sha is recorded), only the wording
  assumes a merge, and per the CR-vs-task test a help string plus a definition has no design surface.
  Fix the help text and define `cr-merged` as "the CR landed on its target branch" — minting a second
  milestone type for the same event would be the parallel mechanism this project keeps refusing.
- 📎 **2026-09-09 — CANDIDATE CR (measured, and it caused a red gate): `path:line` citations drift
  silently everywhere except one guarded block.** CR-CRU-116 shifted `src/v2.ts` by +8 from line 8,
  `src/store.ts` by +31 from `:603` and a further +127 from `:3336`, and `src/hints.ts` by +19 from
  `:276`. Cycle 397 compared every `store.ts:N` / `hints.ts:N` / `v2.ts:N` / `app-logic.mjs:N` /
  `app.js:N` citation in `clients/`, `tests/`, `src/`, `public/` and `docs/` against the CR's base and
  HEAD: **267 cited ranges now hold different content than they did at base.** Three were spot-checked
  as demonstrably accurate at base and wrong now — `src/store.ts:1911` (`tier: meta?.tier ?? "unit"`,
  cited four times from `tests/client/`) is now `:1942`; `src/v2.ts:711`; `src/v2.ts:2053` (cited from
  `public/app-logic.mjs:1327`). Only `clients/_crucible_axi.py`'s `next` block is guarded, by
  `NextBlockCitationsTest`, which is why the gate went red on exactly that one and nowhere else.
  Follow-up: generalise that guard repo-wide, or DECIDE and document that only the `next` block is
  pinned. The status quo is a convention enforced in one file out of hundreds.
- 🧪 **2026-09-09 — CANDIDATE CR: two concurrent python client runs merge into one ingest.**
  `test-reports/` is a single shared dir and `_regression_run` wipes only at ITS own start, so a run
  overlapping another absorbs both XML sets. Measured in cycle 397: an ingest reported **3276 pass / 2
  pending — exactly 2×** the suite, because `test-reports/` held two complete 449-file sets from one
  invocation 68 s apart (the orchestrator's `pre-merge-gate` running beside the agent's own run). Both
  sets were 0-failure so no green was false, but every board figure from an overlapping run is
  inflated. Fix: a per-invocation reports subdir (PID or uuid suffix). **Orchestrator rule until then:
  never run the gate concurrently with an agent's ingesting run.**
- ⚠️ **2026-09-09 — CANDIDATE CR: no verb can re-wave a release-less CR, and the bulk route would
  wipe membership.** `cr-plan` and `wave-sequence` both REQUIRE `--release`, so the four CRs re-waved
  to 7 above cannot be re-waved on the board while their release is undeclared. The only other path is
  the bulk queue POST, and that is destructive: the route stores membership **as received**
  (`src/v2.ts:1964-1971`) while `queue-file` sends only `{cr, title, wave, dependsOn}`, so re-posting
  the table would drop **every release assignment and every lifecycle disposition** on the board. The
  queue table above is therefore the authored truth for those four rows and the board keeps wave 6
  for them until a post-0.2.0 release is proposed or the re-wave path exists. This supersedes the
  earlier "`queue-file` drops lifecycle dispositions" note by naming the second field it also drops.
- 📌 **2026-09-09 — STANDING DECISION 1 is now satisfied BY THE GATE, not beside it.** The standing
  step `python-crucible.py regression --start-dir tests/client` was adopted 2026-09-08 as a second
  command run alongside `pre-merge-gate`. CR-CRU-112 shipped the mechanism it was asking for: the
  gate's own envelope now carries `suites[4]`, one of them `test:client` / `stack: python` /
  `client: python-crucible.py`, 1633 tests, inside ONE invocation (measured on `release/0.2.0`:
  3830 passed / 0 failed / 1 pending / 3831 across 229 files, 4 suites, `tsc` exit 0). Running the
  python step separately is now redundant, not required.
- 🚨 **2026-09-08 (CR-CRU-110 dispatch — AGENT-ID STANDARD BREACHED, recorded because the board
  now carries the evidence).** The four phase agents of plan 118 registered as `Cr110Red`,
  `Cr110Green`, `Cr110Verify` and `Cr110Fix`. The standard is
  `CR-<ACRONYM>-NNN-<cycle>-<ROLE>` — here `CR-CRU-110-C1-RED`, `-C1-GREEN`, `-C2-VERIFY`,
  `-C3-FIX` — and it is **assigned by the orchestrator, never minted by the agent**
  (`~/.agents/skills/crucible/SKILL.md:36-44`). Both halves were broken: the ids were invented, and
  the dispatch briefs said `register --agent <your-id>`, which handed the naming decision to the
  agents. Five ingested runs on plan 118 are therefore mis-attributed permanently; they are NOT
  re-ingested, because re-ingesting to correct a label is run spam (the rule the 2026-08-18 note
  below established). No live ghosts — all four unregistered cleanly. **The rule that prevents
  recurrence: a dispatch brief states the assigned id VERBATIM, and a brief containing
  `<your-id>` is malformed.**
- 🧪 **2026-09-08 — TESTING STRATEGY: a DN, two CRs, and a standing gate step (user rulings).**
  `docs/research/DN-testing-tiers-in-crucible-projects.md` is now the design authority for every
  testing decision in a Crucible-managed project: a tier names the DEPENDENCY a test takes (not its
  subject, not its size), real elapsed time IS a dependency, `unit` is falsifiable by wall-vs-CPU,
  the project classifies while the client drives and tags, and a gate covers every DECLARED suite.
  Seven open questions are left in it deliberately — the `--tier`-flag-vs-verbs fork is the one to
  settle before CR-CRU-111 is cut, because five clients teaching six values is a one-way door.
  **STANDING DECISION 1, adopted today:** this repo's gate includes
  `python3 clients/python-crucible.py regression --start-dir tests/client` beside the bun
  `pre-merge-gate`. Zero new code (`--start-dir`/`--pattern` already exist) and it closes a hole
  that had already cost us: **CR-CRU-108 broke CR-CRU-107's AC8 test** in
  `tests/client/test_plan_file_cycle_flag_help.py` (its stub published no `tracks`, which
  CR-CRU-108 made a hard stop) and **both CRs shipped green**, because `pre-merge-gate` runs
  `bun test` and the broken test is python — 65 files / 1445 tests the gate never collected. Filed:
  **CR-CRU-111** (the client can say which tier it ran — `integration` is a tier the server accepts
  and the bun client cannot emit; `cmd_test` stamps `unit` on every targeted run whatever it
  touches) and **CR-CRU-112** (the gate covers every declared suite), both wave 5 / 0.2.0.
- 🔧 **2026-09-08 — test infrastructure streamlined as MAINTENANCE (no CR, merge `460af30`).**
  Crucible is the SUT, so this was a task, not a change request. Measured first: 2183 tests / 525 s
  with **516 s spent waiting inside tests**, 81 files running 993 tests in 5.4 s against 13 files
  taking 302 s. Landed: one shared render flush (`tests/helpers/dom-settle.ts`) replacing 53 private
  copies of a fixed 20 ms loop — sound because production schedules only 0 ms and 5000 ms timers,
  nothing in between; `test:unit` / `test:integration` / `test:client` / `test:regression` targets
  with membership DERIVED per file and a partition guard (`tests/test-targets.test.ts`) so no file
  falls outside every target; and the python suite in the loop. **A quick check went 525 s → 17.8 s
  (29×)**, now 92% CPU-bound. Two classifier defects were found by measurement, not review: a greedy
  regex read a six-second wait as `0`, and `startServer` (the real production server) was not a
  marker — those two files were 27.8 s of the remaining 29 s. Both pinned as tests.
- ✅ **2026-09-09 — CR-CRU-112 SHIPPED, and the gate caught its own author.** One
  `pre-merge-gate` invocation now covers every declared suite: **ok=true, tier `regression`, 3824
  passed / 0 failed / 3825 total / 229 files** — the bun suite (2191/154) plus `tests/client`
  (1633/75) DISPATCHED to `python-crucible.py`, with `test:e2e` present as `gated:false` carrying the
  reason it is deferred. `src/` and `public/` untouched.
  **The declaration is CR-CRU-111's, extended by one field**, which is what this CR's own Risk section
  demanded ("one declaration serves both or they will drift"): a declared target gains a STACK,
  derived from the command the project already writes; a suite IS a declared target owned by a stack;
  one owned by another stack is dispatched to that stack's client, so "no client learns another
  language's tests" is true by construction. `regression` is the union, and a union is not an element
  of itself. The composition is SHARED — all five gates route through it, because "the gate composes
  the suites" is otherwise satisfied by one client.
  **Two corrections were mine, both caught by measurement.** Cycle 388's composition SUBTRACTED: with
  one declared target the union REPLACED the invoking stack's whole-suite run, so `run.files`
  vanished from every gate envelope (the count that exists precisely so a shrinking suite is
  visible — this CR's own thesis, deleted by its own implementation), the tier was re-stamped `unit`,
  and the invocation narrowed. Cycle 389 made it additive: the whole-suite run is always the union's
  base, foreign suites are ADDED, an own-stack target is not re-run but says so. And my §S2 cited the
  DN's "additive, never exclusionary" for that rule — VERIFY found the DN clause of that name is
  about DISCOVERY exclusions, a different rule; borrowed authority is worse than none, so the CR now
  says plainly that this is a new gate-contract clause.
  **Then the gate found four failures its own implementation had shipped** — a live-code `CR-CRU-112`
  literal EMITTED by a client (CR-CRU-097 AC3a), the clients prose citation count at 785 against a
  pinned 747, one asserted CR literal in a new test, and the CR-CRU-110 guard failing as a
  consequence of those three. The mechanism working on its author is the best evidence it works.
  **AC7 is proven against the REAL history, not a synthetic:** with the CR-CRU-108 `tracks` fix
  reverted in a scratch copy, the gate fails and names the python suite, and the failure is asserted
  from the dispatched client's own JUnit XML to be `queue-track-fact-unpublished` on the exact test
  CR-CRU-108 broke — the one both CRs shipped green past.
  **STANDING DECISION 1 is now SUPERSEDED by the gate itself.** The separate
  `python-crucible.py regression --start-dir tests/client` step beside the bun gate was the manual
  stand-in for this CR; the gate runs that suite itself, so the standing step is redundant rather
  than wrong. Keep running it only if you want the python suite alone.
  **Candidate CRs recorded:** `GET …/plans` takes **6–9 s at 102 open plans** against the client's
  10 s hook-safe bound, so plan-resolving verbs (`cycle-activate`, `cycle-done`) intermittently raise
  an UNCAUGHT `TimeoutError` — a traceback instead of an envelope, and the WRITE may still have
  landed, so the caller cannot tell (observed twice this session); the client has
  `plans_unavailable_warning` for exactly this and does not use it there. Also: the client offers no
  verb for the server-supported `pending → skipped` cycle transition, which forced a verify cycle to
  run before the fix cycle it should have followed. Also: the tsc `check` step's `subprocess.run`
  (`bun-crucible.py:1346`) is the one launch reachable from the gate that still raises out of it.
  Also: the dispatched python run carries no `--coverage`, so gate coverage is the bun half's
  presented as the whole project's — the same class of blind spot this CR closed.
- ✅ **2026-09-08 — CR-CRU-111 SHIPPED in 11 cycles, and the CR was wrong seven times before it was
  right.** Every client now exposes the six `Tier` values as VERBS from one shared registrar
  (`add_tier_verbs`), runs each tier through its own stack's split where one exists, DETECTS and runs
  a project-declared target where one does not, refuses by naming exactly what to declare, stops
  stamping tiers it did not earn, warns when a `unit` run spends its time waiting, and states the
  ingested tier in the envelope. Gate: **2191 pass / 0 fail** (83.3% lines / 86.8% funcs); python
  client suite **1615 / 0** (grew from 1445); `git diff` over `src/` and `public/` **empty across all
  24 commits** — the server interface was read, never redefined (AC10).
  **What the process actually caught, because this is the record worth keeping.** Five REDs and two
  VERIFYs escalated instead of guessing, and it corrected the spec seven times:
  (1) my §S2 census scanned `tier=` KEYWORD literals only, so it read arduino as "stamps nothing"
  when that client stamps on every path — AC13's whole premise was false and the "its help lies"
  inference with it; (2) AC5 was written as if only mvn owned tier-named verbs — there were EIGHT
  across FOUR clients; (3) AC10 demanded clients read `src/types.ts` at runtime, which no client does
  and an installed wheel cannot; (4) AC12 cited a DN mapping the DN does not contain; (5) rust's
  `--lib`/`--test` selectors did not exist and had to be BUILT; (6) AC2 was unassertable because
  `bdd` was wired nowhere; and (7) the largest — **§S3's declaration DETECTION was never built**, so
  18 of 30 cells refused unconditionally and told users to declare targets that changed nothing when
  declared. That last one was found by VERIFY, not by the cycles that shipped it, and it cost three
  more cycles (§S6, ACs 14-16). The final BLOCKING find was sharper still: rust's declared cells were
  reachable-past only because the TEST FIXTURE hand-wrote the JUnit report the help never told anyone
  to configure — nextest emits one only with a `[profile.<tier>.junit]` sub-table. The fixture was
  completing an incomplete instruction, which is the exact defect §S6 exists to remove.
  **Corrected figure for future baselines:** the fleet carries **10** literal tier sites (not the 8
  the cycles reported), all EARNED, zero unearned — measured twice, independently, at re-VERIFY.
  **Two candidate CRs recorded, neither in scope here:** (a) the tripwire's `expect()`-message
  exemption is JS-only because CR-CRU-109 scoped it on the premise that "no client test writes one" —
  cycle 377 falsified that, so Python's `unittest` msg argument is now a real gap, and closing it
  needs the span rules designed deliberately with planted fixtures rather than bolted on; (b) python's
  zero-discovery branch (CR-CRU-039) is asserted only against a synthetic capture and is unreachable
  with the shipped xmlrunner — a path nobody has seen run. Pre-existing on `develop`, confirmed not
  caused by this CR.
- ✅ **2026-09-08 — CR-CRU-110 SHIPPED, and the mechanism is named rather than worked around.**
  §S1 was a bisection, not a build, and it ended somewhere none of the three prior readings
  predicted: after a file drives Chromium through playwright in the same bun process, ONE child of
  a concurrently spawned batch has its stderr pipe torn down without its reader promise settling
  and without the child being reaped — zombie child (`State: Z`, ppid = the bun test process), bun
  holding **0 pipes** among 536 fds against a 1 048 576 limit — so
  `new Response(proc.stderr).text()` can never resolve. It does not complete late: 20 s, 90 s,
  150 s and 180 s caps were all reached and a natural completion was never once observed. What the
  bisection ELIMINATED matters as much: file-mates (the help-test-only copy still hangs), the spawn
  shape (reversing six variants' order makes every one pass), concurrency (8 concurrent trivial
  spawns = 15.3 ms), the client (8 real client helps = 85 ms) and any particular verb (the stalling
  batch's own eight verbs, alone = 83 ms). **Both earlier explanations were wrong** — CR-CRU-108's
  subprocess starvation, and then the replica reading: the 2.28 s replica passed because something
  had already spawned before it, not because it was a replica. Remedy: collect the 168 surfaces via
  `Bun.spawnSync`, the one shape measured immune — no cap raise, no skip, no exclusion, no second
  invocation, all 168 surfaces and every floor intact. Cost stated in full: ~12 s vs ~3.1 s for the
  collection, plus **~46 s** for the new nested guard, which launches Chromium a second time.
  Evidence: pairing 111/0 in 47 s with the help test's own duration **12.2 s** (was pinned at its
  180 s cap); **three gate runs of one tree at 2191 pass / 0 fail** (519/514/499 s) where the same
  defect had previously produced 2122/1, 2122/1, 2123/0; python client suite 1445/0. Ownership is
  **bun's**, not ours (`bun 1.3.14 (0d9b296a)` pinned by AC8), and the exposure is recorded rather
  than over-fixed: 12 test files use async `Bun.spawn` with a piped stderr and 5 launch browsers,
  so this test is not structurally unique — it is the one that spawns 168 times.
- 📐 **2026-09-08 (CR-CRU-110 gap analysis) — the defect is ADJACENCY, not precedence, and the
  spec was corrected.** In a full-suite run the Chromium suite executes at position **137/152** and
  the printed-help test at **147/152** — ten files later, same process — and it passes in 3.2 s with
  the suite green (2183/0, twice, JUnit-instrumented). The hang reproduces 4/4 only when the two
  files ARE the whole invocation. Also measured: **bun's file order is not the argument order** —
  passing the tripwire first ran Chromium first in every attempt (both orders, native and MCP shell,
  before and after `touch`), and mtime-ascending is falsified. So the defect reaches us through
  TARGETED runs, which is how agents run tests, not through the gate's full run. CR-CRU-110 gained
  **AC7** (the remedy is neither a conditional skip nor a bare cap raise — AC1–AC6 were ALL
  satisfiable by "raise the cap to 600 s"), **AC8** (scheduling dependence is stated with the runner
  version pinned) and **AC9** (no discovery exclusion — `suite-integrity` forbids it).
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
