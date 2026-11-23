#!/usr/bin/env bash
# Check the unit tiers as CI does: each named tier runs with its dependency
# hooks recording into its own log in a fresh temporary directory, then
# unit-verdict.py judges every log written.
#
#   scripts/hermetic/unit-check.sh [bun|python]...
#
# With no argument both tiers run, bun then python. Every named tier runs even
# when an earlier one failed, so one run reports everything. The exit is
# non-zero when any tier failed or the verdict found a dependency event (or a
# log the hooks never wrote). It runs from the repository root, whatever the
# caller's directory. See README.md.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$REPO"

if [ "$#" -eq 0 ]; then
    set -- bun python
fi
for tier in "$@"; do
    case "$tier" in
    bun | python) ;;
    *)
        echo "usage: $0 [bun|python]..." >&2
        exit 2
        ;;
    esac
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

failed=0
logs=()
for tier in "$@"; do
    case "$tier" in
    bun)
        log="$WORK/bun-unit.tsv"
        echo "unit-check: bun unit tier (hooks recording to $log)"
        if ! HERMETIC_EVENTS="$log" bun test --timeout 30000 \
            --preload ./scripts/hermetic/hooks/bun-preload.ts ./tests/unit; then
            echo "unit-check: the bun unit tier FAILED" >&2
            failed=1
        fi
        ;;
    python)
        log="$WORK/py-unit.tsv"
        echo "unit-check: python unit tier (hooks recording to $log)"
        if ! PYTHONPATH="$REPO/scripts/hermetic/hooks" HERMETIC_EVENTS="$log" \
            .venv/bin/python scripts/hermetic/tagging_runner.py tests/client/unit; then
            echo "unit-check: the python unit tier FAILED" >&2
            failed=1
        fi
        ;;
    esac
    logs+=("$log")
done

echo "unit-check: verdict over ${logs[*]}"
if ! python3 scripts/hermetic/unit-verdict.py "${logs[@]}"; then
    echo "unit-check: the unit verdict FAILED" >&2
    failed=1
fi

if [ "$failed" -ne 0 ]; then
    echo "unit-check: FAILED" >&2
    exit 1
fi
echo "unit-check: ok -- every tier passed and no dependency event was recorded"
