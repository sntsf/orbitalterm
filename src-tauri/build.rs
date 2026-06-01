fn main() {
    #[cfg(target_os = "linux")]
    build_rdp_bridge();

    tauri_build::build();
}

#[cfg(target_os = "linux")]
fn build_rdp_bridge() {
    // Locate freerdp3 headers and libraries via pkg-config.
    // On Ubuntu/Debian: sudo apt install libfreerdp-dev3 libfreerdp-client3-dev
    // (package names vary by distro; freerdp3 is the FreeRDP 3.x series)
    let freerdp = pkg_config::probe_library("freerdp3")
        .or_else(|_| pkg_config::probe_library("freerdp"))
        .expect(
            "freerdp3 not found — install with: sudo apt install \
             libfreerdp-dev3 libfreerdp-client-dev3",
        );

    let freerdp_client = pkg_config::probe_library("freerdp-client3")
        .or_else(|_| pkg_config::probe_library("freerdp-client"))
        .expect("freerdp-client3 not found");

    let _winpr = pkg_config::probe_library("winpr3")
        .or_else(|_| pkg_config::probe_library("winpr"))
        .expect("winpr3 not found");

    // Collect include paths from both probes
    let mut include_paths: Vec<std::path::PathBuf> = Vec::new();
    include_paths.extend(freerdp.include_paths.iter().cloned());
    include_paths.extend(freerdp_client.include_paths.iter().cloned());

    // Compile the C bridge
    let mut build = cc::Build::new();
    build
        .file("orb_rdp_bridge.c")
        .std("gnu11")
        .opt_level(2)
        .flag("-Wall")
        .flag("-Wextra")
        .flag("-Wno-unused-parameter");

    for path in &include_paths {
        build.include(path);
    }

    build.compile("orb_rdp_bridge");

    // Tell Rust where to find the compiled object (cc already links it, but
    // we also need to link the shared libraries explicitly).
    println!("cargo:rerun-if-changed=orb_rdp_bridge.c");
    println!("cargo:rerun-if-changed=orb_rdp_bridge.h");
}
