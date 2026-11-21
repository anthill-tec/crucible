#!/bin/sh
# Run a command hermetically, behind the board-port tripwire.
#
#   scripts/hermetic/run.sh <log-dir> -- <command...>
#
# Run it from the repository root. The command runs inside a new user and
# network namespace (only `lo`, up; no route), with every capability dropped,
# HOME pointed at an empty directory under <log-dir>, and the tripwire
# (tripwire.py) listening on 127.0.0.1 and ::1, ports 3849 and 3850. See
# README.md for the environment it exports and the exit codes.
set -u

EXIT_USAGE=90
EXIT_MISSING=91
EXIT_NAMESPACE=92
EXIT_NETWORK=93
EXIT_BANNER=94
EXIT_TRIPWIRE_DIED=95
EXIT_HIT=99

BANNER_WAIT_TENTHS=100
SOCKETS="127.0.0.1:3849 [::1]:3849 127.0.0.1:3850 [::1]:3850"

setup_failure() {
    code=$1
    shift
    echo "hermetic: SETUP FAILURE (exit $code): $*" >&2
    exit "$code"
}

drop_caps() {
    setpriv --ambient-caps -all --inh-caps -all --bounding-set -all --no-new-privs "$@"
}

if [ "$#" -lt 3 ] || [ "$2" != "--" ]; then
    echo "usage: $0 <log-dir> -- <command...>" >&2
    exit "$EXIT_USAGE"
fi

