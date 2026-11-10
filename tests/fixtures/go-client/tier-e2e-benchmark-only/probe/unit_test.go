package probe

import "testing"

func TestUnit(t *testing.T) {
	if Answer() != 42 {
		t.Fatal("unit")
	}
}
