"""The `release-notes` verb the client fleet shares: it drafts one release's
CHANGELOG section (Keep a Changelog) from what the board already records —
which CRs the release completed, when each landed, and their titles.

No client loads this module. The core, `_crucible_axi.py`, loads it by file
path from its own directory, eagerly, under a name derived from its own
(`f"{__name__}_release"`), so each client's core instance gets a release
module of its own, and re-exports every name it defines: a client reaches
`_axi().cmd_release_notes` and `_axi().add_release_notes_verb`. Once loaded,
the core binds `_core` to a live view of its own namespace, and every core
name this module uses (`emit_axi`'s emitter, the history refusal, the read
paths, ...) is read through that view at call time, so a test that patches a
core name reaches the code here. A call between two functions of this module
resolves here.

It imports only the standard library.
"""

import datetime
import re
import typing

#: The core this module is bound to: a live view of `_crucible_axi.py`'s
#: namespace, set by the core's loader once this module has run. Every core
#: name is read through it at call time, never copied.
_core: typing.Any = None

RELEASE_NOTES_VERB = "release-notes"

#: The encoding only this verb offers: the section alone, ready to paste.
RELEASE_NOTES_MARKDOWN = "markdown"

#: The form a usage refusal names.
RELEASE_NOTES_USAGE = ("release-notes --release <label> [--date YYYY-MM-DD] "
                       "[--format toon|json|markdown]")

#: The one group every line goes under: the board records no CR type, so the
#: human sorts the lines into their groups.
RELEASE_NOTES_GROUP = "### Changed"

#: The history state whose ship date heads the section.
RELEASE_SHIPPED_STATE = "shipped"

#: The help a held label with nothing in History carries, as `history` gives it.
RELEASE_NOT_IN_HISTORY_HELP = "queue --fields release,seq,points,dependsOn"

_DATE_SHAPE = re.compile(r"\d{4}-\d{2}-\d{2}")


def add_release_notes_verb(sub, funcs, *, parents=(), add_args=()):
    """Register the `release-notes` subparser on `sub`, once for the fleet.

    The `add_run_read_verbs` shape: `funcs` maps the verb name to the
    client's own delegator, `parents` carries a client's shared parent
    parsers, and `add_args` its read-verb arg adders (its project-dir
    argument). A read verb, so it takes no --agent.

    `--release` and `--date` are plain, optional strings here: a missing or
    empty label and a date that is no calendar day are refused by the verb's
    own envelope (exit 2), never by argparse's bare usage exit."""
    rn = sub.add_parser(
        RELEASE_NOTES_VERB, parents=list(parents),
        help="Draft one release's CHANGELOG section from the board (GET "
             "…/history, …/plans?status=closed, and …/queue only when a "
             "completed CR has no closed plan): its dated heading, then one "
             "`### Changed` line per completed CR, in landing order. "
             "Read-only: no --agent.")
    rn.add_argument("--release",
                    help="The release label whose section to draft (required).")
    rn.add_argument("--date", metavar="YYYY-MM-DD",
                    help="The heading's date. Default: the UTC date the "
                         "release shipped, else today's UTC date.")
    rn.add_argument(
        "--format", default=_core.AXI_FORMAT_TOON,
        choices=(*_core.AXI_FORMATS, RELEASE_NOTES_MARKDOWN),
        help="Output encoding: `toon` (default) or `json` — the envelope, "
             "the section as `lines` — or `markdown`: the section alone on "
             "stdout, the human line and any warning on stderr.")
    for adder in add_args:
        adder(rn)
    rn.set_defaults(func=funcs[RELEASE_NOTES_VERB])


def is_calendar_date(text):
    """(PURE) Whether `text` is a real calendar day written `YYYY-MM-DD`."""
    if not _DATE_SHAPE.fullmatch(text):
        return False
    try:
        datetime.date.fromisoformat(text)
    except ValueError:
        return False
    return True


def completed_crs(release):
    """(PURE) The CRs a history row counts completed (its `waves[].crs`), in
    the order the row lists them, each once."""
    crs = []
    for wave in (release or {}).get("waves") or []:
        for cr in wave.get("crs") or []:
            if cr not in crs:
                crs.append(cr)
    return crs


def latest_closed_plans(plans, crs):
    """(PURE) Each of `crs`' latest closed plan (by `closedAt`; the later one
    of a tie), keyed by CR. A CR with no closed plan has no key."""
    latest = {}
    for plan in plans or []:
        cr = plan.get("cr")
        if cr in crs and (cr not in latest or (plan.get("closedAt") or 0)
                          >= (latest[cr].get("closedAt") or 0)):
            latest[cr] = plan
    return latest


def release_notes_lines(crs, latest, queue_titles):
    """(PURE) One `- <title> (<CR id>)` line per completed CR: the planned
    ones by their latest close, earliest first, then the rest in the history
    row's order. The title is the latest closed plan's, else the queue
    entry's; a CR with neither is its id alone."""
    planned = sorted((cr for cr in crs if cr in latest),
                     key=lambda cr: latest[cr].get("closedAt") or 0)
    lines = []
    for cr in planned + [cr for cr in crs if cr not in latest]:
        title = (latest.get(cr) or {}).get("title") or queue_titles.get(cr)
        lines.append(f"- {title} ({cr})" if title else f"- {cr}")
    return lines


def build_release_notes_section(label, date, cr_lines):
    """(PURE) The section, one string per line: the dated heading, then —
    only when there is a line — the `### Changed` group and its lines."""
    section = [f"## [{label}] - {date}"]
    if cr_lines:
        section += ["", RELEASE_NOTES_GROUP, "", *cr_lines]
    return section


