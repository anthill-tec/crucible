package it;
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;
class WidgetIT {
  @Test void builds() throws Exception { Thread.sleep(300); }
  @Test void breaks() { fail("widget broke"); }
  @Test @Disabled void later() { }
}
