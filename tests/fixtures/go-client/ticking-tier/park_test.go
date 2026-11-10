package ticktier

import (
	"os"
	"testing"
	"time"
)

// park holds the running test at gate `n` while a client test reads the
// board: it writes the file TICK_PARKED_<n> names, then waits for the file
// TICK_RELEASE_<n> names. With either unset it returns at once.
func park(t *testing.T, n string) {
	t.Helper()
	parked, release := os.Getenv("TICK_PARKED_"+n), os.Getenv("TICK_RELEASE_"+n)
	if parked == "" || release == "" {
		return
	}
	if err := os.WriteFile(parked, []byte("parked"), 0o644); err != nil {
		t.Fatalf("park %s: %v", n, err)
	}
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(release); err == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("park %s: never released", n)
}
