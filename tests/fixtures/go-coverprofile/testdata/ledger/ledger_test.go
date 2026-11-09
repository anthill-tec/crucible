package ledger

import "testing"

func TestBalanceAndDebits(t *testing.T) {
	es := []Entry{{"cash", 500}, {"cash", -200}, {"bank", 100}}
	for i := 0; i < 3; i++ {
		if got := Balance(es, "cash"); got != 300 {
			t.Fatalf("got %d", got)
		}
	}
	if got := len(Debits(es)); got != 1 {
		t.Fatalf("got %d", got)
	}
}
