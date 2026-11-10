package p

import "testing"

func TestUntagged(t *testing.T) {
	var s string = One()
	_ = s
}
