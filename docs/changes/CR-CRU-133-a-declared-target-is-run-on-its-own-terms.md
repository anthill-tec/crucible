# CR-CRU-133 — a declared target is run on its own terms

**Type** fix · **Wave** 6 (0.2.0) · **Depends on** CR-CRU-046, CR-CRU-131 · **Status** PENDING

## Problem

`clients/bun-crucible.py`'s `e2e` verb cannot ingest, and the reason is a contradiction inside one
function.

`_bun_run_script_cmd` (`clients/bun-crucible.py:479-492`) runs a DECLARED tier target by name and
says why in its own docstring:

> §S6 ruling 2 — a DECLARED tier target is a `package.json` script, and it is run BY NAME
> (`bun run test:unit`), never by re-parsing its body. That is the whole point of a declaration: the
> project can change what the script does without this client noticing, and the client never
> classifies what the project declared.

Then it appends `--reporter=junit --reporter-outfile=<path>` — flags only `bun test` understands.
**That IS a classification.** It assumes the declared script is a `bun test` invocation, which is
exactly the inference the docstring forbids.

Measured 2026-09-14 on `release/0.2.0` at `42766fe`:

- `package.json:30` declares `"test:e2e": "bunx bddgen && bunx playwright test"`.
- `bun run clients/bun-crucible.py e2e --agent <id>` → `error: unknown option
  '--reporter-outfile=…/test-reports/junit.xml'`, playwright exits 1, and the client reports
  `ERROR: no JUnit XML produced — nothing to ingest`.
- The suite itself is HEALTHY: run as the target's own runner expects — `bun run test:e2e` with
  `PLAYWRIGHT_JUNIT_OUTPUT_NAME` — it is **46 passed** in 1.1 m.

So the e2e tier is green and unreportable, which is worse than red: the board records nothing and the
run is left open for the abandon sweep to settle. A `run-left-open` warning fires on every attempt.

## Why it matters beyond e2e

Playwright takes its JUnit path from `PLAYWRIGHT_JUNIT_OUTPUT_NAME`, not a flag. Any declared target
whose runner is not `bun test` hits the same wall — a pytest-backed target, a `vitest` target, a
shell script. The declaration mechanism CR-CRU-111 §S6 introduced is therefore only usable for one
runner, which is not what a declaration is for.

## Scope

### §S1 A declared target is invoked on its own terms

The client runs `bun run <script>` and does NOT append flags the script's runner may not accept. How
the target produces its JUnit XML is the TARGET's business — declared alongside it, not inferred by
the caller.

### §S2 The report path is passed by a mechanism the target chooses

The client needs the XML at a known path; the runner decides how it is told. The declaration carries
that, so a target states its own contract — a flag for `bun test`, an environment variable for
playwright — and the client honours whichever the declaration names without knowing which runner is
behind it. A target that states NO mechanism defaults to the FLAG contract — `bun test`'s own
convention, which is every target this project declares today except `test:e2e` — so AC4's existing
declared targets need no change to their `package.json` entries; only a target whose runner is not
`bun test` opts in to the environment mechanism explicitly.

### §S3 A target that produces no report fails LOUDLY and says which target

Today's `no JUnit XML produced` names no target and offers no diagnosis. It must name the script, the
command it ran, and the report path it expected. `no_report_help`/`no_report_warning`
(`clients/_crucible_axi.py`) are shared across all five clients (11 call sites / 22 helper calls);
the additive `remedy=`/`cause=` keywords CR-CRU-064/065 already added are this CR's extension point
— the richer detail rides those, and neither helper's required-parameter shape changes for the other
four clients.

## Acceptance criteria

- [ ] `e2e` ingests. The 46 e2e tests reach the board with `tier: e2e`, asserted by an ingest whose
      count matches an independently-measured run.
- [ ] `_bun_run_script_cmd` appends no runner-specific flag to a declared target — asserted by
      CONSTRUCTION, so the next runner-specific assumption fails at the scan rather than at a verb.
- [ ] A declared target whose runner takes its report path by ENVIRONMENT is ingested, and one that
      takes it by FLAG is ingested, through the same code path — both asserted.
- [ ] The `bun test` targets keep working unchanged, asserted per declared target that exists today.
- [ ] A target producing no report names the script, the command and the expected path in its error.
- [ ] The docstring's claim and the code agree: a test fails if the invocation classifies a declared
      target by anything other than its declaration.

## Non-goals

- Answering DN open question 5 (who runs e2e and who ingests it). The gate excludes e2e fleet-wide
  and defers to that answer; this CR makes the verb WORK when invoked, and changes no gate policy.
- Adding tier targets this project does not declare.
