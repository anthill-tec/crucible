#!/bin/bash

################################################################################
# release-notes.sh
#
# The one extractor for a version's release notes. Prints the CHANGELOG.md
# section of version X.Y.Z: from the first line that begins `## [X.Y.Z]`
# (exclusive, a literal match) up to the next line that begins `## [`, skipping
# link-reference lines (`[label]: url`). Carriage returns are ignored.
#
# Both readers of release notes go through it: `release.sh finish` (refusing a
# release with no notes) and the release workflow's `create-release` step
# (choosing between the section and GitHub's generated notes).
#
# Usage: release-notes.sh X.Y.Z [FILE]
#   FILE  a changelog path, `-` for standard input, default ./CHANGELOG.md
#
# Exit: 0 notes printed (a non-whitespace character), 1 no notes (no heading,
#       empty or whitespace-only section, no such file), 2 usage error.
################################################################################

set -euo pipefail

usage() {
  echo "usage: release-notes.sh X.Y.Z [FILE]" >&2
  exit 2
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || [ -z "$1" ]; then
  usage
fi

VERSION="$1"
FILE="${2:-CHANGELOG.md}"

if [ "$FILE" != "-" ] && [ ! -r "$FILE" ]; then
  echo "release-notes.sh: no such changelog: $FILE" >&2
  exit 1
fi

# awk reads `-` as standard input. The END block's exit status is the verdict:
# 0 when any printed line held a non-whitespace character, 1 otherwise.
awk -v tag="$VERSION" '
  { gsub(/\r/, "") }
  index($0, "## [" tag "]") == 1 { on = 1; next }
  on && /^## \[/ { exit }
  on && /^\[[^]]+\]: / { next }
  on { print; if ($0 ~ /[^[:space:]]/) found = 1 }
  END { exit(found ? 0 : 1) }
' "$FILE"
