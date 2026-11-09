// Package use calls calc from a second package.
package use

import "example.com/calc"

// Double answers n+n through calc.Add.
func Double(n int) int { return calc.Add(n, n) }
