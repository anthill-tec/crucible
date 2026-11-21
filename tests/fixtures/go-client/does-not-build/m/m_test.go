package m

import (
	"os"
	"testing"
)

// TestMain writes `testmain-ran` into the package dir, the dir a test binary
// runs in, so a test can tell whether any test binary of this package ran.
func TestMain(tm *testing.M) {
	_ = os.WriteFile("testmain-ran", []byte("ran\n"), 0o644)
	os.Exit(tm.Run())
}

func TestTwo(t *testing.T) {
	if Two() != 2 {
		t.Fatal("two")
	}
}
