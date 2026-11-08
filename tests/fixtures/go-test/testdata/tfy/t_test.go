package tfy

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAssert(t *testing.T) { assert.Equal(t, 1, 2, "numbers differ") }
func TestRequire(t *testing.T) { require.NoError(t, errFoo{}) }

type errFoo struct{}

func (errFoo) Error() string { return "foo broke" }
