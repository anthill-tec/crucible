package shapes

// Every shape a `go test -json` stream holds: a passing, a failing and a
// skipped test, a parent with nested subtests, a parent whose subtest fails,
// and an Example with output. TestPass and TestParent's subtests are
// parallel, so the stream also holds `pause` and `cont` lines. Its stream is
// captured once, as `../captured/stream-shapes.jsonl`.

import (
	"fmt"
	"testing"
)

func TestPass(t *testing.T) { t.Parallel() }

func TestFail(t *testing.T) { t.Error("boom") }

func TestSkip(t *testing.T) { t.Skip("later") }

func TestParent(t *testing.T) {
	t.Run("a", func(t *testing.T) { t.Parallel() })
	t.Run("b", func(t *testing.T) {
		t.Parallel()
		t.Run("deep", func(t *testing.T) {})
	})
}

func TestParentFailsChild(t *testing.T) {
	t.Run("bad", func(t *testing.T) { t.Fatal("x") })
}

func Example() {
	fmt.Println("hi")
	// Output: hi
}
