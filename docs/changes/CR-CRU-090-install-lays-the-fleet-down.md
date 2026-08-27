# CR-CRU-090 — `install` never lays the client fleet down, so every manifest path is dead

**Type:** hotfix
**Target release:** 0.1.3 (hotfix off `master`)
**Depends on:** —

## Context

`crucible-axi install --help` declares `--target-dir` as *"directory the client fleet +
manifest are laid down under"* (default `~/.crucible`), and the discovery manifest is built
against exactly that declaration: `manifest.build_manifest(install_dir)` returns
`clients[stack] = <install_dir>/clients/<stack>-crucible.py` and
`status = <install_dir>/clients/STATUS-CONTRACT.md`.

Nothing materialises that directory. At `0.1.2`, `install.STAGE_ORDER = ("server",
"manifest")` and no stage copies the fleet; the wheel force-includes `clients` as
`crucible_axi/clients`, so the files exist only inside the installed package. The result is
a manifest that is written successfully, converges idempotently, and names **six paths that
do not exist** — five clients plus the status contract. `crucible_axi/cli.py` is unaffected
because it resolves the fleet from the package for its own use
(`_CLIENTS_CANDIDATES`/`_clients_dir()`), which is why no in-repo path exercises the gap.

This is the pre-flight contract an external consumer captures at install time
(CR-CRU-009 §S2 [manifest], deferred there from CR-CRU-035). Consuming it as written yields
a dead feed. CR-CRU-009's acceptance criterion asked only that the manifest *"exists with a
stable schema mapping each stack to its installed client path"* — satisfiable while every
path dangles, which is why the gap shipped in 0.1.0 and survived 0.1.1 and 0.1.2.

The declared contract is the one to honour: consumers anchor on `<target-dir>/clients/`,
never on the package's internal location, which moves with the interpreter and is not a
stable surface.

## Steps

### §S1 A `fleet` stage that materialises the fleet under `<target-dir>/clients/`

Add a stage named `fleet` to `crucible_axi/install.py`, ordered **before** `manifest`:
`STAGE_ORDER = ("server", "fleet", "manifest")` — the manifest is written only after the
paths it names exist.

The stage copies, from the resolved source clients directory into
`<target-dir>/clients/`, exactly the packaged fleet:

- `bun-crucible.py`, `python-crucible.py`, `rust-crucible.py`, `mvn-crucible.py`,
  `arduino-crucible.py`
- `_crucible_axi.py`, `toon.py` — the shared envelope + codec modules the five load **by
  file path** from their own directory; a copy without them yields five unrunnable clients
- `STATUS-CONTRACT.md` — the path `manifest.build_manifest` publishes as `status`

Rules:

- Copy is confined to `<target-dir>/clients/`; the directory is created if absent.
- **Idempotent/convergent:** a file whose destination bytes already match the source is not
  rewritten. The stage returns `converged: True` only when every one of the eight files
  already matched, mirroring the `manifest` stage's contract.
- `--force` re-copies unconditionally.
- Files present in the destination but not in the source set are left untouched (the
  install never removes unmanaged files).
- The stage returns the usual envelope fields: `path` (the `~`-abbreviated clients dir) and
  `converged`.

### §S2 One locus for the source clients directory

`cli.py` privately owns `_CLIENTS_CANDIDATES` / `_clients_dir()` (source checkout first,
installed package data second). Expose that resolution once as
`manifest.source_clients_dir()` and have BOTH `cli.py` and the new `fleet` stage call it.
No second copy of the candidate list.

### §S3 The manifest's paths must resolve

`manifest.build_manifest` keeps its signature and its keys. Its contract is tightened by
test, not by shape: after a real `run_install` into a scratch target dir, every path the
manifest publishes — the five `clients[stack]` values and `status` — must exist on disk and
be readable.

## Acceptance criteria

- [ ] **AC1 — `STAGE_ORDER` is `("server", "fleet", "manifest")`**, and `run_install`
      reports a `fleet` stage in its envelope with a `path` ending `/clients`.
- [ ] **AC2 — the eight files land.** After `run_install(target_dir)` into a scratch dir,
      `<target-dir>/clients/` contains exactly `bun-crucible.py`, `python-crucible.py`,
      `rust-crucible.py`, `mvn-crucible.py`, `arduino-crucible.py`, `_crucible_axi.py`,
      `toon.py`, `STATUS-CONTRACT.md`, each byte-identical to its source.
- [ ] **AC3 — every manifest path resolves.** For the manifest written at
      `<target-dir>/crucible-clients.json`: `os.path.exists()` is true for all five
      `clients[stack]` values and for `status`. This assertion fails on `0.1.2`.
- [ ] **AC4 — a copied client actually runs.** `python3 <target-dir>/clients/python-crucible.py
      --help` exits 0 — proving the shared-module-by-path load works from the copied
      location (the failure mode a clients-only copy would hide).
- [ ] **AC5 — convergence.** A second `run_install` with no changes returns the `fleet`
      stage with `converged: True` and rewrites nothing (file mtimes unchanged);
      `--force` returns `converged: False` and rewrites all eight.
- [ ] **AC6 — ordering is enforced, not incidental.** With the `fleet` stage stubbed to
      fail, the `manifest` stage does not run (existing fail-fast contract), so a manifest
      is never written naming paths that were not laid down.
- [ ] **AC7 — one resolver.** `manifest.source_clients_dir()` exists and is THE resolver;
      BOTH `cli._load_client_module` and `install.run_fleet_stage` go through it (provable
      by patching that attribute and observing both behaviours change); neither module
      defines a private candidate list or resolver; and the candidate ORDER is preserved
      (source checkout, then installed package data, falling back to the checkout path so a
      failure names the location an operator expects).
- [ ] **AC8 — integration, real entry point.** The test drives `cli.main()` with
      `install --target-dir <scratch>` (not `run_install` in isolation) with the `server`
      stage stubbed, and asserts AC2 + AC3 from the resulting on-disk state.

## Non-goals

- The uninstall inverse for `<target-dir>/clients/` — `uninstall` does not exist in the
  0.1.x line; the develop-side `uninstall` (CR-CRU-069) gains the inverse when this
  hotfix merges back.
- Changing the manifest's schema, key names, or file name (`crucible-clients.json`) — the
  consumer contract stays byte-compatible; only the values become real.
- The systemd `unit` stage (develop-only).
