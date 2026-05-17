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
        // Check if we're running under Wayland
        let is_wayland = std::env::var("WAYLAND_DISPLAY").is_ok()
            || std::env::var("XDG_SESSION_TYPE")
                .map(|v| v == "wayland")
                .unwrap_or(false);

        if is_wayland {
            // Prefer native Wayland clients
            for bin in ["wlfreerdp3", "wlfreerdp"] {
                if binary_exists(bin) {
                    return Ok(RdpClient { binary: bin.to_string(), is_wayland: true });
                }
            }
        }

        // Fall back to X11 clients (run via XWayland if needed)
        for bin in ["xfreerdp3", "xfreerdp"] {
            if binary_exists(bin) {
                return Ok(RdpClient { binary: bin.to_string(), is_wayland: false });
            }
        }

        let install_hint = if is_wayland {
            "sudo apt install freerdp3-wayland freerdp3-x11"
        } else {
            "sudo apt install freerdp3-x11"
        };

        Err(format!("No RDP client found.\nInstall with: {install_hint}"))
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
