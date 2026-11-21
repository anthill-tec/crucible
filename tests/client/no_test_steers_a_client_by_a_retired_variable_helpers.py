"""The helpers of `test_no_test_steers_a_client_by_a_retired_variable.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""




#: §S1 (C1) retired the first pair, §S2 (C2) the second. One list, because the
#: hazard is identical: a channel nothing reads, still being aimed.
RETIRED_VARIABLES = ("CRUCIBLE_PORT", "CRUCIBLE_HOST",
                     "CRUCIBLE_URL", "CRUCIBLE_BASE")
