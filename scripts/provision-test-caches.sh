#!/bin/sh
# Provision the test suite's own toolchain caches, the one step
# that needs the network. Run it once, and again whenever it says the cache is
# stale; the tests themselves run offline and never fill a cache.
#
#   .cache/test-suite/m2   the maven repository the live maven module
#                          (tests/client/test_a_declared_maven_run_shows_its_
#                          real_surefire_console_live_end_to_end.py) runs
#                          offline on. Filled by running the committed
#                          fixture's real lifecycle (`clean test`) on a temp
#                          copy, online, so every plugin, surefire provider and
#                          JUnit artifact the run needs is fetched. Maven's
#                          HOME is an empty temp dir: no operator settings.
#
# The maven repository carries `provision.stamp`:
#
#   pom-sha256=<sha256 of tests/fixtures/surefire-live-project/pom.xml>
#   maven=<the version `mvn --version` reports, e.g. 3.9.9>
#
# the exact lines the live module's `maven_repo_gap` checks. A stamp matching
# this pom.xml and this maven skips the fill.
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

if ! command -v mvn >/dev/null 2>&1; then
    echo "provision-test-caches: maven (mvn) is not on PATH" >&2
    exit 1
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/crucible-provision-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT TERM
mkdir "$WORK/home"

POM_SHA=$(sha256sum "$FIXTURE/pom.xml" | cut -d ' ' -f 1)
VERSION=$(HOME="$WORK/home" MAVEN_OPTS="-Duser.home=$WORK/home" mvn --version \
    | sed -n 's/.*Apache Maven \([0-9][0-9A-Za-z.-]*\).*/\1/p' | head -n 1)
if [ -z "$VERSION" ]; then
    echo "provision-test-caches: could not read maven's version off mvn --version" >&2
    exit 1
fi
EXPECTED=$(printf 'pom-sha256=%s\nmaven=%s' "$POM_SHA" "$VERSION")

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$EXPECTED" ]; then
    echo "provision-test-caches: $REPO is provisioned for this pom.xml and maven $VERSION; skipped"
    exit 0
fi

echo "provision-test-caches: filling $REPO (maven $VERSION, online)"
mkdir -p "$REPO"
rm -f "$STAMP"
cp -R "$FIXTURE" "$WORK/project"
rm -rf "$WORK/project/target"
# The committed maven.config holds `-o`; the provisioning run is online.
: > "$WORK/project/.mvn/maven.config"
# One bad download must not fail the fill. Maven's resolver retries a dropped
# connection itself, three times (the property under its resolver 1.x and 2.x
# names). A fill that still fails runs once more, with -U: maven records an
# artifact it could not fetch as missing and would not ask for it again.
ATTEMPTS=2
attempt=1
update=""
while :; do
    echo "provision-test-caches: fill attempt $attempt of $ATTEMPTS"
    if (cd "$WORK/project" && HOME="$WORK/home" MAVEN_OPTS="-Duser.home=$WORK/home" \
        mvn -B clean test $update -Dmaven.repo.local="$REPO" -Dmaven.test.failure.ignore=true \
            -Daether.connector.http.retryHandler.count=3 \
            -Daether.transport.http.retryHandler.count=3); then
        break
    fi
    if [ "$attempt" -ge "$ATTEMPTS" ]; then
        echo "provision-test-caches: the fill failed on all $ATTEMPTS attempts" >&2
        exit 1
    fi
    echo "provision-test-caches: fill attempt $attempt failed; retrying in 10 s" >&2
    attempt=$((attempt + 1))
    update="-U"
    sleep 10
done
printf '%s\n' "$EXPECTED" > "$STAMP"
echo "provision-test-caches: wrote $STAMP"
