"""CR-CRU-098 C3 — the frozen `next` oracle, read by the python tests that stand
in for the `GET …/next` route.

AC10 deleted the client-side resolver, so "the same answer as today" is read
from ONE frozen record — tests/fixtures/cr098-next-oracle.json — which
tests/fixtures/cr098-next-oracle.gen.py generates by running the PRE-DELETION
client out of git. Every consumer reaches the record through `RESOLVER`, the
one seam the generator swaps for the old `resolve_next` while it records the
boards those consumers ask about. A board the record never saw is a loud
failure naming the generator, never a silently invented answer.

Not a test module (no `test_` prefix): discovery never collects it.
"""

import json
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

REPO_ROOT = Path(__file__).resolve().parents[2]
ORACLE_PATH = REPO_ROOT / "tests" / "fixtures" / "cr098-next-oracle.json"
REGENERATE = "python3 tests/fixtures/cr098-next-oracle.gen.py"

# The sentence the route's multi-track refusal carries (`fail()`'s first
# argument in src/v2.ts `handleNextGet`) — the key the client must NOT relay.
REFUSAL_ERROR = ("`track` is required — this project declares more than one "
                 "lane, and next never picks one")

SCOPE_PARAMS = ("track", "release", "wave")


def _canonical(value):
    """One spelling per board, so a lookup keys on CONTENT, never on dict or
    tuple identity."""
    return json.dumps(value, sort_keys=True)


def resolver_key(entries, tracks, scope):
    return _canonical({"entries": list(entries), "tracks": list(tracks),
                       "scope": dict(scope)})


def frozen_resolver(entries, tracks, scope):
    """The frozen `resolve_next` answer for this exact board and scope —
    `(ok, code, fields, warnings)`, the shape the deleted function returned."""
    oracle = json.loads(ORACLE_PATH.read_text(encoding="utf-8"))
    wanted = resolver_key(json.loads(json.dumps(list(entries))), tracks, scope)
    for case in oracle["resolver"]:
        if resolver_key(case["entries"], case["tracks"], case["scope"]) == wanted:
            result = case["result"]
            return (result["ok"], result["code"], result["fields"],
                    result["warnings"])
    raise AssertionError(
        f"no frozen resolver answer for this board in {ORACLE_PATH.name} — "
        f"regenerate it: {REGENERATE} (board: {wanted})")


# The seam. Consumers call `cr098_next_oracle.RESOLVER(...)` through the module
# attribute, so the generator's swap reaches every one of them.
RESOLVER = frozen_resolver


def scope_of(path):
    """The scope a `GET …/next` request asked for, exactly as the route reads
    it: each parameter PRESENT (even empty) is passed verbatim, an absent one is
    not in scope at all."""
    query = dict(parse_qsl(urlsplit(path).query, keep_blank_values=True))
    return {name: query[name] for name in SCOPE_PARAMS if name in query}


def route_answer(entries, tracks, scope):
    """`(status, body)` — what `GET …/next` publishes for this board: the whole
    answer with `ok` and `warnings[]` on 200, or the multi-track refusal
    through `fail()` (with its `error`) on 400."""
    ok, _code, fields, warnings = RESOLVER(entries, tracks, scope)
    if ok:
        return 200, {"ok": True, **fields, "warnings": warnings}
    return 400, {"ok": False, "error": REFUSAL_ERROR, **fields}
