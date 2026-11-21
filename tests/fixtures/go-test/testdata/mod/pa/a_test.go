package pa

import (
	"fmt"
	"testing"
)

func TestPass(t *testing.T) {}
func TestFailMulti(t *testing.T) {
	t.Errorf("first line\nsecond line\nthird line")
	t.Log("a log line")
}
func TestSkip(t *testing.T) { t.Skip("not today") }
func TestSubs(t *testing.T) {
	t.Run("ok", func(t *testing.T) {})
	t.Run("bad", func(t *testing.T) { t.Fatal("sub failed") })
	t.Run("skipped", func(t *testing.T) { t.Skip("sub skip reason") })
	t.Run("nest", func(t *testing.T) {
		t.Run("deep", func(t *testing.T) {})
		t.Run("deep bad", func(t *testing.T) { t.Error("deep failed") })
	})
}
func TestParentFailsBeyond(t *testing.T) {
	t.Run("ok", func(t *testing.T) {})
	t.Error("parent body failure")
}
func TestParentAllPassSubs(t *testing.T) {
	t.Run("x", func(t *testing.T) {})
	t.Run("y", func(t *testing.T) {})
}
func TestPar1(t *testing.T) { t.Parallel(); t.Log("p1") }
func TestPar2(t *testing.T) { t.Parallel(); t.Error("p2 fails") }
func TestParSubs(t *testing.T) {
	for i := 0; i < 2; i++ {
		t.Run(fmt.Sprint("s", i), func(t *testing.T) { t.Parallel() })
	}
}
func BenchmarkX(b *testing.B) { for i := 0; i < b.N; i++ {} }
func FuzzF(f *testing.F) { f.Add(1); f.Fuzz(func(t *testing.T, n int) {}) }
func ExampleHello() {
	fmt.Println("hello")
	// Output: hello
}
func ExampleBad() {
	fmt.Println("nope")
	// Output: hello
}
func ExampleNoOutput() { fmt.Println("not run") }
