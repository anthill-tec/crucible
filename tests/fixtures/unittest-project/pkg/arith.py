"""A little arithmetic for the fixture's tests to exercise."""


def add(a, b):
    """The sum of ``a`` and ``b``."""
    return a + b


def divide(a, b):
    """``a`` divided by ``b``; a zero ``b`` raises ``ZeroDivisionError``."""
    return a / b
