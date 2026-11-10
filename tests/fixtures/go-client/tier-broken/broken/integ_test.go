//go:build integration

package broken

import "testing"

// TestBrokenInteg does not compile: a type error the run must file.
func TestBrokenInteg(t *testing.T) {
	var x int = "not an int"
	_ = x
}
