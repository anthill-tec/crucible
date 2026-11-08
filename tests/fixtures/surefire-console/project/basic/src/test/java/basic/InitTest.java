package basic;
import org.junit.jupiter.api.*;
class InitTest {
  @BeforeAll static void up() { throw new IllegalStateException("no database"); }
  @Test void reads() { }
}
