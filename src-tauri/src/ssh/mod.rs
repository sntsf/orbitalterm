use crate::sftp::SshHandler;
use russh::client::Handle;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;

/// Commands sent from the Tauri command thread to the per-session pump task
/// that owns the russh shell channel.
pub enum SshCmd {
    Data(Vec<u8>),
    Resize(u32, u32),
}

/// One interactive SSH session, backed by a single russh connection. The shell
/// runs on one channel (driven by the pump task via `tx`); the SAME `handle`
/// is reused to open SFTP channels, so terminal + file browser share one
/// authenticated session (MobaXterm-style).
pub struct SshSession {
    pub tx: UnboundedSender<SshCmd>,
    pub handle: Arc<Handle<SshHandler>>,
    // Background port-forwarding listener tasks; aborted when the session ends.
    pub tunnel_tasks: Vec<tokio::task::AbortHandle>,
}

impl Drop for SshSession {
    fn drop(&mut self) {
        for t in &self.tunnel_tasks {
            t.abort();
        }
    }
}

// SAFETY: russh's Handle and the mpsc sender are async/tokio types; access is
// serialised through the session map's Mutex and per-command clones.
unsafe impl Send for SshSession {}
unsafe impl Sync for SshSession {}

pub type SshSessionMap = Arc<Mutex<HashMap<String, SshSession>>>;

pub fn new_ssh_sessions() -> SshSessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}
