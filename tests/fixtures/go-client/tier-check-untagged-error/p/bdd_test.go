//go:build bdd

package p

import "testing"

func TestBdd(t *testing.T) {
	if One() != 1 {
		t.Fatal("bdd")
	}
}
