package psubpanic

import "testing"

func TestOuter(t *testing.T) {
	t.Run("ok", func(t *testing.T) {})
	t.Run("boom", func(t *testing.T) { panic("kaboom") })
}
func TestNeverRuns(t *testing.T) {}
func TestFailNoMsg(t *testing.T) { t.Run("a", func(t *testing.T) {}); t.Fail() }
