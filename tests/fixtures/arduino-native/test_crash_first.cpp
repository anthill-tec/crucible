// Two passes, then a test that dies by SIGSEGV halfway through a stream line.
#include "crucible_native.h"

NT_TEST(boots) { NT_CHECK(true, "boots"); }
NT_TEST(reads) { NT_CHECK(3 + 3 == 6, "expected 6"); }
NT_TEST(crashes) { NT_CRASH_MID_LINE(); }

int main() { return nt_run("test_crash_first"); }
