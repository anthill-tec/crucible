# CR-CRU-138 — an installed deployment resolves the configuration it was given

**Type** hotfix · **Wave** 6 (0.2.1) · **Depends on** CR-CRU-131 · **Status** PENDING

## Problem

A production install of 0.2.0 resolves **no** operator configuration at all. Reported from a real
bootstrap, and the warning is correct:

```
warnings[1]{code,detail}:
  limit-configuration,"[crucible] WARNING: no readable configuration at
  /home/antonyj/crucible.toml — it is absent or does not parse, so every bound this client
  enforces runs at the value the build recommends."
==> Crucible bootstrap complete
```

Three paths exist; no two agree. Measured on the reporting machine, 2026-09-16:

| Who | Path it uses | Source | On that machine |
|---|---|---|---|
| clients | `<project dir>/crucible.toml`, falling back to `os.getcwd()` | `clients/_crucible_axi.py:154-158` | absent — bootstrap ran from `$HOME`, so it looked at `/home/antonyj/crucible.toml` |
| server | `dirname(store.path)/crucible.toml` | `src/limits.ts:158-159` | absent — `~/.local/share/crucible/` holds only `crucible.db*` |
| installer | `<target-dir>/crucible.toml` | `crucible_axi/manifest.py:72-75,98-108` | **present**, 3807 bytes at `~/.crucible/crucible.toml`, declared in `crucible-clients.json` as `"config"` |

So the installer lays down a real, commented, operator-editable file and **neither reader ever
consults it**. An operator can edit every limit in it and change nothing.

CR-CRU-131 §S1c exists precisely to prevent this; its own words (line 251) are *"Neither install
package ships one, so an installed deployment would resolve every limit from a file that does not
exist."* That sentence still describes the shipped product. The lay-down location was chosen on a
convenience argument — §S1c item 2, *"laid down by the installer, which already has a `[config]`
stage and already writes one file at `<target-dir>`"* — and never reconciled with either read path.
§S1c line 229 states the intent as *"the file the installer LAYS DOWN in the project directory"*, so
the implementation does not match even its own specification.

Two further facts, both verified:

- **The server's operator file is laid down nowhere.** `install.py:255-266` already computes
  `store_dir()` by the server's own rule, so the installer knows the path; nothing writes there.
  The server therefore runs its three limits on shipped recommendations with no file to edit.
- **This shipped green because the defects are pinned.**
  `tests/client/test_client_limits_resolve_from_configuration.py:786`
  (`test_the_clients_crucible_toml_sits_beside_the_env_it_already_reads`) asserts the project-dir
  rule, and `tests/client/test_installer_lays_down_the_editable_limits_file.py` asserts the
  `target_dir` lay-down. Each half is tested in isolation; **no test installs and then resolves.**
  That is the coverage hole, and it is the reason a two-line path mismatch survived a 4400-test
  suite and four full CI runs.

The two shipped templates are correctly disjoint and stay that way: `clients/crucible.toml` carries
`truncate_field_chars`, `error_detail_chars`, `roadmap_list_rows`; `src/crucible.toml` carries
`run_abandon_ms`, `project_inactive_ms`, `retention`. They differ by design (§S1c lines 224-232,
280-284 — version skew across two independently installable packages). This CR does **not** merge
them.

## Scope

### §S1 A client resolves the installed configuration when it is not inside a project

`project_config_path()` becomes an ordered chain, first readable file winning:

1. `<bound project dir>/crucible.toml` — unchanged, and still first. A project's own settings keep
   priority, which is what §S1b chose and what a multi-project machine needs.
2. `<install dir>/crucible.toml` — the file the installer actually laid down and the manifest
   already declares. The install dir is derived from **the running module's own location**: an
   installed client lives at `<install dir>/clients/_crucible_axi.py`, so the parent of its own
   directory is the install root. No new environment variable, no second source of truth, and a
   client running out of a git checkout resolves the checkout's `clients/` parent — the repo root —
   which is the existing developer behaviour.
3. The shipped package data — unchanged last resort.

**The `os.getcwd()` fallback is removed.** With no project dir bound, configuration resolution
becomes a function of the install, never of the directory the operator happened to be standing in.
That fallback is the whole reason the reported path read `/home/antonyj/crucible.toml`.

