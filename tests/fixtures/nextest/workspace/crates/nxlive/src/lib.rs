pub fn triple(n: u32) -> u32 {
    n * 3
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triples() {
        assert_eq!(triple(2), 6);
    }

    #[test]
    fn triples_wrongly() {
        assert_eq!(triple(2), 7, "tripling broke");
    }

    #[test]
    #[ignore]
    fn waits_for_triple_fix() {}

    #[cfg(feature = "e2e")]
    #[test]
    fn only_with_the_feature() {
        assert_eq!(triple(1), 3);
    }
}
