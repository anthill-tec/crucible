"""Two module-level tests: one passes, one fails."""


def test_it_passes():
    assert 1 + 1 == 2


def test_it_fails():
    assert 1 + 1 == 3, "planted failure"