The unreadable-configuration warning names **every path tried, in order**, not just one: on a
machine carrying three candidate locations, "no readable configuration at X" tells an operator
almost nothing. The warning stays a warning — a client must still format output with no file
anywhere (CR-131's degradation rule is preserved exactly).

### §S2 The installer lays the server's operator file beside the server's database

When the installer provisions the server locally, it lays `src/crucible.toml` from the provisioned
npm package down at `store_dir()/crucible.toml`, by the same rules already established for the
client file:

- commented, operator-editable, carrying **only** the three server limits (§S1c line 230);
- declared in `crucible-clients.json` under its own key, distinct from the client `"config"`;
- an operator-EDITED file survives reinstall and purge; an untouched byte-identical copy may be
  removed (the existing `_operator_config_is_untouched` rule, reused, not reimplemented);
- when the server is **not** provisioned locally (`--no-service`, or a board on another host) the
  stage is skipped and **says so** — a silent skip is how the first hole stayed invisible.

### §S3 A test installs, then resolves

The missing coverage is the defect. One test exercises the real seam end to end: run the installer
into a temp target, then — with no project dir bound and the process cwd somewhere else entirely —
resolve a client limit and assert it comes from the **laid-down file's** value, not the shipped
recommendation. The same for the server: install, then assert the server's resolver reads the file
the installer wrote at the path the server computes.

**Isolation contract.** This test drives the REAL installer, which really writes files, so the
sandbox is part of the specification rather than a detail of how it is written. Three of the four
possible layers are adopted; the fourth is refused.

**L1 — process-scoped environment sandbox (the existing pattern, reused).**
`tests/client/test_installer_lays_down_the_editable_limits_file.py:35-44,93-130` already establishes
it and this CR extends rather than re-invents it: one `tempfile.mkdtemp` root removed by
`addCleanup`; `$HOME`, `$XDG_DATA_HOME`, `$XDG_CONFIG_HOME` and `$BUN_INSTALL` pinned inside that
root through `mock.patch.dict` so they restore even on failure; `CRUCIBLE_NO_SERVICE=1` and
`CRUCIBLE_NO_BUN_BOOTSTRAP=1`; the `[server]` stage (which really runs `bun add -g`) and `[unit]`
(which really drives `systemctl --user enable --now`) stubbed in BOTH the install and uninstall
directions. `[fleet]`, `[manifest]`, `[config]` and `[store]` run for real — that is the point.
`$CRUCIBLE_DB` points at the temp root for the server half, which is CR-CRU-131's existing suite
rule and is itself guarded by `tests/no-suite-resolves-the-repo-configuration.test.ts`.

Four hazards are specific to THIS test and are not covered by the inherited fixture:

1. **cwd is process-global.** The ACs require resolving from two different working directories.
   The chdir is restored in cleanup, and restored BEFORE the temp root is removed — a process whose
   cwd is a deleted inode makes every later `os.getcwd()` in the same worker raise.
2. **`_PROJECT_DIR` is a module global** (`clients/_crucible_axi.py:142`). The module is loaded
   fresh per test by the existing `_load_module_by_path` helper, and `bind_project_dir(None)` runs in
   teardown, so one test's binding cannot decide the next one's answer.
3. **The install root is derived from the module's own location** (§S1), so the client module MUST
   be loaded from the COPY the installer laid down inside the sandbox. Loading it from the checkout
   would resolve the repo root and the test would pass for the wrong reason — the exact failure mode
   that let this defect ship.
4. **The checkout must carry no root `crucible.toml`** during the run, for the same reason.

**L2 — an escape detector, asserted (new).** L1 protects the machine only from code that plays by
the rules; a hardcoded path, an `expanduser` evaluated before the patch, or a subprocess handed a
stale env dict all escape it silently. So the fixture snapshots the operator's REAL locations —
`~/.crucible`, `~/.local/share/crucible`, `~/.config/systemd/user`, and the repo root's own
`crucible.toml` — as `(exists, size, mtime)` before the test and asserts them unchanged after. This
is the layer that actually defends the machine, and it fails loudly rather than polluting quietly.

**L3 — kernel-level isolation, opt-in, not a gate requirement.** `bubblewrap 0.12.0` is available
on the development host, so the install suites can additionally be run under a user namespace with
a tmpfs over `$HOME`, where even a hardcoded absolute write lands on memory and evaporates:
`bwrap --unshare-user --unshare-pid --dev-bind / / --tmpfs "$HOME" --tmpfs /run/user/$(id -u)`.
This is offered as a script for local paranoia, NOT wired into the gate: bubblewrap is a host
dependency the CI runner does not guarantee, and a gate that cannot run everywhere is a gate that
gets bypassed. L1+L2 are portable and run everywhere.

**L4 — a fake filesystem (`pyfakefs` or monkeypatched `open`) is REFUSED.** The defect being fixed
is that the write path and the read path never meet on a real filesystem. A fake filesystem
reintroduces precisely the blind spot that produced this hotfix, and would let the bug survive a
green test for the second time.

## Acceptance criteria

- [ ] With an install at `<target>` whose `crucible.toml` sets `truncate_field_chars` to a legal
      non-recommended value, a client invoked with **no project dir bound and cwd outside the
      install** resolves that value. Pre-fix this test fails, resolving the recommendation.
- [ ] A project-dir `crucible.toml` still wins over the installed one when both exist and set the
      same limit to different legal values.
- [ ] No `crucible.toml` anywhere: every client limit resolves to its shipped recommendation and the
      verb still succeeds — CR-131's degradation behaviour, unchanged.
- [ ] `os.getcwd()` no longer appears in configuration-path resolution. A client run from an
      arbitrary directory with no project dir resolves the same configuration as one run from
      anywhere else — asserted by resolving from two different cwds and comparing.
- [ ] The unreadable-configuration warning lists every candidate path in precedence order.
- [ ] After an install that provisions the server, `store_dir()/crucible.toml` exists, parses,
      carries exactly the three SERVER limits and none of the client three.
- [ ] The server's resolver, pointed at that store dir, returns a value the laid-down file sets —
      proving the file the installer wrote is the file the server reads.
- [ ] `crucible-clients.json` declares both laid-down configuration files, and both declared paths
      exist after install.
- [ ] A server config the operator edited survives reinstall and purge; an untouched one may be
      removed under purge only.
- [ ] When the server is not provisioned locally, the server-config stage is skipped with a stated
      reason in the install output.
- [ ] `tests/client/test_client_limits_resolve_from_configuration.py:786` and the `target_dir`
      assertions in `tests/client/test_installer_lays_down_the_editable_limits_file.py` are updated
      to the chain rather than deleted — each still pins a real rule (project-dir first; the
      installer writes at `<target-dir>`), and neither may keep asserting that the installed file is
      unreachable.
- [ ] The new suite is DISCOVERED by the command CI already runs — `python3 -m unittest discover -s
      tests/client -t .` (`.github/workflows/release.yml`, job `test-python`) — so it gates every
      push with no workflow edit. Asserted by running that exact command and finding the new test
      ids in its output, not by reading the workflow.
- [ ] The L2 escape detector runs in CI as well as locally: it is fixture-level, not marked, not
      skipped on a runner, and asserts the same four real paths.
- [ ] The L1 sandbox holds on a runner as well as a workstation: the suite passes with `$HOME`,
      `$XDG_DATA_HOME`, `$XDG_CONFIG_HOME` and `$BUN_INSTALL` unset in the ambient environment
      (a fresh container's shape), not merely with a developer's values overridden.
- [ ] L3 is a script an operator runs, NOT a CI job — `bwrap` is not guaranteed on
      `ubuntu-latest`, and on a disposable container it defends nothing that L1+L2 do not. The
      script is documented in the RUNBOOK beside the suite it wraps, and a test asserts the
      documented command matches the script's own contents so the two cannot drift (CR-CRU-134's
      derivation rule).

## Non-goals

- Merging the client and server templates into one file. They are disjoint by design for version
  skew across two independently installable packages (§S1c lines 224-232, 280-284).
- Any change to the six limits' names, ranges or recommendations.
- Any new environment variable. The install root is derived from the running module's location; a
  configuration seam resolved from the environment is what CR-CRU-131 removed.
- The five findings in CR-CRU-137 (wave 7). This hotfix touches install-time configuration
  resolution only.
