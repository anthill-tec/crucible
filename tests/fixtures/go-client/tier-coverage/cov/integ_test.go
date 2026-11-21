//go:build integration

package cov

import "testing"

func TestIntegCov(t *testing.T) {
	if Integ(1) != 2 {
		t.Fatal("integration")
	}
}
