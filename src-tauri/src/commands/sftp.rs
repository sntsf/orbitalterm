use serde::Serialize;
use ssh2::{MethodType, Session};
use std::net::TcpStream;
use std::path::Path;
use tauri::{Emitter, State};
use uuid::Uuid;

use crate::{commands::sessions::load_connection, sftp::{SftpConn, SftpSessionMap}};

/// Set broad algorithm preferences so libssh2 can negotiate with modern servers.
/// method_pref rejects lists containing unsupported algorithms, so we try
/// progressively shorter lists until one is accepted.
fn configure_algorithms(session: &Session) {
    for kex in &[
        "curve25519-sha256,curve25519-sha256@libssh2.org,ecdh-sha2-nistp256,ecdh-sha2-nistp384,ecdh-sha2-nistp521,diffie-hellman-group14-sha256,diffie-hellman-group16-sha512,diffie-hellman-group18-sha512,diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha256",
        "ecdh-sha2-nistp256,ecdh-sha2-nistp384,ecdh-sha2-nistp521,diffie-hellman-group14-sha256,diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha256",
        "ecdh-sha2-nistp256,diffie-hellman-group14-sha256,diffie-hellman-group14-sha1",
        "diffie-hellman-group14-sha256,diffie-hellman-group14-sha1",
    ] {
        if session.method_pref(MethodType::Kex, kex).is_ok() {
            break;
        }
    }
    for hostkey in &[
        "ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,rsa-sha2-256,rsa-sha2-512,ssh-rsa",
        "ecdsa-sha2-nistp256,rsa-sha2-256,rsa-sha2-512,ssh-rsa",
        "ssh-rsa",
    ] {
        if session.method_pref(MethodType::HostKey, hostkey).is_ok() {
            break;
        }
    }
}

#[derive(Serialize, Clone)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
}

#[derive(Serialize, Clone)]
struct SftpProgress {
    transferred: u64,
    total: u64,
}

#[tauri::command]
pub async fn sftp_connect(
    sftp_sessions: State<'_, SftpSessionMap>,
    connection_id: String,
) -> Result<String, String> {
    let connection = load_connection(&connection_id)?;

    let addr = format!("{}:{}", connection.host, connection.port);
    let tcp = TcpStream::connect(&addr)
        .map_err(|e| format!("TCP connect failed: {e}"))?;

    let mut session = Session::new().map_err(|e| format!("SSH session error: {e}"))?;
    session.set_tcp_stream(tcp);
    session.set_timeout(30_000);
    configure_algorithms(&session);
    session.handshake().map_err(|e| format!("SSH handshake failed: {e}"))?;

    let username = &connection.username;

    match connection.auth_type.as_str() {
        "agent" => {
            session
                .userauth_agent(username)
                .map_err(|e| format!("Agent auth failed: {e}"))?;
        }
        "key" => {
            if connection.key_path.is_empty() {
                return Err("Key path is empty".to_string());
            }
            let key_path = Path::new(&connection.key_path);
            session
                .userauth_pubkey_file(username, None, key_path, None)
                .map_err(|e| format!("Key auth failed: {e}"))?;
        }
        "password" => {
            let password = crate::commands::sessions::get_saved_password_pub(&connection_id)
                .ok_or("No saved password found")?;
            session
                .userauth_password(username, &password)
                .map_err(|e| format!("Password auth failed: {e}"))?;
        }
        _ => {
            return Err(format!("Unknown auth type: {}", connection.auth_type));
        }
    }

    if !session.authenticated() {
        return Err("Authentication failed".to_string());
    }

    let session_id = Uuid::new_v4().to_string();
    sftp_sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), SftpConn { session });

    Ok(session_id)
}

