//go:build !integration

package shared

import "testing"

// TestX is the fake flavour, compiled only without the integration tag.
func TestX(t *testing.T) {}
