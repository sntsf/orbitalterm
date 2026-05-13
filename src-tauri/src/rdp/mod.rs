use std::{
    collections::HashMap,
    process::Child,
    sync::{Arc, Mutex},
};

pub type RdpSessionMap = Arc<Mutex<HashMap<String, Child>>>;

pub fn new_rdp_sessions() -> RdpSessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn find_rdp_client() -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        for bin in ["xfreerdp3", "xfreerdp"] {
            if std::process::Command::new("which")
                .arg(bin)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
            {
                return Ok(bin.to_string());
            }
        }
        Err("No RDP client found.\nInstall with: sudo apt install freerdp3-x11".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        Ok("mstsc.exe".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        for bin in ["xfreerdp3", "xfreerdp"] {
            if std::process::Command::new("which")
                .arg(bin)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
            {
                return Ok(bin.to_string());
            }
        }
        Err("No RDP client found.\nInstall with: brew install freerdp".to_string())
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Err("RDP not supported on this platform".to_string())
    }
}
