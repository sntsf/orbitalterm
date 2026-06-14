use russh::client::{Handle, Msg, Session};
use russh::Channel;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct SshHandler {
    /// Target host/port — needed to verify the server key against known_hosts.
    pub host: String,
    pub port: u16,
    /// Remote-forward (-R) routing: server bind port → local (host, port).
    pub forwards: HashMap<u32, (String, u16)>,
}

#[async_trait::async_trait]
impl russh::client::Handler for SshHandler {
    type Error = russh::Error;

    // Verify the server key against ~/.ssh/known_hosts (TOFU): accept & record a
    // new host, accept a matching one, and REJECT only if a known host's key
    // changed (possible MITM). Any other error falls back to lenient accept so
    // a missing/unreadable file never blocks connecting.
    async fn check_server_key(
        &mut self,
        server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match russh_keys::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                let _ = russh_keys::learn_known_hosts(&self.host, self.port, server_public_key);
                Ok(true)
            }
            Err(russh_keys::Error::KeyChanged { .. }) => Ok(false),
            Err(_) => {
                let _ = russh_keys::learn_known_hosts(&self.host, self.port, server_public_key);
                Ok(true)
            }
        }
    }

    // A remote-forwarded connection arrived: pipe it to the configured local
    // destination (the -R tunnel target).
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some((host, port)) = self.forwards.get(&connected_port).cloned() {
            tokio::spawn(async move {
                if let Ok(mut tcp) = tokio::net::TcpStream::connect((host.as_str(), port)).await {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                }
            });
        }
        Ok(())
    }
}

pub struct SftpConn {
    pub sftp: russh_sftp::client::SftpSession,
    // Keep the underlying SSH session alive for the lifetime of the SFTP
    // session. Arc so it can be SHARED with an interactive SSH terminal session
    // (reused connection) or owned outright (standalone SFTP connection).
    pub _session: Arc<Handle<SshHandler>>,
}

// SAFETY: SftpSession and Handle are async/tokio types — guarded per-command via Arc
unsafe impl Send for SftpConn {}
unsafe impl Sync for SftpConn {}

pub type SftpSessionMap = Arc<Mutex<HashMap<String, Arc<SftpConn>>>>;

pub fn new_sftp_sessions() -> SftpSessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}
