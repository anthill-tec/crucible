"""CR-CRU-046 C2 (second pass) -- `clients/toon.py`'s own conformance to the
FULL official TOON spec, loaded BY PATH (mirrors `tests/client/test_toon.py`'s
`_load_toon_module()` convention -- see its module docstring and the loader
at line ~36) rather than importing the PyPI stub.

REVISED after the §S2 stub finding (docs/changes/CR-CRU-046-toon-conformance.md
§S2/§S3/§S3b/§S4, user decision 2026-08-01, Option A): PyPI `toon-format`
0.1.0 -- the only release ever published -- is a name-reservation stub whose
`encode`/`decode` both `raise NotImplementedError` (confirmed by unpacking the
wheel, independently twice). There is nothing to import or adopt. Instead
`clients/toon.py` itself is REWRITTEN into a full official-spec-conformant
codec, permanently cross-validated against the first-party TS reference
(`@toon-format/toon`) by the §S4 oracle in the BUN suite (a real client is
spawned and its stdout is decoded with the official library, and vice versa).
This Python suite carries the codec's OWN spec-conformance + self-round-trip
cases only -- it does NOT, and must NOT, import any third-party
`toon`/`toon-format` package (that would defeat the point: the point is that
OUR codec, not a vendored one, speaks the full grammar).

RED phase, against TODAY's `clients/toon.py` (still the narrow 4-construct
Crucible SUBSET ported from `src/toon.ts`, pinned to
`docs/research/DN-crucible-toon-subset.md`, NOT the official grammar):

1. Self round-trip through the REAL emit seam (`_crucible_axi.emit_axi` ->
   `_toon().encode` -> `_toon().decode`) using a representative AXI envelope.
   Genuinely fails today: `context["wave"]` is the numeral-looking STRING
   "4" (the real shape a `WORKFLOW_WAVE` env value takes), and the subset's
   scalar-line decoder treats any bare token matching a JSON number literal
   as numeric -- "4" comes back as the INT 4, not the string "4".

2. Type preservation (§S2's "silent corruption"): encode -> decode of
   STRINGS that look like other TOON scalar types must survive as exact
   strings. Fails today: the subset emits `"42"`/`"true"`/`"null"` bare
   (unquoted) and its decoder re-types them as int/bool/None; it also
   mishandles a blank string (decodes as a nested empty object, not `""`,
   because an empty scalar tail is indistinguishable from a `key:` nested-
   object header) and loses meaningful leading/trailing whitespace (a blind
   `.strip()` on every decoded line).

3. MUST-quote encode shape: the encoded TEXT itself must contain the
   JSON-quoted form of `"42"`, `" padded "` and `"-leading"` -- values the
   official grammar requires quoting to stay unambiguous (digits-only,
   meaningful whitespace, and leading `-` respectively). Fails today: the
   subset encoder's scalar-quoting trigger set (`\n : , { } [ ]`) does not
   include any of those, so none of these three are quoted in the raw
   output.

4. Official-dialect decode: two small hand-written sample documents in the
   OFFICIAL spec's wire form (list arrays as `- `-prefixed lines, quoted
   scalars, and a uniform tabular block) are decoded and compared to the
   expected Python structure. Fails today: the subset's list-array reader
   does not strip the `- ` marker, so every list item decodes with the
   literal `- ` (and, for quoted items, the surrounding quotes) still
   embedded in the string.

Encoder wire-LAYOUT beyond the quoting assertions in (3) is deliberately NOT
pinned here -- cross-stack conformance is proven by the §S4 bun-side oracle
(a real TS decoder reading our output, and vice versa), not by asserting one
specific official list/table rendering choice in this file.

Invocation:
    python3 -m pytest tests/client/test_cr046_official_toon_roundtrip.py -q
Fallback:
    python3 tests/client/test_cr046_official_toon_roundtrip.py
"""

import contextlib
import importlib.util
import io
import json
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
AXI_MODULE_PATH = REPO_ROOT / "clients" / "_crucible_axi.py"
TOON_PATH = REPO_ROOT / "clients" / "toon.py"


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


