package live;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;

class GammaTest {
  @BeforeAll
  static void started() {
    Marks.mark(GammaTest.class, "started");
  }

  @AfterAll
  static void ended() {
    Marks.mark(GammaTest.class, "ended");
  }

  @Test
  void waits() {
    Marks.pause(2500);
  }

  @Test
  @Disabled("kept as a skip")
  void skipped() {}

  @Test
  void lasts() {
    Marks.pause(2500);
  }
}
