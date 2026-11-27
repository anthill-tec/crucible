"""Shared seams for the declaration-schema tests: the shipped descriptor, the
seven clients loaded by file path, a temporary project dir, and a small
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
`requires` (entry level: `{"one_of": [field, ...]}`), `fields` and `shape`,
and optionally `frameworkless` ("skipped": the reader skips an entry with no
`framework`; a stack that omits it keeps the older meaning, that such an
entry is rust's). A `key` may carry `tiers` (the allowed first segment) and
`label: "non-empty"` (the `/<label>` part, when present, is non-empty).

A field descriptor carries `default`, `required`, and either nested `fields`
(an object field) or `values` in one of these forms:

    [v, ...]                          a list
    {"pattern": [template, ...]}      `<NAME>` stands for a non-blank name
    {"board-listed": "codecs.<kind>"} an open codec name, checked at run time
    {"path": {"holds": "<file>"}}     a directory holding <file>, at run time
    {"list": {"min": n, "items": F}}  a list of at least n items, each of form F
    {"path": {"exists": true,         a path relative to the project dir that
              "node_id": "::"}}       exists, optionally followed by ::<node id>
                                      (the part before :: must exist)
    {"path": {"is": "executable"}}    a path relative to the project dir naming
                                      an executable file

A path value is judged against the path fixture (`write_path_fixture`): the
files and directories it lays down are the ones that exist.

and optionally the cross-field rules `requires` (`{field: true}` for "must be
present", `{field: [v, ...]}` for "must hold one of"), `excludes` ([field,
...]) and `when` (`{value: {"requires": {...}}}`, a rule for one value).

An object field (`stream`) is open the way an entry is (`"open": true`): a
subfield it does not list is kept, so the generated entries carry one.
"""

import itertools
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from types import SimpleNamespace

from tests.client import CLIENT_SOURCE_DIR, load_client

SCHEMA_PATH = CLIENT_SOURCE_DIR / "crucible-declaration.schema.json"

STACKS = ("bun", "rust", "arduino", "maven", "python", "go", "eda")
TARGETS_READERS = ("rust", "arduino", "maven", "eda")

ACCEPTED, REFUSED, SKIPPED, UNDECLARED = "accepted", "refused", "skipped", "undeclared"

# A value no stack reserves or accepts, and a field no stack lists.
WRONG_VALUE = "not-a-declared-value"
UNLISTED_FIELD = "x_writer_note"
SAMPLE_CODEC = "sample-codec"
SAMPLE_NAME = "CRUCIBLE_SAMPLE_NAME"
SAMPLE_LABEL = "board"

# The path fixture: what exists in a project dir a path value is judged in.
FIXTURE_DIR = "tests/unit"
FIXTURE_FILE = "tests/unit/test_sample.py"
FIXTURE_NODE = "test_sample"
FIXTURE_EXECUTABLE = "tools/python"
MISSING_PATH = "tests/absent/test_absent.py"
NOT_A_PATH = 7
_FIXTURE_EXISTING = frozenset({"tests", FIXTURE_DIR, FIXTURE_FILE, "tools",
                               FIXTURE_EXECUTABLE})
_FIXTURE_EXECUTABLES = frozenset({FIXTURE_EXECUTABLE})

# The key each `[targets]` reader is driven under.
READER_KEYS = {"rust": "ci", "arduino": "tests/native/unit", "maven": "e2e",
               "eda": "unit"}

_CLIENT_FILES = {"bun": "bun-crucible.py", "rust": "rust-crucible.py",
                 "arduino": "arduino-crucible.py", "maven": "mvn-crucible.py",
                 "python": "python-crucible.py", "go": "go-crucible.py",
                 "eda": "eda-crucible.py"}
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
    """The stack's client module, loaded once from the suite's test install."""
    if stack not in _LOADED:
        _LOADED[stack] = load_client(_CLIENT_FILES[stack],
                                     f"declaration_schema_{stack}_client")
    return _LOADED[stack]


def declaration_refused(stack):
    return client(stack)._axi().DeclarationRefused


# --------------------------------------------------------------------------- #
# A temporary project dir
# --------------------------------------------------------------------------- #
def new_project(case):
    """A temporary project dir, removed after the test. The shared cores'
    bindings are restored to what they were before it, for every core: a
    client function that resolves its project binds the core it shares
    with every other test."""
    path = tempfile.mkdtemp(prefix="declaration-schema-")
    case.addCleanup(_remove_tree, path)
    case.addCleanup(_restore_bindings, _bindings())
    return path


def _bindings():
    """Each loaded client's shared-core binding, by stack."""
    return {stack: module._axi()._PROJECT_DIR for stack, module in _LOADED.items()}


def _restore_bindings(found):
    """Bind every loaded core back to what `found` holds for it; a core
    loaded since started unbound."""
    for stack, module in _LOADED.items():
        module._axi().bind_project_dir(found.get(stack))


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


