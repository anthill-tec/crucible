# CR-CRU-066 — `crucible-axi install` hangs (runs the server) and exposes no run command; provision-and-exit + a `serve` verb + bun guarantee

**Status:** COMPLETED (shipped 2026-08-19 on develop)
**Type:** bugfix (install-contract — release blocker)
**Priority:** P0 — the published `0.1.1` install is unusable: `crucible-axi install` never returns, and nothing puts a runnable server command on PATH. Every `curl … | sh` / `uv tool install` user hits it.
**Depends on:** CR-CRU-009 (the staged installer), CR-CRU-041 (the npm server package + version pin)
**Labels:** bugfix, installer, cli, bun, docs, release-blocker
**Design reference:** README "Quick start" + `docs/RUNBOOK.md` (the documented install/run contract this CR makes true); `crucible_axi/install.py` `STAGE_ORDER`; `bin/crucible-server.mjs` (the Bun launcher).

## Context

Measured on the released `0.1.1` (user install, 2026-08-19):

1. **`crucible-axi install` hangs forever.** `install.py:_server_stage` runs
   `subprocess.run(["npx", "-y", "@anthill-tec/crucible-server@<ver>"])` — and that npm bin **is** the
   server (`bin/crucible-server.mjs` execs `src/server.ts` under Bun and `listen`s). So the "install"
   step launches a long-running server and never returns; the user must `Ctrl-C` it, aborting the
   run before the `manifest` stage.
2. **The idempotency marker is fictional.** `_server_already_installed` probes a `target_dir/server`
   directory that `npx` never creates (npx caches under `~/.npm/_npx`), so the stage is always
   "not installed" and always re-hangs.
3. **No run command exists.** `[project.scripts]` declares only `crucible-axi`; the bare
   `crucible-server` the README/RUNBOOK document exists only via a global npm install, which fails on
   a normal Linux user prefix.

The design intent (README) is clear and correct — install *provisions*, a separate step *runs* — the
code simply violates it. The server is a **Bun program**, so Bun is a hard runtime dependency
regardless of launcher; `npx` does not avoid it (its node shim spawns Bun) — it only adds a node
requirement. The lean, honest model is **bun-only**, guaranteed by install.

## Scope

### §S1 — The `server` stage provisions and EXITS; real idempotency

`_server_stage` no longer runs the server. It provisions the server package **user-scoped** via
`bun add -g @anthill-tec/crucible-server@<pinned>` (Bun's global lives under `~/.bun`, so there is no
system-prefix permission problem — the very failure that `npm -g` hits), which installs the package
and its `crucible-server` bin and **returns**. `_server_already_installed` is replaced by a REAL
probe — the resolved `crucible-server` bin exists under Bun's global bin — so a second `install` is a
genuine no-op, not a re-hang. The version pin logic (`_resolved_server_version_or_fail`) is unchanged.

### §S1b — The install creates its target directory (found by smoke, 2026-08-19)

A fourth defect, found by driving the real `cli.main(['install'])` after C2 rather than by reading:
the default `--target-dir` is `os.path.expanduser("~/.crucible")` (`cli.py:56`), **nothing in
`crucible_axi/` ever creates it** (`grep -rn "makedirs\|mkdir" crucible_axi/*.py` → no match), and it
does not exist on a fresh machine. So post-C1/C2 the server stage provisions successfully and the
**manifest stage then dies** `FileNotFoundError: …/.crucible/crucible-clients.json`, and
`crucible-axi install` still exits 1. The hang is fixed but the install is still not usable — same
user-visible outcome, different cause.

`run_install` creates the target directory (`os.makedirs(target_dir, exist_ok=True)`) before running
any stage, so a first install on a clean machine writes its manifest. Idempotent by `exist_ok`; a
genuinely unwritable target (permissions) must still fail definitively with the path named, never be
swallowed.

### §S2 — Bun is guaranteed or the install fails definitively

Before §S1, ensure Bun. **Detect it at BOTH locations before deciding anything: PATH
(`shutil.which`) AND the explicit `$BUN_INSTALL/bin/bun` (default `~/.bun/bin/bun`).** A PATH-only
probe is wrong and was caught at VERIFY: this CR's own install puts Bun under `~/.bun`, so an
operator who has not re-sourced their shell has a perfectly usable Bun that PATH cannot see — and a
PATH-only probe then re-pipes a remote installer into a shell on every `--force`/re-provision, which
is both wasteful and exactly the pipe-to-shell behaviour the opt-out exists to avoid. Only when
BOTH locations miss does it bootstrap via the Bun installer
(`curl -fsSL https://bun.sh/install | bash`) **and re-resolve** including `~/.bun/bin` (the
installer's target is not on the current shell PATH — the same re-resolve `install.sh` already does
for `uv`). Then **verify** `bun --version` actually runs; if Bun still cannot be resolved, **raise and
fail the whole install** with a named remedy (`install Bun: https://bun.sh, then re-run`) — never the
current `check=False` swallow that limps on to a cryptic later failure. The resolved **absolute** Bun
path is recorded as a stage output in the install envelope.

