fn main() {}

#[cfg(test)]
mod bin_tests {
    #[test]
    fn bin_ok() {}

    #[test]
    fn bin_fails() {
        panic!("the binary's own test fails");
    }
}
