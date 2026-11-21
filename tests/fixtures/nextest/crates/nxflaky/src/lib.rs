#[cfg(test)]
mod flaky {
    // Fails its first attempt and passes its second: the first attempt leaves
    // a marker in NXFLAKY_MARKS, the second finds it and removes it.
    #[test]
    fn flips() {
        let dir = std::env::var("NXFLAKY_MARKS").unwrap_or_else(|_| std::env::temp_dir().display().to_string());
        let mark = std::path::Path::new(&dir).join("nxflaky-flips");
        if mark.exists() {
            std::fs::remove_file(&mark).unwrap();
        } else {
            std::fs::write(&mark, "x").unwrap();
            panic!("the first attempt fails");
        }
    }

    #[test]
    fn always_fails() {
        panic!("every attempt fails");
    }

    #[test]
    fn steady() {}
}
