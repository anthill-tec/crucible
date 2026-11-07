/// The docker tier: the `ci` and `default` profiles' `default-filter`
/// excludes this binary, and the `e2e` profile selects only it.
#[test]
fn needs_docker() {}