Auto-bootstrap is the DEFAULT (README intent); a `--no-bun-bootstrap` flag and
`CRUCIBLE_NO_BUN_BOOTSTRAP=1` opt out — in which case a missing Bun goes straight to the definitive
fail-with-remedy, never piping a remote script to shell.

### §S3 — `crucible-axi serve` — the run command

New verb `crucible-axi serve` launches the server in the FOREGROUND (blocking is correct here, unlike
install): it execs the provisioned server by **absolute path** (`~/.bun/bin/crucible-server`, or
`bunx @anthill-tec/crucible-server@<pinned>` if the bin is absent), forwarding `CRUCIBLE_HOST` /
`CRUCIBLE_PORT` and the child's exit code. Absolute-path resolution matters because a later systemd
`--user` unit (follow-up CR) gets a minimal PATH. `[project.scripts]` still declares only
`crucible-axi`; `serve` is a subcommand, not a second console script.

### §S4 — Docs reconciled to reality

- **README "Quick start":** the one-liner points at
  `https://raw.githubusercontent.com/anthill-tec/crucible/<tag>/install.sh` (the repo is public;
  `crucible.dev` is unregistered — retire that host until it exists). The flow reads
  `uv tool install crucible-axi` → `crucible-axi install` (now exits, provisions Bun + server) →
  `crucible-axi serve`. The bare `crucible-server` line is replaced by `crucible-axi serve`.
- **`docs/RUNBOOK.md`:** `crucible-server` → `crucible-axi serve` (with `CRUCIBLE_HOST`/`CRUCIBLE_PORT`
  examples); note Bun is the runtime and is guaranteed by `crucible-axi install`.
