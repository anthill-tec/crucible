//go:build integration

package shared

import "testing"

// TestX is the integration flavour, and it fails.
func TestX(t *testing.T) { t.Fatal("the integration TestX fails") }
