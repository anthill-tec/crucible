// A second green binary.
#include "crucible_native.h"

NT_TEST(writes) { NT_CHECK(10 / 2 == 5, "expected 5"); }

int main() { return nt_run("test_green_two"); }
