# CR-CRU-089 — VOID — patch: pin bun without routing every npm call through corepack

- **Type**: patch
- **Wave**: 5
- **Depends on**: 087
- **Status**: VOID (2026-08-23, never started)

## VOID — the thing this patched no longer exists

This CR existed to replace CR-087's `packageManager` pin with a `.bun-version` mechanism. That pin has
been **reverted outright** (`93f42f7`), so there is nothing left to re-mechanise.

The pin was never needed for the job CR-087 was filed to do. CI was red because ONE assertion demanded
that a timed-out leaf carry no failure message — true only on the bun this repo develops on.
Re-specifying it as attribution fixed it under any bun, and that alone turned CI green: run
32646793234 on `93f42f7` reports `test-bun` success, alongside `test-python`, `test-e2e`, `build` and
`pack-server`. The pin was added scope, and it cost a 12-second corepack tax on every npm call in CI
(958 ms → 13082 ms on the npm-pack test) for a drift the fixtures now catch anyway.

Kept as a record of the measurement, not as work. Removed from the queue table. If pinning the
toolchain is ever wanted, it is a fresh decision at SCRUM — not this CR resurrected.

The problem statement below is preserved verbatim for its evidence.
## Problem

CR-087 pinned the bun toolchain with `package.json`'s `packageManager` field, chosen because
`setup-bun@v2` reads it first and one declaration then covers all four jobs with no workflow edit.
The pin **worked** — CI run 32641317972 on the merge commit `9ff1e20` reports `bun test v1.3.14
(0d9b296a)`, and the §S2c timeout flip that CR-087 was filed for is gone.

**But `packageManager` is not inert to npm, and CR-087's AC5 therefore FAILED.** Same run,
`test-bun`: 1567 pass / 1 skip / **1 fail**, and the failure is not an assertion — it is a timeout:

```
(fail) §S1 npm pack --dry-run tarball contents > published tarball contains bin/, src/, and public/ [13082.01ms]
  ^ this test timed out after 5000ms.
```

Measured before and after, same test, same CI:

| commit | duration |
|---|---|
| `a6bcb49` (pre-pin, run 32565982939) | **958 ms** |
| `9ff1e20` (post-pin, run 32641317972) | **13082 ms** → timed out at 5000 ms |

So the declaration added ~12 seconds to the first `npm` invocation in the job. `npm` sees
`packageManager: "bun@1.3.14"` and, with corepack enabled in the runner image, provisions that tool
before doing its own work. `publish-npm`, `pack-server` and every future `npm` call in CI pay the same
cost; only this test had a 5-second budget tight enough to notice.

**Not reproducible locally, and that is part of the finding.** Measured here: `npm pack --dry-run`
takes 0.349 s with the field and 0.342 s without it (npm 12.0.2, corepack present at
`/usr/bin/corepack` but not shimming npm). A local green therefore cannot clear this class of defect —
exactly what CR-087's AC5 exists to catch, and it caught it.

## Scope

### §S1 Move the declaration to a file npm never reads

The pinned version lives in **`.bun-version`** (the file `setup-bun` documents for this purpose), and
the four `setup-bun` steps consume it with `bun-version-file: .bun-version`. `packageManager` is
**removed** from `package.json`, so npm's behaviour returns to what it was before CR-087.

This trades CR-087's "no workflow edit" property for correctness, and says so: the single source of
truth is still ONE file, now referenced four times instead of resolved implicitly. A reference is not
a duplicate — no version literal is repeated.

`engines.bun` is untouched and keeps its own meaning: the consumer-facing compatibility floor
(`>=1.2`).

### §S2 The invariants follow the mechanism

CR-087's four assertions in `tests/suite-integrity.test.ts` are re-pointed: the exact pin is read from
`.bun-version`; every `setup-bun` step must reference it via `bun-version-file`; `engines.bun` stays a
range; and the declared version must still equal the running `Bun.version`. The
"no `bun-version:` input anywhere" assertion is kept — `bun-version-file:` is a different input and
must not be confused with it.

### §S3 The npm-pack budget is measured, not guessed

The failing test's 5-second budget was fine for a 958 ms operation and is fine again once npm stops
provisioning bun. The budget is left alone unless §S1's fix does not restore the old duration, in
which case the number is set from a measured CI figure and the reason recorded — never raised to make
a red test green.

## Acceptance criteria

- **AC1** — `.bun-version` exists, contains exactly the pinned version (`1.3.14`), and is the ONLY
  place that version literal appears outside a test fixture.
- **AC2** — `package.json` has **no** `packageManager` field; `engines.bun` is unchanged (`>=1.2`).
- **AC3** — all four `setup-bun` steps (`release.yml:73, :130, :271, :317`) carry
  `bun-version-file: .bun-version`; none carries a `bun-version:` input. Asserted, not eyeballed.
- **AC4** — the declared version still equals the running `Bun.version`, so a runner that installs
  something else fails visibly (CR-087 AC1b preserved through the mechanism change).
- **AC5** — CI observability preserved: the job log shows the resolved version, and `test-bun` reports
  `bun test v1.3.14`.
- **AC6** — **the regression is gone**: `§S1 npm pack --dry-run tarball contents > published tarball
  contains bin/, src/, and public/` completes well inside its 5 s budget in CI, at a duration
  comparable to the pre-pin 958 ms.
- **AC7** — **CR-087's AC5 is finally met**: `test-bun` is GREEN in CI on a push to `develop`, and
  `publish-pypi`/`publish-npm` are no longer skipped. This CR does not close on a local green either.
- **AC8** — `RELEASING.md` is corrected: it currently documents `packageManager` as the mechanism, and
  must document `.bun-version` + `bun-version-file`, including why `packageManager` was abandoned (npm
  reads it and provisions through corepack).

## Estimated size

S — one file, one field removed, four workflow references, the invariants re-pointed, one doc block.

## Risk

The obvious wrong fix is raising the test's timeout: it would leave every `npm` call in CI paying a
12-second corepack tax and hide the cause behind a bigger number. §S3 forbids it unless measurement
demands it.

Second risk: `bun-version-file` is an input on four steps, so a future job added without it silently
falls back to `engines.bun`'s open range — the drift CR-087 closed. AC3's assertion is what makes that
a test failure rather than a surprise.

## Non-goals

- Re-litigating the pin itself. The version and the reason for pinning are CR-087's and stand.
- `astral-sh/setup-uv@v6`, still unpinned — same class, python suite green, still a SCRUM candidate.
- The forward-marrying failure-detail defect — CR-088.
