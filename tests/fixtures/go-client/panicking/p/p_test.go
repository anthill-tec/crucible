package p

import "testing"

func TestBefore(t *testing.T) {}

func TestPanics(t *testing.T) {
	var m map[string]int
	m["a"] = 1
}

func TestAfter(t *testing.T) {}
