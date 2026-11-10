package ticktwo

// The second module of a two-module run: 12 tests (TestMiddle01 holds 3
// subtests, TestMiddle02 is skipped), the second gate, and 2 after it.
// Parked at its gate, the run's two modules have 16 top-level results.

import "testing"

func TestMiddle01(t *testing.T) {
	t.Run("a", func(t *testing.T) {})
	t.Run("b", func(t *testing.T) {
		t.Run("deep", func(t *testing.T) {})
	})
}
func TestMiddle02(t *testing.T) { t.Skip("a skip is a result") }
func TestMiddle03(t *testing.T) {}
func TestMiddle04(t *testing.T) {}
func TestMiddle05(t *testing.T) {}
func TestMiddle06(t *testing.T) {}
func TestMiddle07(t *testing.T) {}
func TestMiddle08(t *testing.T) {}
func TestMiddle09(t *testing.T) {}
func TestMiddle10(t *testing.T) {}
func TestMiddle11(t *testing.T) {}
func TestMiddle12(t *testing.T) {}

func TestGateTwo(t *testing.T) { park(t, "2") }

func TestAfter01(t *testing.T) {}
func TestAfter02(t *testing.T) {}
