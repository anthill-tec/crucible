"""CR-CRU-046 C2 -- official `toon-format` (PyPI) client-side round-trip
conformance, pinning the CLIENT half (§S2 + §S4) of the flip from the
hand-written `clients/toon.py` subset codec to the official library, at both
seams `clients/_crucible_axi.py` drives:
  - the `_emit` ENCODE seam (`_toon().encode({"axi": ...})`,
    `clients/_crucible_axi.py:~84`) -- client -> agent direction.
  - the snapshot DECODE path (each client's two `_toon().decode(snap)`
    sites, e.g. `gate_from_axi`) -- server -> client direction.

RED phase, TWO independent layers, both deliberately left unguarded:

1. `import toon_format` at module top is a BARE import -- NOT wrapped in
   try/except, NOT skip-guarded. `toon-format` is declared as a runtime
   dependency in `pyproject.toml` (`dependencies = ["toon-format>=0.1,<0.2"]`)
   but is NOT installed in the ambient `.venv` test interpreter today
   (confirmed: `.venv/bin/python -c "import toon_format"` raises
   `ModuleNotFoundError: No module named 'toon_format'`). That collection-time
   failure IS the expected RED for this suite right now -- a missing,
   not-yet-resolvable dependency, same convention as a missing SUT symbol
   (see `tests/client/test_toon.py`'s module docstring). GREEN's §S3 harness
   work (making the pinned dependency resolvable to the interpreter these
   tests run under) is what turns this import into a real collection.

2. ESCALATION -- CRITICAL FINDING (verified 2026-08-01 against the live PyPI
   index): `pip index versions toon-format` reports **0.1.0 is the only
   version ever published**, and downloading + inspecting that wheel
   (`toon_format-0.1.0-py3-none-any.whl`) shows BOTH public entry points are
   literal stubs:

       # toon_format/encoder.py:34
       def encode(value, options=None):
           raise NotImplementedError("TOON encoder is not yet implemented")

       # toon_format/decoder.py:29
       def decode(input, options=None):
           raise NotImplementedError("TOON decoder is not yet implemented")

   Every test below that reaches a real `toon_format.encode`/`.decode` call
   will therefore raise `NotImplementedError`, not merely fail an assertion,
   for as long as the installed release is 0.1.0 -- independent of, and in
   addition to, the ModuleNotFoundError RED in (1). The §S4 round-trip AC as
   written cannot be satisfied against today's only published release; it
   needs either a future patch inside the pinned `>=0.1,<0.2` window that
   actually implements encode/decode, or the CR's version pin revisited.
   Flagging for the orchestrator/GREEN agent rather than working around it
   (no skip, no mock of the third-party library -- that would defeat the
   point of this conformance gate).

These tests assert DEEP-EQUALITY on decoded Python structures, never exact
encoded TEXT, precisely so they stay valid regardless of which concrete
layout (inline-compact vs multi-line dash-prefixed list-array) the official
implementation eventually picks -- the contract §S4 pins is round-trip
fidelity between two independent implementations, not byte-for-byte layout.

Invocation:
    python3 -m pytest tests/client/test_cr046_official_toon_roundtrip.py -q
Fallback:
    python3 tests/client/test_cr046_official_toon_roundtrip.py
"""

import contextlib
import importlib.util
import io
import unittest
from pathlib import Path

import toon_format

REPO_ROOT = Path(__file__).resolve().parents[2]
AXI_MODULE_PATH = REPO_ROOT / "clients" / "_crucible_axi.py"


