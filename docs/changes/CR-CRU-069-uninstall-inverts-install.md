# CR-CRU-069 — Install has no inverse: `crucible-axi uninstall` + `install.sh` teardown

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 009, 066
- **Status**: PENDING (0.2.0)

## Problem

`install.sh` bootstraps uv, runs `uv tool install crucible-axi`, then delegates
the real provisioning to `crucible-axi install`, whose stages guarantee Bun and
provision the server. **Nothing reverses any of it.** `uninstall` appears zero
times in `crucible_axi/cli.py` and `crucible_axi/install.py`.

`uv tool uninstall crucible-axi` removes only the Python CLI and orphans
everything its stages created. Measured on 2026-08-20 after exactly that:

| artifact | state after `uv tool uninstall` |
|---|---|
| `~/.bun/install/global/node_modules/@anthill-tec/crucible-server` | still installed (0.1.2) |
| `~/.bun/bin/crucible-server` (symlink) | still present |
| `~/.crucible/crucible-clients.json` | still present |
| `~/.local/share/crucible/` | still present (9.1 MB) |

So the documented install path leaves a user with a provisioned server, a live
`crucible-server` on PATH, and client state, after they believe they have
uninstalled the product.

## Design — a logical inversion of install, along the same path

Install is a script that delegates to a verb. Teardown mirrors it exactly, in
reverse order, because a running tool cannot remove itself:

```
install:    install.sh → uv tool install crucible-axi → crucible-axi install   [bun guarantee] [server]
uninstall:  install.sh → crucible-axi uninstall  [state] [server]  → uv tool uninstall crucible-axi
```

The verb reverses the stages it owns; the script performs the one step the verb
structurally cannot (removing the tool that is executing), and it does it
**last**.

## Scope

Non-goals, explicitly:

- **`crucible-axi install` stays.** `install.sh` calls it and that delegation is
  the intended path — this CR adds the inverse, it does not restructure or
  duplicate the installer.
- **Bun is never removed.** Install only *guarantees* Bun; it does not own it.
  A user's Bun may predate Crucible and serve other projects. Uninstall reverses
  what install *provisioned*, never what it *found or bootstrapped as a runtime*.
- No change to `install`'s stages, argv, envelope, or exit codes.
- No change to `serve` (CR-CRU-066), which remains envelope-free.

## Acceptance criteria

**AC1 — `crucible-axi uninstall` reverses exactly what the stages provisioned.**
It removes the global server package and its `crucible-server` symlink (the
inverse of the `[server]` stage's `bun add -g`, via the same absolute-Bun
resolution — never a bare `bun` off PATH) and removes the client state written
under the target dir. It removes nothing it did not provision.

**AC2 — stage inversion is ordered and reported.** Stages run in reverse install
order (state before server), each reported as its own stage, fail-fast, with the
same TOON-AXI envelope shape and exit-code contract as `install` (`ok=False` →
exit 1). Parity with `install` is asserted, not assumed.

**AC3 — idempotent.** Running `uninstall` on an already-clean machine converges:
every stage reports converged, `ok=True`, exit 0, and no subprocess is spawned
for an artifact that is already absent. Running it twice is indistinguishable
from running it once.

**AC4 — data is opt-in, never collateral.** The store
(`~/.local/share/crucible/`, including any `crucible-pre-*.db` backups) is
**retained by default** and removed only under an explicit `--purge-data`. The
default run states, in its envelope, that the store was retained and where it
is. `--purge-data` on an absent store still converges.

**AC5 — `install.sh` gains the inverse path.** The script performs teardown by
calling `crucible-axi uninstall` first and `uv tool uninstall crucible-axi`
last, and it must not fail when the tool is already gone (a partially
uninstalled machine converges). The one-liner form is documented in README
alongside the install one-liner, on the same `master` raw-GitHub ref.

**AC6 — the inverse is proven against real artifacts.** A test provisions into a
temp `$BUN_INSTALL` + temp target dir, runs `uninstall`, and asserts the package
directory, the symlink, and the state file are gone — asserted by filesystem
absence, not by mocking the remover. No test binds a port or runs a real server.

**AC7 — docs describe the reversal.** README and RUNBOOK document the teardown
path and state plainly that Bun is left installed and that the store survives
unless `--purge-data` is passed.

## Notes

- Found when the maintainer uninstalled `crucible-axi` with uv and the 0.1.2
  server, its symlink, and client state were all still live afterwards.
- `bun remove -g <pkg>` is the counterpart to the `bun add -g` the `[server]`
  stage uses; `bun remove --help` documents `-g` only as "Install globally",
  which is a Bun help-text quirk, not a missing capability. The stage must not
  depend on that text.
