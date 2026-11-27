"""Every pytest run on a copy of this project records its own environment.

At the start of each pytest process, one JSON line is appended to
`<rootdir>/child-env.jsonl`: the values (or null) of `QT_QPA_PLATFORM`,
`DISPLAY`, `WAYLAND_DISPLAY` and `COLUMNS` as the pytest child itself sees
them, so a test can read what environment the client handed its child.
"""

import json
import os

_RECORDED = ("QT_QPA_PLATFORM", "DISPLAY", "WAYLAND_DISPLAY", "COLUMNS")


def pytest_configure(config):
    record = {name: os.environ.get(name) for name in _RECORDED}
    with open(os.path.join(str(config.rootpath), "child-env.jsonl"), "a",
              encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")
