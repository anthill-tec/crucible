# CR-CRU-080 — the release ceremony cannot report a release (no agent identity)

- **Type**: bugfix
- **Wave**: 5 (0.2.0)
- **Depends on**: 074
- **Status**: PENDING (0.2.0)

## Problem

CR-074 made releases first-class: `release` joined `MILESTONE_TYPES`, `release.sh finish` reports
the release after the push, and `release.sh backfill-releases` replays shipped tags. The
mechanism was verified by contract tests against a stubbed client — and **the real invocation
has never worked**.

`scripts/release.sh:346`:

```sh
python3 "$client" milestone --type release --label "$version" --commit "$sha"
```

No `--agent`. The client requires an agent identity and — correctly, by CR-057's design — has
**no fallback and no default**:

```
agent-identity-required — no agent identity was declared; supply it with `--agent <agentId>`.
There is no fallback and no default: $WORKFLOW_ROLE carries the track lane (mainline | track-n),
not an identity, and a filename-derived default would plant a phantom row on the agent rail.
Nothing was posted.
```

So **every** release report fails. Proven by running the real thing: `backfill-releases` for
0.1.0 / 0.1.1 / 0.1.2 emitted three `agent-identity-required` errors and recorded nothing, and
`GET /releases` returned `{"releases":[]}` afterwards.

The failure is silent by design, which is why it survived: reporting is deliberately non-fatal
(`WARN: reporting release X to Crucible failed; the release is published and complete`), so the
ceremony exits successfully having recorded nothing. Three shipped releases left no trace, which
in turn starved everything downstream of a release record:

- the roadmap rendered **zero** release-boundary rows, so nothing on the board distinguished
  "in this release" from "deferred" (the defect that surfaced this bug);
- CR-073's gate retirement has no completion event to fire on;
- CR-022's forecast band has no release to anchor to.

Recovered by hand with `milestone --type release --label <tag> --commit <sha> --agent vidushi`
for each tag; all three now present. That is a manual workaround, not a fix: the next release
will fail the same way.

## Scope

### §S1 Pass an identity

`emit_release_milestone` supplies `--agent`, sourced explicitly rather than invented:
an `--agent` flag on `release.sh`, falling back to a documented environment variable
(`CRUCIBLE_AGENT`). No filename-derived or role-derived default — the client's no-fallback rule
is correct and must not be worked around at the script layer.

### §S2 An unreportable release must be loud

Reporting stays non-fatal — a published release must never be rolled back because a tracking
call failed — but the outcome may no longer be a warning buried in output. Absent identity is a
**preflight** failure: `release.sh` refuses to start the ceremony without one, so the operator
learns before the tag exists rather than after. A genuine transport failure mid-ceremony still
warns and continues, and the summary states plainly that the release is unrecorded, with the
exact recovery command.

### §S3 Backfill is idempotent and reports honestly

`backfill-releases` reports per tag and prints a final tally (`3/3 recorded`, or which failed
and why). Re-running never duplicates a release for the same tag/commit.

## Acceptance criteria

- **AC1** — `emit_release_milestone` passes `--agent`; a release ceremony with an identity
  records a `release` milestone, and `GET /releases` returns it. Asserted against a real
  invocation path, not a stub that accepts any argv.
- **AC2** — with **no** identity available, `release.sh` fails **preflight**, before any tag is
  created or pushed. It must not reach the tag step and then warn.
- **AC3** — a transport failure *after* the tag exists still exits success, warns, and prints
  the exact recovery command including the tag's sha.
- **AC4** — `backfill-releases` prints a per-tag result and a final tally; a partial failure is
  visible in the exit summary rather than only in the middle of the log.
- **AC5** — re-running `backfill-releases` does not duplicate releases for tags already recorded.
- **AC6** — the existing contract test that stubs the client is strengthened to assert the
  **argv actually contains `--agent`**; the current stub passes without it, which is precisely
  why this shipped broken.

## Estimated size

S — one argument, a preflight check, a tally, and a strengthened assertion.

## Risk

Low. The sharp edge is AC6: the existing test suite proved the *shape* of the call while
ignoring its required argument, so the fix must tighten the assertion or the same class of bug
returns. Preflight refusal (AC2) changes ceremony behaviour — a release cannot start without an
identity — which is the intended trade: better to refuse at the start than to publish a release
that Crucible never learns about.

## Non-goals

- Changing the client's no-fallback identity rule (CR-057) — it is correct.
- Making release reporting fatal after publication.
- Release→gate association (still nothing answers "which gates belong to release X").
- Roadmap row ordering and duplicate wave dividers — **CR-078 §S4**.
