# CR-CRU-187 — a release drafts its notes from the board

**Type** feature · **Points** 5 (set at filing, 2026-10-14) · **Wave** 8 (0.4.0) · **Depends on** — ·
**Status** PENDING — filed 2026-10-14 (user ruling: accept Model B's #1449 request; placed at the end
of wave 8)

## Problem

Requested by Model B (Sandesh #1449, 2026-10-14), following #1433 §A1.

A release's notes are a section of the repo-root `CHANGELOG.md` (Keep a Changelog 1.1.0), written on
the release branch before `finish` (`RELEASING.md` step 3). Model B adopts the same flow in every
project it scaffolds. Today the section is written by hand, from memory or from reading `history`
and `landings`. The board already holds the record the section is built from: which CRs a release
landed, and their titles.

## Steps

### §S1 — `release-notes --release <label>` drafts the section

A new read-only verb in the shared module, reached by all five clients. It reads what the board
already serves (the release's CRs, as `history --release` lists them) and prints one Keep a
Changelog section on stdout:

```
## [<label>] - <YYYY-MM-DD, the release's ship date, or "Unreleased">

### Changed
- <CR title> (<CR id>)
```

- One line per CR the release landed, in landing order, each carrying its CR id.
- Grouping: the board records no CR type, so every line goes under `### Changed` for the human to
  sort. (Whether a CR type becomes board data, so that `Added`/`Fixed` can be derived, is settled at
  gap analysis.)
- The section is the whole stdout payload, ready to paste. The AXI envelope goes to stderr, or the
  verb takes `--format json` for programs, as the other read verbs do.
- It writes nothing to the board.

### §S2 — refusals say what to do

- A label the project does not hold: the existing `unknown release: <label>` refusal.
- A label the project holds that has landed no CR: CR-CRU-181's "not in History yet" refusal, with
  its `queue` help.

Both exit non-zero, with nothing on stdout but the envelope.

### §S3 — the release flow points to it

`RELEASING.md` step 3 and the release flow's own `help[]` (where `release-propose` or the release
milestone names the next step) name `release-notes --release <label>` as the way to start the
section.

## Acceptance criteria

- [ ] **The draft.** For EACH of the five clients, against a live in-process board holding a shipped
      release with three landed CRs, `release-notes --release <label>` exits 0. Its section names
      the release and its ship date, and lists the three CRs' titles and ids under `### Changed`, in
      landing order.
- [ ] **An unshipped release.** For a release with landed CRs that has not shipped, the heading
      reads `## [<label>] - Unreleased`.
- [ ] **Refusals.** An unknown label and a held-but-empty label each exit non-zero, with the
      refusal wording and help above and no section on stdout.
- [ ] **Read-only.** The board receives no write from the verb (a capturing proxy).
- [ ] **The flow names it.** `RELEASING.md` step 3 names the verb, and so does the help the release
      flow prints at that step.
- [ ] **No new CR literals.** No CR-shaped literal is added to comments under `clients/` or `src/`,
      and the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: RED (the ACs above, fleet-wide), GREEN in the shared module and `RELEASING.md`,
then verify.
