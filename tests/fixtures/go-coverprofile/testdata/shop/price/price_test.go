package price

import "testing"

func TestDiscount(t *testing.T) {
	if got := Discount(1000, 10); got != 900 {
		t.Fatalf("got %d", got)
	}
}
