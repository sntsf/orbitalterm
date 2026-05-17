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

#[derive(Debug, Clone, PartialEq)]
pub enum RdpFlavor {
    FreeRdp,  // xfreerdp3 / xfreerdp  — uses /v: /u: /p: syntax
    Remmina,  // remmina               — uses rdp://user@host:port URI
}

pub struct RdpClient {
    pub binary: String,
    pub flavor: RdpFlavor,
}

/// Detect the best available RDP client.
/// Priority: xfreerdp3 → xfreerdp → remmina
pub fn find_rdp_client() -> Result<RdpClient, String> {
    #[cfg(target_os = "linux")]
    {
        for bin in ["xfreerdp3", "xfreerdp"] {
            if binary_exists(bin) {
                return Ok(RdpClient { binary: bin.to_string(), flavor: RdpFlavor::FreeRdp });
            }
        }
        if binary_exists("remmina") {
            return Ok(RdpClient { binary: "remmina".to_string(), flavor: RdpFlavor::Remmina });
        }
        Err(
            "NO_RDP_CLIENT:freerdp3-x11\nNo RDP client found.\n\
            Install FreeRDP (recommended):\n  sudo apt install freerdp3-x11\n\
            Or Remmina:\n  sudo apt install remmina remmina-plugin-rdp"
                .to_string(),
        )
    }
    #[cfg(target_os = "windows")]
    {
        Ok(RdpClient { binary: "mstsc.exe".to_string(), flavor: RdpFlavor::FreeRdp })
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
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Err("RDP not supported on this platform".to_string())
    }
}
