#!/bin/sh
# capture.sh <version>: every case's combined console and its reports under out/<version>/
V=$1; O=/tmp/surefire-console-project/out/$V; rm -rf $O; mkdir -p $O
cd /tmp/surefire-console-project
mvn -o -B -q -Dsv=$V clean test-compile -fae >/dev/null 2>&1
run() { case=$1; shift; echo "\$ mvn $*" > $O/$case.cmd; mvn "$@" -Dsv=$V > $O/$case.txt 2>&1; echo "$case exit=$?" >> $O/exits; mkdir -p $O/$case-reports; for d in */target/surefire-reports */target/failsafe-reports; do [ -d $d ] && cp -r $d $O/$case-reports/$(echo $d | tr / _); done; mvn -o -B -q -Dsv=$V clean >/dev/null 2>&1; mvn -o -B -q -Dsv=$V test-compile >/dev/null 2>&1; }
run basic -o -B -pl basic test
run rerun -o -B -pl rerun test
run failsafe -o -B -pl it verify
run forks -o -B -pl forks test
run reactor -o -B -T 2 -fae -pl forks,it verify
run crash -o -B -pl crash test
run ansi -o -Dstyle.color=always -pl basic test
