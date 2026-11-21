# CR-CRU-247 — every fleet census names every client, or says why it does not

**Status:** PENDING · Pre-review: due — user ruling
**Type:** maintenance
**Priority:** low. It is the wave's test hygiene, sequenced last.
**Depends on:** CR-CRU-243, CR-CRU-244, CR-CRU-245, CR-CRU-248, CR-CRU-249
**Labels:** tests, census
**Phase:** design
**Design reference:** CR-CRU-195 §S6 (the fleet carries a new client)

## Context

Some of the test suite's closed lists of clients name only the five clients that predate Go: bun,
python, mvn, rust and arduino. Neither go nor eda joined them. Whether each list leaves those two out on
purpose is recorded nowhere. Such a list silently stops checking a contract for every newer client.

## Scope

- **Each list is judged on its own.** Either it names every client in `manifest.CLIENT_STACKS`, or it
  carries a one-line comment stating why a named client is out. For example, a list of clients with
  inline JUnit reports leaves out the streamed ones.
- **A guard keeps it that way.**

### §S1 — the lists

**Python tests:**

- `test_gated_run_bracket_lives_once_and_refused_runs_post_nothing.py`
- `test_the_run_pipeline_lives_in_its_own_shared_module.py` (`CLIENT_FILES`)
- `test_the_console_tee_lives_once_in_the_shared_module.py`
- `test_every_clients_help_says_regression_coverage_is_opt_in.py`
- `test_plan_file_names_the_release_it_plans.py`
- `test_next_lane_carries_release_and_wave.py`
- `test_gate_names_the_release_it_gates.py`
- `test_cr054_axi_context_lift.py`
- `test_cr054_http_core_lift.py`
- `test_cr054_verb_surface_lift.py`
- `test_cr054_fleet_inventory.py`
- `test_cr054_drift_guard.py`
- `test_client_tier_stamping.py`
- `test_a_relative_project_dir_resolves_absolute.py`
- `test_status_speaks_json_to_programs.py`
- `test_every_verb_that_runs_a_test_runner_is_classified.py` (`DECLARED_TIER_CLIENTS`)
- `test_client_tier_run_envelope.py` (its inline five-client check)
- `test_client_limits_resolve_from_configuration.py` (its five-client site)

**TypeScript tests:**

- `project-namespace-tripwire.test.ts` (`CLIENTS`)
- `release-backfill.test.ts` (`STACK_CLIENTS`)
- `release-reporting.test.ts`
- `clients-never-self-register-a-project.test.ts`
- `milestone-vocabulary-has-one-source.test.ts` (`READING_SITES`)
- `junit-reading-is-one-rule-for-every-stack.test.ts` (`EVERY_STACK`)
- `failure-message-attribute-is-stored-trimmed.test.ts` (`EVERY_STACK`)
- `a-streamed-run-equals-its-junit-record.test.ts` (its fixture dirs)

Each list either gains go and eda, or gains an exclusion comment of the form
`# not <stack>: <reason>` / `// not <stack>: <reason>` for each client it leaves out.

### §S2 — the guard

A python test reads each list in §S1 from source. It fails when a stack of `manifest.CLIENT_STACKS` is
neither in the list nor named by an exclusion comment in that list's statement.

## Acceptance criteria

- [ ] **AC1 — every list is judged.** Each list in §S1 names each of the seven stacks, or carries an
  exclusion comment that names the stack and gives a reason.
- [ ] **AC2 — the guard bites.** On a synthetic source that omits a stack with no comment, the guard fails,
  naming the file, the list and the stack. With the comment, it passes.
- [ ] **AC3 — the suites hold.** The full python client suite and the bun suite pass with the lists
  widened. Any list that gains go or eda runs its contract on that client.
- [ ] **AC4 — no CR id.** The comments and the guard carry no CR id literal.

## Estimated size

3 points.

## Risk

- **A widened list may expose a real gap** in go or eda. Such a gap is a new CR, filed on the board. It is
  never excluded silently.

## Non-goals

- Changing any client.
- Lists that already name all clients, or that are derived by glob.
