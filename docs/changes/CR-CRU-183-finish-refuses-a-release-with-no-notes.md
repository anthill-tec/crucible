# CR-CRU-183 — `finish` refuses a release with no notes, and its report skips voided CRs

**Type** fix (patch CR, after the 0.3.0 release) · **Points** 5 (3 at filing; raised at gap analysis
2026-10-21 when the notes rule became one extractor shared with the release workflow) · **Wave** 8
(0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-10 (user ruling: the 0.3.0
follow-ups are patch CRs in wave 8)

## Problem

Found while releasing 0.3.0 (2026-10-10).

1. **A release can finish with no release notes.** The notes are a release task (`RELEASING.md`
   step 3): the version's `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md`, written on the release
   branch before `finish`. `create-release` takes that section as the GitHub Release body, through
   its own `awk` (the heading at the start of a line, everything up to the next `## [`, link-reference
   lines skipped). When the section is missing it falls back to GitHub's generated notes with a
   warning, because a tag must always get a release. By then the tag is pushed and master is merged.
   Nothing stops `scripts/release.sh finish` from tagging a release whose notes were never written;
   0.3.0 shipped that way and its notes were added after.
2. **`finish`'s provenance report lists voided CRs as work that never landed.** The 0.3.0 report
   printed `6 unplaceable queued CR(s) — NEVER landed: CR-CRU-082 CR-CRU-141 CR-CRU-144 CR-CRU-151
   CR-CRU-152 CR-CRU-153`. CR-CRU-082, 141 and 144 are VOID: CR-CRU-147 ruled that a voided CR is
   not queued work, and the queue rows carry their `lifecycle` (VOID or SUPERSEDED). The report's
   reader of the queue (`queued_crs`) ignores that column.

`finish` also commits the manifest alignment on the release branch before its preflight guards run,
under `--dry-run` too, so a guard placed beside the manifest and tag-prefix guards would refuse with
that commit already made. `RELEASING.md` says "two preflight guards" though the identity guard is a
third.

## Design (settled with the user, 2026-10-21)

- One extractor prints a version's release notes from `CHANGELOG.md`; both the `finish` guard and the
  release workflow's `create-release` step read the notes through it, so the guard refuses exactly
  when `create-release` would fall back to generated notes.

## Steps

### §S1 — one extractor for a version's notes

`scripts/release-notes.sh X.Y.Z` prints the version's section of `CHANGELOG.md` by the rule
`create-release` uses today: from the line that begins `## [X.Y.Z]` (exclusive) up to the next line
that begins `## [`, with link-reference lines (`[label]: url`) skipped. It exits 0 when what it
printed holds a non-whitespace character, and non-zero otherwise (no such heading, or only
whitespace). The `create-release` step in `.github/workflows/release.yml` takes its notes from it in
place of its own `awk`, with today's fallback to generated notes and its warning unchanged.

### §S2 — a release needs its notes before anything is written

`finish X.Y.Z` gains a notes guard that runs right after the identity guard and before the manifest
is aligned, so a refused `finish` makes no commit, merges nothing and tags nothing; it runs under
`--dry-run` too. It refuses when `CHANGELOG.md` has no line that begins `## [X.Y.Z] - ` followed by a
`YYYY-MM-DD` date, or when the extractor finds no content in the version's section. The refusal names
the file, the heading it expected, and `RELEASING.md` step 3.

### §S3 — the provenance report skips voided and superseded CRs

A queue row whose `lifecycle` is VOID or SUPERSEDED is not reported as unplaceable, in either the
evicted or the never-landed list. It is not queued work.

### §S4 — the runbook says so

`RELEASING.md` names all three preflight guards (identity, notes, then the manifest and tag-prefix
checks after the alignment), each with its failure and remedy, and step 3 says `finish` refuses
without the version's notes. `release.sh --help` lists the notes guard.

## Acceptance criteria

- [ ] **The extractor.** On fixture changelogs, `scripts/release-notes.sh X.Y.Z` prints exactly the
      version's body (no heading, no next section, no link-reference lines) and exits 0; with no
      heading, an empty section, or a section holding only whitespace or link references, it prints
      nothing that matters and exits non-zero.
- [ ] **The workflow uses it.** The `create-release` step calls `scripts/release-notes.sh "$TAG"` and
      no longer carries its own section `awk`; its generated-notes fallback and warning are
      unchanged.
- [ ] **No notes, no release.** In a scratch release repo whose `CHANGELOG.md` lacks
      `## [9.9.9] - <date>`, `finish 9.9.9` and `finish 9.9.9 --dry-run` each exit non-zero. Stderr
      contains `CHANGELOG.md`, `## [9.9.9]` and `RELEASING.md`; the release branch has no new
      commit; `master` and the tags are unchanged.
- [ ] **Empty notes, no release.** The same refusal holds for a heading without a date, and for a
      dated section whose body is empty, whitespace or link references only.
- [ ] **With notes, unchanged.** With the dated section present and non-empty, `finish 9.9.9`
      proceeds exactly as today. Every existing release-driver, release-reporting and
      release-provenance test passes, with each of their scratch repos given a `CHANGELOG.md`
      section for the version it finishes (test edits authorised by this criterion, in their own
      commit).
- [ ] **Voided work is not queued work.** With queue rows for a VOID CR, a SUPERSEDED CR and a PENDING
      CR, none of which has landed, `finish`'s report names only the PENDING CR as never landed; and
      a VOID CR that a stored release record names is not reported as evicted either.
- [ ] **The runbook.** `RELEASING.md`'s guard table lists all three preflight guards with their
      failures and remedies, step 3 says `finish` refuses without the notes, and `release.sh --help`
      names the notes guard.

## Non-goals

- Writing or drafting the notes (CR-CRU-187).
- Checking the notes' content beyond its presence.
