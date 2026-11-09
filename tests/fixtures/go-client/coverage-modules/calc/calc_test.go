package calc

import "testing"

func TestAdd(t *testing.T) {
	if Add(2, 3) != 5 {
		t.Fatal("Add(2, 3) != 5")
	}
}

func TestSignPositive(t *testing.T) {
	if Sign(4) != 1 {
		t.Fatal("Sign(4) != 1")
	}
}
