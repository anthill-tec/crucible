"""The `crucible-clients.json` CONSUMER CONTRACT, declared ONCE.

Three suites pin the manifest's top-level key set -- CR-CRU-090's
`test_cr090_fleet_stage.py` and two assertions in `test_crucible_axi_install.py`
-- and until CR-CRU-131 §S1c each carried its own copy of the literal. Three
copies of one key set is the same drift farm §S1c exists to close, one layer
out: a schema change then has to land on three sites by hand and can silently
land on two.

The pin stays an EXACT set rather than a superset. It is not a proxy for
anything -- it IS the contract other tools parse, so it catches internal state
leaking into a published document, which is a plausible defect rather than a
hypothetical one. A schema change that deliberately adds a key edits this one
line in the same commit, and the pin has then done exactly its job.

Not named `test_*`, so unittest discovery never collects it as a suite.
"""

#: The manifest's top-level keys, exactly.
#:
#: `version`/`clients`/`status` are CR-CRU-009's original schema; `config`
#: joined in CR-CRU-131 §S1c, which made the installer lay an operator-editable
#: `crucible.toml` down at `<target-dir>` -- a file the installer WRITES belongs
#: in the manifest like everything else it lays down, or automation cannot
#: discover the file it is meant to edit. Purely ADDITIVE: every pre-existing
#: field keeps its exact shape and value.
EXPECTED_MANIFEST_KEYS = frozenset({"version", "clients", "status", "config"})
