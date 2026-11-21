// Package types holds types and constants only: no statement to cover.
package types

// Kind names a kind of pair.
type Kind int

// The kinds.
const (
	KindA Kind = iota
	KindB
)

// Pair holds two ints.
type Pair struct{ A, B int }
