package basic;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;
class CalcTest {
  @Test void adds() { assertEquals(4, 2 + 2); }
  @Test void subtracts() { assertEquals(1, 3 - 1, "subtraction is off: ½ ≠ 1"); }
  @Test void divides() { throw new IllegalStateException("divide by zero"); }
  @Test @Disabled("not yet") void multiplies() { }
  @Nested class Rounding {
    @Test void roundsDown() { assertEquals(2, Math.round(2.4)); }
    @Test void roundsUp() { assertEquals(4, Math.round(2.6), "rounding is off"); }
  }
}
