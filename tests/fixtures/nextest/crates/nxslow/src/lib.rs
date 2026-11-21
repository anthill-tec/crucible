#[cfg(test)]
mod waits {
    #[test]
    fn quick() {}

    #[test]
    fn hangs() {
        std::thread::sleep(std::time::Duration::from_secs(30));
    }
}
