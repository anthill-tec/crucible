"""Shared reads for the go client's tier-verb tests.

A Go project declares a tier with a build tag: for tier `<tier>`, a package's
tier files are the `_test.go` files `go list -tags <tier>` names and the same
`go list` without the tag does not, and the tier's tests are the top-level
`Test*` / `Fuzz*` / `Example*`-with-output functions those files declare. A
tier verb runs only those tests, in ONE run filed under the tier.

These helpers drive the real go client through `go_client_harness.GoProject`
(the recording `go` shim first on PATH, the real `go` behind it) against a
`RecordingBoard`, and read back what go was asked and what the board was sent.

Not a test module: it holds no `TestCase`.
"""

from tests.client.go_client_harness import (
    START,
    GoProject,
    diagnostics,
    envelope,
    flag_value,
    go_events,
    said,
    terminal_events,
)

#: The legacy error code the shared `TierRunUndeclared` hard stop prints.
UNDECLARED_CODE = "tier-run-undeclared"
#: The legacy error code the shared `UnattributedRunRefused` hard stop prints.
UNATTRIBUTED_CODE = "unattributed-run-refused"
#: Linux's per-argument limit (`MAX_ARG_STRLEN`): no `-run` may reach it.
ARG_LIMIT_BYTES = 128 * 1024


def tier_project(case, fixture):
    """A scratch copy of `tests/fixtures/go-client/<fixture>` on its own
    recording board."""
    return GoProject(case, fixture=fixture)


def drive_tier(p, tier, *argv, **env):
    """`go-crucible.py <tier> [argv] --agent go-runner --project-dir <dir>`."""
    return p.drive(*argv, verb=tier, **env)


def go_test_calls(p):
    """Every call whose go subcommand is `test` (never `go list`)."""
    return p.subcommand_calls("test")


def go_subcommands(p):
    """The go subcommand of every recorded call, in order."""
    return [c["argv"][0] if c["argv"] else "" for c in p.calls()]


def run_patterns(p):
    """The `-run` value of every `go test` call, in order (None when absent)."""
    return [flag_value(c["argv"], "-run") for c in go_test_calls(p)]


def held_terminals(p):
    """`(Package, Test, Action)` of each terminal test event the board's held
    stream carries."""
    return terminal_events(p.held())


def held_events(p):
    return go_events(p.held())


def where(p, result):
    return (f"go calls={[c['argv'][:6] for c in p.calls()]!r} "
            f"posts={[path for path, _b in p.posts()]!r} {diagnostics(result)}")


def starts(p):
    return [b for path, b in p.posts() if path == START]


__all__ = [
    "ARG_LIMIT_BYTES", "UNATTRIBUTED_CODE", "UNDECLARED_CODE", "drive_tier",
    "envelope", "go_subcommands", "go_test_calls", "held_events",
    "held_terminals", "run_patterns", "said", "starts", "tier_project", "where",
]
