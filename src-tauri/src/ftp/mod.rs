use std::collections::HashMap;
use std::sync::Mutex;
use suppaftp::FtpStream;

pub struct FtpConn {
    pub stream: FtpStream,
}

// FtpStream wraps TcpStream which is Send
unsafe impl Send for FtpConn {}

pub type FtpSessionMap = Mutex<HashMap<String, FtpConn>>;

pub fn new_ftp_sessions() -> FtpSessionMap {
    Mutex::new(HashMap::new())
}