def _load_axi_module():
    """Load clients/_crucible_axi.py by file path -- mirrors the loader in
    tests/client/test_crucible_axi_shared.py's `_load_axi_module` (the module
    is not importable under a normal package name from the hyphenated
    client scripts' invocation context)."""
    spec = importlib.util.spec_from_file_location(
        "crucible_axi_under_test_cr046", AXI_MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ClientEmitOfficialToonConformanceTest(unittest.TestCase):
    """§S4 client -> agent direction: the `emit_axi` encode seam
    (clients/_crucible_axi.py:~84, `_toon().encode({"axi": ...})`) must
    produce text that an OFFICIAL TOON decoder reads back as an object
    deep-equal to the source envelope -- proving the client's encoder and
    the official library's decoder (two independent implementations) agree.
    Fails today: the hand-written subset encoder's list-array form omits the
    spec's `- `-prefixed elements (see CR context, `help[]`), so a
    standard-conformant decoder either mis-reads or rejects it."""

    def _representative_envelope_result_fields(self):
        return {
            "help": ["cycle-activate <id>", "status", "test --agent <id>"],
        }

    def _representative_context(self):
        return {
            "projectKey": "proj-k",
            "agentId": "CR-CRU-046-C2-py-RED",
            "cycleId": 142,
            "wave": "4",
        }

    def _representative_warnings(self):
        return [{"code": "no-wave", "detail": "plan filed with no wave"}]

    def test_emit_axi_stdout_decodes_via_official_toon_format_to_the_source_envelope(self):
        axi_mod = _load_axi_module()
        result_fields = self._representative_envelope_result_fields()
        context = self._representative_context()
        warnings = self._representative_warnings()

        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            axi_mod.emit_axi("status", True, result_fields, context, warnings)

        expected_axi = {"verb": "status", "ok": True, **result_fields,
                         "context": context, "warnings": warnings}
        decoded = toon_format.decode(stdout.getvalue())

        self.assertEqual(
            decoded, {"axi": expected_axi},
            f"official toon_format.decode() of the client's emit_axi stdout "
            f"must deep-equal the source envelope {expected_axi!r}; got "
            f"{decoded!r} from stdout={stdout.getvalue()!r}")

    def test_emit_axi_help_list_round_trips_as_the_exact_ordered_list_of_strings(self):
        """Bound check on the hottest-path construct named by the CR: `help[]`
        must survive as the SAME list, same order, same element count -- not
        merged into one string, not truncated, not reordered."""
        axi_mod = _load_axi_module()
        result_fields = self._representative_envelope_result_fields()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            axi_mod.emit_axi("status", True, result_fields,
                              self._representative_context(), [])

        decoded = toon_format.decode(stdout.getvalue())
        help_list = decoded.get("axi", {}).get("help")

        self.assertEqual(
            help_list, result_fields["help"],
            f"help[] must round-trip as the exact 3-element ordered list "
            f"{result_fields['help']!r}; got {help_list!r}")
        self.assertEqual(len(help_list), 3,
                          f"expected exactly 3 help[] entries, got {help_list!r}")


class ClientEmitTypePreservationTest(unittest.TestCase):
    """§S4 + AC bullet: STRING values that look like other TOON scalar types
    must decode back as the exact same STRING, not a coerced bool/int/None,
    after passing through the client's emit seam then the official decoder.
    Fails today: the subset encoder emits these values unquoted, and a
    standard decoder reads their literal-looking form as the typed value."""

    TRICKY_STRINGS = {
        "numeric": "42",
        "boolean": "true",
        "nullish": "null",
        "blank": "",
        "padded": " padded ",
        "dashed": "-leading",
    }

    def test_string_values_resembling_other_scalar_types_survive_as_exact_strings(self):
        axi_mod = _load_axi_module()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            axi_mod.emit_axi(
                "check", True, {"tricky": dict(self.TRICKY_STRINGS)},
                {"projectKey": "proj-k"}, [])

        decoded = toon_format.decode(stdout.getvalue())
        tricky = decoded.get("axi", {}).get("tricky", {})

        for key, original in self.TRICKY_STRINGS.items():
            with self.subTest(field=key, original=original):
                self.assertIn(key, tricky,
                              f"decoded envelope missing tricky field {key!r}; "
                              f"got tricky={tricky!r}")
                actual = tricky[key]
                self.assertIsInstance(
                    actual, str,
                    f"{key!r} (source value {original!r}) must decode back "
                    f"as a STRING, not {type(actual).__name__} ({actual!r}) "
                    f"-- e.g. \"42\" must NOT become the number 42")
                self.assertEqual(
                    actual, original,
                    f"{key!r} must round-trip to the EXACT original string "
                    f"{original!r}; got {actual!r}")


class ClientDecodeOfficialToonDialectTest(unittest.TestCase):
    """§S4 server -> client direction: a server SNAPSHOT encoded with the
    OFFICIAL `toon_format.encode` must decode, through the SAME seam the
    clients use for gate/status snapshots (`_toon().decode`, bound via
    `_crucible_axi`'s own private `_toon()` loader so this assertion survives
    the swap from `clients/toon.py` to `toon_format`), to an object deep-equal
    to the source snapshot. Fails today: the hand-written subset decoder
    mis-reads the official library's list-array and quoting forms."""

    def test_official_encoded_server_snapshot_decodes_via_the_clients_decode_seam(self):
        axi_mod = _load_axi_module()
        snapshot = {
            "run": {
                "steps": [
                    {"step": "build", "status": "passed"},
                    {"step": "test", "status": "failed"},
                ],
                "outcome": "checks-passed",
                "head": "abc123",
            },
            "notes": ["42", "true", "-leading"],
        }

        encoded = toon_format.encode(snapshot)
        decoded = axi_mod._toon().decode(encoded)

        self.assertEqual(
            decoded, snapshot,
            f"the client's current decode seam (_crucible_axi._toon().decode) "
            f"must deep-equal the source snapshot {snapshot!r} when fed text "
            f"produced by the OFFICIAL toon_format.encode(); got {decoded!r} "
            f"from encoded={encoded!r}")

    def test_official_encoded_notes_list_survives_as_exact_ordered_strings(self):
        """Bound check mirroring the type-preservation AC on the DECODE
        direction: the tricky-looking strings inside a list array must not be
        coerced by the client's decoder when the text came from the official
        encoder's own (possibly differently-formatted) list-array form."""
        axi_mod = _load_axi_module()
        snapshot = {"notes": ["42", "true", "-leading"]}

        encoded = toon_format.encode(snapshot)
        decoded = axi_mod._toon().decode(encoded)
        notes = decoded.get("notes")

        self.assertEqual(
            notes, ["42", "true", "-leading"],
            f"notes[] must decode to the exact 3-element ordered string list; "
            f"got {notes!r} from encoded={encoded!r}")
        for value in notes or []:
            self.assertIsInstance(
                value, str,
                f"every element of notes[] must remain a STRING after "
                f"decode; got {type(value).__name__} ({value!r}) in {notes!r}")


if __name__ == "__main__":
    unittest.main()
