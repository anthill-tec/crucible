"""Shared fixtures for the rust client's streamed-run tests on the fake
cargo: a scratch rust project pointed at a `RecordingBoard`, the shared fake
`cargo` (`live_run_harness.FAKE_CARGO`, whose streamed calls
`fake_nextest.py` answers) and a fake `docker` first on `PATH`, and readers
for what the client sent the board and asked of cargo.

Not a test module: it holds no `TestCase`.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from tests.client.client_cadence_settings import launcher_command
from tests.client.fake_nextest import list_text, read_calls
from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    install_project,
    load_toon,
    new_scratch,
    scrubbed_env,
    write_fake_cargo,
    write_fake_docker,
)

TOON = load_toon()
RUST_CLIENT = CLIENTS / "rust-crucible.py"
AGENT = "rust-streamer"
PROJECT_KEY = "pk-rust-stream"
RUN_ID = "run-live-1"
RUNS = "/api/v2/runs"
COMPILE = "/api/v2/runs/compile"
START = "/api/v2/runs/start"
TIMEOUT = 90

# Every verb of the four test-running bodies, by label, with the flags it
# needs beyond `--agent`/`--project-dir`: the crate a per-crate verb names,
# and the disk-guard floor and target reclaim that would otherwise measure
# (and `cargo clean`) the host.
VERBS = {
    "test": ("test", "--crate", "fake-crate"),
    "unit": ("unit",),
    "integration": ("integration",),
    "e2e": ("e2e",),
    "regression-ingest": ("regression-ingest", "--crates", "fake-crate"),
    "smoke-test": ("smoke-test",),
    "docker-e2e-gate": ("docker-e2e-gate", "--min-free-g", "0"),
    "workspace-regression": ("workspace-regression", "--min-free-g", "0",
                             "--keep-target"),
    "regression": ("regression", "--min-free-g", "0"),
    "regression --coverage": ("regression", "--coverage", "--min-free-g", "0",
                              "--keep-target"),
    "pre-merge-gate": ("pre-merge-gate", "--skip-clippy", "--min-free-g", "0",
                       "--keep-target"),
}
# The verbs whose run measures coverage.
COVERAGE_VERBS = ("regression-ingest", "workspace-regression",
                  "regression --coverage", "pre-merge-gate")
# The verbs that run without an agent (the others require one).
AGENT_OPTIONAL_VERBS = ("test", "unit", "integration", "e2e")
# The verbs that accepted `--ignore-run-fail`.
IGNORE_RUN_FAIL_VERBS = {
    "workspace-regression": ("workspace-regression", "--min-free-g", "0"),
    "regression --coverage": ("regression", "--coverage", "--min-free-g", "0"),
}

# The standard rust profiles, each with a JUnit report as nextest allows.
STANDARD_PROFILES = """[profile.default]
default-filter = "not binary(e2e_dock)"
[profile.default.junit]
path = "junit.xml"
[profile.ci]
default-filter = "not binary(e2e_dock)"
[profile.ci.junit]
path = "junit.xml"
[profile.e2e]
default-filter = "binary(e2e_dock)"
[profile.e2e.junit]
path = "junit.xml"
"""

_SCRUBBED = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_URL",
             "RUST_CRUCIBLE_PROJECT_DIR", "RUST_CRUCIBLE_COMPOSE_FILE",
             "CARGO_TARGET_DIR", "NEXTEST_EXPERIMENTAL_LIBTEST_JSON",
             "NEXTEST_PROFILE", "LLVM_PROFILE_FILE", "CARGO_LLVM_COV")

# The cargo flags that select what a run lists and runs.
_VALUED = ("-P", "--profile", "-p", "--package", "--features", "--test", "-E",
           "--filterset")
_BARE = ("--workspace", "--lib", "--tests", "--all-features", "--bins")


def envelope(stdout):
    """The `axi` block of the client's one TOON envelope, or None."""
    try:
        decoded = TOON.decode(stdout)
    except ValueError:
        return None
    return decoded.get("axi") if isinstance(decoded, dict) else None


def diagnostics(result):
    return (f"exit={result.returncode} stdout={result.stdout[-1500:]!r} "
            f"stderr={result.stderr[-1500:]!r}")


def warning_texts(axi):
    """Each warning of an envelope, as one string (code and detail)."""
    warnings = (axi or {}).get("warnings") or []
    return [json.dumps(w) if not isinstance(w, str) else w for w in warnings]


