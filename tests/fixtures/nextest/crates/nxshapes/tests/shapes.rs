#[test]
fn passes() {}

#[test]
fn child_panic() {
    std::thread::spawn(|| panic!("the spawned thread panics"))
        .join()
        .unwrap();
}

#[test]
#[should_panic]
fn never_panics() {}

#[test]
fn returns_err() -> Result<(), String> {
    Err("the result is an error".into())
}

#[test]
fn prints_then_panics() {
    println!("some output first");
    panic!("line one\nline two");
}
