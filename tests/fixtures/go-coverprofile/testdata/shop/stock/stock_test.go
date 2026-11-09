package stock

import "testing"

func TestValue(t *testing.T) {
	s := Shelf{Count: 3, Cents: 7}
	if got := s.Value(5); got != 20 {
		t.Fatalf("got %d", got)
	}
}