case "$0" in
*/*) HERE=$(cd "${0%/*}" && pwd) ;;
*) HERE=$PWD ;;
esac
SELF="$HERE/run.sh"

case "${HERMETIC_STAGE:-}" in
"")
    # Outside: check the tools, build the environment, enter the namespace.
    for tool in unshare setpriv ip python3; do
        command -v "$tool" >/dev/null 2>&1 \
            || setup_failure "$EXIT_MISSING" "\`$tool\` is not on PATH"
    done
    mkdir -p "$1" || setup_failure "$EXIT_USAGE" "cannot create the log dir $1"
    LOG_DIR=$(cd "$1" && pwd)
    shift 2

    ORIGINAL_HOME=${HOME:?HOME is not set}
    SUITE_CACHE="$PWD/.cache/test-suite"
    export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$ORIGINAL_HOME/.cache/ms-playwright}"
    export RUSTUP_HOME="${RUSTUP_HOME:-$ORIGINAL_HOME/.rustup}"
    export CARGO_HOME="${CARGO_HOME:-$ORIGINAL_HOME/.cargo}"
    export ARDUINO_DIRECTORIES_DATA="${ARDUINO_DIRECTORIES_DATA:-$ORIGINAL_HOME/.arduino15}"
    if [ -z "${GOROOT:-}" ] && command -v go >/dev/null 2>&1; then
        GOROOT=$(go env GOROOT) || setup_failure "$EXIT_MISSING" "\`go env GOROOT\` failed"
    fi
    if [ -n "${GOROOT:-}" ]; then
        export GOROOT
    fi
    export GOPATH="$SUITE_CACHE/go"
    export GOMODCACHE="$SUITE_CACHE/go-mod"
    export GOCACHE="$SUITE_CACHE/go-build"
    export DOCKER_HOST="unix:///nonexistent"
    rm -rf "${LOG_DIR:?}/home"
    mkdir "$LOG_DIR/home" || setup_failure "$EXIT_USAGE" "cannot create $LOG_DIR/home"
    export HOME="$LOG_DIR/home"
    # Each XDG base directory would point past the redirected HOME.
    unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME
    # The operator's registry variables (direnv exports the root .env into the
    # shell): the same set the suites drop, ENV_REGISTRY_VARIABLES in
    # tests/client/__init__.py and tests/helpers/isolated-store-preload.ts.
    unset CRUCIBLE_PROJECT_KEY CRUCIBLE_PROJECT_NAME WORKFLOW_ORCHESTRATOR \
        SANDESH_PROJECT SANDESH_ADDRESS PROJECT_TOKEN PROJECT_STACKS \
        KNOWLEDGE_CATEGORY

    if ! unshare --map-current-user --keep-caps -n true 2>"$LOG_DIR/unshare.err"; then
        setup_failure "$EXIT_NAMESPACE" \
            "the kernel refused an unprivileged network namespace: $(cat "$LOG_DIR/unshare.err")"
    fi
    HERMETIC_STAGE=namespace exec unshare --map-current-user --keep-caps -n \
        sh "$SELF" "$LOG_DIR" -- "$@"
    ;;
namespace)
    # Inside the namespace, still privileged in it: bring lo up, drop every
    # capability, re-enter.
    LOG_DIR=$1
    shift 2
    ip link set lo up || setup_failure "$EXIT_NETWORK" "cannot bring lo up"
    drop_caps true || setup_failure "$EXIT_NETWORK" "setpriv cannot drop the capabilities"
    HERMETIC_STAGE=dropped exec setpriv --ambient-caps -all --inh-caps -all \
        --bounding-set -all --no-new-privs sh "$SELF" "$LOG_DIR" -- "$@"
    ;;
dropped)
    LOG_DIR=$1
    shift 2
    ;;
*)
    setup_failure "$EXIT_USAGE" "unknown HERMETIC_STAGE=$HERMETIC_STAGE"
    ;;
esac
unset HERMETIC_STAGE

# The preamble: what the command's own shell sees.
echo "hermetic: ip -o addr"
ip -o addr
echo "hermetic: ip route"
ip route
echo "hermetic: ip -6 route"
ip -6 route
echo "hermetic: id"
id
echo "hermetic: capabilities"
while IFS= read -r line; do
    case "$line" in
    CapEff:* | CapBnd:*) echo "$line" ;;
    esac
done </proc/self/status
echo "hermetic: HOME=$HOME DOCKER_HOST=$DOCKER_HOST"

# The tripwire, with the hooks' environment stripped.
TRIPWIRE_LOG="$LOG_DIR/tripwire.log"
: >"$TRIPWIRE_LOG"
env -u PYTHONPATH -u HERMETIC_EVENTS -u HERMETIC_TEST \
    python3 -I "$HERE/tripwire.py" >"$TRIPWIRE_LOG" 2>&1 &
TRIP=$!

banner=""
tenths=0
while [ "$tenths" -lt "$BANNER_WAIT_TENTHS" ]; do
    while IFS= read -r line; do
        case "$line" in
        "tripwire listening "*) banner=$line ;;
        esac
    done <"$TRIPWIRE_LOG"
    [ -n "$banner" ] && break
    kill -0 "$TRIP" 2>/dev/null || break
    sleep 0.1
    tenths=$((tenths + 1))
done
# Globbing off: each socket is a word, and `[::1]:3849` is also a glob.
set -f
for socket in $SOCKETS; do
    case " $banner " in
    *" $socket "*) ;;
    *)
        kill "$TRIP" 2>/dev/null
        cat "$TRIPWIRE_LOG" >&2
        setup_failure "$EXIT_BANNER" "the tripwire banner did not name $socket"
        ;;
    esac
done
set +f
echo "hermetic: $banner"

echo "hermetic: running $*"
"$@"
status=$?
echo "hermetic: the command exited $status"

if ! kill -0 "$TRIP" 2>/dev/null; then
    wait "$TRIP"
    cat "$TRIPWIRE_LOG" >&2
    setup_failure "$EXIT_TRIPWIRE_DIED" "the tripwire died during the run"
fi
kill -TERM "$TRIP"
wait "$TRIP"
trip_status=$?
if [ "$trip_status" -ne 0 ]; then
    cat "$TRIPWIRE_LOG" >&2
    setup_failure "$EXIT_TRIPWIRE_DIED" "the tripwire exited $trip_status instead of draining"
fi

hits=0
while IFS= read -r line; do
    case "$line" in
    "HIT "*) hits=$((hits + 1)) ;;
    esac
done <"$TRIPWIRE_LOG"
if [ "$hits" -gt 0 ]; then
    echo "hermetic: VERDICT HIT — $hits connection(s) to a board port:"
    cat "$TRIPWIRE_LOG"
    exit "$EXIT_HIT"
fi
echo "hermetic: VERDICT clean — no tripwire hit; the command's status is $status"
exit "$status"
