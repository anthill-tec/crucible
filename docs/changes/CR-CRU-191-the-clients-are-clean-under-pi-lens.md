# CR-CRU-191 — the clients are clean under pi-lens

**Type** fix (patch CR) · **Points** 5 (set at filing, 2026-10-14) · **Wave** 8 (0.4.0) · **Depends
on** — · **Status** PENDING — filed 2026-10-14 (user ruling: the pi-lens flags are fixed in a patch
CR; moved out of CR-CRU-188 when that CR's live-data section widened past the cap)

## Problem

**The clients carry blocking static-analysis findings that no gate checks.** pi-lens flags them on
every edit to these files; they predate this CR's wave and were waved through as "not ours".
Measured 2026-10-14 (`lens_diagnostics`, session, full):

| File | Blocking | Kinds |
|---|---|---|
| `clients/_crucible_axi.py` | 15 | Pyright: a possibly-`None` value used as a path (L771), as a slice bound (L4455, L4462, L4463), as a dict key (L5998) and in arithmetic (L6332, L6333); a field name outside its `Literal` set (L2811). ast-grep: an unguarded throwing call (L302, L324, L686) |
| `clients/arduino-crucible.py` | 8 | ast-grep: an unguarded throwing call (L108, L366, L568, L572, L591, L600, L601). Ruff: an unnecessary `dict()` call (L1430) |
| `clients/mvn-crucible.py` | 6 | ast-grep: an unguarded throwing call (L137, L171, L611, L613, L649, L757) |
| `clients/python-crucible.py` | 6 | ast-grep: an unguarded throwing call (L126, L486, L580, L722, L775, L906) |
| `clients/rust-crucible.py` | 6 | ast-grep: an unguarded throwing call (L154, L535, L837, L858, L862, L873) |
| `clients/bun-crucible.py` | 4 | ast-grep: an unguarded throwing call (L145, L880, L1188, L1336) |
| `clients/toon.py` | 4 | Pyright: a possibly-`None` match or value used (L552, L1109, L1177, L1216) |
| `tests/client/test_crucible_axi_shared.py` | 1 | Pyright: a possibly-`None` callable called (L1261) |
| `tests/client/test_cr054_drift_guard.py` | 1 | Ruff: `if` branches to combine with `or` (L156) |
| `tests/client/test_cr054_http_core_lift.py` | 2 | Pyright: a `dict` passed as `HTTPError` headers (L186); a zero-argument `read` assigned (L187) |

Warnings also stand: unguarded `int()`/`float()` parses in `_crucible_axi.py` (L3248, L4683,
L4692), `arduino-crucible.py` (L369–L375) and `rust-crucible.py` (L480, L538–L544, L662, L663,
L694, L750, L835).

## Steps

### §S1 — the clients are clean under pi-lens

Every blocking finding in the table, and every warning named with it, is resolved one of two ways:
- **fixed:** the possibly-`None` value is checked or narrowed; the unguarded parse or call handles its
  failure the way its verb already reports failures (an envelope, never a traceback);
- **kept on purpose:** where the call is meant to raise (a missing file the verb must refuse on, say),
  it is marked in place with the reason, in the suppression form pi-lens honours.

No behaviour a test pins changes.

## Acceptance criteria

- [ ] **Lint-clean.** A pi-lens sweep (`lens_diagnostics`, session, full) over `clients/` and the three
      named test files reports zero blocking findings, and none of the warnings named in the table.
      Each suppression carries its reason. Both full suites pass.
- [ ] **No new CR literals.** No CR-shaped literal is added under `clients/` or in test comments, and
      the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: RED (the sweep's findings are the failing check, and a test pins each
behaviour a fix changes), GREEN per file, then verify.
