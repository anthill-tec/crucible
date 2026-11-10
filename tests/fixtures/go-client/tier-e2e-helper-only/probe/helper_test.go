//go:build e2e

package probe

// e2eAnswer is a helper the e2e tag adds; it declares no test.
func e2eAnswer() int { return Answer() }
