package basic;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import static org.junit.jupiter.api.Assertions.*;
class ParamTest {
  @ParameterizedTest @ValueSource(doubles = {1.5, 2.5}) void small(double d) { assertTrue(d < 2, "too big: " + d); }
  @ParameterizedTest @ValueSource(strings = {"a.b", "c(d)"}) void named(String s) { assertEquals(3, s.length(), "length of " + s); }
}
