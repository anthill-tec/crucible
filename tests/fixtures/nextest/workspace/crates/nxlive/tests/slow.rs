use std::time::Duration;

/// Runs for at least three of the client's relay cycles. When
/// NXLIVE_MARKER_DIR is set it writes `started` there as it begins and
/// `finished` as it ends, so a watcher can tell whether it is still running.
#[test]
fn stays_running_across_relay_cycles() {
    let marks = std::env::var("NXLIVE_MARKER_DIR").ok();
    if let Some(dir) = &marks {
        std::fs::write(format!("{dir}/started"), b"").unwrap();
    }
    std::thread::sleep(Duration::from_secs(8));
    if let Some(dir) = &marks {
        std::fs::write(format!("{dir}/finished"), b"").unwrap();
    }
}
