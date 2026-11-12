# CR-CRU-187 — a release drafts its notes from the board

**Status:** PENDING — filed 2026-10-14 (user ruling: accept Model B's #1449 request); gap analysis
ran 2026-11-12 · Pre-review: ran — user rulings at design (10 findings folded)
**Type:** feature
**Points:** 8 (5 at filing; 8 after the gap analysis's ruling for a new shared module)
**Wave:** 8 (0.4.0)
**Depends on:** —
**Labels:** clients, release
**Design reference:** CR-CRU-150 §S9 (`landings`); CR-CRU-181 (`history` and its refusals);
CR-CRU-183 (`finish` refuses a release with no notes; `scripts/release-notes.sh`)

## Problem

Requested by Model B (Sandesh #1449, 2026-10-14), following #1433 §A1.

A release's notes are a section of the repo-root `CHANGELOG.md` (Keep a Changelog 1.1.0), written on
the release branch before `finish` (`RELEASING.md` step 3). Model B adopts the same flow in every
project it scaffolds. Today the section is written by hand, from memory or from reading `history`
and `landings`. The board already holds the record the section is built from: which CRs a release
landed, when each landed, and their titles.

## Steps

### §S1 — `release-notes --release <label>` drafts the section

A new read-only verb, `release-notes`, reached by each of the six clients (`bun-crucible.py`,
`python-crucible.py`, `rust-crucible.py`, `mvn-crucible.py`, `arduino-crucible.py`,
`go-crucible.py`). It takes no `--agent` and writes nothing to the board. It takes `--release
<label>` (required) and `--date <YYYY-MM-DD>` (optional).

**What it reads.** Only these `GET`s, in this order:

1. `…/history`: the release's row gives the CRs it COMPLETED (its `waves[].crs`), its `state` and,
   when it shipped, `shippedAt`.
2. `…/plans?status=closed`: each closed plan's `cr`, `title` and `closedAt`.
3. `…/queue`, only when a completed CR has no closed plan (a CR a shipped release record names
   without a plan), or its latest closed plan carries no title: its entry's `title`.

On the refusal path only, once the label is missing from the history: the queue and the release
proposals, the reads the `history` verb makes to tell a held label from an unknown one.

**The section.**

```text
## [<label>] - <YYYY-MM-DD>

### Changed

- <title> (<CR id>)
```

- **Heading date.** `--date` when given; else, for a release whose `state` is `shipped`, the UTC
  date of its `shippedAt`; else today's UTC date. The draft is written at step 3, before `finish`
  records the ship, so an unshipped release still gets the dated heading `finish`'s notes guard
  demands. A `--date` that is not a real `YYYY-MM-DD` date is refused (§S3).
- **One line per completed CR**, carrying its CR id. Pending CRs of the release are not listed.
  A release that completed no CR but shipped is its heading alone, with no group (`count` 0).
- **Order.** Landing order: by the CR's latest closed plan's `closedAt`, earliest first. CRs with
  no closed plan follow, in the order the history row lists them.
- **Title.** The latest closed plan's `title`, else the queue entry's `title`. A CR with neither is
  its id alone: `- <CR id>`.
- **Grouping.** The board records no CR type, so every line goes under `### Changed` for the human
  to sort (user ruling 2026-11-12: a CR type stays off the board).
- **Non-goal.** A CR is listed when the board's history counts it completed (a closed plan with a
  merge, or a shipped release record naming it). A CR whose landing the board knows only from a
  `cr-merged` milestone is not listed; the human adds it.

**Output** (user ruling 2026-11-12). `--format` picks the encoding, as for the other read verbs:

- `toon` (the default) and `json`: the usual AXI envelope on stdout, `verb: release-notes`,
  carrying `release`, `state`, `date`, `count`, the section as `lines` (one string per line) and
  `help`.
- `markdown` (this verb's own value): the section alone on stdout, ending in one newline, ready to
  paste. The human line, and each warning the envelope would carry (a limit disclosure, an unknown
  project), go to stderr, one line each.

### §S2 — the verb lives in its own shared module

`clients/_crucible_axi.py` stands at 9183 lines against its 9200-line guard, so the verb lives in a
new sibling module, `clients/_crucible_release.py` (user ruling 2026-11-12). The core loads it
EAGERLY, as it loads `_crucible_run.py` (by file path from its own directory, under a name derived
from its own, bound to a live view of the core), and its names reach the clients as the run
module's do. The `history` verb's refusal helper takes the verb's name, so `release-notes` refuses
under its own name.

Everything that names the shared modules names the new one:

- **Shipped:** the installer's `FLEET_FILES` (`crucible_axi/install.py`), the wheel's client
  payload, and the README's shared-module sentence.
- **Tests that copy or list the fleet:** `EXPECTED_FLEET_FILES` (`test_cr090_fleet_stage.py`,
  `test_cr090_cli_install_integration.py`), `EXPECTED_CLIENT_PAYLOAD`
  (`test_crucible_axi_wheel_packaging.py`), `SHARED_MODULES`
  (`clients-never-self-register-a-project.test.ts`,
  `test_a_runs_ingest_helpers_live_once_in_the_shared_module.py`), `SHARED_MODULE_NAMES`
  (`test_cr054_drift_guard.py`), the ruff and stdlib-only checks of
  `test_the_run_pipeline_lives_in_its_own_shared_module.py`, and the fixtures that copy the core
  (`test_client_fleet_envelope_census.py`, `test_a_clients_board_is_its_projects_configuration.py`,
  `test_no_suite_resolves_the_checkout_configuration.py`).
- **Line budgets:** `SHARED_MODULE_LINE_BUDGETS` in the rust, mvn and arduino
  sends-its-runners-reports tests is re-recorded for the core's new count and gains the new
  module's, in the same change.

### §S3 — refusals say what to do

Each refusal is the `release-notes` envelope (`verb: release-notes`) on stdout, under every
`--format` (under `markdown`, the `toon` envelope), with no section, and its own stderr line.

- **No `--release`, an empty one, or a bad `--date`:** exit 2, a usage refusal naming the form
  `release-notes --release <label> [--date YYYY-MM-DD] [--format toon|json|markdown]`.
- **A label the project does not hold:** exit 1, `unknown release: <label>` with the `history`
  verb's help.
- **A held label that has completed no CR and not shipped:** exit 1, `release <label> is not in
  History yet: nothing shipped and no CR completed`, with the help
  `queue --fields release,seq,points,dependsOn`.
- **A read that fails** (the history, the closed plans, or the queue when it is needed): exit 1, a
  refusal naming that read and its error, with the server-failure help the `history` verb gives. A
  failed queue read never falls back to bare ids.

### §S4 — the release flow names it, and the docs say it

- `RELEASING.md` step 3, and the notes line of its "Release at a glance" block, name
  `release-notes --release <label> --format markdown` as the way to start the section.
- `scripts/release.sh`'s notes guard, when it refuses a release with no committed, dated notes,
  names the same command.
- The CHANGELOG `[Unreleased]` names the verb, `--format markdown`, `--date`, and what each line
  carries.

## Acceptance criteria

- [ ] **AC1 — the draft, in each client.** For EACH of the six clients, against a live in-process
  board holding a shipped release with three completed CRs closed out of their filing order,
  `release-notes --release <label> --format markdown` exits 0 and prints exactly the section: the
  label and the UTC ship date in the heading, then `### Changed`, then the three CRs' titles and
  ids in landing order. The default `toon` and `--format json` envelopes carry `verb:
  release-notes` and the same section as `lines`, with `release`, `state`, `date` and `count`.
- [ ] **AC2 — the heading date.** An unshipped release with completed and pending CRs is headed with
  today's UTC date and lists only the completed CRs; `--date 2026-12-01` heads it
  `## [<label>] - 2026-12-01`; a `ship not recorded` release takes today's date too. A shipped
  release with no completed CR prints its dated heading alone and exits 0.
- [ ] **AC3 — the draft passes the notes guard.** The markdown output for an unshipped release,
  written into a `CHANGELOG.md`, is accepted by `scripts/release-notes.sh <label>` (it prints the
  section) and by the heading check of `finish`'s notes guard.
- [ ] **AC4 — the edge cases.** A completed CR with no closed plan takes its queue title and
  follows the planned ones; a CR whose latest closed plan has no title takes its queue title in
  its landing place; a CR with neither title is its id alone; a CR with two closed plans of
  different titles is one line, at its latest close, with that plan's title.
- [ ] **AC5 — refusals.** Each case of §S3 (no `--release`, an empty one, a bad `--date`, an unknown
  label, a held label with no completed CR, and a failed history, closed-plans or queue read) exits
  with its code, under each `--format`, with `verb: release-notes`, the wording and help of §S3,
  and no section on stdout.
- [ ] **AC6 — read-only.** Through a capturing proxy, the verb issues only the `GET`s §S1 names —
  the queue only when a completed CR lacks a titled closed plan, the queue and release proposals
  only on the refusal path — and no write.
- [ ] **AC7 — warnings under markdown.** A `--format markdown` run whose envelope would carry a
  limit-disclosure warning prints the section alone on stdout and the warning on stderr.
- [ ] **AC8 — its own module.** `release-notes` is defined in `clients/_crucible_release.py`, which
  the core loads by file path as it loads; `_crucible_axi.py` stays within its line guard; every
  site §S2 lists names the new module, and the line budgets are re-recorded; an install lays the
  module down beside the core; the verb census classifies `release-notes` as a read verb.
- [ ] **AC9 — the flow names it.** `RELEASING.md` step 3 and its at-a-glance notes line, and the
  notes guard's refusal in `scripts/release.sh`, each name `release-notes --release` with
  `--format markdown`.
- [ ] **AC10 — docs and hygiene.** The CHANGELOG `[Unreleased]` names the verb as §S4 says. No
  CR-shaped literal, `§` or AC number is added to comments or text under `clients/`, `src/` or
  `scripts/`, and the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: RED (the ACs above, fleet-wide), GREEN in the new shared module, the six
clients' parsers, the installer and the fleet lists, `RELEASING.md` and `scripts/release.sh`, then
VERIFY. Model B hears of the verb in the 0.4.0 release notes.
