"""The `crucible-clients.json` CONSUMER CONTRACT, declared ONCE.

Three suites pin the manifest's top-level key set -- CR-CRU-090's
`test_cr090_fleet_stage.py` and two assertions in `test_crucible_axi_install.py`
-- and until CR-CRU-131 §S1c each carried its own copy of the literal. Three
copies of one key set is the same drift farm §S1c exists to close, one layer
out: a schema change then has to land on three sites by hand and can silently
land on two.

The pin stays CLOSED rather than becoming a subset check. It is not a proxy
for anything -- it IS the contract other tools parse, so it catches internal
state leaking into a published document, which is a plausible defect rather
than a hypothetical one. A schema change that deliberately adds a key edits
this file in the same commit, and the pin has then done exactly its job.

The contract has TWO halves, and CR-CRU-143 exists because only one of them
was declared here. `EXPECTED_MANIFEST_KEYS` is the UNCONDITIONAL half -- the
floor, every key every install publishes. `CONDITIONAL_MANIFEST_KEYS` is the
half published only when its own condition holds. Asserting exact equality
against the floor alone made a key that is conditional BY CONTRACT read as an
intruder: green on a CI runner with nothing provisioned, red on any workstation
that had run `crucible-axi install`. So an assertion site asks two questions
instead of one -- is the floor present, and is anything outside
`ALLOWED_MANIFEST_KEYS` present -- and both halves are declared HERE, so a
future conditional key is added once rather than at every assertion site.

Not named `test_*`, so unittest discovery never collects it as a suite.
"""

#: The manifest's UNCONDITIONAL top-level keys, exactly -- the floor every
#: install publishes, whatever the machine. The keys published only under a
#: condition are `CONDITIONAL_MANIFEST_KEYS`, below.
#:
#: `version`/`clients`/`status` are CR-CRU-009's original schema; `config`
#: joined in CR-CRU-131 §S1c, which made the installer lay an operator-editable
#: `crucible.toml` down at `<target-dir>` -- a file the installer WRITES belongs
#: in the manifest like everything else it lays down, or automation cannot
#: discover the file it is meant to edit. Purely ADDITIVE: every pre-existing
#: field keeps its exact shape and value.
#:
#: `shipped_config` joined in CR-CRU-138 §S4: the distribution's OWN limit
#: declarations, laid down with the fleet at `<install>/clients/crucible.toml`
#: as package data. It is a different KIND of thing from `config` -- the build's
#: file, replaced wholesale on every upgrade, against the operator's, which
#: survives one -- and automation that cannot tell them apart eventually edits
#: the wrong one. Declared UNCONDITIONALLY, like `status`: the fleet stage lays
#: it down on every install.
#:
#: `server_config` (CR-CRU-138 §S2) is deliberately NOT here. It is CONDITIONAL
#: -- published only when the server was really provisioned locally, because
#: the file is written beside the server's own database and there is none to
#: write beside otherwise. Listing it unconditionally would require publishing
#: a path that does not exist, which is the dangling-path defect CR-CRU-090
#: closed. It is declared just below in `CONDITIONAL_MANIFEST_KEYS` and
#: asserted against that condition -- owed in the provisioned case, refused
#: with a stated reason in the other.
EXPECTED_MANIFEST_KEYS = frozenset({
    "version", "clients", "status", "config", "shipped_config",
})

#: The manifest's CONDITIONAL top-level keys, with the condition each is
#: published under:
#:
#: * `server_config` (CR-CRU-138 §S2) -- published exactly when the install
#:   PROVISIONED A SERVER LOCALLY, i.e. when `install.server_config_plan()`
#:   found a `src/crucible.toml` inside a provisioned server package and the
#:   `[manifest]` stage therefore laid the server's operator-editable file down
#:   beside the server's own database. When no server is provisioned here
#:   (`--no-service`, `$CRUCIBLE_NO_SERVICE`, or a board on another host) the
#:   key is ABSENT and the stage reports the reason instead -- publishing a
#:   path nothing wrote is the dangling-path defect CR-CRU-090 closed.
#:
#: A conditional key is not an unexpected one (CR-CRU-143): it is asserted
#: against its CONDITION, never merely tolerated. Its presence alone proves
#: nothing, so a suite that can control provisioned-ness asserts both branches.
CONDITIONAL_MANIFEST_KEYS = frozenset({
    "server_config",
})

#: The CLOSED upper bound: every key any install may publish. A key outside
#: this set is an addition nobody declared -- internal state leaking into a
#: document other tools parse -- and every assertion site must still reject it.
ALLOWED_MANIFEST_KEYS = EXPECTED_MANIFEST_KEYS | CONDITIONAL_MANIFEST_KEYS


def missing_manifest_keys(document) -> list[str]:
    """The unconditional keys `document` FAILS to publish, sorted.

    The floor CR-CRU-090 established: an install that drops a key other tools
    parse breaks them, whatever else it got right.
    """
    return sorted(EXPECTED_MANIFEST_KEYS - set(document))


def unexpected_manifest_keys(document) -> list[str]:
    """The keys `document` publishes that NO part of the contract declares,
    sorted -- neither unconditional nor conditional.

    This is the half of the old exact-equality check that was worth keeping:
    the bound stays closed, so a genuinely undeclared addition still fails.
    """
    return sorted(set(document) - ALLOWED_MANIFEST_KEYS)
