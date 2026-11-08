// Two passes, in a second binary.
#include "crucible_native.h"

NT_TEST(parses) { NT_CHECK(std::atoi("42") == 42, "expected 42"); }
NT_TEST(rounds) { NT_CHECK((int)(2.6 + 0.5) == 3, "expected 3"); }

int main() { return nt_run("test_beta"); }
