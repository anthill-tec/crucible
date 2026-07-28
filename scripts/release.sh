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
#   finish <X.Y.Z>       Preflight guards, then git flow finish + push.
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

  finish <X.Y.Z>    Run both preflight guards (manifest version, tag prefix),
                    then finish the git-flow release/hotfix and push master +
                    develop + tags. Allowed only on release/* or hotfix/*.

  status            Print the current branch and the derived version
                    (git describe --tags, leading 'v' stripped). Exit 0.

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

# ============================================================================
# Preflight guards (both run BEFORE any git-flow/push command, and also under
# --dry-run, which is a true preflight rather than an execution skip).
# ============================================================================

# Guard (a): the manual manifest must already carry the finish version.
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
        error "package.json version '$found' does not match finish version '$want' — run: scripts/release.sh set-version $want" "$EXIT_ERROR"
    fi
}

# Guard (b) (§S5): git-flow must be configured to cut vX.Y.Z tags. The setting
# lives in .git/config, which is not version-controlled, so it can only be
# asserted — an unset/wrong prefix would cut a tag every publish guard rejects.
guard_tag_prefix() {
    local prefix
    prefix="$(git config --get gitflow.prefix.versiontag || true)"
    if [ "$prefix" != "v" ]; then
        error "gitflow.prefix.versiontag is '$prefix' (expected 'v') — run: git config gitflow.prefix.versiontag v" "$EXIT_ERROR"
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

    # Format-preserving rewrite: replace only the value of the "version" key,
    # leaving all other bytes/formatting untouched (no JSON re-serialization).
    python3 - "$mf" "$VERSION" <<'PY'
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
        info "set-version: package.json already at $VERSION; nothing to commit"
        return "$EXIT_SUCCESS"
    fi
    git commit -q -m "chore(release): set package.json to $VERSION"
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

cmd_finish() {
    local branch
    branch="$(require_release_branch)"

    if [ -z "$VERSION" ]; then
        error "finish requires a version: release.sh finish <X.Y.Z>" "$EXIT_USAGE"
    fi

    # Preflight guards FIRST — before anything is printed or executed, and
    # regardless of --dry-run.
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
}

cmd_status() {
    local branch version
    branch="$(current_branch)"

    # Derive version from the latest tag; tolerate no-tag gracefully.
    if version="$(git describe --tags 2>/dev/null)"; then
        version="${version#v}"
    else
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
