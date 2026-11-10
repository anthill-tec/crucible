//go:build integration

package brokenhelper

// integHelper is the only thing the tag adds here, and it does not compile.
func integHelper() int { return "not an int" }
