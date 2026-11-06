pub fn double(n: u32) -> u32 {
    n * 2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles() {
        assert_eq!(double(3), 6);
    }

    #[test]
    fn doubles_wrongly() {
        assert_eq!(double(2), 5, "doubling broke");
    }

    #[test]
    #[ignore]
    fn waits_for_a_fix() {}
}