#[tauri::command]
pub async fn sftp_list_dir(
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let map = sftp_sessions.lock().unwrap();
    let conn = map.get(&session_id).ok_or("SFTP session not found")?;

    let sftp = conn.session.sftp().map_err(|e| format!("SFTP subsystem error: {e}"))?;
    let dir_path = std::path::Path::new(&path);

    let entries = sftp
        .readdir(dir_path)
        .map_err(|e| format!("readdir error: {e}"))?;

    let mut result: Vec<SftpEntry> = entries
        .into_iter()
        .filter_map(|(pb, stat)| {
            let name = pb.file_name()?.to_string_lossy().to_string();
            if name == "." || name == ".." {
                return None;
            }
            let is_dir = stat.is_dir();
            let size = stat.size.unwrap_or(0);
            let modified = stat.mtime.unwrap_or(0) as i64;
            let entry_path = if path.ends_with('/') {
                format!("{}{}", path, name)
            } else {
                format!("{}/{}", path, name)
            };
            Some(SftpEntry { name, path: entry_path, is_dir, size, modified })
        })
        .collect();

    // Sort: directories first, then files, both alphabetically
    result.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

#[tauri::command]
pub async fn sftp_upload(
    app: tauri::AppHandle,
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let data = std::fs::read(&local_path)
        .map_err(|e| format!("Failed to read local file: {e}"))?;
    let total = data.len() as u64;

    let map = sftp_sessions.lock().unwrap();
    let conn = map.get(&session_id).ok_or("SFTP session not found")?;
    let sftp = conn.session.sftp().map_err(|e| format!("SFTP subsystem error: {e}"))?;
    let mut file = sftp
        .create(std::path::Path::new(&remote_path))
        .map_err(|e| format!("Failed to create remote file: {e}"))?;

    use std::io::Write;
    let chunk_size: usize = 32 * 1024;
    let mut written: u64 = 0;
    for chunk in data.chunks(chunk_size) {
        file.write_all(chunk).map_err(|e| format!("Failed to write remote file: {e}"))?;
        written += chunk.len() as u64;
        app.emit("sftp-upload-progress", SftpProgress { transferred: written, total }).ok();
    }

    Ok(())
}

#[tauri::command]
pub async fn sftp_mkdir(
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let map = sftp_sessions.lock().unwrap();
    let conn = map.get(&session_id).ok_or("SFTP session not found")?;

    let sftp = conn.session.sftp().map_err(|e| format!("SFTP subsystem error: {e}"))?;
    sftp.mkdir(std::path::Path::new(&path), 0o755)
        .map_err(|e| format!("mkdir error: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn sftp_delete(
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let map = sftp_sessions.lock().unwrap();
    let conn = map.get(&session_id).ok_or("SFTP session not found")?;

    let sftp = conn.session.sftp().map_err(|e| format!("SFTP subsystem error: {e}"))?;
    let p = std::path::Path::new(&path);

    if is_dir {
        sftp.rmdir(p).map_err(|e| format!("rmdir error: {e}"))?;
    } else {
        sftp.unlink(p).map_err(|e| format!("unlink error: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn sftp_download(
    app: tauri::AppHandle,
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    use std::io::Read;
    let map = sftp_sessions.lock().unwrap();
    let conn = map.get(&session_id).ok_or("SFTP session not found")?;
    let sftp = conn.session.sftp().map_err(|e| format!("SFTP subsystem error: {e}"))?;

    let stat = sftp.stat(std::path::Path::new(&remote_path))
        .map_err(|e| format!("Failed to stat remote file: {e}"))?;
    let total = stat.size.unwrap_or(0);

    let mut remote_file = sftp
        .open(std::path::Path::new(&remote_path))
        .map_err(|e| format!("Failed to open remote file: {e}"))?;

    let chunk_size: usize = 32 * 1024;
    let mut data = Vec::with_capacity(total as usize);
    let mut buf = vec![0u8; chunk_size];
    let mut transferred: u64 = 0;
    loop {
        let n = remote_file.read(&mut buf).map_err(|e| format!("Read error: {e}"))?;
        if n == 0 { break; }
        data.extend_from_slice(&buf[..n]);
        transferred += n as u64;
        app.emit("sftp-download-progress", SftpProgress { transferred, total }).ok();
    }

    std::fs::write(&local_path, &data)
        .map_err(|e| format!("Failed to write local file: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_rename(
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let map = sftp_sessions.lock().unwrap();
    let conn = map.get(&session_id).ok_or("SFTP session not found")?;
    let sftp = conn.session.sftp().map_err(|e| format!("SFTP subsystem error: {e}"))?;
    sftp.rename(
        std::path::Path::new(&old_path),
        std::path::Path::new(&new_path),
        None,
    )
    .map_err(|e| format!("rename error: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_create_file(
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let map = sftp_sessions.lock().unwrap();
    let conn = map.get(&session_id).ok_or("SFTP session not found")?;
    let sftp = conn.session.sftp().map_err(|e| format!("SFTP subsystem error: {e}"))?;
    sftp.create(std::path::Path::new(&path))
        .map_err(|e| format!("Failed to create file: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_disconnect(
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
) -> Result<(), String> {
    sftp_sessions.lock().unwrap().remove(&session_id);
    Ok(())
}
