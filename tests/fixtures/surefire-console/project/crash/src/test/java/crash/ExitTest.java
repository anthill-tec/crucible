package crash;
import org.junit.jupiter.api.*;
class ExitTest {
  @Test void first() { }
  @Test void exits() { System.out.println("about to exit"); System.exit(3); }
}