def heading_date(release, date):
    """The heading's date: `date` when given; else the UTC date of a shipped
    release's `shippedAt`; else today's UTC date."""
    if date:
        return date
    shipped_at = release.get("shippedAt")
    if release.get("state") == RELEASE_SHIPPED_STATE and shipped_at is not None:
        return datetime.datetime.fromtimestamp(
            shipped_at, tz=datetime.UTC).strftime("%Y-%m-%d")
    return datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%d")


def _usage_error(label, date):
    """What a usage refusal says was wrong, naming the usage form."""
    if label is None:
        reason = "--release <label> is required"
    elif not label:
        reason = "--release needs a label, not an empty string"
    else:
        reason = f"--date {date!r} is not a real YYYY-MM-DD date"
    return f"{reason}; usage: {RELEASE_NOTES_USAGE}"


def _read_refusal(emit, ops, project_dir, read, resp):
    """A failed read: exit 1, naming the read and its error, with the
    server-failure help the `history` verb gives."""
    return _core._history_refusal(
        RELEASE_NOTES_VERB, emit, ops, project_dir,
        f"could not read the project's {read}: {resp.get('error')}",
        _core.server_failure_help(resp) or [
            ("check CRUCIBLE_PROJECT_KEY in the project's .env names a "
             "project the board holds"),
            (f"check the Crucible server is running / reachable at "
             f"{ops.base_url}")])


def _label_refusal(emit, ops, project_dir, label, held):
    """A label with nothing to draft: one held but not in History yet, or
    one the project does not hold at all. Exit 1, with `history`'s help."""
    if held:
        return _core._history_refusal(
            RELEASE_NOTES_VERB, emit, ops, project_dir,
            f"release {label} is not in History yet: nothing shipped and no "
            f"CR completed", [RELEASE_NOT_IN_HISTORY_HELP])
    return _core._history_refusal(
        RELEASE_NOTES_VERB, emit, ops, project_dir, f"unknown release: {label}",
        ["history — lists every release label the project holds"])


def _emit_markdown(axi, section, legacy):
    """`--format markdown`: the section alone on stdout, ending in one
    newline; the human line, then each warning the envelope carries, on
    stderr, one line each."""
    _core.write_to_pipe("stdout", "\n".join(section) + "\n")
    _core.write_to_pipe("stderr", legacy + "\n")
    for warning in axi.get("warnings") or []:
        detail = " ".join(str(warning.get("detail")).split())
        _core.write_to_pipe("stderr",
                            f"warning: {warning.get('code')}: {detail}\n")


def cmd_release_notes(args, project_dir, ops):
    """Draft `--release <label>`'s CHANGELOG section from the board
    (read-only, no --agent).

    The reads, in order: the history; the closed plans; the queue only when a
    completed CR has no closed plan to take its title from. A label missing
    from the history reads only the queue and the release proposals
    (`_history_label_is_held`), to tell a held label from an unknown one, and
    never the closed plans. `--format` picks the encoding: the envelope
    (`toon`, `json`) carries the section as `lines`; `markdown` prints the
    section alone. Every refusal is this verb's envelope (TOON under
    `markdown`): exit 2 for a usage refusal, 1 for the rest."""
    emit = _core._status_emitter(args, ops)
    label = getattr(args, "release", None)
    date = getattr(args, "date", None)
    if not label or (date is not None and not is_calendar_date(date)):
        _core._history_refusal(RELEASE_NOTES_VERB, emit, ops, project_dir,
                               _usage_error(label, date), [RELEASE_NOTES_USAGE])
        return 2
    project_key = ops.project_key(project_dir)
    history = ops.get(_core.history_path(project_key)) or {}
    if not history.get("ok"):
        return _read_refusal(emit, ops, project_dir, "history", history)
    release = next((r for r in history.get("releases") or []
                    if _core._history_label(r) == label), None)
    if release is None:
        held = _core._history_label_is_held(ops, project_key, label)
        return _label_refusal(emit, ops, project_dir, label, held)
    crs = completed_crs(release)
    if not crs and release.get("state") != RELEASE_SHIPPED_STATE:
        return _label_refusal(emit, ops, project_dir, label, True)
    plans = ops.get(_core.plans_status_path(ops.plans_path(project_dir),
                                            _core.PLANS_STATUS_CLOSED)) or {}
    if not plans.get("ok"):
        return _read_refusal(emit, ops, project_dir, "closed plans", plans)
    latest = latest_closed_plans(plans.get("plans"), crs)
    queue_titles = {}
    if any(cr not in latest for cr in crs):
        queue = ops.get(f"/api/v2/projects/{project_key}/queue") or {}
        if not queue.get("ok"):
            return _read_refusal(emit, ops, project_dir, "queue", queue)
        queue_titles = {e.get("cr"): e.get("title")
                        for e in queue.get("entries") or [] if isinstance(e, dict)}
    cr_lines = release_notes_lines(crs, latest, queue_titles)
    date = heading_date(release, date)
    section = build_release_notes_section(label, date, cr_lines)
    fields = {"release": label, "state": release.get("state"),
              "date": date, "count": len(cr_lines),
              "lines": section,
              "help": [(f"{RELEASE_NOTES_VERB} --release {label} --format "
                        f"{RELEASE_NOTES_MARKDOWN}"), f"history --release {label}"]}
    legacy = f"{RELEASE_NOTES_VERB}: ok=True release={label} count={len(cr_lines)}"
    if getattr(args, "format", None) == RELEASE_NOTES_MARKDOWN:
        _emit_markdown(_core.axi_object(RELEASE_NOTES_VERB, True, fields,
                                        ops.context(project_dir), []),
                       section, legacy)
        return 0
    emit(RELEASE_NOTES_VERB, True, fields, ops.context(project_dir), [], legacy)
    return 0
