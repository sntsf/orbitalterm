use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use rusqlite::params;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use serde::Serialize;

use crate::{
    commands::connections::Connection,
    db,
    rdp::{EmbeddedRdpSessionMap, RdpSessionMap},
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

// ── Password storage (SQLite) ─────────────────────────────────────────────────

fn get_saved_password(connection_id: &str) -> Option<String> {
    let db = db::open().ok()?;
    db.query_row(
        "SELECT password FROM passwords WHERE connection_id = ?1",
        params![connection_id],
        |row| row.get(0),
    ).ok()
}

pub fn get_saved_password_pub(connection_id: &str) -> Option<String> {
    get_saved_password(connection_id)
}

#[tauri::command]
pub async fn save_password(connection_id: String, password: String) -> Result<(), String> {
    let db = db::open().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO passwords (connection_id, password) VALUES (?1, ?2)",
        params![connection_id, password],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_password(connection_id: String) -> Result<(), String> {
    let db = db::open().map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM passwords WHERE connection_id = ?1",
        params![connection_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn has_password(connection_id: String) -> Result<bool, String> {
    let db = db::open().map_err(|e| e.to_string())?;
    let count: i64 = db.query_row(
        "SELECT COUNT(*) FROM passwords WHERE connection_id = ?1",
        params![connection_id],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    Ok(count > 0)
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
                            if lower.contains("password:") || lower.contains("password for")
                                || lower.contains("passphrase for")
                            {
                                if let Ok(mut w) = writer_ref.lock() {
                                    // PTY raw mode: Enter key is \r, not \n
                                    let _ = write!(w, "{}\r", pass);
                                    let _ = w.flush();
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

#[derive(Serialize)]
pub struct RdpConnectResult {
    pub session_id: String,
    pub embedded: bool,
    pub width: u16,
    pub height: u16,
}

#[tauri::command]
pub async fn connect_rdp(
    app: AppHandle,
    #[allow(unused_variables)] rdp_sessions: State<'_, RdpSessionMap>,
    embedded_sessions: State<'_, EmbeddedRdpSessionMap>,
    connection_id: String,
    width: Option<u16>,
    height: Option<u16>,
    admin_mode: Option<bool>,
) -> Result<RdpConnectResult, String> {
    let connection = load_connection(&connection_id)?;
    let password = get_saved_password(&connection_id);

    #[cfg(target_os = "linux")]
    {
        let w = width.unwrap_or(1280).max(640);
        let h = height.unwrap_or(800).max(480);
        let session_id = Uuid::new_v4().to_string();
        let session = crate::rdp::embedded::launch(
            app,
            &session_id,
            &connection.host,
            connection.port,
            &connection.username,
            &connection.domain,
            password.as_deref(),
            w,
            h,
            admin_mode.unwrap_or(false),
        )?;
        let width = session.width;
        let height = session.height;
        embedded_sessions.lock().unwrap().insert(session_id.clone(), session);
        return Ok(RdpConnectResult { session_id, embedded: true, width, height });
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, embedded_sessions);
        let rdp_client = crate::rdp::find_rdp_client()?;
        let mut cmd = std::process::Command::new(&rdp_client.binary);
        build_rdp_args(&mut cmd, &connection, password.as_deref(), &rdp_client.flavor);
        cmd.stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to launch {}: {e}", rdp_client.binary))?;

        std::thread::sleep(std::time::Duration::from_millis(600));
        if let Ok(Some(exit)) = child.try_wait() {
            let stderr = child
                .stderr
                .take()
                .map(|mut s| {
                    let mut buf = String::new();
                    let _ = std::io::Read::read_to_string(&mut s, &mut buf);
                    buf
                })
                .unwrap_or_default();

            let snippet = stderr
                .lines()
                .filter(|l| !l.trim().is_empty())
                .take(4)
                .collect::<Vec<_>>()
                .join("\n");

            return Err(format!(
                "El cliente RDP cerró inmediatamente (código {}).\n\
                Verificá:\n\
                • RDP esté habilitado en la máquina remota\n\
                • Las credenciales sean correctas\n\
                • El firewall permita el puerto {}\n\
                {}",
                exit.code().unwrap_or(-1),
                connection.port,
                if !snippet.is_empty() {
                    format!("\nDetalle:\n{}", snippet)
                } else {
                    String::new()
                }
            ));
        }

        drop(child.stderr.take());

        let session_id = Uuid::new_v4().to_string();
        rdp_sessions.lock().unwrap().insert(session_id.clone(), child);
        Ok(RdpConnectResult { session_id, embedded: false, width: 0, height: 0 })
    }
}

#[tauri::command]
pub async fn rdp_mouse_input(
    #[allow(unused_variables)]
    sessions: State<'_, EmbeddedRdpSessionMap>,
    #[allow(unused_variables)]
    session_id: String,
    #[allow(unused_variables)]
    event_type: u8,
    #[allow(unused_variables)]
    button: u8,
    #[allow(unused_variables)]
    x: i16,
    #[allow(unused_variables)]
    y: i16,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let display = {
            let map = sessions.lock().unwrap();
            map.get(&session_id)
                .map(|s| s.display.clone())
                .ok_or_else(|| "Session not found".to_string())?
        };
        crate::rdp::embedded::mouse_event(&display, event_type, button, x, y)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn rdp_key_input(
    #[allow(unused_variables)]
    sessions: State<'_, EmbeddedRdpSessionMap>,
    #[allow(unused_variables)]
    session_id: String,
    #[allow(unused_variables)]
    pressed: bool,
    #[allow(unused_variables)]
    key: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let display = {
            let map = sessions.lock().unwrap();
            map.get(&session_id)
                .map(|s| s.display.clone())
                .ok_or_else(|| "Session not found".to_string())?
        };
        crate::rdp::embedded::key_event(&display, pressed, &key)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn rdp_status(
    rdp_sessions: State<'_, RdpSessionMap>,
    embedded_sessions: State<'_, EmbeddedRdpSessionMap>,
    session_id: String,
) -> Result<String, String> {
    if embedded_sessions.lock().unwrap().contains_key(&session_id) {
        return Ok("connected".into());
    }
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
    embedded_sessions: State<'_, EmbeddedRdpSessionMap>,
    session_id: String,
) -> Result<(), String> {
    embedded_sessions.lock().unwrap().remove(&session_id);
    if let Some(mut child) = rdp_sessions.lock().unwrap().remove(&session_id) {
        child.kill().ok();
    }
    Ok(())
}

/// Read the user's real Linux clipboard (called from the canvas Ctrl+V handler).
#[tauri::command]
pub async fn rdp_get_linux_clipboard() -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        return Ok(crate::rdp::embedded::read_linux_clipboard().unwrap_or_default());
    }
    #[allow(unreachable_code)]
    Ok(String::new())
}

/// Write text to the Xvfb clipboard so xfreerdp3's cliprdr can serve it to Windows.
#[tauri::command]
pub async fn rdp_set_clipboard(
    #[allow(unused_variables)] embedded_sessions: State<'_, EmbeddedRdpSessionMap>,
    #[allow(unused_variables)] session_id: String,
    #[allow(unused_variables)] text: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let display = embedded_sessions.lock().unwrap()
            .get(&session_id)
            .map(|s| s.display.clone());
        if let Some(display) = display {
            crate::rdp::embedded::set_clipboard(&display, &text)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn rdp_resize_session(
    embedded_sessions: State<'_, EmbeddedRdpSessionMap>,
    session_id: String,
    width: u16,
    height: u16,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let map = embedded_sessions.lock().unwrap();
        if let Some(session) = map.get(&session_id) {
            crate::rdp::embedded::resize(&session.display, &session.dims, width, height)?;
        }
    }
    let _ = (embedded_sessions, session_id, width, height);
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn build_rdp_args(
    cmd: &mut std::process::Command,
    conn: &Connection,
    password: Option<&str>,
    flavor: &crate::rdp::RdpFlavor,
) {
    use crate::rdp::RdpFlavor;

    if *flavor == RdpFlavor::Remmina {
        // Remmina accepts a URI: rdp://[user[:pass]@]host[:port]
        let authority = match password {
            Some(p) => format!(
                "{}:{}@{}:{}",
                urlenccode(&conn.username),
                urlenccode(p),
                conn.host,
                conn.port
            ),
            None => format!("{}@{}:{}", urlenccode(&conn.username), conn.host, conn.port),
        };
        cmd.arg("-c").arg(format!("rdp://{authority}"));
        return;
    }

    // FreeRDP (/v: style) — works on Linux, Windows, macOS
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

    #[cfg(target_os = "windows")]
    if password.is_some() {
        // Store credentials in Windows Credential Manager so mstsc picks them up
        let _ = std::process::Command::new("cmdkey")
            .args([
                &format!("/add:{}", conn.host),
                &format!("/user:{}", conn.username),
                &format!("/pass:{}", password.unwrap_or("")),
            ])
            .status();
    }
}

#[cfg(not(target_os = "linux"))]
fn urlenccode(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => {
                vec![c]
            }
            other => {
                let mut buf = [0u8; 4];
                let bytes = other.encode_utf8(&mut buf);
                bytes.bytes().flat_map(|b| {
                    let hi = "0123456789ABCDEF".chars().nth((b >> 4) as usize).unwrap();
                    let lo = "0123456789ABCDEF".chars().nth((b & 0xf) as usize).unwrap();
                    vec!['%', hi, lo]
                }).collect()
            }
        })
        .collect()
}
