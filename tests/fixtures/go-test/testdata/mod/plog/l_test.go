package plog

import "testing"

func TestLogsThenFailingSub(t *testing.T) {
	t.Log("setting up the table")
	t.Run("bad", func(t *testing.T) { t.Error("sub failed") })
}
func TestLogThenError(t *testing.T) {
	t.Log("step one")
	t.Error("boom")
}
func TestOwnErrorAndFailingSub(t *testing.T) {
	t.Run("bad", func(t *testing.T) { t.Error("sub failed") })
	t.Error("own failure")
}
