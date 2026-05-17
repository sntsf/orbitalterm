use serde::Serialize;
use ssh2::Session;
use std::net::TcpStream;
use std::path::Path;
use tauri::State;
use uuid::Uuid;

use crate::{commands::sessions::load_connection, sftp::{SftpConn, SftpSessionMap}};

#[derive(Serialize, Clone)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
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
            // Load from keyring
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
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let data = std::fs::read(&local_path)
        .map_err(|e| format!("Failed to read local file: {e}"))?;

    let map = sftp_sessions.lock().unwrap();
    let conn = map.get(&session_id).ok_or("SFTP session not found")?;

    let sftp = conn.session.sftp().map_err(|e| format!("SFTP subsystem error: {e}"))?;

    let remote = std::path::Path::new(&remote_path);
    let mut file = sftp
        .create(remote)
        .map_err(|e| format!("Failed to create remote file: {e}"))?;

    use std::io::Write;
    file.write_all(&data).map_err(|e| format!("Failed to write remote file: {e}"))?;

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
pub async fn sftp_disconnect(
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
) -> Result<(), String> {
    sftp_sessions.lock().unwrap().remove(&session_id);
    Ok(())
}
