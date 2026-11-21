"""The verdict of a hermetic unit run, taken over its dependency event logs.

    python3 scripts/hermetic/unit-verdict.py <event-log>...

Each log is written by hooks/sitecustomize.py or hooks/bun-preload.ts, one
tab-separated line per event: `<charge>\t<event>\t<detail>\t<where>`. Any
spawn, connect, bind, serve, fetch or wait event fails the verdict: each is
printed under the test file it is charged to, and an event charged to no file
is printed with the top stack frame the hook recorded for it. The bun
preload's own `preload` line is excluded; other recorded events (an open of a
watched file) are listed but do not fail it.

Exit codes: 0 no dependency event; 1 at least one; 2 a log is missing or
unreadable (the hooks did not run, so there is nothing to judge).
"""

import sys
from collections import defaultdict

FAILING = ("spawn", "connect", "bind", "serve", "fetch", "wait")
EXCLUDED = ("preload",)


def _file_of(charge: str) -> str:
    return charge.split("::", 1)[0]


def main(paths: list[str]) -> int:
    if not paths:
        sys.stderr.write("usage: unit-verdict.py <event-log>...\n")
        return 2
    charged: dict[str, list[str]] = defaultdict(list)
    uncharged: list[str] = []
    noted: list[str] = []
    excluded = 0
    for path in paths:
        try:
            with open(path, encoding="utf-8") as fh:
                lines = fh.read().splitlines()
        except OSError as exc:
            print(f"unit-verdict: cannot read {path}: {exc} (did the hooks load?)")
            return 2
        for line in lines:
            if not line.strip():
                continue
            charge, event, detail, where = (line.split("\t") + ["", "", ""])[:4]
            if event in EXCLUDED:
                excluded += 1
            elif event not in FAILING:
                noted.append(f"{charge}\t{event}\t{detail}")
            elif charge == "-":
                uncharged.append(f"{event}\t{detail}\tat {where}")
            else:
                charged[_file_of(charge)].append(f"{event}\t{detail}\t({charge})")
    for item in noted:
        print(f"unit-verdict: note (not a dependency): {item}")
    total = sum(len(events) for events in charged.values()) + len(uncharged)
    if total == 0:
        print(f"unit-verdict: clean — no dependency event in {len(paths)} log(s) "
              f"({excluded} preload line(s) excluded)")
        return 0
    for test_file in sorted(charged):
        print(f"FILE {test_file}")
        for event in charged[test_file]:
            print(f"    {event}")
    if uncharged:
        print("UNCHARGED (no test file on the stack)")
        for event in uncharged:
            print(f"    {event}")
    print(f"unit-verdict: FAIL — {total} dependency event(s): {len(charged)} test file(s), "
          f"{len(uncharged)} uncharged")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
