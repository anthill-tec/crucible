//go:build e2e

package probe

import (
	"os"
	"testing"
)

// TestMain is all the e2e tag adds: a setup hook, never a test.
func TestMain(m *testing.M) { os.Exit(m.Run()) }
