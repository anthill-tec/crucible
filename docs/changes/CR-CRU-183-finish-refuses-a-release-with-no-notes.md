# CR-CRU-183 — `finish` refuses a release with no notes, and its report skips voided CRs

**Type** fix (patch CR, after the 0.3.0 release) · **Points** 8 (3 at filing; raised at gap analysis
and its pre-review 2026-10-21 for the shared notes extractor and the `queue --format json` read) ·
**Wave** 8 (0.4.0) · **Depends on** — · **Status** DONE — filed 2026-10-10 (user ruling: the 0.3.0
follow-ups are patch CRs in wave 8); merged 2026-10-21 (plan 204, cycles 722–728, gate 7864/0)

## Problem

Found while releasing 0.3.0 (2026-10-10).

1. **A release can finish with no release notes.** The notes are a release task (`RELEASING.md`
   step 3): the version's `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md`, written on the release
   branch before `finish`. `create-release` takes that section as the GitHub Release body through its
   own `awk` (from the line that begins `## [X.Y.Z]` up to the next `## [`, link-reference lines
   skipped); with no section it falls back to GitHub's generated notes with a warning, because a tag
   must always get a release. By then the tag is pushed and master is merged. Nothing stops
   `scripts/release.sh finish` from tagging a release whose notes were never written; 0.3.0 shipped
   that way and its notes were added after.
2. **`finish`'s provenance report lists voided CRs as work that never landed.** The 0.3.0 report
   printed `6 unplaceable queued CR(s) — NEVER landed: CR-CRU-082 CR-CRU-141 CR-CRU-144 CR-CRU-151
   CR-CRU-152 CR-CRU-153`. CR-CRU-082, 141 and 144 are VOID: CR-CRU-147 ruled that a voided CR is not
   queued work, and each queue row carries its `lifecycle`. The report's readers split the `queue`
   envelope's rows on commas, so a field after a quoted title holding a comma is misread (CR-CRU-144's
   `lifecycle` reads wrong on the live board, measured 2026-10-21).

Measured 2026-10-21: `finish` commits the manifest alignment before its manifest and tag-prefix
guards, under `--dry-run` too; git-flow's clean-tree check ignores untracked files, and that commit
sweeps in whatever is staged, so notes that are written but uncommitted would pass a working-tree
check and still miss the tag; `RELEASING.md` says "two preflight guards" though the identity guard is
a third, and says `finish`'s first preflight asserts the manifest.

## Design (settled with the user, 2026-10-21)

- One extractor prints a version's notes; the `finish` guard and the workflow's `create-release` both
  read the notes through it.
- The guard reads the notes as committed at the release branch's HEAD, which is what the tag and
  `create-release` see.
- The guard is stricter than `create-release`: it refuses whenever `create-release` would fall back,
  and also when the version's heading carries no date.
- The provenance report reads the queue as JSON (`queue --format json`), not by splitting text rows.

## Steps

### §S1 — one extractor for a version's notes

`scripts/release-notes.sh X.Y.Z [FILE]` (committed executable) reads `FILE`, `-` for standard input,
or `CHANGELOG.md` in the current directory when no file is given, ignoring carriage returns. It
prints the version's section by `create-release`'s rule: from the first line that begins
`## [X.Y.Z]` (exclusive) up to the next line that begins `## [`, skipping lines that match
`^\[[^]]+\]: `. It exits 0 when what it printed holds a non-whitespace character, 1 when it does not
(no such heading, an empty or whitespace-only section, or no such file), and 2 with a usage message
for a missing version or extra arguments.

The `create-release` step in `.github/workflows/release.yml` takes its notes from it in place of its
own `awk`, inside an `if`, so a non-zero exit still reaches the generated-notes fallback and its
warning under the step's `bash -e`.

### §S2 — a release needs its notes before anything is written

`finish X.Y.Z` gains a notes guard that runs right after the identity guard and before the manifest
is aligned, on `release/*` and `hotfix/*` alike and under `--dry-run` too, so a refused `finish`
makes no commit, merges nothing and tags nothing. It reads `CHANGELOG.md` as committed at HEAD
(`git show HEAD:CHANGELOG.md`), finds the extractor beside `release.sh` itself, and refuses when the
heading the extractor would read is not `## [X.Y.Z] - YYYY-MM-DD`, or when the extractor exits
non-zero. The refusal goes through `error()` to stderr with exit 1, and names `CHANGELOG.md`, the
heading it expected, and `RELEASING.md` step 3.

