"""Shared seams for the declaration-schema tests: the shipped descriptor, the
six clients loaded by file path, a temporary project dir, and a small
interpreter of the descriptor's vocabulary.

The descriptor (`clients/crucible-declaration.schema.json`) is plain JSON:

    version             an integer, 1 or more
    description         says it is a plain descriptor, not a JSON Schema
    writer              the writer rule (see the content tests)
    skip_rule           {readers, decided_on, description}
    reserved_frameworks {<stack or "go">: [framework, ...]}
    stacks              {<stack>: {location, entry, package?, stack_table?}}

An `entry` (null for python and go, which read no `[targets]` entry) carries `key`,
`open`, `other_stacks` ("skipped" | "refused"), `refused` (field names),
`requires` (entry level: `{"one_of": [field, ...]}`), `fields` and `shape`.

A field descriptor carries `default`, `required`, and either nested `fields`
(an object field) or `values` in one of four forms:

    [v, ...]                          a list
    {"pattern": [template, ...]}      `<NAME>` stands for a non-blank name
    {"board-listed": "codecs.<kind>"} an open codec name, checked at run time
    {"path": {"holds": "<file>"}}     a directory holding <file>, at run time

and optionally the cross-field rules `requires` (`{field: true}` for "must be
present", `{field: [v, ...]}` for "must hold one of"), `excludes` ([field,
...]) and `when` (`{value: {"requires": {...}}}`, a rule for one value).

An object field (`stream`) is open the way an entry is (`"open": true`): a
subfield it does not list is kept, so the generated entries carry one.
"""

import importlib.util
import itertools
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from types import SimpleNamespace

from tests.client.live_run_harness import CLIENTS

SCHEMA_PATH = CLIENTS / "crucible-declaration.schema.json"

STACKS = ("bun", "rust", "arduino", "maven", "python", "go")
TARGETS_READERS = ("rust", "arduino", "maven")

ACCEPTED, REFUSED, SKIPPED, UNDECLARED = "accepted", "refused", "skipped", "undeclared"

# A value no stack reserves or accepts, and a field no stack lists.
WRONG_VALUE = "not-a-declared-value"
UNLISTED_FIELD = "x_writer_note"
SAMPLE_CODEC = "sample-codec"
SAMPLE_NAME = "CRUCIBLE_SAMPLE_NAME"

# The key each `[targets]` reader is driven under.
READER_KEYS = {"rust": "ci", "arduino": "tests/native/unit", "maven": "e2e"}

_CLIENT_FILES = {"bun": "bun-crucible.py", "rust": "rust-crucible.py",
                 "arduino": "arduino-crucible.py", "maven": "mvn-crucible.py",
                 "python": "python-crucible.py", "go": "go-crucible.py"}
_LOADED = {}


def load_schema(case) -> dict:
    """The shipped descriptor, parsed; the test fails (never errors) naming the
    path when it is absent, is not JSON, or is not a JSON object."""
    case.assertTrue(SCHEMA_PATH.is_file(),
                    f"the declaration schema is not shipped at {SCHEMA_PATH}")
    try:
        parsed = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    except ValueError as error:
        raise case.failureException(f"{SCHEMA_PATH} is not JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise case.failureException(f"{SCHEMA_PATH} is not a JSON object")
    return parsed


def client(stack):
    """The stack's client module, loaded once by file path."""
    if stack not in _LOADED:
        path = CLIENTS / _CLIENT_FILES[stack]
        spec = importlib.util.spec_from_file_location(
            f"declaration_schema_{stack}_client", path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _LOADED[stack] = module
    return _LOADED[stack]


def declaration_refused(stack):
    return client(stack)._axi().DeclarationRefused


# --------------------------------------------------------------------------- #
# A temporary project dir
# --------------------------------------------------------------------------- #
def new_project(case):
    path = tempfile.mkdtemp(prefix="declaration-schema-")
    case.addCleanup(_remove_tree, path)
    return path


def _remove_tree(path):
    shutil.rmtree(path, ignore_errors=True)


def toml_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, dict):
        inner = ", ".join(f"{toml_key(k)} = {toml_value(v)}" for k, v in value.items())
        return "{ " + inner + " }" if inner else "{}"
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(v) for v in value) + "]"
    raise TypeError(f"no TOML form for {value!r}")


def toml_key(key):
    return key if re.fullmatch(r"[A-Za-z0-9_-]+", key) else json.dumps(key)


