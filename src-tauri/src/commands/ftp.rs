use serde::Serialize;
use std::io::Cursor;
use suppaftp::{FtpStream, types::FileType};
use tauri::{Emitter, State};
use uuid::Uuid;

use crate::{commands::sessions::load_connection, ftp::{FtpConn, FtpSessionMap}};

#[derive(Serialize, Clone)]
pub struct FtpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: String,
}

#[derive(Serialize, Clone)]
struct FtpProgress {
    transferred: u64,
    total: u64,
}

/// Parse a UNIX-style FTP LIST line into an FtpEntry.
/// e.g. "-rw-r--r-- 1 user grp 1234 Jan 01 12:00 file.txt"
/// or   "drwxr-xr-x 2 user grp 4096 Jan 01 2023 dirname"
fn parse_unix_list(line: &str, parent: &str) -> Option<FtpEntry> {
    if line.is_empty() || line.starts_with("total") {
        return None;
    }
    // Consume 8 whitespace-delimited fields, rest = name
    let mut rem = line;
    let mut fields = Vec::with_capacity(8);
    for _ in 0..8 {
        let s = rem.trim_start();
        if s.is_empty() {
            return None;
        }
        let end = s.find(char::is_whitespace).unwrap_or(s.len());
        fields.push(&s[..end]);
        rem = &s[end..];
    }
    let raw_name = rem.trim_start();
    if raw_name.is_empty() || raw_name == "." || raw_name == ".." {
        return None;
    }
    // Symlinks: "name -> target" — keep only the name part
    let name = raw_name.split(" -> ").next().unwrap_or(raw_name).to_string();
    let perms = fields[0];
    let is_dir = perms.starts_with('d');
    let size: u64 = fields[4].parse().unwrap_or(0);
    let modified = format!("{} {} {}", fields[5], fields[6], fields[7]);
    let path = if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", parent.trim_end_matches('/'))
    };
    Some(FtpEntry { name, path, is_dir, size, modified })
}

/// Parse a DOS/Windows-style FTP LIST line into an FtpEntry.
/// e.g. "01-01-21  12:00PM       <DIR>          dirname"
/// or   "01-01-21  12:00PM                 1234 file.txt"
fn parse_dos_list(line: &str, parent: &str) -> Option<FtpEntry> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 4 {
        return None;
    }
    let modified = format!("{} {}", parts[0], parts[1]);
    let (is_dir, size) = if parts[2] == "<DIR>" {
        (true, 0u64)
    } else {
        (false, parts[2].parse().unwrap_or(0))
    };
    let name = parts[3..].join(" ");
    if name == "." || name == ".." {
        return None;
    }
    let path = if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", parent.trim_end_matches('/'))
    };
    Some(FtpEntry { name, path, is_dir, size, modified })
}

fn parse_list_entry(line: &str, parent: &str) -> Option<FtpEntry> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    // Detect DOS format: first char is a digit (date like "01-01-21")
    if line.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        parse_dos_list(line, parent)
    } else {
        parse_unix_list(line, parent)
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn ftp_connect(
    ftp_sessions: State<'_, FtpSessionMap>,
    connection_id: String,
) -> Result<String, String> {
    let connection = load_connection(&connection_id)?;
    let addr = format!("{}:{}", connection.host, connection.port);

    let mut stream = FtpStream::connect(&addr)
        .map_err(|e| format!("FTP connect failed: {e}"))?;

    let password = crate::commands::sessions::get_saved_password_pub(&connection_id)
        .unwrap_or_default();
    stream
        .login(&connection.username, &password)
        .map_err(|e| format!("FTP login failed: {e}"))?;

    stream
        .transfer_type(FileType::Binary)
        .map_err(|e| format!("FTP binary mode failed: {e}"))?;

    let session_id = Uuid::new_v4().to_string();
    ftp_sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), FtpConn { stream });

    Ok(session_id)
}

