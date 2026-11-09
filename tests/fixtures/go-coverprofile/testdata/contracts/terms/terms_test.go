package terms

import "testing"

func TestCurrencies(t *testing.T) {
	if EUR == GBP {
		t.Fatal("currencies collide")
	}
}
