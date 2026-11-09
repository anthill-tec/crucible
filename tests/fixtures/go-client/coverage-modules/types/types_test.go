package types

import "testing"

func TestKindsAreDistinct(t *testing.T) {
	if KindA == KindB {
		t.Fatal("KindA == KindB")
	}
}
