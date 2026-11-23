#!/bin/sh
# Provision the test suite's own toolchain caches, the one step
# that needs the network. Run it once, and again whenever it says the cache is
# stale; the tests themselves run offline and never fill a cache.
#
#   .cache/test-suite/m2   the maven repository the live maven module
#                          (tests/client/integration/test_a_declared_maven_
#                          run_shows_its_real_surefire_console_live_end_to_
#                          end.py) runs
#                          offline on. Filled by running the committed
#                          fixture's real lifecycle (`clean test`) on a temp
#                          copy, online, so every plugin, surefire provider and
#                          JUnit artifact the run needs is fetched. Maven's
#                          HOME is an empty temp dir: no operator settings.
#
#                          The same repository is filled for the failsafe
#                          fixture (tests/fixtures/failsafe-live-project),
#                          whose real lifecycle runs through `verify`, so
#                          failsafe and the jar plugin are fetched too. The
#                          maven tier module (tests/client/integration/test_a_
#                          maven_tier_verb_runs_the_tests_its_plugin_names.py)
#                          runs it offline.
#
# The maven repository carries `provision.stamp`:
#
#   pom-sha256=<sha256 of tests/fixtures/surefire-live-project/pom.xml>
#   maven=<the version `mvn --version` reports, e.g. 3.9.9>
#
# the exact lines the live module's `maven_repo_gap` checks, and
# `failsafe-provision.stamp`, the same two lines for the failsafe fixture's
# pom.xml. A stamp matching its pom.xml and this maven skips that fill.
#
# The go fixtures (tests/fixtures/go-client) require no module, so the go
# caches (.cache/test-suite/go-build, go-mod) need no download: go fills them
# offline on first use. The uv cache (.cache/test-suite/uv) is filled by the
# uv gate's own `uv pip install` of the wheel it builds.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO="$ROOT/.cache/test-suite/m2"
STAMP="$REPO/provision.stamp"
FIXTURE="$ROOT/tests/fixtures/surefire-live-project"
FAILSAFE_STAMP="$REPO/failsafe-provision.stamp"
FAILSAFE_FIXTURE="$ROOT/tests/fixtures/failsafe-live-project"

if ! command -v mvn >/dev/null 2>&1; then
    echo "provision-test-caches: maven (mvn) is not on PATH" >&2
    exit 1
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/crucible-provision-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT TERM
mkdir "$WORK/home"

# The JDK the fill compiles with, then maven's own report (it names the JDK
# it runs on): the fixture compiles with `release 21`, so the log says which
# JDK a run had before any build starts.
echo "provision-test-caches: java -version"
java -version 2>&1 || echo "provision-test-caches: no java on PATH"
MVN_REPORT=$(HOME="$WORK/home" MAVEN_OPTS="-Duser.home=$WORK/home" mvn --version) || {
    echo "provision-test-caches: mvn --version failed (exit $?)" >&2
    exit 1
}
printf '%s\n' "$MVN_REPORT"
VERSION=$(printf '%s\n' "$MVN_REPORT" \
    | sed -n 's/.*Apache Maven \([0-9][0-9A-Za-z.-]*\).*/\1/p' | head -n 1)
if [ -z "$VERSION" ]; then
    echo "provision-test-caches: could not read maven's version off mvn --version" >&2
    exit 1
fi

# fill <fixture> <stamp> <phase after test, or empty>: fill the suite
# repository from the fixture's real lifecycle, `clean test` and then the
# phase given, and write its stamp. A matching stamp skips the fill.
fill() {
fixture=$1
stamp=$2
through=$3
POM_SHA=$(sha256sum "$fixture/pom.xml" | cut -d ' ' -f 1)
EXPECTED=$(printf 'pom-sha256=%s\nmaven=%s' "$POM_SHA" "$VERSION")

if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$EXPECTED" ]; then
    echo "provision-test-caches: $REPO is provisioned for $fixture/pom.xml and maven $VERSION; skipped"
    return 0
fi

echo "provision-test-caches: filling $REPO for $fixture (maven $VERSION, online)"
mkdir -p "$REPO"
rm -f "$stamp"
rm -rf "$WORK/project"
cp -R "$fixture" "$WORK/project"
rm -rf "$WORK/project/target"
# The committed maven.config holds `-o`; the provisioning run is online.
: > "$WORK/project/.mvn/maven.config"
# One bad download must not fail the fill, and nothing else is retried.
# Maven's resolver retries a dropped connection itself, three times (the
# property under its resolver 1.x and 2.x names). A fill that still fails runs
# once more, with -U (maven records an artifact it could not fetch as missing
# and would not ask for it again), but only when it failed fetching:
#
#   an attempt is retried when one of maven's `[ERROR]` lines in its output
#   matches RESOLUTION_FAILURE below, case-insensitively. Those are maven's
#   resolution and transfer messages ("Could not resolve dependencies",
#   "Plugin ... could not be resolved", "Could not transfer artifact",
#   "Failed to read artifact descriptor", "Non-resolvable parent POM") and the
#   network errors they carry (connection reset or refused, a timeout, an
#   unknown host, a handshake the remote host cut).
#
# Any other failure is the build's own (a compile error, an unsupported
# `release`, a bad pom, a plugin's error): the same build fails the same way
# again, so it fails at once. Maven's output streams to this log as it runs.
RESOLUTION_FAILURE='could not resolve|could not be resolved|could not transfer|failed to read artifact descriptor|non-resolvable|transfer failed|connection reset|connection refused|timed out|unknown host|remote host terminated'
ATTEMPTS=2
attempt=1
update=""
while :; do
    echo "provision-test-caches: fill attempt $attempt of $ATTEMPTS"
    rm -f "$WORK/fill.status"
    (
        cd "$WORK/project"
        rc=0
        HOME="$WORK/home" MAVEN_OPTS="-Duser.home=$WORK/home" \
            mvn -B clean test $through $update -Dmaven.repo.local="$REPO" -Dmaven.test.failure.ignore=true \
                -Daether.connector.http.retryHandler.count=3 \
                -Daether.transport.http.retryHandler.count=3 || rc=$?
        echo "$rc" > "$WORK/fill.status"
    ) 2>&1 | tee "$WORK/fill.log"
    status=$(cat "$WORK/fill.status" 2>/dev/null || echo 1)
    if [ "$status" -eq 0 ]; then
        break
    fi
    if ! grep -E -i -q "\[ERROR\].*($RESOLUTION_FAILURE)" "$WORK/fill.log"; then
        echo "provision-test-caches: fill attempt $attempt failed (maven exit $status) on no resolution or transfer error; a build failure is not retried, maven's output is above" >&2
        exit 1
    fi
    if [ "$attempt" -ge "$ATTEMPTS" ]; then
        echo "provision-test-caches: the fill failed resolving or transferring an artifact on all $ATTEMPTS attempts" >&2
        exit 1
    fi
    echo "provision-test-caches: fill attempt $attempt failed resolving or transferring an artifact:" >&2
    grep -E -i -m 3 "\[ERROR\].*($RESOLUTION_FAILURE)" "$WORK/fill.log" >&2
    echo "provision-test-caches: retrying in 10 s with -U" >&2
    attempt=$((attempt + 1))
    update="-U"
    sleep 10
done
printf '%s\n' "$EXPECTED" > "$stamp"
echo "provision-test-caches: wrote $stamp"
}

fill "$FIXTURE" "$STAMP" ""
fill "$FAILSAFE_FIXTURE" "$FAILSAFE_STAMP" verify
