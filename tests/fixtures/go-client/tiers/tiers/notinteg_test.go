//go:build !integration

package tiers

import "testing"

func TestNotInteg(t *testing.T) {
	if Answer() != 42 {
		t.Fatal("not integration")
	}
}
