#!/bin/bash

################################################################################
# release.sh
#
# CR-CRU-041 §S3 + §S5 — branch-gated release driver for Crucible.
#
# Wraps the git-flow release/hotfix finish + the Test-PyPI rehearsal dispatch
# behind a small, branch-aware CLI so a release step cannot be triggered from
# the wrong branch, and so the two release-day footguns (a manual manifest left
# at the previous version, and a missing `gitflow.prefix.versiontag`) are caught
# as preflights instead of after the merge has already happened.
#
# Subcommands:
#   set-version <X.Y.Z>  Format-preservingly rewrite + commit package.json.
#   checkpoint           gh workflow run release.yml --ref <branch>.
#   finish <X.Y.Z>       Align + commit the manifest, preflight guards, then git
#                        flow finish + push. NOTE: the alignment write/commit is
#                        real even under --dry-run (it must precede the merge);
#                        only the git-flow finish and the push are gated.
#   status               Print current branch + tag-derived version.
#
# Usage: ./scripts/release.sh <subcommand> [args] [--dry-run] [--verbose] [-h|--help]
################################################################################

set -euo pipefail

# ============================================================================
# Configuration & Defaults
# ============================================================================

# Exit codes
EXIT_SUCCESS=0
EXIT_ERROR=1
EXIT_USAGE=2

# Script variables (set via argument parsing)
SUBCOMMAND=""
VERSION=""
DRY_RUN=false
VERBOSE=false
# CR-CRU-080 §S1 — the ceremony's Crucible identity, from `--agent <id>`. Empty
# means "not given on the command line"; ceremony_agent() then falls back to
# $CRUCIBLE_AGENT.
AGENT=""

# ============================================================================
# Helper Functions
# ============================================================================

# Print error message to stderr and exit
error() {
    echo "ERROR: $1" >&2
    exit "${2:-$EXIT_ERROR}"
}

# Print info message (to stderr to not interfere with stdout contracts)
info() {
    echo "$1" >&2
}

# Print debug message (only if verbose)
debug() {
    if [ "$VERBOSE" = true ]; then
        echo "DEBUG: $1" >&2
    fi
}

