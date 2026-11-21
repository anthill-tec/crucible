package pbench

import "testing"

func TestPass(t *testing.T) {}
func BenchmarkX(b *testing.B) { for i := 0; i < b.N; i++ {} }
func BenchmarkLogs(b *testing.B) { b.Log("bench says"); for i := 0; i < b.N; i++ {} }
