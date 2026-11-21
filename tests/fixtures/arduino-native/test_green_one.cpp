// A green binary.
#include "crucible_native.h"

NT_TEST(boots) { NT_CHECK(true, "boots"); }
NT_TEST(reads) { NT_CHECK(2 * 2 == 4, "expected 4"); }

int main() { return nt_run("test_green_one"); }
