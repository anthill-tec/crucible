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
Usage: release.sh <subcommand> [args] [--dry-run] [--verbose] [-h|--help]

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
                    the merge — no separate set-version run is needed), run both
                    preflight guards (manifest version, tag prefix), then finish
                    the git-flow release/hotfix and push master + develop +
                    tags. Allowed only on release/* or hotfix/*.

  status            Print the current branch and the derived version
                    (git describe --tags). Tags are bare SemVer (X.Y.Z).
                    Exit 0.

Options:
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
# Re-runs emit an identical (type, label, commit), so the server dedups.
report_release() {
    local tag prefix version sha client

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

    client="$(repo_root)/clients/python-crucible.py"
    if ! python3 "$client" milestone --type release --label "$version" --commit "$sha"; then
        info "WARN: reporting release $version to Crucible failed; the release is published and complete"
        return "$EXIT_SUCCESS"
    fi
}

cmd_finish() {
    local branch
    branch="$(require_release_branch)"

    if [ -z "$VERSION" ]; then
        error "finish requires a version: release.sh finish <X.Y.Z>" "$EXIT_USAGE"
    fi

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
    *)
        echo "ERROR: unknown subcommand: $SUBCOMMAND" >&2
        exit "$EXIT_USAGE"
        ;;
esac
