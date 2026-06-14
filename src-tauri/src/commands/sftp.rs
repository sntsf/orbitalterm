use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use tauri::{Emitter, State};
use uuid::Uuid;

use crate::{commands::sessions::load_connection, sftp::{SftpConn, SftpSessionMap, SshHandler}};

#[derive(Serialize, Clone)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
    pub mode: u32,
}

#[derive(Serialize, Clone)]
struct SftpProgress {
    transferred: u64,
    total: u64,
}

// Clone Arc from map and release lock before any await — avoids holding
// std::sync::Mutex across an await point.
macro_rules! get_conn {
    ($map:expr, $id:expr) => {{
        let map = $map.lock().unwrap();
        match map.get(&$id) {
            Some(c) => c.clone(),
            None => return Err("SFTP session not found".to_string()),
        }
    }};
}

#[tauri::command]
pub async fn sftp_connect(
    sftp_sessions: State<'_, SftpSessionMap>,
    connection_id: String,
) -> Result<String, String> {
    let connection = load_connection(&connection_id)?;

    let config = Arc::new(russh::client::Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    });

    let addr = (connection.host.as_str(), connection.port as u16);
    let mut sh = russh::client::connect(config, addr, SshHandler::default())
        .await
        .map_err(|e| format!("SSH connect failed: {e}"))?;

    let username = connection.username.clone();

    match connection.auth_type.as_str() {
        "password" => {
            let password = crate::commands::sessions::get_saved_password_pub(&connection_id)
                .ok_or("No saved password found")?;
            let ok = sh
                .authenticate_password(&username, password)
                .await
                .map_err(|e| format!("Password auth failed: {e}"))?;
            if !ok {
                return Err("Password authentication rejected by server".to_string());
            }
        }
        "key" => {
            if connection.key_path.is_empty() {
                return Err("Key path is empty".to_string());
            }
            let key = russh_keys::load_secret_key(Path::new(&connection.key_path), None)
                .map_err(|e| format!("Failed to load private key: {e}"))?;
            let ok = sh
                .authenticate_publickey(&username, Arc::new(key))
                .await
                .map_err(|e| format!("Key auth failed: {e}"))?;
            if !ok {
                return Err("Key authentication rejected by server".to_string());
            }
        }
        "agent" => {
            // authenticate_future returns (AgentClient, Result<bool>) — the agent is
            // moved in and returned so we can try multiple identities in a loop.
            let mut agent = russh_keys::agent::client::AgentClient::connect_env()
                .await
                .map_err(|e| format!("SSH agent not available (SSH_AUTH_SOCK): {e}"))?;
            let identities = agent
                .request_identities()
                .await
                .map_err(|e| format!("Agent identities request failed: {e}"))?;
            if identities.is_empty() {
                return Err("SSH agent has no loaded identities".to_string());
            }
            let mut authenticated = false;
            for key in identities {
                let (returned_agent, result) = sh
                    .authenticate_future(&username, key, agent)
                    .await;
                agent = returned_agent;
                match result {
                    Ok(true) => { authenticated = true; break; }
                    Ok(false) => {}
                    Err(e) => return Err(format!("Agent auth attempt failed: {e}")),
                }
            }
            if !authenticated {
                return Err("SSH agent authentication rejected by server".to_string());
            }
        }
        other => return Err(format!("Unknown auth type: {other}")),
    }

    let channel = sh
        .channel_open_session()
        .await
        .map_err(|e| format!("Channel open failed: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("SFTP subsystem request failed: {e}"))?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("SFTP session init failed: {e}"))?;

    let session_id = Uuid::new_v4().to_string();
    sftp_sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), Arc::new(SftpConn { sftp, _session: Arc::new(sh) }));

    Ok(session_id)
}

/// Open an SFTP session that REUSES an existing interactive SSH session's
/// connection — so the file browser and terminal share one authenticated
/// session (MobaXterm-style). No separate connect/auth, and it works even when
/// the password was only entered at connect time and never saved.
#[tauri::command]
pub async fn sftp_connect_from_ssh(
    ssh_sessions: State<'_, crate::ssh::SshSessionMap>,
    sftp_sessions: State<'_, SftpSessionMap>,
    ssh_session_id: String,
) -> Result<String, String> {
    let handle = {
        let map = ssh_sessions.lock().unwrap();
        let s = map.get(&ssh_session_id).ok_or("SSH session not found")?;
        Arc::clone(&s.handle)
    };

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Channel open failed: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("SFTP subsystem request failed: {e}"))?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("SFTP session init failed: {e}"))?;

    let session_id = Uuid::new_v4().to_string();
    sftp_sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), Arc::new(SftpConn { sftp, _session: handle }));

    Ok(session_id)
}

