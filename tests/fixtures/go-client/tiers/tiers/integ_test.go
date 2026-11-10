//go:build integration

package tiers

import "testing"

func TestInteg(t *testing.T) {
	if Answer() != 42 {
		t.Fatal("integration")
	}
}
