package report

import "fmt"

// Line formats one report line.
func Line(name string, cents int) string {
	if cents < 0 {
		return fmt.Sprintf("%s: -", name)
	}
	return fmt.Sprintf("%s: %d.%02d", name, cents/100, cents%100)
}
