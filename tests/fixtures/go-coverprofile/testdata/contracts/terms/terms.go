package terms

// Currency names a currency by its ISO code.
type Currency string

// The currencies the shop sells in.
const (
	EUR Currency = "EUR"
	GBP Currency = "GBP"
)

// Order is a priced order line.
type Order struct {
	SKU      string
	Cents    int
	Currency Currency
}
