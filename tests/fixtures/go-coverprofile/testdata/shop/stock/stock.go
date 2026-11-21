package stock

import "example.com/shop/price"

// Shelf holds a count of items at one price.
type Shelf struct {
	Count int
	Cents int
}

// Value is the shelf's worth, rounded to step.
func (s Shelf) Value(step int) int {
	return price.Round(s.Count*s.Cents, step)
}

// Take removes n items; it refuses to go below zero.
func (s *Shelf) Take(n int) bool {
	if n > s.Count {
		return false
	}
	s.Count -= n
	return true
}