def selection(argv):
    """The flags of a cargo call that select its tests, as a sorted tuple."""
    picked = []
    for i, arg in enumerate(argv):
        if arg in _VALUED and i + 1 < len(argv):
            picked.append((arg, argv[i + 1]))
        elif arg in _BARE:
            picked.append((arg, ""))
    return tuple(sorted(picked))


def stream_lines(text):
    """The held stream, one decoded JSON line each (a line that is not
    JSON decodes to its text)."""
    lines = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            lines.append(json.loads(line))
        except ValueError:
            lines.append(line)
    return lines


def results(text, event=None):
    """The test result lines (`ok`, `failed`, `ignored`) of a held stream."""
    return [line for line in stream_lines(text)
            if isinstance(line, dict) and line.get("type") == "test"
            and line.get("event") in ((event,) if event else ("ok", "failed", "ignored"))]


class StreamedRustProject:
    """One scratch rust project on its own `RecordingBoard`.

    `settings`, when given, maps client setting names to values: the client
    is then spawned through the test-only launcher on those settings, and
    `timeout` (default `TIMEOUT`) bounds each drive."""

    def __init__(self, test, nextest_toml=STANDARD_PROFILES, board=None, settings=None,
                 timeout=TIMEOUT):
        self.test = test
        self.settings = settings
        self.timeout = timeout
        self.board = board or RecordingBoard()
        test.addCleanup(self.board.close)
        self.dir = new_scratch("rust-stream-")
        install_project(self.dir, self.board.url, PROJECT_KEY)
        Path(self.dir, "Cargo.toml").write_text(
            '[package]\nname = "fake-crate"\nversion = "0.1.0"\nedition = "2021"\n')
        if nextest_toml is not None:
            Path(self.dir, ".config").mkdir(exist_ok=True)
            Path(self.dir, ".config", "nextest.toml").write_text(nextest_toml)
        self.bin_dir = os.path.join(self.dir, "fake-bin")
        os.makedirs(self.bin_dir)
        write_fake_cargo(self.bin_dir)
        write_fake_docker(self.bin_dir)
        self.calls_path = os.path.join(self.dir, "cargo-calls.jsonl")

    def env(self, **fake):
        env = scrubbed_env(self.bin_dir, FAKE_CARGO_CALLS=self.calls_path)
        for key in _SCRUBBED:
            env.pop(key, None)
        env.update({k: str(v) for k, v in fake.items()})
        return env

    def argv(self, label, *extra, agent: str | None = AGENT, verb_argv=None):
        verb = list(verb_argv or VERBS[label])
        cmd = (launcher_command(RUST_CLIENT, *verb, **self.settings) if self.settings
               else [sys.executable, str(RUST_CLIENT), *verb])
        if agent:
            cmd += ["--agent", agent]
        return cmd + ["--project-dir", self.dir, *extra]

    def drive(self, label, *extra, agent: str | None = AGENT, verb_argv=None, timeout=None,
              **fake):
        return subprocess.run(self.argv(label, *extra, agent=agent,
                                        verb_argv=verb_argv),
                              cwd=self.dir, env=self.env(**fake),
                              capture_output=True, text=True,
                              timeout=timeout or self.timeout,
                              check=False)

    # ── what cargo was asked ────────────────────────────────────────────────
    def calls(self):
        return read_calls(self.calls_path)

    def calls_of(self, *head):
        return [c for c in self.calls() if c["argv"][:len(head)] == list(head)]

    def call_index(self, *head):
        for i, c in enumerate(self.calls()):
            if c["argv"][:len(head)] == list(head):
                return i
        return None

    # ── what the board was sent ─────────────────────────────────────────────
    def posts(self):
        return self.board.posts()

    def closes(self):
        return [b for p, b in self.posts() if p == RUNS]

    def starts(self):
        return [b for p, b in self.posts() if p == START]

    def compiles(self):
        return [b for p, b in self.posts() if p == COMPILE]

    def junit_ingests(self):
        return [b for p, b in self.posts()
                if p in (RUNS, "/api/v2/runs/parsed") and isinstance(b, dict)
                and b.get("codec") == "junit"]

    def held(self):
        return self.board.held_stream(RUN_ID)

    def first_post_index(self, predicate):
        for i, (path, body) in enumerate(self.posts()):
            if predicate(path, body):
                return i
        return None


def fake_list(total):
    """The list the shared fake cargo answers for FAKE_TOTAL=`total`."""
    from tests.client.fake_nextest import case
    return list_text([case(f"tests::case_{i}") for i in range(1, total + 1)])


def wait_until(predicate, timeout=15.0, step=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(step)
    return predicate()
