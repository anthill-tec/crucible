// Package p compiles; its only finding is one `go vet` reports.
package p

import "fmt"

// Shown formats its value wrongly.
func Shown() string { return fmt.Sprintf("%d", "x") }