def write_targets_toml(project_dir, key, entry):
    """`crucible.toml` holding one `[targets]` entry under `key`."""
    if isinstance(entry, dict):
        body = f"[targets.{toml_key(key)}]\n" + "".join(
            f"{toml_key(k)} = {toml_value(v)}\n" for k, v in entry.items())
    else:
        body = f"[targets]\n{toml_key(key)} = {toml_value(entry)}\n"
    Path(project_dir, "crucible.toml").write_text(body, encoding="utf-8")


def write_toml(project_dir, text):
    Path(project_dir, "crucible.toml").write_text(text, encoding="utf-8")


UNPARSEABLE_TOML = "[targets.ci\nframework = nextest\n"


def write_package(project_dir, manifest):
    Path(project_dir, "package.json").write_text(json.dumps(manifest), encoding="utf-8")


# --------------------------------------------------------------------------- #
# What each client does with an entry
# --------------------------------------------------------------------------- #
def reader_verdict(stack, project_dir, key):
    """What a `[targets]` reader makes of the project's crucible.toml for `key`:
    rust answers ACCEPTED for no refusal (it cannot tell a skipped entry from
    its own), arduino and maven ACCEPTED / SKIPPED-or-UNDECLARED / REFUSED."""
    module = client(stack)
    if stack == "rust":
        refusal = module._targets_refusal(project_dir, key)
        return ACCEPTED if refusal is None else REFUSED
    path = os.path.join(project_dir, "crucible.toml")
    try:
        declared = module._declared_entry(path, key)
    except declaration_refused(stack):
        return REFUSED
    return ACCEPTED if declared is True else UNDECLARED


def entry_verdict(stack, project_dir, entry):
    """The client's verdict on one entry, written to a fresh crucible.toml (or
    read directly, for bun's pure entry check)."""
    if stack == "bun":
        _target, refusal = client("bun")._read_target_entry("crucible.targets.k", entry)
        return ACCEPTED if refusal is None else REFUSED
    key = READER_KEYS[stack]
    write_targets_toml(project_dir, key, entry)
    return reader_verdict(stack, project_dir, key)


def no_python_args(**overrides):
    return SimpleNamespace(**{"runner": None, "python": None, **overrides})


# --------------------------------------------------------------------------- #
# The descriptor's vocabulary, interpreted
# --------------------------------------------------------------------------- #
def _template_regex(template):
    parts = re.split(r"<[A-Za-z_]+>", template)
    return re.compile(r"(?:\s*\S.*?)".join(re.escape(p) for p in parts) + r"\Z", re.S)


def value_ok(desc, value):
    """Whether `value` is one the field descriptor `desc` allows."""
    if "fields" in desc:
        if not isinstance(value, dict):
            return False
        for name, sub in desc["fields"].items():
            if name not in value:
                if sub.get("required"):
                    return False
                continue
            if not value_ok(sub, value[name]):
                return False
        return True
    values = desc["values"]
    if isinstance(values, list):
        return value in values
    if "pattern" in values:
        templates = values["pattern"]
        templates = [templates] if isinstance(templates, str) else templates
        return isinstance(value, str) and any(
            _template_regex(t).match(value) for t in templates)
    if "board-listed" in values:
        return isinstance(value, str) and bool(value.strip())
    raise AssertionError(f"no entry-level check for values {values!r}")


def _holds(entry, fields, name, wanted):
    present = name in entry
    if wanted is True:
        return present
    value = entry[name] if present else fields.get(name, {}).get("default")
    return value in wanted


def other_frameworks(schema, stack):
    return {fw for owner, fws in schema["reserved_frameworks"].items()
            if owner != stack for fw in fws}


def schema_verdict(schema, stack, entry):
    """What the descriptor says `stack`'s client makes of `entry`."""
    desc = schema["stacks"][stack]["entry"]
    if not isinstance(entry, dict):
        return desc["shape"]["entry_not_a_table"]
    if entry.get("framework") in other_frameworks(schema, stack):
        return desc["other_stacks"]
    fields = desc["fields"]
    if any(f in entry for f in desc.get("refused", [])):
        return REFUSED
    for name, fdesc in fields.items():
        if name not in entry:
            if fdesc.get("required"):
                return REFUSED
            continue
        value = entry[name]
        if not value_ok(fdesc, value):
            return REFUSED
        for other, wanted in (fdesc.get("requires") or {}).items():
            if not _holds(entry, fields, other, wanted):
                return REFUSED
        if any(other in entry for other in fdesc.get("excludes") or []):
            return REFUSED
        rule = (fdesc.get("when") or {}).get(value) if isinstance(value, str) else None
        for other, wanted in ((rule or {}).get("requires") or {}).items():
            if not _holds(entry, fields, other, wanted):
                return REFUSED
    one_of = (desc.get("requires") or {}).get("one_of")
    if one_of and not any(f in entry for f in one_of):
        return REFUSED
    return ACCEPTED


