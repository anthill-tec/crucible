//go:build integration

package p

import "testing"

func TestInteg(t *testing.T) {
	if One() != 1 {
		t.Fatal("integration")
	}
}
