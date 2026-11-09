// Package cases is the subject of the go client's end-to-end fixture.
package cases

// Hello is what the passing example prints.
func Hello() string { return "hello" }

// Bad is what the failing example names.
func Bad() {}

// NoOutput is what the example without an Output comment names.
func NoOutput() {}
