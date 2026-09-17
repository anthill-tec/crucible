# CR-CRU-142 — the orchestrator's own copy resolves its own package, not the install it just wrote

**Type** hotfix · **Wave** 7 (0.2.2) · **Depends on** — · **Status** PENDING

## Problem

Reported from a real production install, `crucible-axi==0.2.1` via `install.sh` on a machine with no
prior Crucible state:

```
axi:
  verb: install
  ok: true
  ...
  warnings[1]{code,detail}:
    limit-configuration,"[crucible] WARNING: no readable configuration. Tried, in precedence order:
    /home/antonyj/.local/share/uv/tools/crucible-axi/lib/python3.13/site-packages/crucible_axi/crucible.toml
    — none of them reads (absent, or does not parse), so every bound this client enforces runs at
    the value the build recommends. Create the first of them (or correct its TOML) to configure
    them."
```

The named path is inside `crucible-axi`'s own `uv tool install` venv — a directory `uv` owns and
replaces wholesale on every upgrade, and not a path any operator would ever create or edit. The
install that emitted this warning had, in the same run, just written a real operator-editable file
at `~/.crucible/crucible.toml` (visible in that same envelope's `[manifest]` stage). The warning
named the wrong file while sitting beside the right one.

**Root cause, verified by reading the code CR-CRU-138 shipped.** `clients/_crucible_axi.py`'s
config-precedence chain (CR-CRU-138 §S1) resolves an unbound `_PROJECT_DIR` to
`_INSTALL_DIR/crucible.toml`, where `_INSTALL_DIR` is derived from **the running module's own file
location** — correct for the two shapes CR-138 enumerated (a checkout's `clients/`, and a
FLEET-installed client at `<install>/clients/_crucible_axi.py`, giving `_INSTALL_DIR = <install>`).
Neither is what actually loads this warning here.

`crucible_axi/cli.py`'s `_load_client_module` (both call sites: `cmd_install:108`,
`cmd_uninstall:244` — measured on THIS branch, whose `cli.py` is 328 lines; the first draft of this
paragraph cited `:159`/`:295`, read off `develop`, where CR-CRU-139's retry loop has since pushed
them down) vendors its OWN copy of the same shared module by file path, from **inside its own venv**
(`crucible_axi/clients/_crucible_axi.py`, per the
PyPI wheel's own layout — confirmed by downloading `crucible_axi-0.2.1-py3-none-any.whl` and
listing it). That copy's `_INSTALL_DIR` therefore resolves to `dirname(crucible_axi/clients)` =
`crucible_axi` **inside site-packages** — a THIRD execution shape CR-138 never accounted for.
Neither `cmd_install` nor `cmd_uninstall` ever calls `bind_project_dir`, so `_PROJECT_DIR` stays
`None` and the chain collapses to that one useless candidate.

The fix is not a new precedence rule: `args.target_dir` — the exact directory `cmd_install` and
`cmd_uninstall` already operate on, and the one `run_install` just finished writing
`crucible.toml` into — is sitting unused in the same function that loads the vendored module.

## Scope

### §S1 — the orchestrator's own install/uninstall bind the module to the install it is acting on

`cmd_install` and `cmd_uninstall` each call `axi.bind_project_dir(args.target_dir)` immediately
after loading the vendored `_crucible_axi` module and before any call that can emit a disclosure
(`emit_axi`). This makes `_project_config_candidates()` resolve `<target_dir>/crucible.toml` first
— the file the install verb itself lays down — exactly matching what a fleet-installed client
resolves when it later reads the same file from inside `<target_dir>/clients/`.

No change to `_crucible_axi.py` itself: `bind_project_dir` already exists (CR-CRU-138 §S1b) and is
already the exact mechanism every `*-crucible.py` client uses to bind its own project root. This CR
is a two-call-site wiring fix in `crucible_axi/cli.py`, not a new resolution rule.

### §S2 — the warning read as a fresh install, not a diagnosis of a stale one