#[tauri::command]
pub async fn ftp_list_dir(
    ftp_sessions: State<'_, FtpSessionMap>,
    session_id: String,
    path: String,
) -> Result<Vec<FtpEntry>, String> {
    let mut map = ftp_sessions.lock().unwrap();
    let conn = map.get_mut(&session_id).ok_or("FTP session not found")?;

    // Change to the requested directory first
    conn.stream.cwd(&path).map_err(|e| format!("CWD error: {e}"))?;

    let listing = conn.stream.list(None).map_err(|e| format!("LIST error: {e}"))?;

    let mut entries: Vec<FtpEntry> = listing
        .iter()
        .filter_map(|line| parse_list_entry(line, &path))
        .collect();

    // Sort: directories first, then alphabetically
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub async fn ftp_upload(
    app: tauri::AppHandle,
    ftp_sessions: State<'_, FtpSessionMap>,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let data = std::fs::read(&local_path)
        .map_err(|e| format!("Failed to read local file: {e}"))?;
    let total = data.len() as u64;

    app.emit("ftp-upload-progress", FtpProgress { transferred: 0, total }).ok();

    let mut map = ftp_sessions.lock().unwrap();
    let conn = map.get_mut(&session_id).ok_or("FTP session not found")?;

    conn.stream
        .put_file(&remote_path, &mut Cursor::new(data))
        .map_err(|e| format!("FTP upload failed: {e}"))?;

    app.emit("ftp-upload-progress", FtpProgress { transferred: total, total }).ok();
    Ok(())
}

#[tauri::command]
pub async fn ftp_download(
    app: tauri::AppHandle,
    ftp_sessions: State<'_, FtpSessionMap>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let mut map = ftp_sessions.lock().unwrap();
    let conn = map.get_mut(&session_id).ok_or("FTP session not found")?;

    // Try to get file size for progress
    let total = conn.stream.size(&remote_path).unwrap_or(0) as u64;
    app.emit("ftp-download-progress", FtpProgress { transferred: 0, total }).ok();

    let buf = conn.stream
        .retr_as_buffer(&remote_path)
        .map_err(|e| format!("FTP download failed: {e}"))?;

    let data = buf.into_inner();
    let transferred = data.len() as u64;

    std::fs::write(&local_path, &data)
        .map_err(|e| format!("Failed to write local file: {e}"))?;

    app.emit("ftp-download-progress", FtpProgress { transferred, total: transferred }).ok();
    Ok(())
}

#[tauri::command]
pub async fn ftp_mkdir(
    ftp_sessions: State<'_, FtpSessionMap>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let mut map = ftp_sessions.lock().unwrap();
    let conn = map.get_mut(&session_id).ok_or("FTP session not found")?;
    conn.stream.mkdir(&path).map_err(|e| format!("FTP mkdir failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn ftp_delete(
    ftp_sessions: State<'_, FtpSessionMap>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let mut map = ftp_sessions.lock().unwrap();
    let conn = map.get_mut(&session_id).ok_or("FTP session not found")?;
    if is_dir {
        conn.stream.rmdir(&path).map_err(|e| format!("FTP rmdir failed: {e}"))?;
    } else {
        conn.stream.rm(&path).map_err(|e| format!("FTP rm failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ftp_rename(
    ftp_sessions: State<'_, FtpSessionMap>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let mut map = ftp_sessions.lock().unwrap();
    let conn = map.get_mut(&session_id).ok_or("FTP session not found")?;
    conn.stream.rename(&old_path, &new_path).map_err(|e| format!("FTP rename failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn ftp_pwd(
    ftp_sessions: State<'_, FtpSessionMap>,
    session_id: String,
) -> Result<String, String> {
    let mut map = ftp_sessions.lock().unwrap();
    let conn = map.get_mut(&session_id).ok_or("FTP session not found")?;
    conn.stream.pwd().map_err(|e| format!("FTP pwd failed: {e}"))
}

#[tauri::command]
pub async fn ftp_disconnect(
    ftp_sessions: State<'_, FtpSessionMap>,
    session_id: String,
) -> Result<(), String> {
    let mut map = ftp_sessions.lock().unwrap();
    if let Some(mut conn) = map.remove(&session_id) {
        conn.stream.quit().ok();
    }
    Ok(())
}
