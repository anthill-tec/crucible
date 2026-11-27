"""The `integration/net` entry's gates: one passes, one fails."""


def test_the_ground_net_joins_every_ground_pin():
    assert {"U1.4", "C1.2"} <= {"U1.4", "C1.2", "J1.1"}


def test_the_layout_matches_the_schematic():
    opens, shorts = 1, 0
    assert (opens, shorts) == (0, 0), f"LVS: {opens} open(s), {shorts} short(s)"
