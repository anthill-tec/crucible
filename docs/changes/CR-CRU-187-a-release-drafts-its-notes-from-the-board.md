# CR-CRU-187 — a release drafts its notes from the board

**Status:** PENDING — filed 2026-10-14 (user ruling: accept Model B's #1449 request); gap analysis
ran 2026-11-12 · Pre-review: due — user rulings at design
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
`go-crucible.py`). It takes no `--agent` and writes nothing to the board.

**What it reads.** Only these:

- `GET …/history`: the release's row gives the CRs it COMPLETED (its `waves[].crs`), its `state`
  and, when it shipped, `shippedAt`.
- `GET …/plans?status=closed`: each closed plan's `cr`, `title` and `closedAt`.
- The queue, only when a completed CR has no closed plan (a CR a shipped release record names
  without a plan): its entry's `title`.

**The section.**

```text
## [<label>] - <the ship date, YYYY-MM-DD>

### Changed

- <title> (<CR id>)
```

- **Heading.** A release whose `state` is `shipped` carries the UTC date of its `shippedAt`. Any
  other release (`in progress`, `ship not recorded`) reads `## [<label>] - Unreleased`.
- **One line per completed CR**, carrying its CR id. Pending CRs of the release are not listed.
  A shipped release that completed no CR is its heading alone, with no group (`count` 0).
- **Order.** Landing order: by the CR's closed plan's `closedAt`, earliest first. A CR with several
  closed plans is one line, at its latest close. CRs with no closed plan follow, in the order the
  history row lists them.
- **Title.** The closed plan's `title`, else the queue entry's `title`. A CR with neither is its
  id alone: `- <CR id>`.
- **Grouping.** The board records no CR type, so every line goes under `### Changed` for the human
  to sort (user ruling 2026-11-12: a CR type stays off the board).

**Output** (user ruling 2026-11-12). `--format` picks the encoding, as for the other read verbs:

- `toon` (the default) and `json`: the usual AXI envelope on stdout, carrying `release`, `state`,
  `date` (the heading's date, or `Unreleased`), `count`, the section as `lines` (one string per line)
  and `help`.
- `markdown` (this verb's own value): the section alone on stdout, ending in one newline, ready to
  paste; the human line goes to stderr as for every verb.

### §S2 — the verb lives in its own shared module

`clients/_crucible_axi.py` stands at 9183 lines against its 9200-line guard, so the verb lives in a
new sibling module, `clients/_crucible_release.py` (user ruling 2026-11-12). The core loads it the
way it loads `_crucible_run.py` (by file path from its own directory, under a name derived from its
own, bound to a live view of the core), and its names reach the clients as the run module's do.
The installer ships it with the fleet, and the README names it among the shared modules.

### §S3 — refusals say what to do

- A label the project does not hold: the `history` verb's `unknown release: <label>` refusal and
  help.
- A label the project holds that has completed no CR and not shipped: the `history` verb's
  `release <label> is not in History yet: nothing shipped and no CR completed` refusal, with its
  `queue --fields release,seq,points,dependsOn` help.
- A board that cannot be read: a refusal naming the failed read, with the server-failure help the
  `history` verb gives.

Each exits 1. Under every `--format`, a refusal prints its envelope on stdout (under `markdown`,
the `toon` envelope) and no section.

### §S4 — the release flow names it, and the docs say it

- `RELEASING.md` step 3, and the notes line of its "Release at a glance" block, name
  `release-notes --release <label> --format markdown` as the way to start the section.
- `scripts/release.sh`'s notes guard, when it refuses a release with no committed, dated notes,
  names the same command.
- The CHANGELOG `[Unreleased]` names the verb, its `--format markdown` and what each line carries.
- `docs/RUNBOOK.md`, where it lists the client's read verbs, names it.

## Acceptance criteria

- [ ] **AC1 — the draft, in each client.** For EACH of the six clients, against a live in-process
  board holding a shipped release with three completed CRs closed out of their filing order,
  `release-notes --release <label> --format markdown` exits 0 and prints exactly the section: the
  label and the UTC ship date in the heading, then `### Changed`, then the three CRs' titles and
  ids in landing order. The default `toon` and `--format json` envelopes carry the same section as
  `lines`, with `release`, `state`, `date` and `count`.
- [ ] **AC2 — an unshipped release.** A release in progress with completed and pending CRs reads
  `## [<label>] - Unreleased` and lists only the completed CRs; a `ship not recorded` release also
  reads `Unreleased`. A shipped release with no completed CR prints its dated heading alone and
  exits 0.
- [ ] **AC3 — the edge cases.** A completed CR with no closed plan takes its queue title and
  follows the planned ones; a CR with neither title is its id alone; a CR with two closed plans is
  one line, at its latest close.
- [ ] **AC4 — refusals.** An unknown label, a held label with no completed CR, and a board that
  cannot be read each exit 1 with the refusal wording and help of §S3, under each `--format`, and
  no section on stdout.
- [ ] **AC5 — read-only.** Through a capturing proxy, the verb issues only the `GET` reads §S1
  names and no write.
- [ ] **AC6 — its own module.** `release-notes` is defined in `clients/_crucible_release.py`, which
  the core loads by file path; `_crucible_axi.py` stays within its line guard; the installer's
  fleet ships the new module and an install lays it down beside the core; the README names it; the
  verb census classifies `release-notes` as a read verb.
- [ ] **AC7 — the flow names it.** `RELEASING.md` step 3 and its at-a-glance notes line, and the
  notes guard's refusal in `scripts/release.sh`, each name `release-notes --release` with
  `--format markdown`.
- [ ] **AC8 — docs and hygiene.** The CHANGELOG `[Unreleased]` and the RUNBOOK name the verb as
  §S4 says. No CR-shaped literal, `§` or AC number is added to comments or text under `clients/`,
  `src/` or `scripts/`, and the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: RED (the ACs above, fleet-wide), GREEN in the new shared module, the six
clients' parsers, the installer, `RELEASING.md` and `scripts/release.sh`, then VERIFY. Model B
hears of the verb in the 0.4.0 release notes.
