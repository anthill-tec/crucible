// Package cov is covered in part by its untagged test and in part by its
// integration-tagged test, so the two runs' profiles differ.
package cov

// Unit is what the untagged test calls.
func Unit(x int) int {
	if x > 0 {
		return 1
	}
	return 0
}

// Integ is what the integration-tagged test calls.
func Integ(x int) int {
	if x > 0 {
		return 2
	}
	return 3
}

// Never is called by no test.
func Never() int {
	return 4
}