- **Stale skills claims (CR-042 fallout):** README:33 still says install "installs the multi-harness
  skill set" and README:58 describes `clients/skills/` — both false since CR-042 retired the `[skills]`
  stage (`STAGE_ORDER = server, manifest` only; skills are Model-B's `modelb-axi`). Correct both so the
  README states install provisions the server + writes the manifest, and does NOT touch skills.
- **`install.sh`:** it already calls `crucible-axi install`, which now terminates — no logic change
  beyond confirming it no longer hangs end to end; update the `<crucible>` hosting comment.

### §S5 — Tests (the regression guards the bug had none of)

- `run_install` **terminates** — the highest-value guard: with the `server` runner stubbed to a
  fast provision, `run_install` returns `(ok, stages, warnings)` and never blocks; a test that would
  hang on the old `npx -y <server>` behaviour.
- Bun-missing → `_server_stage`/install **raises** the named remedy (not a swallow); with
  `--no-bun-bootstrap`, a missing Bun fails without invoking the installer.
- Real idempotency — a provisioned bin makes a second `install` a no-op (converged) without shelling
  out.
- `crucible-axi serve` resolves the **absolute** Bun/bin path and version pin, and forwards
  `CRUCIBLE_HOST`/`CRUCIBLE_PORT` (drive it as data; do not actually bind a port in the unit test).
- **Rewrite the tests that pin the defect (RED-first):** `tests/client/test_crucible_axi_stages.py`
  asserts the broken contract verbatim — `npx -y <SERVER_NPM_PACKAGE>` delegation, a RuntimeError
  "mentioning npx", and `_server_already_installed` mocking. Re-point these to the `bun add -g`
  provision-and-exit contract + the real bin-probe idempotency; they encode the bug today and must
  change with the fix, not survive it. Add the `serve` verb to `tests/cli-axi.test.ts`.
- **`tests/client/test_crucible_axi_version_pin.py` is in the impact set too** — its module helper
  `_server_npx_argv` (`:76`) only recognises an argv containing `npx`, so under the new contract it
  returns `None` and four tests fail: the two `ServerStageNpxArgvVersionPinTest.*` cases AND the two
  `ServerStageFailsFastOnUnresolvedVersionTest.test_server_stage_proceeds_*` cases (all four consume
  the same helper). The pin SEMANTICS are unaffected — the captured argv carries the correct pinned
  version/override — so the fix is re-pointing the matcher to `["bun","add","-g"]` and renaming the
  two `*_npx_argv_*` tests. Recorded because the first impact sweep used a truncated `grep … | head`
  and missed this file; the unfiltered sweep is the authority (`cli-axi.test.ts` /
  `cr009-release-bundle.test.ts` also mention `npx`, but only as prose about the npm bin being
  npx-runnable, which stays true — both green, no action).
- README/RUNBOOK data assertions updated (`tests/cr009-release-bundle.test.ts`): the install/run
  commands the docs advertise match the CLI the package ships.

## Acceptance criteria

1. `crucible-axi install` (with the server stage stubbed to provision) **returns**; a test that
   asserts termination passes, and would fail/hang against the `0.1.1` `npx -y <server>` behaviour.
2. `_server_stage` invokes `bun add -g @anthill-tec/crucible-server@<pinned-version>` (user-scoped),
   never a command that runs the server; on success it returns `converged=False`, and a second call
   with the bin already present returns `converged=True` without shelling out.
3. Bun absent + auto-bootstrap: the stage runs the Bun installer, re-resolves `~/.bun/bin`, and
   proceeds. Bun still unresolved after bootstrap → the install raises a `RuntimeError` naming the
   remedy; `run_install` returns `ok=False` with that message, never a silent continue.
4. `--no-bun-bootstrap` / `CRUCIBLE_NO_BUN_BOOTSTRAP=1`: a missing Bun fails immediately with the
   remedy and does NOT invoke the `curl … bun.sh` bootstrap.
5. `crucible-axi serve` exists as a subcommand, launches the server by absolute path in the
   foreground, honours `CRUCIBLE_HOST`/`CRUCIBLE_PORT`, and returns the child's exit code.
5a. **Ctrl-C stops it cleanly, with no traceback.** `RUNBOOK` documents Ctrl-C as the stop gesture, so
   a foreground `SIGINT` — which the shell delivers to the whole process group — must NOT surface a
   Python `KeyboardInterrupt` stack trace out of `subprocess.run`. It exits `130` (the SIGINT
   convention). This is the same unpolished failure the 0.1.1 hang produced when the user Ctrl-C'd it,
   and the reason the resolution-failure path already forbids tracebacks.
5b. **A signal-terminated server reports `128+N`, not a masked negative.** `CompletedProcess.returncode`
   is negative when the child is signalled (`-15` for SIGTERM), and `sys.exit(-15)` masks to OS status
   `241`. `serve` translates it (`143` for SIGTERM, `137` for SIGKILL) so a supervisor — including the
   systemd `--user` unit this CR delivers `serve` for — can tell the process was signalled.
6. README "Quick start" contains no `crucible.dev` and no bare `crucible-server`; its one-liner is the
   `raw.githubusercontent.com/anthill-tec/crucible/<tag>/install.sh` form, and its run step is
   `crucible-axi serve`. `docs/RUNBOOK.md` matches.
7. `run_install` creates `target_dir` (`exist_ok=True`) before any stage, so a first install on a
   clean machine (no `~/.crucible`) completes: server provisions AND the manifest is written, exit 0.
   Driven end to end against a non-existent target dir — the exact smoke that exposed the defect. An
   unwritable target still fails definitively with the path named.
8. Both stacks green before close-out (CR-CRU-045 §S3 — Python + bun suites), including the release
   `.github/workflows/release.yml`/README-as-data suite if its assertions are touched.

## Estimated size

Medium. One install-stage rewrite + a bun-guarantee helper + one new CLI subcommand + doc
reconciliation, with focused tests. Five cycles (C1, C1b, C2–C4) then VERIFY, then the `0.1.2` patch
release.

## Risk

- **A test that actually shells to `bun add -g` or the Bun installer is slow and environment-coupled.**
  Drive the provision and the bootstrap through mockable seams (as `_server_already_installed` /
  `_server_stage` already are); assert the COMMAND composed, not a real network install.
- **`serve` blocking is correct, but a test that runs it for real hangs like the original bug.** Test
  the composed launch (absolute path, pin, env) as data; never bind a port in a unit test.
- **Absolute-path resolution** must survive a minimal PATH (the systemd follow-up depends on it) —
  resolve `~/.bun/bin` explicitly rather than trusting inherited PATH.

## Implementation notes

### `serve` deliberately emits NO TOON-AXI envelope (C3)

Every other verb emits one document on stdout (CR-CRU-030 §S1). `serve` does not, and that is a
deliberate deviation rather than an omission: `serve` hands stdout to the **server process** for the
life of the run, so emitting an envelope first would either violate §S3 stdout purity (a document
followed by unrelated server output) or force us to swallow the server's own stdout. A run command
that blocks by design has no terminal state to report at launch time.

What it does instead: a pre-launch resolution failure (no provisioned bin AND no resolvable Bun)
writes `crucible-axi serve: <remedy>` to **stderr** and exits 1 — no traceback — and the child's exit
code otherwise passes through verbatim. If the fleet later wants a machine-readable `serve`
(e.g. a pre-launch envelope on a separate fd, or a `--dry-run` that prints the composed argv and
exits), that is a deliberate follow-up, not something half-done here.

### Unwritable target dir returns an envelope, not a traceback (C3)

`run_install`'s `makedirs` failure becomes `{"code": "target-dir-failed", detail: "could not create
target dir <path>: <exc>"}` with `ok=False`, rather than a propagated `OSError`. The AC accepts
either shape; this one keeps `crucible-axi install` emitting a well-formed envelope and exiting 1 on
a permissions problem, which is what an agent consuming the install output needs.

## Non-goals

- The **systemd `--user` daemon** (`crucible-axi service …` + unit template) — the Linux-native
  managed run — is a SEPARATE follow-up CR, not this patch. This CR delivers the foreground `serve`
  it will wrap.
- No change to the version-pin model, the manifest stage, or the PyPI/OIDC publish flow.
- No `npx`/node path — the server is a Bun program; bun-only is deliberate (§S1/Context).
