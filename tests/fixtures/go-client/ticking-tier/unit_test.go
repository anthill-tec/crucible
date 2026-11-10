package ticktier

// The untagged test: the gate's whole run holds it alone.

import "testing"

func TestUnitAnswer(t *testing.T) {
	if Answer() != 42 {
		t.Fatal("answer")
	}
}