def write_targets_entries(project_dir, entries):
    """`crucible.toml` holding one `[targets]` entry per `{key: entry}`: an
    entry that is not a table is written under a leading `[targets]`."""
    scalars = {k: v for k, v in entries.items() if not isinstance(v, dict)}
    entries = {k: v for k, v in entries.items() if isinstance(v, dict)}
    head = "[targets]\n" + "".join(
        f"{toml_key(k)} = {toml_value(v)}\n" for k, v in scalars.items()) + "\n"
    body = (head if scalars else "") + "".join(
        f"[targets.{toml_key(key)}]\n" + "".join(
            f"{toml_key(k)} = {toml_value(v)}\n" for k, v in entry.items()) + "\n"
        for key, entry in entries.items())
    Path(project_dir, "crucible.toml").write_text(body, encoding="utf-8")


def write_path_fixture(project_dir):
    """Lay down the path fixture under `project_dir`: a test directory, a
    test file in it (not executable) and an executable file."""
    Path(project_dir, FIXTURE_DIR).mkdir(parents=True, exist_ok=True)
    test_file = Path(project_dir, FIXTURE_FILE)
    test_file.write_text(f"def {FIXTURE_NODE}():\n    pass\n", encoding="utf-8")
    test_file.chmod(0o644)
    executable = Path(project_dir, FIXTURE_EXECUTABLE)
    executable.parent.mkdir(parents=True, exist_ok=True)
    executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    executable.chmod(0o755)


# --------------------------------------------------------------------------- #
# What each client does with an entry
# --------------------------------------------------------------------------- #
def reader_verdict(stack, project_dir, key):
    """What a `[targets]` reader makes of the project's crucible.toml for `key`:
    rust answers ACCEPTED for no refusal (it cannot tell a skipped entry from
    its own), arduino and maven ACCEPTED / SKIPPED-or-UNDECLARED / REFUSED;
    eda reads the whole declaration, and answers ACCEPTED when it holds an
    entry under `key`, UNDECLARED when it holds none (skipped or absent), and
    REFUSED when the declaration is refused."""
    module = client(stack)
    if stack == "rust":
        refusal = module._targets_refusal(project_dir, key)
        return ACCEPTED if refusal is None else REFUSED
    if stack == "eda":
        try:
            declaration = module._read_declaration(project_dir)
        except declaration_refused(stack):
            return REFUSED
        return ACCEPTED if any(e.key == key for e in declaration.entries) else UNDECLARED
    path = os.path.join(project_dir, "crucible.toml")
    try:
        declared = module._declared_entry(path, key)
    except declaration_refused(stack):
        return REFUSED
    return ACCEPTED if declared is True else UNDECLARED


def entry_verdict(stack, project_dir, entry, key=None):
    """The client's verdict on one entry, written to a fresh crucible.toml
    under `key` (the reader's own key by default), or read directly, for bun's
    pure entry check. An eda entry is judged beside the path fixture."""
    if stack == "bun":
        _target, refusal = client("bun")._read_target_entry("crucible.targets.k", entry)
        return ACCEPTED if refusal is None else REFUSED
    key = READER_KEYS[stack] if key is None else key
    if stack == "eda":
        write_path_fixture(project_dir)
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
    return values_ok(desc["values"], value)


def values_ok(values, value):
    """Whether `value` is one the `values` form allows."""
    if isinstance(values, list):
        return value in values
    if "pattern" in values:
        templates = values["pattern"]
        templates = [templates] if isinstance(templates, str) else templates
        return isinstance(value, str) and any(
            _template_regex(t).match(value) for t in templates)
    if "board-listed" in values:
        return isinstance(value, str) and bool(value.strip())
    if "list" in values:
        form = values["list"]
        return (isinstance(value, list) and len(value) >= form["min"]
                and all(values_ok(form["items"], item) for item in value))
    if "path" in values:
        return _path_ok(values["path"], value)
    raise AssertionError(f"no entry-level check for values {values!r}")


def _path_ok(form, value):
    """Whether `value` names what the path form asks for, in the path fixture."""
    if form.get("is") == "executable":
        return isinstance(value, str) and value in _FIXTURE_EXECUTABLES
    if form.get("exists") is True:
        if not isinstance(value, str):
            return False
        separator = form.get("node_id")
        named = value.split(separator, 1)[0] if separator else value
        return named in _FIXTURE_EXISTING
    raise AssertionError(f"no entry-level check for the path form {form!r}")


def key_ok(key_desc, key):
    """Whether `key` is one the key descriptor allows: any key, unless it
    states `tiers` (the first segment must be one) and `label: non-empty`
    (a `/<label>` part, when present, must be non-empty)."""
    tiers = key_desc.get("tiers")
    if tiers is None:
        return True
    tier, slash, label = key.partition("/")
    if tier not in tiers:
        return False
    return not (slash and key_desc.get("label") == "non-empty" and not label)


def sample_keys(key_desc):
    """Every key form the key descriptor allows: each tier bare, and each tier
    with a sample label when the descriptor states a label."""
    tiers = list(key_desc["tiers"])
    labelled = [f"{t}/{SAMPLE_LABEL}" for t in tiers] if "label" in key_desc else []
    return tiers + labelled


