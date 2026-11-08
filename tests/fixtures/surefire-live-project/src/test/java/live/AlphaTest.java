package live;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

class AlphaTest {
  @BeforeAll
  static void started() {
    Marks.mark(AlphaTest.class, "started");
  }

  @AfterAll
  static void ended() {
    Marks.mark(AlphaTest.class, "ended");
  }

  @Test
  void adds() {
    Marks.pause(1500);
  }

  @Test
  void subtracts() {
    Marks.pause(1500);
  }
}
