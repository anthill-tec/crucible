"""The fleet's client table of `test_client_tier_surface.py`, lifted out of
that test module so a suite importing it does not import a test module
(CR-CRU-261).

Holds no `TestCase` and no test: the shared registrar's source path
(`AXI_MODULE_PATH`), the fleet's client scripts (`CLIENT_FILES`) and the
asserted client count (`EXPECTED_CLIENT_COUNT`). `test_client_tier_surface`
imports them back, so the table still lives in one place.
"""

from tests.client import CLIENT_SOURCE_DIR

# The SOURCE paths: the tier-surface module and its importers
# (test_cr128_flag_help_census) read and label them repo-relative. A spawn or a
# load goes through `client_script`, the test install.
AXI_MODULE_PATH = CLIENT_SOURCE_DIR / "_crucible_axi.py"

CLIENT_FILES = {
    "bun": CLIENT_SOURCE_DIR / "bun-crucible.py",
    "rust": CLIENT_SOURCE_DIR / "rust-crucible.py",
    "mvn": CLIENT_SOURCE_DIR / "mvn-crucible.py",
    "python": CLIENT_SOURCE_DIR / "python-crucible.py",
    "arduino": CLIENT_SOURCE_DIR / "arduino-crucible.py",
    # go joined the fleet's tier surface when its tiers became declared by
    # build tag: it registers the six through the same shared registrar.
    "go": CLIENT_SOURCE_DIR / "go-crucible.py",
}

# AC1's own words: "Five assertions and the client count asserted" -- six since
# go joined. The count is a CONSTANT here and is compared against the number of
# clients each test actually DROVE, so a loop that silently shrank to one
# client fails -- that is the specific defect AC1 exists to prevent ("the
# client exposes the verbs" is satisfiable by one client).
EXPECTED_CLIENT_COUNT = 6