def wrong_keys(key_desc):
    """Keys generated to probe the key descriptor's edges: a tier it does not
    list (bare and labelled), and an empty label under its first tier."""
    wrong = [WRONG_VALUE, f"{WRONG_VALUE}/{SAMPLE_LABEL}"]
    if key_desc.get("label") == "non-empty":
        wrong.append(f"{key_desc['tiers'][0]}/")
    return wrong


def _holds(entry, fields, name, wanted):
    present = name in entry
    if wanted is True:
        return present
    value = entry[name] if present else fields.get(name, {}).get("default")
    return value in wanted


def other_frameworks(schema, stack):
    return {fw for owner, fws in schema["reserved_frameworks"].items()
            if owner != stack for fw in fws}


def schema_verdict(schema, stack, entry, key=None):
    """What the descriptor says `stack`'s client makes of `entry` (under
    `key`, when one is given and the key descriptor constrains it)."""
    desc = schema["stacks"][stack]["entry"]
    if not isinstance(entry, dict):
        return desc["shape"]["entry_not_a_table"]
    if "framework" not in entry and desc.get("frameworkless") == SKIPPED:
        return SKIPPED
    if entry.get("framework") in other_frameworks(schema, stack):
        return desc["other_stacks"]
    if key is not None and not key_ok(desc["key"], key):
        return REFUSED
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
    found = values_samples(desc["values"])
    return found + [v for v in (desc.get("when") or {}) if v not in found]


def values_samples(values):
    """Every value a `values` form allows, a sample standing in for a pattern,
    an open codec name or a path (one from the path fixture); for a list form,
    each item sample alone and all of them together."""
    if isinstance(values, list):
        return list(values)
    if "pattern" in values:
        templates = values["pattern"]
        templates = [templates] if isinstance(templates, str) else templates
        return [re.sub(r"<[A-Za-z_]+>", SAMPLE_NAME, t) for t in templates]
    if "board-listed" in values:
        return [SAMPLE_CODEC]
    if "list" in values:
        form = values["list"]
        items = values_samples(form["items"])
        found = [[item] * max(form["min"], 1) for item in items]
        if len(items) > 1 and len(items) >= form["min"]:
            found.append(list(items))
        return found
    if "path" in values and values["path"].get("is") == "executable":
        return [FIXTURE_EXECUTABLE]
    if "path" in values and values["path"].get("exists") is True:
        separator = values["path"].get("node_id")
        node = [f"{FIXTURE_FILE}{separator}{FIXTURE_NODE}"] if separator else []
        return [FIXTURE_FILE, FIXTURE_DIR] + node
    raise AssertionError(f"no sample for values {values!r}")


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
    return values_wrong(desc["values"])


def values_wrong(values):
    """Values a `values` form refuses. For a list form: a value that is not a
    list, a list shorter than its minimum, a list of each wrong item, and a
    sample item beside a wrong one. For a path that must exist: a missing
    path (with a node id, when the form allows one) and a non-string. For an
    executable file: a file that is not executable, a directory, a missing
    path, an empty string and a non-string."""
    if isinstance(values, list):
        return [WRONG_VALUE]
    if "pattern" in values:
        templates = values["pattern"]
        templates = [templates] if isinstance(templates, str) else templates
        return [WRONG_VALUE] + [re.sub(r"<[A-Za-z_]+>", "", t) for t in templates
                                if re.search(r"<[A-Za-z_]+>", t)]
    if "board-listed" in values:
        return ["", 7]
    if "list" in values:
        form = values["list"]
        wrong_items = values_wrong(form["items"])
        short = [[]] if form["min"] >= 1 else []
        mixed = [[values_samples(form["items"])[0], wrong_items[0]]]
        return [WRONG_VALUE] + short + [[w] for w in wrong_items] + mixed
    if "path" in values and values["path"].get("is") == "executable":
        return [FIXTURE_FILE, FIXTURE_DIR, MISSING_PATH, "", NOT_A_PATH]
    if "path" in values and values["path"].get("exists") is True:
        separator = values["path"].get("node_id")
        node = [f"{MISSING_PATH}{separator}{FIXTURE_NODE}"] if separator else []
        return [MISSING_PATH] + node + [NOT_A_PATH]
    return [WRONG_VALUE]


def complete_value(desc):
    """An object field with every subfield at its first allowed value."""
    return {name: sample_values(sub)[0] for name, sub in desc["fields"].items()}


def complete_entries(schema, stack, framework=None):
    """`stack`'s complete valid entries, generated from its descriptor: the
    entries it accepts whose fields no other accepted entry extends (bun's
    fullest `junit` entry and its `stream` entry alike), so a skip is tested on
    a full entry, never a bare framework."""
    listed = set(schema["stacks"][stack]["entry"]["fields"])
    candidates = [c for c in candidate_entries(schema, stack)
                  if isinstance(c, dict) and not carries_unlisted(c)
                  and set(c) <= listed
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
