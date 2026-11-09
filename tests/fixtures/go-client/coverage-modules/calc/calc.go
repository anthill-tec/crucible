// Package calc holds the covered module's arithmetic.
package calc

// Add answers a+b.
func Add(a, b int) int { return a + b }

// Sign answers -1, 0 or 1.
func Sign(n int) int {
	if n < 0 {
		return -1
	}
	if n > 0 {
		return 1
	}
	return 0
}

// Unused is never called by a test.
func Unused() string { return "never" }
