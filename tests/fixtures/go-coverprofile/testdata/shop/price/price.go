package price

// Discount takes pct percent off cents; a pct outside 0..100 is refused.
func Discount(cents, pct int) int {
	if pct < 0 || pct > 100 {
		return cents
	}
	off := cents * pct / 100
	return cents - off
}

// Round rounds cents to the nearest whole unit of step.
func Round(cents, step int) int {
	if step <= 0 {
		return cents
	}
	rem := cents % step
	if rem*2 >= step {
		return cents - rem + step
	}
	return cents - rem
}
