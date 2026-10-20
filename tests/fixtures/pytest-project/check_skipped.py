"""One test in a class, skipped."""

import pytest


class TestSkipped:

    @pytest.mark.skip(reason="planted skip")
    def test_it_is_skipped(self):
        raise AssertionError("a skipped test must never run")
