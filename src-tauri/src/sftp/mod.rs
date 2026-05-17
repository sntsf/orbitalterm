use ssh2::Session;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct SftpConn {
    pub session: Session,
}

// SAFETY: ssh2::Session is not Send by default but we guard all access with Mutex
unsafe impl Send for SftpConn {}

pub type SftpSessionMap = Arc<Mutex<HashMap<String, SftpConn>>>;

pub fn new_sftp_sessions() -> SftpSessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}
