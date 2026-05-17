use std::{
    collections::HashMap,
    process::Child,
    sync::{Arc, Mutex},
};

pub type RdpSessionMap = Arc<Mutex<HashMap<String, Child>>>;

pub fn new_rdp_sessions() -> RdpSessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}

fn binary_exists(name: &str) -> bool {
    std::process::Command::new("which")
        .arg(name)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub struct RdpClient {
    pub binary: String,
    pub is_wayland: bool,
}

/// Detect the best available RDP client for the current environment.
/// On Linux, prefers native Wayland clients over X11 ones.
pub fn find_rdp_client() -> Result<RdpClient, String> {
    #[cfg(target_os = "linux")]
    {
        // xfreerdp3/xfreerdp work on both X11 and Wayland (via XWayland).
        // wlfreerdp3 is deprecated upstream and requires XDG_RUNTIME_DIR which
        // may not be inherited by the child process — skip it.
        for bin in ["xfreerdp3", "xfreerdp"] {
            if binary_exists(bin) {
                return Ok(RdpClient { binary: bin.to_string(), is_wayland: false });
            }
        }

        Err("No RDP client found.\nInstall with:\n  sudo apt install freerdp3-x11".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        Ok(RdpClient { binary: "mstsc.exe".to_string(), is_wayland: false })
    }
    #[cfg(target_os = "macos")]
    {
        for bin in ["xfreerdp3", "xfreerdp"] {
            if binary_exists(bin) {
                return Ok(RdpClient { binary: bin.to_string(), is_wayland: false });
            }
        }
        Err("No RDP client found.\nInstall with: brew install freerdp".to_string())
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Err("RDP not supported on this platform".to_string())
    }
}
