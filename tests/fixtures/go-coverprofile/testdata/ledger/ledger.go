package ledger

// Entry is one ledger posting.
type Entry struct {
	Account string
	Cents   int
}

// Balance sums the postings of one account.
func Balance(entries []Entry, account string) int {
	total := 0
	for _, e := range entries {
		if e.Account == account {
			total += e.Cents
		}
	}
	return total
}

// Filter keeps the entries keep accepts.
func Filter(entries []Entry, keep func(Entry) bool) []Entry {
	var out []Entry
	for _, e := range entries {
		if keep(e) {
			out = append(out, e)
		}
	}
	return out
}

// Debits keeps the negative postings, through a function literal declared inside the function.
func Debits(entries []Entry) []Entry {
	return Filter(entries, func(e Entry) bool {
		return e.Cents < 0
	})
}

// Close zeroes an account by posting its negated balance.
func Close(entries []Entry, account string) []Entry {
	b := Balance(entries, account)
	if b == 0 {
		return entries
	}
	return append(entries, Entry{Account: account, Cents: -b})
}
