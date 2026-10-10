# CR-CRU-183 — `finish` refuses a release with no notes, and its report skips voided CRs

**Type** fix (patch CR, after the 0.3.0 release) · **Points** 3 (set at filing, 2026-10-10) ·
**Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-10 (user ruling: the 0.3.0
follow-ups are patch CRs in wave 8)

## Problem

Found while releasing 0.3.0 (2026-10-10).

1. **A release can finish with no release notes.** The notes are a release task (`RELEASING.md`
   step 3): the version's `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md`, written on the release
   branch before `finish`. `create-release` uses that section as the GitHub Release body. When the
   section is missing, it falls back to GitHub's generated notes with a warning, because a tag must
   always get a release. By then the tag is pushed and master is merged. Nothing stops `scripts/release.sh
   finish` from tagging a release whose notes were never written; 0.3.0 shipped that way and its
   notes were added after.
2. **`finish`'s provenance report lists voided CRs as work that never landed.** The 0.3.0 report
   printed `6 unplaceable queued CR(s) — NEVER landed: CR-CRU-082 CR-CRU-141 CR-CRU-144 CR-CRU-151
   CR-CRU-152 CR-CRU-153`. CR-CRU-082, 141 and 144 are VOID: CR-CRU-147 ruled that a voided CR is
   not queued work, and the queue rows carry `lifecycle: VOID`. Only 151–153, which are pending in
   0.4.0, are queued work that hasn't landed.

## Steps

### §S1 — a release needs its notes before it is tagged

`finish X.Y.Z` gains a third preflight guard, beside the manifest and tag-prefix guards. Like them,
it runs before any merge, and under `--dry-run` too. It refuses when `CHANGELOG.md` has no line that
begins `## [X.Y.Z] - ` followed by a `YYYY-MM-DD` date, or when that section has no content before
the next `## [`. The refusal names the file, the heading it expected, and `RELEASING.md` step 3.

### §S2 — the provenance report skips voided CRs

A queue row whose lifecycle is VOID (or SUPERSEDED) is not reported as unplaceable, in either of the
report's two lists. It is not queued work.

## Acceptance criteria

- [ ] In a scratch release repo whose `CHANGELOG.md` lacks `## [9.9.9] - <date>`, `finish 9.9.9`
      (and `finish 9.9.9 --dry-run`) exits non-zero before any merge. Stderr contains
      `CHANGELOG.md`, `## [9.9.9]` and `RELEASING.md`, and `master` and the tags are unchanged.
- [ ] The same refusal holds for a section that exists but is empty before the next `## [`.
- [ ] With the section present and non-empty, `finish 9.9.9` proceeds exactly as today. Every
      existing release-driver, release-reporting and release-provenance test passes, with each of
      their scratch repos given a `CHANGELOG.md` section for the version it finishes.
- [ ] With queue rows for a VOID CR, a SUPERSEDED CR and a PENDING CR, none of which has landed,
      `finish`'s report names only the PENDING CR as never landed.
- [ ] `RELEASING.md`'s guard table lists the third guard, its failure and its remedy.

## How it is worked

On a feature branch: RED (the refusals and the report case), GREEN in `scripts/release.sh`, then
verify.
