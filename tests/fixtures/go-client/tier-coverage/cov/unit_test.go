package cov

import "testing"

func TestUnitCov(t *testing.T) {
	if Unit(1) != 1 {
		t.Fatal("unit")
	}
}
