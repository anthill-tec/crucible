"""The `unit` entry's gates: two pass, one fails, one cannot run yet."""

import pytest


def test_the_netlist_names_every_part():
    assert sorted(["R1", "C1", "U1"]) == ["C1", "R1", "U1"]


def test_the_supply_rail_is_five_volts():
    rail_volts = 5.0
    assert rail_volts == pytest.approx(5.0)


def test_the_erc_finds_no_unconnected_pin():
    unconnected = ["U1.7"]
    assert unconnected == [], f"ERC: {len(unconnected)} unconnected pin(s): {unconnected}"


def test_the_populated_board_answers_its_probe():
    pytest.skip("board not populated")
