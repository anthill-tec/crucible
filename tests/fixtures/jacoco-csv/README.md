# JaCoCo CSV texts

Both files here are hand-written in JaCoCo's CSV shape: the thirteen-column header JaCoCo's CSV
report writes, then one row per class. Neither is a capture of a real JaCoCo run. The captured
single-row reports are `tests/fixtures/reports/mvn/{app,core}/target/site/jacoco/jacoco.csv`.

## `multi-row.csv`

Five rows, one per class, chosen for the rows a single-row capture cannot show:

| `PACKAGE` | `CLASS` | Lines (missed + covered) | Methods (missed + covered) | Why the row is here |
|---|---|---|---|---|
| `com.acme.shop` | `Basket` | 3 + 17 | 1 + 7 | an ordinary class, partly covered |
| `com.acme.shop` | `Basket.Line` | 0 + 6 | 0 + 3 | a nested class, written `Outer.Inner` in `CLASS` |
| `com.acme.shop` | `Currency` | 2 + 0 | 0 + 0 | a row of 0 methods |
| (empty) | `Launcher` | 4 + 2 | 1 + 1 | a row whose `PACKAGE` is empty |
| `com.acme.shop.tax` | `Rate` | 8 + 0 | 3 + 0 | methods stated, none covered |

Column sums: lines 25 covered of 42; methods 11 covered of 16; branches 9 covered of 16.

## `header-only.csv`

The header row and no class row.
