"""The retired board variables other modules import. Holds no `TestCase`
and no test.
"""




#: §S1 (C1) retired the first pair, §S2 (C2) the second. One list, because the
#: hazard is identical: a channel nothing reads, still being aimed.
RETIRED_VARIABLES = ("CRUCIBLE_PORT", "CRUCIBLE_HOST",
                     "CRUCIBLE_URL", "CRUCIBLE_BASE")
