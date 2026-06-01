use std::{
    collections::HashMap,
    process::Child,
    sync::{Arc, Mutex},
};

#[cfg(target_os = "linux")]
pub mod freerdp;

#[cfg(target_os = "windows")]
pub mod windows_rdp;

// Stub for platforms that have no embedded implementation (macOS, etc.)
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub mod embedded {
    pub struct EmbeddedSession {}
}

#[cfg(target_os = "linux")]
pub type EmbeddedSession = freerdp::FreerdpSession;

#[cfg(target_os = "windows")]
pub type EmbeddedSession = windows_rdp::WindowsRdpSession;

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub type EmbeddedSession = embedded::EmbeddedSession;

pub type RdpSessionMap = Arc<Mutex<HashMap<String, Child>>>;
pub type EmbeddedRdpSessionMap = Arc<Mutex<HashMap<String, EmbeddedSession>>>;

pub fn new_rdp_sessions() -> RdpSessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn new_embedded_rdp_sessions() -> EmbeddedRdpSessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}

#[cfg(not(target_os = "linux"))]
fn binary_exists(name: &str) -> bool {
    std::process::Command::new("which")
        .arg(name)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
#[derive(Debug, Clone, PartialEq)]
pub enum RdpFlavor {
    FreeRdp,
    Remmina,
    Mstsc,
}

#[cfg(not(target_os = "linux"))]
pub struct RdpClient {
    pub binary: String,
    pub flavor: RdpFlavor,
}

#[cfg(not(target_os = "linux"))]
pub fn find_rdp_client() -> Result<RdpClient, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(RdpClient { binary: "mstsc.exe".to_string(), flavor: RdpFlavor::Mstsc })
    }
    #[cfg(target_os = "macos")]
    {
        for bin in ["xfreerdp3", "xfreerdp"] {
            if binary_exists(bin) {
                return Ok(RdpClient { binary: bin.to_string(), flavor: RdpFlavor::FreeRdp });
            }
        }
        Err("NO_RDP_CLIENT:freerdp\nNo RDP client found.\nInstall with: brew install freerdp".to_string())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err("RDP not supported on this platform".to_string())
    }
}
