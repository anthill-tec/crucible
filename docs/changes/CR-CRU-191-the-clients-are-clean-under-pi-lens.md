# CR-CRU-191 — the clients are clean under pi-lens

**Type** fix (patch CR) · **Points** 8 (5 at filing; 8 after the pre-review widened §S1 and §S3, 2026-10-14) · **Wave** 8 (0.4.0) · **Depends
on** — · **Status** PENDING — filed 2026-10-14 (user ruling: the pi-lens flags are fixed in a patch
CR; moved out of CR-CRU-188 when that CR's live-data section widened past the cap). Re-scoped at gap
analysis 2026-10-14 (user rulings: one seam and the two lexical rules turned off; every Python file
the clients ship; the XML parse kept, marked); spec pre-review findings folded in

## Problem

**The Python the project ships carries static-analysis findings that pi-lens raises on every edit,
and that were waved through as "not ours".** They fall into three kinds.

1. **An I/O or parse failure escapes as a traceback.** `run_verb`, the dispatch all five clients
   (`python`, `bun`, `rust`, `mvn`, `arduino`) exit through, converts only its typed hard stops into
   the `ok: false` envelope. An `OSError` from reading a report, creating or clearing a reports
   directory, or moving a report, and a `ValueError` from parsing a report's numbers or JSON, end the
   verb with a Python traceback and no envelope. The no-argument dashboard (`cmd_dashboard`, run when
   no verb is given) does not pass through `run_verb` at all, in any client. The installer's
   `crucible_axi.cli.main` has no conversion either. pi-lens's `unchecked-throwing-call-python` and
   `unchecked-numeric-parse-python` rules point at this. They do it lexically, flagging every `open`,
   `os.makedirs`, `os.remove`, `shutil.move`, `os.listdir`, `int()` and `float()` with no enclosing
   `try`. Measured: 31 such calls in `clients/`, 13 in `crucible_axi/install.py`, and 40 parses.
2. **The type checker cannot see a value is never `None`.** Pyright flags possibly-`None` values in
   `_crucible_axi.py`:
   - a path join, in `run_reports_dir`;
   - a column index, in `parse_queue_table`;
   - a dict key, in the gate's suite listing;
   - a timer's start mark, in the resource meter's `__exit__`;
   - a field name outside the history columns' `Literal` set, in `select_history_fields`.

   It flags four more in `toon.py`. In the tests it flags a possibly-`None` callable called in
   `test_crucible_axi_shared.py`, and in `test_cr054_http_core_lift.py` an `HTTPError` built with a
   `dict` for headers and a zero-argument `read` stub. Two real defects sit in `parse_queue_table`:
   - a queue table whose header has no `title` or `depends` column reaches `cells[None]` and raises
     `TypeError`, where every other malformed table raises `QueueParseError`;
   - a file with no recognisable queue table (no header naming both a CR and a Wave column) parses to
     an empty list without complaint. `queue-file` then posts it, and the queue endpoint is a full
     replace.
3. **A rule misreads deliberate code.**
   - `unreachable-except` flags the transport's `HTTPError`/`URLError` pair. The subclass is caught
     first, so neither clause is unreachable.
   - `python-empty-except` flags the git-provenance read's deliberate `pass`.
   - opengrep's `use-defused-xml-parse` flags the two ElementTree parses, in `_crucible_axi.py` and
     `arduino-crucible.py`. Both read the JUnit report the local runner has just written, and the
     clients are stdlib-only (`dependencies = []`).
   - Ruff's `SIM114` flags a branch pair in `test_cr054_drift_guard.py`.

## Steps

### §S1 — a failure that escapes a verb is reported, never a traceback

`run_verb` converts an `OSError` or a `ValueError` that escapes a verb into the `ok: false` envelope.
It does so after every typed hard stop it already converts, never in their place. The envelope's
`error` names the exception's type and message, and the exit code is non-zero. Each of the five
clients reaches this through its existing `run_verb` call, and its no-argument dashboard goes through
the same conversion. A typed hard stop is reported exactly as before. `KeyboardInterrupt`,
`SystemExit` and an abandoned run's signal path are untouched.

A `pre-merge-gate` that dies this way after its runner started still records its outcome milestone,
as a `fail`. Only a hard stop that refused before the runner started records nothing, as today.

In the installer, `crucible_axi.cli.main` does the same for `install` and `uninstall`, through the
envelope they already emit. `serve` keeps its own contract: it has no envelope, because its stdout
belongs to the server. So it reports an `OSError`, including one from starting the server binary, as
its existing sites do, with an error line and exit 1.

### §S2 — the lexical rules are turned off for the project, with their reasons

A committed `.pi-lens.json` at the repo root disables `unchecked-throwing-call-python` and
`unchecked-numeric-parse-python`. The disable reaches every Python file in the project, so each
entry's `reason` states both halves: in the shipped code, §S1's seam reports the failure the rule
warns of; in test code, a raising call fails its test loudly and needs no envelope.

### §S3 — the type checker's findings are fixed

Each possibly-`None` value is narrowed or checked where it is used. `parse_queue_table` raises
`QueueParseError` naming the missing column when the header has no `title` or `depends` column,
and raises `QueueParseError` when the text holds no queue table, so `queue-file` posts nothing. The two test files build their `HTTPError` and `read` stub in the types the standard library
declares.

### §S4 — a deliberate construct is marked in place

`unreachable-except`, `python-empty-except` and `use-defused-xml-parse` are suppressed at each
flagged site with `# pi-lens-ignore: <rule> — <reason>`, the reason stating why the code is right
as written. `SIM114` in `test_cr054_drift_guard.py` is fixed, not marked.

## Acceptance criteria

- [ ] **An escaping failure is an envelope, in every client.** For EACH of `python-crucible.py`,
      `bun-crucible.py`, `rust-crucible.py`, `mvn-crucible.py` and `arduino-crucible.py`, a verb
      that raises an `OSError` and a verb that raises a `ValueError`, each driven through the
      client's own `main`, exit non-zero. The output is an `ok: false` envelope whose `error` names
      the exception's type and message, with no traceback on stderr. The same holds for the
      no-argument dashboard in each client.
- [ ] **A gate that died after it ran records a fail.** For EACH client's `pre-merge-gate`, an
      `OSError` raised after its runner started yields the `ok: false` envelope and a
      `pre-merge-gate` milestone with outcome `fail`. A hard stop before the runner started still
      records none.
- [ ] **The installer too.** `crucible_axi.cli.main` does the same for an `OSError` raised by
      `install` and by `uninstall`. `serve` reports an `OSError` from starting the server binary with
      an error line and exit 1, with no envelope and no traceback.
- [ ] **Typed stops unchanged.** Each typed hard stop `run_verb` converts today is still reported
      with its own envelope and exit code.
- [ ] **A table missing a column is a parse error.** `parse_queue_table` raises `QueueParseError`
      naming the missing column for a header without `title` and for one without `depends`, never
      `TypeError`.
- [ ] **No queue table is a parse error.** `parse_queue_table` raises `QueueParseError` for text with
      no queue table. `queue-file` given such a file answers `ok: false` and posts nothing.
- [ ] **The rules are off with reasons.** `.pi-lens.json` disables exactly
      `unchecked-throwing-call-python` and `unchecked-numeric-parse-python`, each with a `reason`
      covering both shipped and test code.
- [ ] **Type-clean.** pi-lens's own bundled Pyright CLI (`~/.pi-lens/tools/node_modules/.bin/pyright`),
      run directly over `clients/`, `crucible_axi/` and the three named test files, reports zero
      errors. It is run directly because pi-lens's language-server probe cannot sync a file over
      5,000 lines, and `_crucible_axi.py` is over that.
- [ ] **Lint-clean.** A pi-lens sweep (`lens_diagnostics`, `source: session`, `mode: full`,
      `refreshRunners: all`) over the same files reports zero blocking findings and no `unchecked-*`
      warnings. Each `pi-lens-ignore` carries a reason. A file an analyser did not answer for is
      re-swept after it is touched, never counted as clean.
- [ ] **No pinned behaviour moves.** Both full suites pass, and the typecheck is clean.
- [ ] **No new CR literals.** No CR-shaped literal is added under `clients/`, `crucible_axi/` or in
      test comments, and the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch. Cycle 1: RED for §S1's five clients, their dashboards, the gate's outcome and the
installer, plus the two queue-table parses, then GREEN for §S1 and §S3's behaviour change. Cycle 2: §S2, the rest of §S3 and §S4. It has
no failing-test RED, because it changes no behaviour. The sweep is its check, and it is labelled as
such. Then VERIFY.
