package pmain

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	m.Run()
	os.Exit(3)
}
func TestOk(t *testing.T) {}
