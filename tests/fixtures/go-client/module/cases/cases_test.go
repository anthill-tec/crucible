package cases

import (
	"fmt"
	"testing"
)

func TestPass(t *testing.T) {}

func TestFail(t *testing.T) {
	t.Errorf("first line\nsecond line")
}

func TestSkip(t *testing.T) { t.Skip("not today") }

func TestSubs(t *testing.T) {
	t.Run("ok", func(t *testing.T) {})
	t.Run("bad", func(t *testing.T) { t.Fatal("sub failed") })
	t.Run("skipped", func(t *testing.T) { t.Skip("sub skip reason") })
	t.Run("nest", func(t *testing.T) {
		t.Run("deep", func(t *testing.T) {})
		t.Run("deep_bad", func(t *testing.T) { t.Error("deep failed") })
	})
}

func TestParentFailsBeyond(t *testing.T) {
	t.Run("ok", func(t *testing.T) {})
	t.Error("parent body failure")
}

func TestAllPassSubs(t *testing.T) {
	t.Run("x", func(t *testing.T) {})
	t.Run("y", func(t *testing.T) {})
}

func BenchmarkHello(b *testing.B) {
	for i := 0; i < b.N; i++ {
		Hello()
	}
}

func FuzzHello(f *testing.F) {
	f.Add(1)
	f.Fuzz(func(t *testing.T, n int) {})
}

func ExampleHello() {
	fmt.Println(Hello())
	// Output: hello
}

func ExampleBad() {
	fmt.Println("nope")
	// Output: hello
}

func ExampleNoOutput() { fmt.Println("never run") }
