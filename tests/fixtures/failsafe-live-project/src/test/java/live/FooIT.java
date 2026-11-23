package live;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/** The project's one integration test: failsafe runs it in `integration-test`. */
class FooIT {

    @Test
    void integrates() {
        assertEquals("ab", "a" + "b");
    }
}
