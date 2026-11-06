#!/usr/bin/env bash
# Regenerates every captured nextest run under runs/ from the scratch crates
# under crates/, with cargo-nextest 0.9.130. Nothing is built in this tree:
# the crates are copied to a scratch directory under /tmp and built there,
# with their own CARGO_TARGET_DIR.
#
# Each run directory holds three files, all written by the same nextest:
#   list.json    cargo nextest list --message-format json [filter]
#   stream.jsonl NEXTEST_EXPERIMENTAL_LIBTEST_JSON=1 cargo nextest run
#                  --profile ci --no-fail-fast
#                  --message-format libtest-json-plus --message-format-version 0.1
#                  [filter] [--retries N]
#                (stdout only; the human output on stderr is dropped)
#   junit.xml    the JUnit report the same run wrote (the `ci` profile's junit.path)
# Rewritten: the toolchain's home directory in list.json, to /home/user/.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="${NEXTEST_FIXTURE_SCRATCH:-/tmp/nextest-fixture-scratch}"
export CARGO_TARGET_DIR="$SCRATCH/target"
export NXFLAKY_MARKS="$SCRATCH/marks"

rm -rf "$SCRATCH/crates" "$NXFLAKY_MARKS"
mkdir -p "$SCRATCH" "$NXFLAKY_MARKS"
cp -r "$HERE/crates" "$SCRATCH/crates"

# capture <run> <crate> <retries> [filter args...]
capture() {
  local run="$1" crate="$2" retries="$3"
  shift 3
  local out="$HERE/runs/$run"
  mkdir -p "$out"
  cd "$SCRATCH/crates/$crate"
  cargo nextest list --message-format json "$@" | sed "s#$HOME/#/home/user/#g" > "$out/list.json"
  rm -f target/nextest/ci/junit.xml
  NEXTEST_EXPERIMENTAL_LIBTEST_JSON=1 cargo nextest run --profile ci --no-fail-fast \
    --message-format libtest-json-plus --message-format-version 0.1 \
    --retries "$retries" "$@" > "$out/stream.jsonl" 2> /dev/null || true
  cp target/nextest/ci/junit.xml "$out/junit.xml"
}

capture all-pass nxpass 0
capture a-failure nxshapes 0 -E 'test(=passes) | test(=prints_then_panics)'
capture distinct-targets nx-targets 0
capture same-name nxsame 0
capture spawned-thread-panic nxshapes 0 -E 'test(=child_panic)'
capture should-panic-without-a-panic nxshapes 0 -E 'test(=never_panics)'
capture err-return nxshapes 0 -E 'test(=returns_err)'
capture flaky-retries nxflaky 2
capture timeout nxslow 0