def _load_toon_module():
    """Load clients/toon.py by file path -- the SAME by-path convention as
    `tests/client/test_toon.py`'s `_load_toon_module()` (line ~36), so this
    suite never depends on a package-importable `toon`/`toon_format` name."""
    spec = importlib.util.spec_from_file_location("toon_under_test_cr046", TOON_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ClientEmitSelfRoundTripThroughRealSeamTest(unittest.TestCase):
    """Item 1 -- drive the REAL `_crucible_axi.emit_axi` encode seam with a
    representative AXI envelope (verb/ok/help[]/context/warnings), capture
    stdout, decode it back with `clients/toon.py`'s OWN decode (via the same
    `_toon()` accessor `_crucible_axi` itself uses), and deep-equal the
    result against `{"axi": ...}` -- INCLUDING exact types, not just values."""

    def _representative_envelope(self):
        result_fields = {
            "help": ["cycle-activate <id>", "status", "test --agent <id>"],
        }
        context = {
            "projectKey": "proj-k",
            "agentId": "CR-CRU-046-C2-py-RED",
            "cycleId": 142,
            "wave": "4",
        }
        warnings = [{"code": "no-wave", "detail": "plan filed with no wave"}]
        return result_fields, context, warnings

    def test_emit_axi_stdout_self_round_trips_to_the_source_envelope(self):
        axi_mod = _load_axi_module()
        result_fields, context, warnings = self._representative_envelope()

        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            axi_mod.emit_axi("status", True, result_fields, context, warnings)

        expected_axi = {"verb": "status", "ok": True, **result_fields,
                         "context": context, "warnings": warnings}
        decoded = axi_mod._toon().decode(stdout.getvalue())

        self.assertEqual(
            decoded, {"axi": expected_axi},
            f"toon.py's own decode() of the client's emit_axi stdout must "
            f"deep-equal the source envelope {expected_axi!r}; got "
            f"{decoded!r} from stdout={stdout.getvalue()!r}")

    def test_emit_axi_context_wave_survives_as_the_exact_string_not_an_int(self):
        """Bound/type check, both directions: the envelope's genuinely
        NON-string fields (`ok`: bool, `context.cycleId`: int, exactly 1
        warning) must keep their own exact types/shape -- proving this is a
        targeted STRING-typing bug, not a blanket decode failure -- before
        asserting the actual RED: `context["wave"]` is the numeral-looking
        STRING "4" (the real WORKFLOW_WAVE env shape), which must not be
        silently retyped as the int 4."""
        axi_mod = _load_axi_module()
        result_fields, context, warnings = self._representative_envelope()

        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            axi_mod.emit_axi("status", True, result_fields, context, warnings)

        decoded = axi_mod._toon().decode(stdout.getvalue())
        axi = decoded.get("axi", {})

        self.assertIsInstance(
            axi.get("ok"), bool,
            f"axi.ok must decode back as a bool, got "
            f"{type(axi.get('ok')).__name__} ({axi.get('ok')!r})")
        self.assertEqual(axi.get("ok"), True)
        self.assertIsInstance(
            axi.get("context", {}).get("cycleId"), int,
            f"context.cycleId must decode back as an int, got "
            f"{type(axi.get('context', {}).get('cycleId')).__name__}")
        self.assertEqual(axi.get("context", {}).get("cycleId"), 142)
        self.assertEqual(
            len(axi.get("warnings", [])), 1,
            f"expected exactly 1 warning entry, got {axi.get('warnings')!r}")

        wave = axi.get("context", {}).get("wave")
        self.assertIsInstance(
            wave, str,
            f"context.wave (source value {context['wave']!r}) must decode "
            f"back as a STRING, not {type(wave).__name__} ({wave!r})")
        self.assertEqual(
            wave, "4",
            f"context.wave must round-trip to the exact string '4'; got {wave!r}")


class ClientEncodeDecodeTypePreservationTest(unittest.TestCase):
    """Item 2 -- STRINGS that look like other TOON scalar types must survive
    encode -> decode as exact strings, per the CR's AC bullet: `"42"`,
    `"true"`, `"null"`, `""`, `" padded "`, `"-leading"` all round-trip as
    STRINGS ("`"42"` must not become a number."). Fails today: the subset's
    scalar-quoting trigger set omits digits-only/whitespace/leading-dash
    content, so these are emitted bare and re-typed on decode."""

    TRICKY_STRINGS = {
        "numeric": "42",
        "boolean": "true",
        "nullish": "null",
        "blank": "",
        "padded": " padded ",
        "dashed": "-leading",
    }

    def test_tricky_string_values_survive_encode_decode_as_exact_strings(self):
        toon = _load_toon_module()
        encoded = toon.encode(dict(self.TRICKY_STRINGS))
        decoded = toon.decode(encoded)

        for key, original in self.TRICKY_STRINGS.items():
            with self.subTest(field=key, original=original):
                self.assertIn(
                    key, decoded,
                    f"decoded object missing field {key!r}; got {decoded!r} "
                    f"from encoded={encoded!r}")
                actual = decoded[key]
                self.assertIsInstance(
                    actual, str,
                    f"{key!r} (source value {original!r}) must decode back "
                    f"as a STRING, not {type(actual).__name__} ({actual!r})")
                self.assertEqual(
                    actual, original,
                    f"{key!r} must round-trip to the EXACT original string "
                    f"{original!r}; got {actual!r}")

    def test_numeric_looking_string_specifically_must_not_become_a_number(self):
        """AC-named case, pinned on its own: `"42"` must not become the
        number 42."""
        toon = _load_toon_module()
        decoded = toon.decode(toon.encode({"n": "42"}))

        self.assertNotIsInstance(
            decoded["n"], (int, float),
            f'"42" must not decode as a number; got {decoded["n"]!r} '
            f"({type(decoded['n']).__name__})")
        self.assertEqual(decoded["n"], "42")


class MustQuoteEncodeShapeTest(unittest.TestCase):
    """Item 3 -- the encoded TEXT itself must carry the JSON-quoted form of
    values the official grammar requires quoting to stay unambiguous: a
    digits-only string, a string with meaningful surrounding whitespace, and
    a string starting with `-` (ambiguous with the list-item marker / a
    negative number). Fails today: none of these trigger the subset
    encoder's quoting rule."""

    def test_encoded_text_quotes_numeric_padded_and_leading_dash_strings(self):
        toon = _load_toon_module()
        encoded = toon.encode({
            "numeric": "42",
            "padded": " padded ",
            "dashed": "-leading",
        })

        self.assertIn(
            json.dumps("42"), encoded,
            f'expected the JSON-quoted form {json.dumps("42")!r} of "42" in '
            f"the encoded output; got {encoded!r}")
        self.assertIn(
            json.dumps(" padded "), encoded,
            f'expected the JSON-quoted form {json.dumps(" padded ")!r} of '
            f'" padded " in the encoded output; got {encoded!r}')
        self.assertIn(
            json.dumps("-leading"), encoded,
            f'expected the JSON-quoted form {json.dumps("-leading")!r} of '
            f'"-leading" in the encoded output; got {encoded!r}')

        # Negative/bound: the BARE (unquoted) numeric line must not appear --
        # guards against a false pass where the quoted substring happens to
        # appear elsewhere by coincidence while the actual value line stays bare.
        self.assertNotIn(
            "numeric: 42\n", encoded + "\n",
            f'expected "42" to be quoted, found it emitted bare in {encoded!r}')


class OfficialDialectDecodeTest(unittest.TestCase):
    """Item 4 -- two hand-written sample documents in the OFFICIAL TOON wire
    form (list arrays as `- `-prefixed lines, quoted scalars, a uniform
    tabular block) must decode to the expected Python structure. Fails
    today: the subset's list-array reader does not strip the `- ` marker,
    so list items decode with it (and any quoting) still embedded."""

    def test_decodes_dash_prefixed_list_with_quoted_scalar_and_tabular_block(self):
        toon = _load_toon_module()
        raw = (
            'title: "42"\n'
            "tags[3]:\n"
            '  - "-leading"\n'
            "  - plain\n"
            '  - "true"\n'
            "rows[2]{id,name}:\n"
            "  1,Ada\n"
            '  2,"Bo,b"\n'
        )
        expected = {
            "title": "42",
            "tags": ["-leading", "plain", "true"],
            "rows": [{"id": 1, "name": "Ada"}, {"id": 2, "name": "Bo,b"}],
        }

        decoded = toon.decode(raw)

        self.assertEqual(
            decoded, expected,
            f"expected the official-dialect sample to decode to {expected!r}; "
            f"got {decoded!r} from raw={raw!r}")
        self.assertEqual(
            len(decoded.get("tags", [])), 3,
            f"expected exactly 3 tags[] entries, got {decoded.get('tags')!r}")

    def test_decodes_dash_prefixed_list_nested_under_an_object_with_quoted_scalar(self):
        toon = _load_toon_module()
        raw = (
            "meta:\n"
            '  code: "-leading"\n'
            "notes[2]:\n"
            "  - alpha\n"
            "  - beta\n"
        )
        expected = {
            "meta": {"code": "-leading"},
            "notes": ["alpha", "beta"],
        }

        decoded = toon.decode(raw)

        self.assertEqual(
            decoded, expected,
            f"expected the official-dialect sample to decode to {expected!r}; "
            f"got {decoded!r} from raw={raw!r}")
        self.assertEqual(decoded.get("meta", {}).get("code"), "-leading")


if __name__ == "__main__":
    unittest.main()
