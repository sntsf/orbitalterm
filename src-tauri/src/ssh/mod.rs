use portable_pty::MasterPty;
use std::{
    collections::HashMap,
    io::Write,
    sync::{Arc, Mutex},
};

pub struct SshSession {
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub master: Box<dyn MasterPty + Send>,
}

// SAFETY: MasterPty + Send and Write + Send are both Send
unsafe impl Send for SshSession {}

pub type SshSessionMap = Arc<Mutex<HashMap<String, SshSession>>>;

pub fn new_ssh_sessions() -> SshSessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}