def sample_values(desc):
    """Every value a field allows, a sample standing in for a pattern or an
    open codec name."""
    if "fields" in desc:
        return [complete_value(desc)]
    values = desc["values"]
    if isinstance(values, list):
        found = list(values)
    elif "pattern" in values:
        templates = values["pattern"]
        templates = [templates] if isinstance(templates, str) else templates
        found = [re.sub(r"<[A-Za-z_]+>", SAMPLE_NAME, t) for t in templates]
    elif "board-listed" in values:
        found = [SAMPLE_CODEC]
    else:
        raise AssertionError(f"no sample for values {values!r}")
    return found + [v for v in (desc.get("when") or {}) if v not in found]


def wrong_values(desc):
    """Values generated from a field's form to probe its edges: values it
    refuses, and for an object field each subfield left out or wrong (which
    the descriptor may still allow, where a subfield has a default) and the
    complete value with one subfield it does not list (which an open object
    field keeps)."""
    if "fields" in desc:
        base = complete_value(desc)
        probes: list[object] = ["not-a-table", {**base, UNLISTED_FIELD: "kept"}]
        for name, sub in desc["fields"].items():
            probes.append({k: v for k, v in base.items() if k != name})
            probes.extend({**base, name: w} for w in wrong_values(sub))
        return probes
    values = desc["values"]
    if isinstance(values, list):
        return [WRONG_VALUE]
    if "pattern" in values:
        templates = values["pattern"]
        templates = [templates] if isinstance(templates, str) else templates
        return [WRONG_VALUE] + [re.sub(r"<[A-Za-z_]+>", "", t) for t in templates
                                if re.search(r"<[A-Za-z_]+>", t)]
    if "board-listed" in values:
        return ["", 7]
    return [WRONG_VALUE]


def complete_value(desc):
    """An object field with every subfield at its first allowed value."""
    return {name: sample_values(sub)[0] for name, sub in desc["fields"].items()}


def complete_entries(schema, stack, framework=None):
    """`stack`'s complete valid entries, generated from its descriptor: the
    entries it accepts whose fields no other accepted entry extends (bun's
    fullest `junit` entry and its `stream` entry alike), so a skip is tested on
    a full entry, never a bare framework."""
    candidates = [c for c in candidate_entries(schema, stack)
                  if isinstance(c, dict) and not carries_unlisted(c)
                  and schema_verdict(schema, stack, c) == ACCEPTED
                  and (framework is None or c.get("framework", framework) == framework)]
    if framework is not None:
        candidates = [{**c, "framework": framework} for c in candidates]
    shapes = {frozenset(c) for c in candidates}
    out = []
    for c in candidates:
        if not any(frozenset(c) < shape for shape in shapes) and c not in out:
            out.append(c)
    return out


def carries_unlisted(entry):
    """Whether a generated entry carries the unlisted field, at entry level or
    inside an object field."""
    return UNLISTED_FIELD in entry or any(
        isinstance(v, dict) and UNLISTED_FIELD in v for v in entry.values())


def candidate_entries(schema, stack):
    """Entries generated from `stack`'s descriptor: every field absent, at each
    allowed value and at each wrong value, crossed; then added to each, one at
    a time: each field it refuses, each field another stack lists or refuses
    (so a refusal the schema leaves out is caught), and one unlisted field."""
    desc = schema["stacks"][stack]["entry"]
    absent = object()
    options = []
    for name, fdesc in desc["fields"].items():
        opts = [absent] + sample_values(fdesc) + wrong_values(fdesc)
        options.append([(name, o) for o in opts])
    base = []
    for combo in itertools.product(*options):
        base.append({name: value for name, value in combo if value is not absent})
    out = list(base)
    elsewhere = []
    for other, other_stack in schema["stacks"].items():
        other_desc = other_stack.get("entry")
        if other == stack or other_desc is None:
            continue
        for name in [*other_desc["fields"], *other_desc.get("refused", [])]:
            if name not in desc["fields"] and name not in elsewhere:
                elsewhere.append(name)
    refused = list(desc.get("refused", []))
    extras = [(f, "flag") for f in refused + [n for n in elsewhere if n not in refused]]
    extras.append((UNLISTED_FIELD, "kept"))
    for entry in base:
        for field, value in extras:
            out.append({**entry, field: value})
    return out
