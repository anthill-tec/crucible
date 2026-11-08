// A binary the Makefile never reaches once the first one crashed.
#include "crucible_native.h"

NT_TEST(never_runs) { NT_CHECK(true, "never runs"); }

int main() { return nt_run("test_crash_later"); }
