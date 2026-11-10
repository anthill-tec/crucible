// Package waits spends a test's time the way FAKE_BURN_MODE says: asleep
// (`sleep`, wall time and no CPU) or computing (`spin`, wall time that is CPU),
// for FAKE_BURN_SECONDS. GO_BURN_NONCE is read so that a run under a new
// nonce is never answered from go's test cache.
package waits

import (
	"os"
	"strconv"
	"time"
)

var sink uint64

// Burn spends FAKE_BURN_SECONDS as FAKE_BURN_MODE says; nothing without them.
func Burn() {
	_ = os.Getenv("GO_BURN_NONCE")
	secs, err := strconv.ParseFloat(os.Getenv("FAKE_BURN_SECONDS"), 64)
	if err != nil || secs <= 0 {
		return
	}
	d := time.Duration(secs * float64(time.Second))
	switch os.Getenv("FAKE_BURN_MODE") {
	case "sleep":
		time.Sleep(d)
	case "spin":
		end := time.Now().Add(d)
		x := sink + 1
		for time.Now().Before(end) {
			x = x*6364136223846793005 + 1442695040888963407
		}
		sink = x
	}
}