# Show usage information (to stdout)
usage() {
    cat <<'EOF'
Usage: release.sh <subcommand> [args] [--agent <agentId>] [--dry-run] [--verbose] [-h|--help]

Branch-gated release driver for Crucible.

Subcommands:
  set-version <X.Y.Z>
                    Rewrite the manual manifest version to X.Y.Z and commit it.
                    Allowed only on release/* or hotfix/* branches.
                    Touches: package.json (format-preserving). The Python
                    version is hatch-vcs tag-derived and is never hand-edited.

  checkpoint        Dispatch the Test-PyPI rehearsal workflow for the current
                    branch. Allowed only on release/* or hotfix/* branches.
                    Runs: gh workflow run release.yml --ref <branch>

  finish <X.Y.Z>    Align package.json to X.Y.Z (committing it, so it lands on
                    the merge — no separate set-version run is needed), run the
                    preflight guards (ceremony identity, manifest version, tag
                    prefix), then finish the git-flow release/hotfix and push
                    master + develop + tags. Allowed only on release/* or
                    hotfix/*.

  status            Print the current branch and the derived version
                    (git describe --tags). Tags are bare SemVer (X.Y.Z).
                    Exit 0.

  backfill-releases
                    Retroactively record every already-shipped release as a
                    `release` milestone in Crucible, from the repo's bare-SemVer
                    tags (git tag + git rev-list -1 <tag>). Prints a per-tag
                    result and a final `N/M recorded` tally, and warns-not-fails
                    on a reporting error. Idempotent: the server collapses a
                    repeated (type, label, commit) release onto the row it
                    already holds (CR-CRU-080 §S3). Exit 0.

Options:
  --agent <agentId> The Crucible identity the release report is attributed to.
                    Falls back to $CRUCIBLE_AGENT when the flag is absent; the
                    flag wins when both are present. REQUIRED for `finish` and
                    `backfill-releases` — both refuse at preflight without one,
                    because the client has no identity fallback (CR-CRU-057) and
                    a report with no identity silently records nothing.
  --dry-run         Print the commands that would run without executing them.
                    Preflight guards still run and still refuse.
  --verbose         Print debug output.
  -h, --help        Show this help and exit 0.
EOF
}

# Current branch name
current_branch() {
    git rev-parse --abbrev-ref HEAD
}

# Repo root, so the script is correct when invoked by an absolute path.
repo_root() {
    git rev-parse --show-toplevel
}

# The single manual manifest (the Python version is tag-derived).
manifest_path() {
    echo "$(repo_root)/package.json"
}

# Require the current branch to be release/* or hotfix/*; exit 2 otherwise.
# Echoes the branch name on success.
require_release_branch() {
    local branch
    branch="$(current_branch)"
    case "$branch" in
        release/*|hotfix/*)
            echo "$branch"
            ;;
        *)
            error "must be run on a release/* or hotfix/* branch (current: $branch)" "$EXIT_USAGE"
            ;;
    esac
}

# Derive the git-flow kind (release|hotfix) from the current branch prefix.
branch_kind() {
    local branch="$1"
    case "$branch" in
        release/*) echo "release" ;;
        hotfix/*) echo "hotfix" ;;
        *) error "cannot derive git-flow kind from branch: $branch" "$EXIT_USAGE" ;;
    esac
}

# Read the "version" value out of a JSON manifest.
read_manifest_version() {
    python3 - "$1" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)
print(data.get("version", ""))
PY
}

# Bring the manual manifest to $1, committing it if (and only if) that changed
# anything. The SINGLE write path for the manifest version — used by both
# `set-version` and `finish` (CR-CRU-061 §S7), so the two can never diverge.
#
# The rewrite is format-preserving: only the value of the "version" key is
# replaced, leaving every other byte untouched (no JSON re-serialization). A
# manifest with NO "version" key therefore matches nothing and is left alone —
# it genuinely cannot be aligned, and guard_manifest_version stays fatal for it.
#
# Idempotent: an already-aligned manifest produces no diff and no commit.
align_manifest_version() {
    local want="$1"
    local mf
    mf="$(manifest_path)"

    if [ ! -f "$mf" ]; then
        debug "align: no manifest at $mf; nothing to do"
        return "$EXIT_SUCCESS"
    fi

    python3 - "$mf" "$want" <<'PY'
import re
import sys

path, new_version = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as fh:
    text = fh.read()
text = re.sub(
    r'("version"\s*:\s*")[^"]*(")',
    lambda m: m.group(1) + new_version + m.group(2),
    text,
    count=1,
)
with open(path, "w", encoding="utf-8") as fh:
    fh.write(text)
PY

    git add "$mf"
    if git diff --cached --quiet; then
        info "package.json unchanged (no version value was rewritten to $want); nothing to commit"
        return "$EXIT_SUCCESS"
    fi
    git commit -q -m "chore(release): set package.json to $want"
}

# ============================================================================
# Preflight guards (both run BEFORE any git-flow/push command, and also under
# --dry-run, which is a true preflight rather than an execution skip).
# ============================================================================

# Guard (a): the manual manifest must carry the finish version. Since
# CR-CRU-061 §S7 `finish` aligns the manifest itself first, so this guard is an
# invariant the script maintains rather than a wall the operator hits — it fires
# only when the manifest genuinely CANNOT be aligned (e.g. no "version" key at
# all for the format-preserving rewrite to substitute).
guard_manifest_version() {
    local want="$1"
    local mf
    mf="$(manifest_path)"

    if [ ! -f "$mf" ]; then
        return "$EXIT_SUCCESS"
    fi

    local found
    found="$(read_manifest_version "$mf")"
    if [ "$found" != "$want" ]; then
        error "package.json version '$found' could not be aligned to the finish version '$want' — the manifest has no \"version\" key to rewrite; add one and retry" "$EXIT_ERROR"
    fi
}

# Guard (b) (CR-CRU-061 §S1, superseding CR-CRU-041 §S5): git-flow must be
# configured to cut BARE SemVer tags (X.Y.Z, no prefix). The setting lives in
# .git/config, which is not version-controlled, so it can only be asserted — a
# wrong prefix would cut a tag every publish guard rejects.
#
# 🚨 MEASURED: git-flow distinguishes UNSET from SET-TO-EMPTY. With the key
# UNSET, git-flow dies with "Fatal: Version tag not set"; with it explicitly set
# to the empty string it works and cuts bare tags. So the ONLY valid state is
# set-and-empty, and `git config --get`'s exit status (1 = key absent, 0 = key
# present, even with an empty value) is what tells the two apart — a plain
# `|| true` capture cannot.
guard_tag_prefix() {
    local prefix
    if ! prefix="$(git config --get gitflow.prefix.versiontag)"; then
        error 'gitflow.prefix.versiontag is UNSET (git-flow itself refuses to run in that state) — run: git config gitflow.prefix.versiontag ""' "$EXIT_ERROR"
    fi
    if [ -n "$prefix" ]; then
        error "gitflow.prefix.versiontag is '$prefix' (expected the empty string, for bare X.Y.Z tags) — run: git config gitflow.prefix.versiontag \"\"" "$EXIT_ERROR"
    fi
}

# Guard (c) (CR-CRU-080 §S1/§S2): the ceremony's Crucible identity, resolved
# EXPLICITLY — `--agent <id>` first, then the documented $CRUCIBLE_AGENT. There
# is deliberately no third source: $WORKFLOW_ROLE carries the track lane rather
# than an identity, and a filename- or role-derived default would plant a
# phantom row on the agent rail (CR-CRU-057). Echoes the identity, or nothing.
ceremony_agent() {
    if [ -n "$AGENT" ]; then
        echo "$AGENT"
        return 0
    fi
    echo "${CRUCIBLE_AGENT:-}"
}

# An absent identity is a PREFLIGHT refusal, not a warning after the fact: the
# client requires `--agent` and has no fallback, so a ceremony without one
# publishes a tag Crucible never learns about. Refusing here means the operator
# finds out BEFORE the tag exists, when it is still free to fix.
guard_agent_identity() {
    if [ -n "$(ceremony_agent)" ]; then
        return 0
    fi
    error "no Crucible identity for the release report — pass --agent <agentId> or set \$CRUCIBLE_AGENT. There is no fallback and no default (CR-CRU-057), and a release reported without one records nothing." "$EXIT_ERROR"
}

# ============================================================================
# Subcommand implementations
# ============================================================================

# Rewrite the manual manifest version to $VERSION and commit it.
# Branch-gated (release/* or hotfix/* only) and version-validated (X.Y.Z).
cmd_set_version() {
    local branch
    branch="$(require_release_branch)"
    debug "set-version on branch: $branch"

    # Validate the version string (must be exactly X.Y.Z).
    if [ -z "$VERSION" ] || ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        error "set-version requires a version X.Y.Z (got: '$VERSION')" "$EXIT_USAGE"
    fi

    local mf
    mf="$(manifest_path)"

    if [ "$DRY_RUN" = true ]; then
        echo "set-version: would set version to $VERSION in:"
        if [ -f "$mf" ]; then
            echo "  $mf"
        else
            echo "  (no manifest found)"
        fi
        return "$EXIT_SUCCESS"
    fi

    if [ ! -f "$mf" ]; then
        info "set-version: no manifest found; nothing to do"
        return "$EXIT_SUCCESS"
    fi

    align_manifest_version "$VERSION"
}

cmd_checkpoint() {
    local branch
    branch="$(require_release_branch)"

    local gh_cmd="gh workflow run release.yml --ref $branch"

    if [ "$DRY_RUN" = true ]; then
        echo "$gh_cmd"
        return "$EXIT_SUCCESS"
    fi

    debug "dispatching: $gh_cmd"
    gh workflow run release.yml --ref "$branch"
}

# CR-CRU-074 §S2 — report the shipped release to Crucible, through the repo
# client (never a bare curl). Called ONLY after `git push … --tags` has
# published the tag, so a recorded release always corresponds to a tag the
# remote actually received. The version is the TAG's bare SemVer and the commit
# is the tagged sha — never a value guessed from the CLI argument. A reporting
# failure (including an absent/malformed tag) must NOT fail the release, since
# the tag is already public: warn, naming the version, and return success.
report_release() {
    local tag prefix version sha

    if ! tag="$(git describe --tags --abbrev=0 2>/dev/null)" || [ -z "$tag" ]; then
        info "WARN: could not read the release tag; release $VERSION was NOT reported to Crucible"
        return "$EXIT_SUCCESS"
    fi

    # Strip the git-flow versiontag prefix (guarded to empty) to get bare SemVer.
    prefix="$(git config --get gitflow.prefix.versiontag 2>/dev/null || true)"
    version="${tag#"$prefix"}"

    if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        info "WARN: release tag '$tag' is not bare SemVer; release $VERSION was NOT reported to Crucible"
        return "$EXIT_SUCCESS"
    fi

    if ! sha="$(git rev-list -n 1 "$tag" 2>/dev/null)" || [ -z "$sha" ]; then
        info "WARN: could not resolve the commit for tag '$tag'; release $version was NOT reported to Crucible"
        return "$EXIT_SUCCESS"
    fi

    # CR-CRU-080 §S2/AC3 — non-fatal AFTER publication: the tag is already
    # public, so a transport failure warns (with its recovery command, printed
    # by the reporter) and the ceremony still exits successfully.
    emit_release_milestone "$version" "$sha" || true
    # CR-CRU-081 §S2 — same tally on the live path: an incomplete `crs` must be
    # visible at the moment it is produced, not only in a backfill.
    report_unplaceable_crs
    return "$EXIT_SUCCESS"
}

# CR-CRU-080 §S4 — WHEN a release shipped: the commit date of the commit its tag
# points at, in epoch SECONDS (git's `%ct`). This is deliberately NOT the ingest
# time Crucible stamps when the report lands — that is when the release was
# RECORDED, which is why the three hand-backfilled releases all claimed the
# backfill's own minute while their tags were days older. Empty when git cannot
# answer, in which case nothing is reported rather than a guessed date.
release_ship_date() {
    git log -1 --format=%ct "$1" 2>/dev/null || true
}

# CR-CRU-081 §S1 — the release tags in ship order: bare SemVer only (a
# v-prefixed or non-release tag is never a release), version-sorted, so
# "the EARLIEST tag containing a commit" is well defined.
release_tags() {
    git tag 2>/dev/null \
        | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
        | sort -V || true
}

# CR-CRU-081 §S1 — the CR → landing-sha map the project ALREADY keeps: every
# CLOSED plan's `merge.commit`, read through the client's existing `plans` verb
# (its `mergeCommit` column). One line per closed plan, `<cr> <sha>`, with the
# sha absent when the plan recorded none. No new read surface, no DB access,
# and — the whole point of CR-CRU-081 — no prose parsed.
#
# Tolerant by construction: an unreachable or failing client yields NO lines, so
# provenance is simply omitted rather than invented. A release is published
# before it is reported and must never fail on its own provenance.
plan_merge_map() {
    local client
    client="$(repo_root)/clients/python-crucible.py"

    python3 "$client" plans --fields mergeCommit 2>/dev/null \
        | awk '
            /^[[:space:]]*plans\[[0-9]+\]\{/ {
                header = $0
                sub(/^[^{]*\{/, "", header)
                sub(/\}.*$/, "", header)
                cols = split(header, name, ",")
                for (i = 1; i <= cols; i++) col[name[i]] = i
                next
            }
            cols > 0 {
                row = $0
                gsub(/"/, "", row)
                if (split(row, v, ",") < cols) next
                cr = v[col["cr"]]
                gsub(/^[[:space:]]+|[[:space:]]+$/, "", cr)
                if (cr !~ /^CR-[A-Z]+-[0-9]+$/) next
                if (v[col["status"]] != "closed") next
                sha = v[col["mergeCommit"]]
                print cr, (sha == "null" ? "" : sha)
            }' \
        | sort -u || true
}

# CR-CRU-081 §S1 — the EARLIEST bare-SemVer tag whose history contains `sha`
# (`git merge-base --is-ancestor`, the ancestry primitive itself), or EMPTY when
# no tag contains it. Empty is not a gap: it is a CR that landed after the
# newest tag and has simply not shipped yet.
earliest_tag_containing() {
    local sha="$1" tag

    while IFS= read -r tag; do
        [ -n "$tag" ] || continue
        if git merge-base --is-ancestor "$sha" "$tag" >/dev/null 2>&1; then
            printf '%s\n' "$tag"
            return "$EXIT_SUCCESS"
        fi
    done < <(release_tags)

    return "$EXIT_SUCCESS"
}

# CR-CRU-081 §S1 — WHAT a release shipped: every CR whose RECORDED landing
# commit is an ancestor of this tag and of no earlier one, comma-separated for
# the client's `--crs`.
#
# This replaces CR-CRU-080 §S4's scan of MERGE-COMMIT SUBJECTS, which silently
# dropped every CR that landed by fast-forward or squash (measured: CR-CRU-021
# and CR-CRU-023 shipped in 0.1.0 and appeared in no release's `crs`). Ancestry
# is exact and text-independent (AC6): nothing here reads a commit message.
#
# Attributing to the EARLIEST containing tag keeps the per-release sets a
# partition (CR-080 AC10), which holds even when the tags are not one straight
# ancestry chain.
#
# Git is still the half only the repo can answer; which of these ids the project
# actually REGISTERED is the queue's half, intersected in the client on this
# side of the wire, so git never enters the server's path.
release_crs() {
    local version="$1" cr sha
    local -a shipped=()

    while read -r cr sha; do
        [ -n "$sha" ] || continue
        if [ "$(earliest_tag_containing "$sha")" = "$version" ]; then
            shipped+=("$cr")
        fi
    done < <(plan_merge_map)

    [ "${#shipped[@]}" -gt 0 ] || return "$EXIT_SUCCESS"
    printf '%s\n' "${shipped[@]}" | sort -u | paste -sd, - || true
}

# CR-CRU-081 §S2 — the project's registered CR QUEUE and its `cr-merged` landing
# markers, read through the client's `queue` verb (one call, both sources). The
# queue is what says which CR ids the project ever filed; the two landing
# sources together say which of them Crucible knows the landing of.
#
# Tolerant exactly as `plan_merge_map` is: an unreachable or failing client
# yields NO output, so the ceremony reports what it can rather than failing on
# its own reporting — a published release must never be blocked by a gap in the
# report about it.
queue_read() {
    python3 "$(repo_root)/clients/python-crucible.py" queue 2>/dev/null || true
}

# The CR ids the queue holds, one per line, from a `queue` envelope on stdin.
queued_crs() {
    awk '
        /^[[:space:]]*queue\[[0-9]+\]\{/ {
            header = $0
            sub(/^[^{]*\{/, "", header)
            sub(/\}.*$/, "", header)
            cols = split(header, name, ",")
            for (i = 1; i <= cols; i++) col[name[i]] = i
            next
        }
        cols > 0 {
            row = $0
            gsub(/"/, "", row)
            if (split(row, v, ",") < cols) next
            cr = v[col["cr"]]
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", cr)
            if (cr ~ /^CR-[A-Z]+-[0-9]+$/) print cr
        }' | sort -u || true
}

# The CR ids a `cr-merged` milestone covers — the SECOND landing source — from
# the same envelope, one per line.
cr_merged_crs() {
    awk -F': ' '/^[[:space:]]*crMerged\[[0-9]+\]:/ {
            gsub(/,/, "\n", $2)
            print $2
        }' | tr -d ' ' | grep -E '^CR-[A-Z]+-[0-9]+$' | sort -u || true
}

# CR-CRU-081 §S2 — name and COUNT the CRs ancestry could not place, in the TWO
# distinct classes §S2 defines, so "tracked, but the landing sha is missing" is
# never read as "Crucible has no record of this CR landing at all":
#
#   1. a plan that is CLOSED (the CR landed) yet records no merge commit, so
#      there is no sha to test ancestry against;
#   2. a CR the project QUEUED for which no landing record exists at any source
#      — no closed plan, and no `cr-merged` milestone either. This is the class
#      that was invisible: ancestry cannot place such a CR and nothing reported
#      it, so 0.1.0's provenance shrank from 58 CRs to 51 in total silence.
#
# Each class is counted and described SEPARATELY, on its own line, with disjoint
# id sets — one shared total would re-create exactly the confusion §S2 names.
#
# Reporting places nothing: a named CR stays absent from every release's `crs`,
# because Crucible genuinely does not know where it landed and inventing a
# placement would be fabrication.
#
# A CR whose sha IS recorded but precedes no tag is in NEITHER class: it landed
# after the newest tag, which is placement, not a gap.
report_unplaceable_crs() {
    local cr sha queue_out tracked="" merged=""
    local -a missing_sha=() no_record=()

    while read -r cr sha; do
        [ -n "$cr" ] || continue
        tracked="$tracked $cr"
        [ -n "$sha" ] || missing_sha+=("$cr")
    done < <(plan_merge_map)

    queue_out="$(queue_read)"
    merged=" $(printf '%s\n' "$queue_out" | cr_merged_crs | paste -sd' ' -) "
    while IFS= read -r cr; do
        [ -n "$cr" ] || continue
        [[ " $tracked " != *" $cr "* ]] || continue
        [[ "$merged" != *" $cr "* ]] || continue
        no_record+=("$cr")
    done < <(printf '%s\n' "$queue_out" | queued_crs)

    if [ "${#missing_sha[@]}" -gt 0 ]; then
        info "provenance: ${#missing_sha[@]} unplaceable CR(s) — tracked, but the landing sha is missing: the plan is closed and records no merge commit, so there is no commit to test ancestry against: ${missing_sha[*]}"
    fi
    if [ "${#no_record[@]}" -gt 0 ]; then
        info "provenance: ${#no_record[@]} unplaceable queued CR(s) — no landing record at all: Crucible holds neither a closed plan nor a cr-merged milestone for them, so where they landed is unknown: ${no_record[*]}"
    fi
}

# The SINGLE release-report path: report one (version, sha) pair as a `release`
# milestone through the repo client (never a bare curl), declaring the
# ceremony's identity (CR-CRU-080 §S1) — the client requires it and has no
# fallback, so a report without one posts nothing.
#
# Idempotent: the server collapses a repeated (type, label, commit) release onto
# the row it already holds (CR-CRU-080 §S3). It did NOT do so before — the
# comment that used to claim it here was false, and a re-run of the backfill
# duplicated every release.
#
# CR-CRU-080 §S4 — the SAME single path also carries the release's provenance:
# when it shipped and what it shipped, each reported only when git actually
# answered, so an unanswerable field is omitted rather than invented.
#
# Returns non-zero when the report failed, having printed the warning AND the
# single-line recovery command carrying the tag's sha (and its provenance, so
# the recovery records the same release, not a poorer one). Whether that is
# fatal is the CALLER's call: after publication it never is (report_release
# swallows it), while the backfill counts it into its tally.
emit_release_milestone() {
    local version="$1" sha="$2" client agent ship_date crs shown=""
    local -a provenance=()

    agent="$(ceremony_agent)"
    client="$(repo_root)/clients/python-crucible.py"

    ship_date="$(release_ship_date "$sha")"
    if [ -n "$ship_date" ]; then
        provenance+=(--released-at "$ship_date")
        shown="$shown --released-at $ship_date"
    fi
    crs="$(release_crs "$version")"
    if [ -n "$crs" ]; then
        provenance+=(--crs "$crs")
        shown="$shown --crs $crs"
    fi

    if python3 "$client" milestone --type release --label "$version" \
        --commit "$sha" --agent "$agent" ${provenance[@]+"${provenance[@]}"}; then
        return "$EXIT_SUCCESS"
    fi

    info "WARN: release $version is NOT recorded in Crucible; the release itself is published and complete"
    info "  recover with: python3 $client milestone --type release --label $version --commit $sha --agent $agent$shown"
    return "$EXIT_ERROR"
}

# CR-CRU-074 §S4 — retroactively record the releases that already shipped, so
# the board is not permanently missing its own history. Enumerate the repo's
# tags (`git tag`), keep ONLY bare SemVer (X.Y.Z) — a v-prefixed or non-release
# tag is never a release — and report each as a `release` milestone through the
# SAME path §S2 built (emit_release_milestone → the repo client), with the
# commit resolved from `git rev-list -n 1 <tag>`, never a guessed value or a
# gate's intent text.
#
# CR-CRU-080 §S1/§S3 — the identity is a PREFLIGHT: a backfill with none cannot
# spend one client call per tag discovering that it has no identity, so it
# refuses before the first. Idempotent through the SERVER's dedup on
# (type, label, commit), so a re-run converges on the rows already held rather
# than duplicating each release. Every tag gets a named result, and the run ends
# with an `N/M recorded` tally naming whatever did not land — a partial failure
# has to be readable in the exit summary, not only mid-log. Reporting stays
# warns-not-fails, so the exit is 0 even with a failed tag or no SemVer tags.
cmd_backfill_releases() {
    local tags tag sha total=0 recorded=0
    local -a failed=()

    guard_agent_identity

    tags="$(git tag)"
    for tag in $tags; do
        if ! printf '%s' "$tag" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
            continue
        fi
        total=$((total + 1))
        if ! sha="$(git rev-list -n 1 "$tag" 2>/dev/null)" || [ -z "$sha" ]; then
            info "  $tag: NOT backfilled — could not resolve the tag's commit"
            failed+=("$tag")
            continue
        fi
        if emit_release_milestone "$tag" "$sha"; then
            info "  $tag: recorded ($sha)"
            recorded=$((recorded + 1))
        else
            failed+=("$tag")
        fi
    done

    # CR-CRU-081 §S2 — the provenance gap, once per ceremony run: whatever
    # ancestry could not place is named here rather than left invisible.
    report_unplaceable_crs

    if [ "${#failed[@]}" -eq 0 ]; then
        info "backfill-releases: $recorded/$total recorded"
    else
        info "backfill-releases: $recorded/$total recorded; NOT recorded: ${failed[*]}"
    fi

    return "$EXIT_SUCCESS"
}

cmd_finish() {
    local branch
    branch="$(require_release_branch)"

    if [ -z "$VERSION" ]; then
        error "finish requires a version: release.sh finish <X.Y.Z>" "$EXIT_USAGE"
    fi

    # CR-CRU-080 §S2/AC2 — the identity guard runs FIRST, before the manifest
    # is even aligned: a ceremony that cannot report must refuse to start, so
    # the operator learns while the tag does not yet exist. Everything after
    # this point either publishes or is a local, revertible commit.
    guard_agent_identity

    # CR-CRU-061 §S7 — align the manifest to the finish version OURSELVES, so a
    # release is ONE command. This write + commit is REAL even under --dry-run:
    # it must land on the release branch BEFORE the git-flow finish or it would
    # not be on the merge, and it is a purely local commit (only the terminal
    # `git flow ... finish` / `git push` are --dry-run-gated). Idempotent — an
    # already-aligned manifest yields no diff and no commit.
    align_manifest_version "$VERSION"

    # Preflight guards next — before anything is printed or executed, and
    # regardless of --dry-run. The manifest guard now fires only when the
    # manifest could not be aligned at all.
    guard_manifest_version "$VERSION"
    guard_tag_prefix

    local kind
    kind="$(branch_kind "$branch")"

    # Pass -m so git-flow does not open the annotated-tag editor (which
    # GIT_MERGE_AUTOEDIT does not suppress) — otherwise finish hangs
    # non-interactively.
    local flow_cmd="git flow $kind finish -m \"Release $VERSION\" $VERSION"
    local push_cmd="git push origin master develop --tags"

    if [ "$DRY_RUN" = true ]; then
        echo "$flow_cmd"
        echo "$push_cmd"
        return "$EXIT_SUCCESS"
    fi

    debug "finishing: $flow_cmd"
    GIT_MERGE_AUTOEDIT=no git flow "$kind" finish -m "Release $VERSION" "$VERSION"
    debug "pushing: $push_cmd"
    git push origin master develop --tags

    # CR-CRU-074 §S2 — the tag is now published; record the release.
    report_release
}

cmd_status() {
    local branch version
    branch="$(current_branch)"

    # Derive version from the latest tag; tolerate no-tag gracefully.
    if ! version="$(git describe --tags 2>/dev/null)"; then
        version="(no tag)"
    fi

    echo "branch:  $branch"
    echo "version: $version"
}

# ============================================================================
# Argument parsing
# ============================================================================

POSITIONAL=()
while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)
            usage
            exit "$EXIT_SUCCESS"
            ;;
        # CR-CRU-080 §S1 — the explicit identity source; wins over
        # $CRUCIBLE_AGENT (see ceremony_agent).
        --agent)
            if [ $# -lt 2 ] || [ -z "$2" ]; then
                echo "ERROR: --agent requires an agentId" >&2
                exit "$EXIT_USAGE"
            fi
            AGENT="$2"
            shift 2
            ;;
        --agent=*)
            AGENT="${1#--agent=}"
            if [ -z "$AGENT" ]; then
                echo "ERROR: --agent requires an agentId" >&2
                exit "$EXIT_USAGE"
            fi
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        -*)
            echo "ERROR: unknown flag: $1" >&2
            exit "$EXIT_USAGE"
            ;;
        *)
            POSITIONAL+=("$1")
            shift
            ;;
    esac
done

# First positional = subcommand, second = version (for set-version / finish)
if [ "${#POSITIONAL[@]}" -ge 1 ]; then
    SUBCOMMAND="${POSITIONAL[0]}"
fi
if [ "${#POSITIONAL[@]}" -ge 2 ]; then
    VERSION="${POSITIONAL[1]}"
fi

if [ -z "$SUBCOMMAND" ]; then
    usage >&2
    echo "ERROR: no subcommand given" >&2
    exit "$EXIT_USAGE"
fi

# ============================================================================
# Dispatch
# ============================================================================

case "$SUBCOMMAND" in
    set-version)
        cmd_set_version
        ;;
    checkpoint)
        cmd_checkpoint
        ;;
    finish)
        cmd_finish
        ;;
    status)
        cmd_status
        ;;
    backfill-releases)
        cmd_backfill_releases
        ;;
    *)
        echo "ERROR: unknown subcommand: $SUBCOMMAND" >&2
        exit "$EXIT_USAGE"
        ;;
esac
