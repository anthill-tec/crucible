// Mixed outcomes: a pass, a failure and an ignored test.
#include "crucible_native.h"

NT_TEST(adds) { NT_CHECK(1 + 2 == 3, "expected 3"); }
NT_TEST(subtracts) { NT_CHECK(7 - 3 == 3, "expected 3 got 4"); }
NT_TEST(waits_for_board) { NT_IGNORE("needs the board"); }

int main() { return nt_run("test_alpha"); }
