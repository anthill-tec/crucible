package rerun;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;
class FlakyTest {
  static int calls = 0;
  @Test void steady() { }
  @Test void flips() { calls += 1; assertTrue(calls > 1, "first call fails"); }
  @Test void broken() { fail("always broken"); }
}
