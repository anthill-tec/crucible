"""The coverage-percent oracle's generator.

WHY THIS EXISTS. A coverage axis's `percent` is the double
`covered / total * 100` rounded to one decimal the way the clients round it
today: Python's `round(x, 1)` — the double's EXACT decimal value, ties to
even — and 0 when `total` is 0. A naive JavaScript rounding differs (1/80 is
1.2 in Python, 1.3 by `Math.round(x * 10) / 10` or `x.toFixed(1)`), so the
board's rounding is held against Python's own answer, computed here by Python
itself, over EVERY (covered, total) pair with 0 <= covered <= total < 1500.

WHAT IT WRITES. `tests/fixtures/coverage-percent-oracle.json`:
  * `totalBelow` / `pairs` — the table's extent and its pair count;
  * `order` — rows by `total` ascending (0 .. totalBelow-1), and within a row
    `covered` ascending (0 .. total);
  * `encoding` — each pair's percent as an integer count of TENTHS; within a
    row each value is stored as its delta from the previous one (the first
    from 0), as an unsigned LEB128 varint; the byte stream is gzipped
    (mtime 0, so a regeneration is byte-identical) and base64-encoded in
    `data`;
  * `sha256` — the hex digest of the UNCOMPRESSED varint stream, so a reader
    proves it decoded the very bytes this script wrote.

CONSUMER: tests/coverage-percent-rounds-as-the-clients-round.test.ts.

REGENERATE: `python3 tests/fixtures/coverage-percent-oracle.gen.py` from the
repo root (or anywhere: the output path is resolved beside this script).
"""

import base64
import gzip
import hashlib
import json
import os

TOTAL_BELOW = 1500


def client_percent(covered, total):
    """The clients' rounding, verbatim (`_parse_lcov`, `_collect_jacoco`)."""
    return round(covered / total * 100, 1) if total else 0


def varint(value, out):
    while True:
        low = value & 0x7F
        value >>= 7
        if value:
            out.append(low | 0x80)
        else:
            out.append(low)
            return


def main():
    stream = bytearray()
    pairs = 0
    for total in range(TOTAL_BELOW):
        previous = 0
        for covered in range(total + 1):
            percent = client_percent(covered, total)
            tenths = round(percent * 10)
            # The percent IS a whole number of tenths (as a double); the
            # integer encoding loses nothing.
            assert abs(tenths / 10 - percent) < 1e-9, (covered, total, percent)
            delta = tenths - previous
            assert delta >= 0, (covered, total)  # monotone within a row
            varint(delta, stream)
            previous = tenths
            pairs += 1

    oracle = {
        "description": (
            "Python's round(covered / total * 100, 1) (0 when total is 0) for every "
            "0 <= covered <= total < totalBelow — the clients' coverage-percent rounding"
        ),
        "generator": "tests/fixtures/coverage-percent-oracle.gen.py",
        "totalBelow": TOTAL_BELOW,
        "pairs": pairs,
        "order": "total ascending from 0; within a total, covered ascending from 0",
        "encoding": (
            "tenths of a percent; per-total-row deltas from 0; unsigned LEB128 varints; "
            "gzip; base64"
        ),
        "sha256": hashlib.sha256(bytes(stream)).hexdigest(),
        "data": base64.b64encode(gzip.compress(bytes(stream), 9, mtime=0)).decode("ascii"),
    }
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "coverage-percent-oracle.json")
    with open(path, "w") as f:
        json.dump(oracle, f, indent=2)
        f.write("\n")
    print(f"wrote {path}: {pairs} pairs, {len(stream)} varint bytes")


if __name__ == "__main__":
    main()