#[tauri::command]
pub async fn sftp_list_dir(
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let conn = get_conn!(sftp_sessions, session_id);

    // read_dir returns ReadDir which is a sync Iterator (already filters "." / "..")
    let read_dir = conn
        .sftp
        .read_dir(&path)
        .await
        .map_err(|e| format!("readdir error: {e}"))?;

    let mut result: Vec<SftpEntry> = read_dir
        .map(|entry| {
            let name = entry.file_name();
            let meta = entry.metadata();
            let is_dir = meta.is_dir();
            let size = meta.size.unwrap_or(0);
            let modified = meta.mtime.map(|t| t as i64).unwrap_or(0);
            let mode = meta.permissions.unwrap_or(0) & 0o7777;
            let entry_path = if path.ends_with('/') {
                format!("{}{}", path, name)
            } else {
                format!("{}/{}", path, name)
            };
            SftpEntry { name, path: entry_path, is_dir, size, modified, mode }
        })
        .collect();

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

    let conn = get_conn!(sftp_sessions, session_id);

    let mut file = conn
        .sftp
        .create(&remote_path)
        .await
        .map_err(|e| format!("Failed to create remote file: {e}"))?;

    use tokio::io::AsyncWriteExt;
    let chunk_size = 32 * 1024usize;
    let mut written = 0u64;
    for chunk in data.chunks(chunk_size) {
        file.write_all(chunk)
            .await
            .map_err(|e| format!("Write error: {e}"))?;
        written += chunk.len() as u64;
        app.emit("sftp-upload-progress", SftpProgress { transferred: written, total }).ok();
    }
    file.flush().await.map_err(|e| format!("Flush error: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn sftp_mkdir(
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let conn = get_conn!(sftp_sessions, session_id);
    conn.sftp
        .create_dir(&path)
        .await
        .map_err(|e| format!("mkdir error: {e}"))
}

#[tauri::command]
pub async fn sftp_delete(
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let conn = get_conn!(sftp_sessions, session_id);
    if is_dir {
        conn.sftp
            .remove_dir(&path)
            .await
            .map_err(|e| format!("rmdir error: {e}"))
    } else {
        conn.sftp
            .remove_file(&path)
            .await
            .map_err(|e| format!("unlink error: {e}"))
    }
}

#[tauri::command]
pub async fn sftp_download(
    app: tauri::AppHandle,
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let conn = get_conn!(sftp_sessions, session_id);

    let stat = conn
        .sftp
        .metadata(&remote_path)
        .await
        .map_err(|e| format!("Failed to stat remote file: {e}"))?;
    let total = stat.size.unwrap_or(0);

    let mut remote_file = conn
        .sftp
        .open(&remote_path)
        .await
        .map_err(|e| format!("Failed to open remote file: {e}"))?;

    use tokio::io::AsyncReadExt;
    let chunk_size = 32 * 1024usize;
    let mut data = Vec::with_capacity(total as usize);
    let mut buf = vec![0u8; chunk_size];
    let mut transferred = 0u64;
    loop {
        let n = remote_file
            .read(&mut buf)
            .await
            .map_err(|e| format!("Read error: {e}"))?;
        if n == 0 {
            break;
        }
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
    let conn = get_conn!(sftp_sessions, session_id);
    conn.sftp
        .rename(&old_path, &new_path)
        .await
        .map_err(|e| format!("rename error: {e}"))
}

#[tauri::command]
pub async fn sftp_chmod(
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let conn = get_conn!(sftp_sessions, session_id);
    let attrs = russh_sftp::protocol::FileAttributes {
        permissions: Some(mode & 0o7777),
        ..Default::default()
    };
    conn.sftp
        .set_metadata(path, attrs)
        .await
        .map_err(|e| format!("chmod error: {e}"))
}

#[tauri::command]
pub async fn sftp_create_file(
    sftp_sessions: State<'_, SftpSessionMap>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let conn = get_conn!(sftp_sessions, session_id);
    conn.sftp
        .create(&path)
        .await
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
