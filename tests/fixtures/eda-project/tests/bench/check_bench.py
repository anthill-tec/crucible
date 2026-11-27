"""The `e2e` entry's gates: every one needs the bench, so every one is skipped."""

import pytest


def test_the_bench_supply_powers_the_board():
    pytest.skip("bench not connected")


def test_the_bench_scope_sees_the_clock():
    pytest.skip("bench not connected")
