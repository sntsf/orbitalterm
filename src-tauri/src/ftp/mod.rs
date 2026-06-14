use std::collections::HashMap;
use std::sync::Mutex;
use suppaftp::NativeTlsFtpStream;

/// An FTP control connection. We always use the TLS-capable stream type: it
/// carries plain data connections until `into_secure` upgrades it (FTPS), so
/// one type covers both plain FTP and FTPS.
pub struct FtpConn {
    pub stream: NativeTlsFtpStream,
}

// Wraps TcpStream / TLS streams which are Send
unsafe impl Send for FtpConn {}

pub type FtpSessionMap = Mutex<HashMap<String, FtpConn>>;

pub fn new_ftp_sessions() -> FtpSessionMap {
    Mutex::new(HashMap::new())
}
