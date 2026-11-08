package live;

import static org.junit.jupiter.api.Assertions.fail;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

class BetaTest {
  @BeforeAll
  static void started() {
    Marks.mark(BetaTest.class, "started");
  }

  @AfterAll
  static void ended() {
    Marks.mark(BetaTest.class, "ended");
  }

  @Test
  void holds() {
    Marks.pause(2500);
  }

  @Test
  void breaks() {
    Marks.pause(2500);
    fail("beta broke");
  }
}