### §S3 — the provenance report reads the queue as JSON and skips voided and superseded CRs

Every client's `queue` verb gains `--format json`, emitting the same envelope as one JSON object, as
`status --format json` does. `release.sh` reads the queue through it (one read, parsed as JSON as
`plan_merge_map` parses `landings`), in place of its text readers. A row whose `lifecycle` is VOID or
SUPERSEDED is not reported as unplaceable, in either the evicted or the never-landed list, on both
paths that report (`finish` and `backfill-releases`).

### §S4 — the runbook says so

`RELEASING.md` names the three preflight guards in order (identity, notes, then the manifest and
tag-prefix checks after the alignment), each with its failure and remedy; step 3 says `finish`
refuses without the committed, dated notes; the stale "first preflight asserts the manifest" text
(step 1 and "On `set-version`") is corrected. `release.sh`'s `usage()` and header comment state the
same order.

## Acceptance criteria

- [x] **The extractor.** On fixture changelogs, `scripts/release-notes.sh X.Y.Z FILE` prints exactly
      the version's body (no heading, no next section, no link-reference lines; CRLF read as LF) and
      exits 0; for no heading, an empty section, a whitespace-only or link-references-only section,
      a missing file, and a `9.9.90` heading asked for `9.9.9`, its stdout holds no non-whitespace
      character and it exits 1; with no version or extra arguments it exits 2. Reading `-` takes
      standard input. The script is committed with mode 100755.
- [x] **The workflow uses it.** The `create-release` step calls `scripts/release-notes.sh "$TAG"`
      inside an `if` and carries no section `awk`. Its run body, executed with a stubbed `gh` (as
      `cr009-release-bundle.test.ts` executes the publish-npm body), creates the release from the
      notes when the section exists, and falls back to `--generate-notes` with its warning when it
      does not.
- [x] **No notes, no release.** In a scratch release repo with a stale `package.json` version whose
      committed `CHANGELOG.md` lacks the version's section, `finish 9.9.9` and
      `finish 9.9.9 --dry-run` each exit 1; stderr names `CHANGELOG.md`, `## [9.9.9] - ` and
      `RELEASING.md`; the release branch has no new commit; `master` and the tags are unchanged. The
      same on a `hotfix/9.9.9` branch, and with no `CHANGELOG.md` at all.
- [x] **Only committed, dated notes count.** The same refusal holds for an undated `## [9.9.9]`
      heading, for a dated section whose body is empty, whitespace or link references only, and for
      a dated section that exists only uncommitted (staged, or untracked).
- [x] **With notes, unchanged.** With the dated section committed, `finish 9.9.9` proceeds exactly as
      today. The release tests that run `finish` (`release-driver`, `release-reporting`,
      `release-reporting-live`) pass, with each scratch world given a committed `CHANGELOG.md`
      section for the version it finishes (test edits authorised by this criterion, in their own
      commit); each refusal test of an existing guard still asserts that guard's own message.
- [x] **`queue --format json`.** In every client, `queue --format json` prints one JSON object
      carrying the same rows and fields as the text envelope, `lifecycle` included; the verb census
      and the fleet parity tests pass.
- [x] **Voided work is not queued work.** With queue rows for a VOID CR whose title contains a comma,
      a SUPERSEDED CR and a PENDING CR, none of which has landed, `finish`'s report and
      `backfill-releases`' report name only the PENDING CR as never landed; and a VOID CR that a
      stored release record names (voided before the release record was written) is not reported as
      evicted.
- [x] **The runbook.** `RELEASING.md`'s guard table lists the three guards in order with failures and
      remedies; step 3 says `finish` refuses without committed, dated notes; no text says the first
      preflight asserts the manifest; `release.sh --help` names the notes guard.

## Non-goals

- Writing or drafting the notes (CR-CRU-187).
- Checking the notes' content beyond its presence and the heading's date.
- `DN-release-process.md`, a research note, is not rewritten.
