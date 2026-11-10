//go:build e2e

package probe

import "testing"

// BenchmarkAnswer is all the e2e tag adds: a benchmark, never a test.
func BenchmarkAnswer(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_ = Answer()
	}
}
