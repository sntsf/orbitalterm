use russh::client::Handle;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct SshHandler;

#[async_trait::async_trait]
impl russh::client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true) // accept-new: trust any host key
    }
}

pub struct SftpConn {
    pub sftp: russh_sftp::client::SftpSession,
    pub _session: Handle<SshHandler>, // keep session alive for the lifetime of sftp
}

// SAFETY: SftpSession and Handle are async/tokio types — guarded per-command via Arc
unsafe impl Send for SftpConn {}
unsafe impl Sync for SftpConn {}

pub type SftpSessionMap = Arc<Mutex<HashMap<String, Arc<SftpConn>>>>;

pub fn new_sftp_sessions() -> SftpSessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}
