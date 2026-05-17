use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use rusqlite::params;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::{
    commands::connections::Connection,
    db,
    rdp::RdpSessionMap,
    ssh::{SshSession, SshSessionMap},
};

// ── DB helper ────────────────────────────────────────────────────────────────

pub fn load_connection(id: &str) -> Result<Connection, String> {
    let db = db::open().map_err(|e| e.to_string())?;
    db.query_row(
        "SELECT id, name, type, host, port, username, auth_type, key_path,
                folder_id, notes, description, domain, created_at, updated_at
         FROM connections WHERE id=?1",
        params![id],
        |row| {
            Ok(Connection {
                id: row.get(0)?,
                name: row.get(1)?,
                conn_type: row.get(2)?,
                host: row.get(3)?,
                port: row.get(4)?,
                username: row.get(5)?,
                auth_type: row.get(6)?,
                key_path: row.get(7)?,
                folder_id: row.get(8)?,
                notes: row.get(9)?,
                description: row.get(10)?,
                domain: row.get(11)?,
                created_at: row.get(12)?,
                updated_at: row.get(13)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

// ── Keyring helpers ──────────────────────────────────────────────────────────

fn kr_entry(connection_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("orbitalterm", connection_id).map_err(|e| e.to_string())
}

fn get_saved_password(connection_id: &str) -> Option<String> {
    kr_entry(connection_id).ok()?.get_password().ok()
}

pub fn get_saved_password_pub(connection_id: &str) -> Option<String> {
    get_saved_password(connection_id)
}

#[tauri::command]
pub async fn save_password(connection_id: String, password: String) -> Result<(), String> {
    kr_entry(&connection_id)?.set_password(&password).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_password(connection_id: String) -> Result<(), String> {
    kr_entry(&connection_id)?
        .delete_credential()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn has_password(connection_id: String) -> Result<bool, String> {
    match kr_entry(&connection_id)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

// ── SSH ──────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn connect_ssh(
    app: AppHandle,
    sessions: State<'_, SshSessionMap>,
    connection_id: String,
) -> Result<String, String> {
    let connection = load_connection(&connection_id)?;
    let saved_password = get_saved_password(&connection_id);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    // Build ssh command — CommandBuilder::arg returns () so no chaining
    let mut cmd = CommandBuilder::new("ssh");
    cmd.arg("-o");
    cmd.arg("StrictHostKeyChecking=accept-new");
    cmd.arg("-o");
    cmd.arg("ServerAliveInterval=30");
    cmd.arg("-o");
    cmd.arg("ConnectTimeout=10");
    cmd.arg("-p");
    cmd.arg(connection.port.to_string());

    if connection.auth_type == "key" && !connection.key_path.is_empty() {
        cmd.arg("-i");
        cmd.arg(&connection.key_path);
        cmd.arg("-o");
        cmd.arg("IdentitiesOnly=yes");
    }

    cmd.arg(format!("{}@{}", connection.username, connection.host));

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    let raw_writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(raw_writer));
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let session_id = Uuid::new_v4().to_string();
    let sid = session_id.clone();
    let app_handle = app.clone();
    let writer_ref = Arc::clone(&writer);

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut password_injected = false;

        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();

                    if !password_injected {
                        if let Some(ref pass) = saved_password {
                            let lower = data.to_lowercase();
                            if lower.contains("password:") || lower.contains("password for") {
                                if let Ok(mut w) = writer_ref.lock() {
                                    let _ = writeln!(w, "{}", pass);
                                    password_injected = true;
                                }
                            }
                        }
                    }

                    app_handle.emit(&format!("ssh-data-{sid}"), &data).ok();
                }
            }
        }
        app_handle.emit(&format!("ssh-closed-{sid}"), ()).ok();
    });

    sessions.lock().unwrap().insert(
        session_id.clone(),
        SshSession { writer, master: pair.master },
    );

    Ok(session_id)
}

#[tauri::command]
pub async fn send_input(
    sessions: State<'_, SshSessionMap>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let map = sessions.lock().unwrap();
    let session = map.get(&session_id).ok_or("Session not found")?;
    let result = session
        .writer
        .lock()
        .unwrap()
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string());
    result
}