Because `cmd_install`'s envelope is built AFTER `run_install` has already written
`<target_dir>/crucible.toml` (per CR-CRU-138 §S1c's fleet-lay-down), a healthy fresh install now
resolves that very file it just wrote and the warning goes silent — it was never really "no
configuration exists", it was "the resolver looked in the wrong place". `cmd_uninstall` has no file
to have just written (uninstall may have removed it), so its warning, when one fires, now correctly
names `<target_dir>/crucible.toml` — the file an operator actually owns — rather than a site-packages
path they cannot act on.

### §S3 — nothing to sweep here, and why that is a finding rather than a relief

The first draft required re-recording three `cli.py:355-362` citations after the insertions. On this
branch there is no such range — `cli.py` ends at 328 — and `grep -rn 'cli.py:3[0-9][0-9]' tests/`
returns NOTHING. Those citations exist only on `develop`, because the `--host`/`--port` behaviour
they name is CR-CRU-139's rewrite (serve WRITES the listener into the server's `crucible.toml`),
which is not in 0.2.2's lineage: here `cmd_serve` still exports `SERVER_HOST_ENV_VAR` /
`SERVER_PORT_ENV_VAR`, the mechanism CR-CRU-139 retired.

So this section requires no sweep on the hotfix branch. It is recorded rather than deleted because
the same two insertions WILL shift those develop-side citations when 0.2.2 back-merges into
`develop` at `git flow hotfix finish` — and that is where they must be re-checked, against
develop's own line numbers, not invented from this branch's.

## Acceptance criteria

**§S1**
- [ ] A real `crucible-axi install --target-dir <tmp>` into an empty directory, with `<tmp>` then
      holding a `crucible.toml` that sets a legal non-recommended limit value, emits an envelope
      whose `warnings` carries no `limit-configuration` disclosure — the install resolves the file
      it just wrote. Pre-fix this test's envelope carries the disclosure naming a site-packages path.
- [ ] With `<tmp>/crucible.toml` absent or deleted before the install (`--force` re-run), any
      `limit-configuration` warning `cmd_install` emits names `<tmp>/crucible.toml` as its first
      candidate — never a path under the process's own module location.
- [ ] `crucible-axi uninstall --target-dir <tmp>` exhibits the same rule: any `limit-configuration`
      warning its envelope carries names `<tmp>/crucible.toml`, not a site-packages path.
- [ ] A test asserts `_PROJECT_DIR` is bound to `args.target_dir` at the point each envelope is
      built, for both `cmd_install` and `cmd_uninstall` — driven through the real CLI entry point,
      not by calling `bind_project_dir` directly in the test.

**§S2**
- [ ] `clients/_crucible_axi.py` is unchanged by this CR — the fix is confined to the two call sites
      in `crucible_axi/cli.py` that were missing the bind. A diff touching `_crucible_axi.py` is out
      of scope for this CR.

**§S3**
- [ ] Every `cli.py:NNN` citation in this branch's `tests/` tree is checked against the line it
      names after §S1 lands, and any that the two insertions shifted is re-pointed. **The "zero
      hits" this AC first claimed was wrong, and wrongly measured**: it came from
      `grep 'cli\.py:3[0-9][0-9]'`, a pattern narrowed to develop's serve citations. The honest
      pattern `grep -rn 'cli\.py:[0-9]\+' tests/` returns FOUR — `cli.py:53`, `:56`, `:104` in
      `test_cr066_serve_and_target_dir.py` (all above the first insertion at `:107`, unshifted) and
      `cli.py:130` in `test_cr070_systemd_unit.py`, which IS in the shifted region and whose content
      now sits at `:138`. All four are re-checked; the shifted one is corrected. (`cli.py:130` and
      its two `install.py` siblings were ALREADY stale before this CR — CR-CRU-070 RED-phase
      archaeology pointing at unrelated lines — so this CR invalidated no correct citation, but the
      AC is only tickable once they name what they claim.)
- [ ] The back-merge is where develop's three `cli.py:355-362` citations get re-checked — recorded
      here as a close-out obligation of `git flow hotfix finish`, against develop's own line
      numbers, never numbers carried over from this branch.

## Estimated size

Small. Two `bind_project_dir` calls, one test file exercising both verbs through the real CLI with a
real filesystem (matching CR-CRU-138 §S3's L1+L2 isolation discipline — no fake filesystem).

## Risk

- **A fake or mocked filesystem would hide this class of bug again**, the same failure mode
  CR-CRU-138 §S3 refused for its own suite. This CR's test drives the real `crucible-axi` console
  script against a real temp directory.

## Non-goals

- Any change to `_crucible_axi.py`'s precedence chain itself — CR-CRU-138 §S1's three-candidate
  order (project → install → shipped) is correct; this CR only makes `crucible_axi/cli.py` participate
  in it honestly.
- `cmd_serve` — it never loads the vendored module and carries no disclosure to fix.
