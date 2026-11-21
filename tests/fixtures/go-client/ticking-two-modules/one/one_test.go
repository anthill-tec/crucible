package tickone

// The first module of a two-module run: 3 tests, then the first gate.

import "testing"

func TestBefore01(t *testing.T) {}
func TestBefore02(t *testing.T) {}
func TestBefore03(t *testing.T) {}

func TestGateOne(t *testing.T) { park(t, "1") }
