# surefire-console captures

Real maven consoles, the combined stdout and stderr of one `mvn` run each, as the
`surefire-console` view codec reads them. Nothing is edited but two machine paths:
the scratch project's own directory became `/tmp/surefire-console-project` and the home
directory became `~`.

- **Maven** 3.9.9, **JDK** 25 (GraalVM CE 25.0.1), **JUnit Jupiter** 5.13.4.
- **Plugins:** `maven-surefire-plugin` and `maven-failsafe-plugin` at the version of the
  directory, `3.2.5/` or `3.5.4/`, passed as `-Dsv=<version>`.
- **Project:** `project/` (a five-module reactor). `project/capture.sh <version>` produced
  every file here, running each case from a clean, test-compiled tree, offline.

| File | Command (`-Dsv=<version>` appended) | Covers |
| --- | --- | --- |
| `basic.txt` | `mvn -o -B -pl basic test` | a nested class (`CalcTest$Rounding`), a failure, an error and a skip, a class-level error (`InitTest`, `@BeforeAll`), parameterized failures (`small(double)[2]`, `named(String)[2]`), a test whose stdout prints a surefire-like summary line with and without `-- in` |
| `rerun.txt` | `mvn -o -B -pl rerun test` | `rerunFailingTestsCount=2`: a flake (`flips`) and a test failing on every run (`broken`) |
| `failsafe.txt` | `mvn -o -B -pl it verify` | a surefire run then a failsafe run (`WidgetIT`: a pass, a failure, a skip) |
| `forks.txt` | `mvn -o -B -pl forks test` | `forkCount=2`: `Running` lines back to back, classes closed out of order |
| `reactor.txt` | `mvn -o -B -T 2 -fae -pl forks,it verify` | a two-module `-T` reactor, the modules' lines interleaved |
| `crash.txt` | `mvn -o -B -pl crash test` | a forked JVM that dies (`System.exit(3)`): `Running crash.ExitTest` is never closed |
| `ansi.txt` | `mvn -o -Dstyle.color=always -pl basic test` | the `basic` case with maven's own colour (SGR) |

The JUnit reports of two cases are kept beside them, for the view-against-record checks:
`rerun.junit.xml` (`TEST-rerun.FlakyTest.xml`) and `basic.<Class>.junit.xml` (3.2.5 writes the
nested class `basic.CalcTest$Rounding` a report of its own; 3.5.4 folds it into `basic.CalcTest`).
