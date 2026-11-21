package live;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/** Writes `<class>.started` and `<class>.ended` into $SUREFIRE_LIVE_MARKS, when it is set. */
final class Marks {
  private Marks() {}

  static void mark(Class<?> test, String phase) {
    String dir = System.getenv("SUREFIRE_LIVE_MARKS");
    if (dir == null || dir.isEmpty()) {
      return;
    }
    try {
      Files.writeString(Path.of(dir, test.getName() + "." + phase), "");
    } catch (IOException e) {
      throw new IllegalStateException("could not write the mark " + phase, e);
    }
  }

  static void pause(long millis) {
    try {
      Thread.sleep(millis);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException(e);
    }
  }
}
