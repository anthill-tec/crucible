"""Test names and a failure message beyond ASCII."""
import unittest


class NonAsciiTest(unittest.TestCase):

    def test_grüße_aus_dem_café(self):
        # Fails, with a message holding two-, three- and four-byte characters.
        self.fail("Grüße aus dem Café — 😀 nicht bestanden")

    def test_ñandú_läuft(self):
        # Passes, under a non-ASCII name.
        self.assertEqual("ñandú".upper(), "ÑANDÚ")


if __name__ == "__main__":
    unittest.main()
