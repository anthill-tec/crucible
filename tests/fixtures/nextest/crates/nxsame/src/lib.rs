pub fn one() -> u32 {
    1
}

#[cfg(test)]
mod lib_tests {
    #[test]
    fn lib_ok() {
        assert_eq!(super::one(), 1);
    }
}
