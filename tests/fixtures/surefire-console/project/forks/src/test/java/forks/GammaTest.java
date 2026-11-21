package forks;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;
class GammaTest {
  @Test void waits() throws Exception { Thread.sleep(700); }
  @Test void fails() throws Exception { Thread.sleep(200); fail("Gamma failed"); }
}