#[tauri::command]
pub async fn resize_pty(
    sessions: State<'_, SshSessionMap>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = sessions.lock().unwrap();
    let session = map.get(&session_id).ok_or("Session not found")?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disconnect_ssh(
    sessions: State<'_, SshSessionMap>,
    session_id: String,
) -> Result<(), String> {
    sessions.lock().unwrap().remove(&session_id);
    Ok(())
}

// ── RDP ──────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn connect_rdp(
    rdp_sessions: State<'_, RdpSessionMap>,
    connection_id: String,
) -> Result<String, String> {
    let connection = load_connection(&connection_id)?;
    let password = get_saved_password(&connection_id);

    let rdp_client = crate::rdp::find_rdp_client()?;
    let mut cmd = std::process::Command::new(&rdp_client.binary);
    build_rdp_args(&mut cmd, &connection, password.as_deref(), rdp_client.is_wayland);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch {}: {e}", rdp_client.binary))?;

    let session_id = Uuid::new_v4().to_string();
    rdp_sessions.lock().unwrap().insert(session_id.clone(), child);
    Ok(session_id)
}

#[tauri::command]
pub async fn rdp_status(
    rdp_sessions: State<'_, RdpSessionMap>,
    session_id: String,
) -> Result<String, String> {
    let mut map = rdp_sessions.lock().unwrap();
    match map.get_mut(&session_id) {
        None => Ok("disconnected".into()),
        Some(child) => match child.try_wait() {
            Ok(Some(_)) => Ok("disconnected".into()),
            Ok(None) => Ok("connected".into()),
            Err(e) => Err(e.to_string()),
        },
    }
}

#[tauri::command]
pub async fn disconnect_rdp(
    rdp_sessions: State<'_, RdpSessionMap>,
    session_id: String,
) -> Result<(), String> {
    if let Some(mut child) = rdp_sessions.lock().unwrap().remove(&session_id) {
        child.kill().ok();
    }
    Ok(())
}

fn build_rdp_args(
    cmd: &mut std::process::Command,
    conn: &Connection,
    password: Option<&str>,
    #[allow(unused_variables)] is_wayland: bool,
) {
    #[cfg(target_os = "linux")]
    {
        cmd.arg(format!("/v:{}:{}", conn.host, conn.port));
        cmd.arg(format!("/u:{}", conn.username));
        if !conn.domain.is_empty() {
            cmd.arg(format!("/d:{}", conn.domain));
        }
        if let Some(p) = password {
            cmd.arg(format!("/p:{p}"));
        }
        cmd.arg("/dynamic-resolution");
        cmd.arg("/cert:ignore");
        cmd.arg("/clipboard");
    }
    #[cfg(target_os = "windows")]
    {
        cmd.arg(format!("/v:{}:{}", conn.host, conn.port));
        cmd.arg(format!("/u:{}", conn.username));
        if !conn.domain.is_empty() {
            cmd.arg(format!("/d:{}", conn.domain));
        }
        if let Some(p) = password {
            let _ = std::process::Command::new("cmdkey")
                .args([
                    &format!("/add:{}", conn.host),
                    &format!("/user:{}", conn.username),
                    &format!("/pass:{p}"),
                ])
                .status();
        }
        cmd.arg("/clipboard");
    }
    #[cfg(target_os = "macos")]
    {
        cmd.arg(format!("/v:{}:{}", conn.host, conn.port));
        cmd.arg(format!("/u:{}", conn.username));
        if !conn.domain.is_empty() {
            cmd.arg(format!("/d:{}", conn.domain));
        }
        if let Some(p) = password {
            cmd.arg(format!("/p:{p}"));
        }
        cmd.arg("/clipboard");
    }
}
