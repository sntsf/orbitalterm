use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use rusqlite::params;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
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
                folder_id, notes, description, domain, rdp_admin, created_at, updated_at,
                sort_order, group_id, icon, url, custom_hosts
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
                rdp_admin: row.get::<_, i64>(12).unwrap_or(0) != 0,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
                sort_order: row.get(15).unwrap_or(0),
                group_id: row.get::<_, String>(16).unwrap_or_default(),
                icon: row.get::<_, String>(17).unwrap_or_default(),
                url: row.get::<_, String>(18).unwrap_or_default(),
                custom_hosts: row.get::<_, String>(19).unwrap_or_default(),
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
pub async fn copy_password(from_id: String, to_id: String) -> Result<(), String> {
    let db = db::open().map_err(|e| e.to_string())?;
    let maybe_pw: Option<String> = db.query_row(
        "SELECT password FROM passwords WHERE connection_id = ?1",
        params![from_id],
        |row| row.get(0),
    ).ok();
    if let Some(pw) = maybe_pw {
        db.execute(
            "INSERT OR REPLACE INTO passwords (connection_id, password) VALUES (?1, ?2)",
            params![to_id, pw],
        ).map_err(|e| e.to_string())?;
    }
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
    pub native_window: bool, // true = Windows mstsc reparented (no canvas frames)
    pub width: u16,
    pub height: u16,
}

#[tauri::command]
pub async fn connect_rdp(
    app: AppHandle,
    window: tauri::WebviewWindow,
    #[allow(unused_variables)] rdp_sessions: State<'_, RdpSessionMap>,
    embedded_sessions: State<'_, EmbeddedRdpSessionMap>,
    connection_id: String,
    width: Option<u16>,
    height: Option<u16>,
    admin_mode: Option<bool>,
    // Canvas position relative to Tauri window (needed for Windows embedded mode)
    canvas_x: Option<i32>,
    canvas_y: Option<i32>,
) -> Result<RdpConnectResult, String> {
    let connection = load_connection(&connection_id)?;
    let password = get_saved_password(&connection_id);

    #[cfg(target_os = "linux")]
    {
        let w = width.unwrap_or(1280).max(640);
        let h = height.unwrap_or(800).max(480);
        let session_id = Uuid::new_v4().to_string();
        let session = crate::rdp::freerdp::launch(
            app,
            &session_id,
            &connection.host,
            connection.port,
            &connection.username,
            &connection.domain,
            password.as_deref(),
            w,
            h,
            connection.rdp_admin || admin_mode.unwrap_or(false),
        )?;
        let width = session.width;
        let height = session.height;
        embedded_sessions.lock().unwrap().insert(session_id.clone(), session);
        let _ = window;
        return Ok(RdpConnectResult { session_id, embedded: true, native_window: false, width, height });
    }

    #[cfg(target_os = "windows")]
    {
        let w = width.unwrap_or(1280) as i32;
        let h = height.unwrap_or(800) as i32;
        let x = canvas_x.unwrap_or(0);
        let y = canvas_y.unwrap_or(0);

        // Use the window that issued the IPC call — could be "main" or a
        // detached window. Hardcoding "main" would place the WS_POPUP over
        // the wrong window when RDP is opened in a torn-out window.
        let parent_hwnd = window.hwnd().map_err(|e| e.to_string())?;

        let session = crate::rdp::windows_rdp::launch(
            parent_hwnd,
            &connection.host,
            connection.port as u16,
            &connection.username,
            &connection.domain,
            password.as_deref(),
            x,
            y,
            w,
            h,
            connection.rdp_admin || admin_mode.unwrap_or(false),
        )?;

        let session_id = Uuid::new_v4().to_string();
        embedded_sessions.lock().unwrap().insert(session_id.clone(), session);
        let _ = (rdp_sessions, app, window);
        return Ok(RdpConnectResult { session_id, embedded: true, native_window: true, width: w as u16, height: h as u16 });
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (app, window, embedded_sessions, canvas_x, canvas_y);
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
                if !snippet.is_empty() { format!("\nDetalle:\n{}", snippet) } else { String::new() }
            ));
        }
        drop(child.stderr.take());
        let session_id = Uuid::new_v4().to_string();
        rdp_sessions.lock().unwrap().insert(session_id.clone(), child);
        Ok(RdpConnectResult { session_id, embedded: false, native_window: false, width: 0, height: 0 })
    }
}

#[tauri::command]
pub async fn rdp_mouse_input(
    #[allow(unused_variables)]
    sessions: State<'_, EmbeddedRdpSessionMap>,
    #[allow(unused_variables)]
    session_id: String,
    #[allow(unused_variables)]
    flags: u16,
    #[allow(unused_variables)]
    x: u16,
    #[allow(unused_variables)]
    y: u16,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let map = sessions.lock().unwrap();
        if let Some(session) = map.get(&session_id) {
            session.send_mouse(flags, x, y);
        }
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
    code: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let map = sessions.lock().unwrap();
        if let Some(session) = map.get(&session_id) {
            session.send_key(pressed, &code);
        }
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
        return Ok(read_linux_clipboard().unwrap_or_default());
    }
    #[allow(unreachable_code)]
    Ok(String::new())
}

/// Push text to the RDP remote clipboard via the cliprdr virtual channel.
#[tauri::command]
pub async fn rdp_set_clipboard(
    #[allow(unused_variables)] embedded_sessions: State<'_, EmbeddedRdpSessionMap>,
    #[allow(unused_variables)] session_id: String,
    #[allow(unused_variables)] text: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let map = embedded_sessions.lock().unwrap();
        if let Some(session) = map.get(&session_id) {
            session.set_clipboard(&text);
        }
    }
    Ok(())
}

/// Read the user's real Linux clipboard (Wayland-native, falls back to X11).
#[cfg(target_os = "linux")]
fn read_linux_clipboard() -> Option<String> {
    let out = std::process::Command::new("wl-paste")
        .args(["--no-newline", "--type", "text/plain"])
        .stderr(std::process::Stdio::null())
        .output();
    if let Ok(o) = out {
        if o.status.success() {
            if let Ok(s) = String::from_utf8(o.stdout) {
                if !s.is_empty() { return Some(s); }
            }
        }
    }
    let display = std::env::var("DISPLAY").unwrap_or_default();
    if display.is_empty() { return None; }
    let out = std::process::Command::new("xclip")
        .args(["-display", &display, "-selection", "clipboard", "-o"])
        .stderr(std::process::Stdio::null())
        .output().ok()?;
    if out.status.success() { String::from_utf8(out.stdout).ok() } else { None }
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
            session.resize(width, height);
        }
    }
    let _ = (embedded_sessions, session_id, width, height);
    Ok(())
}

/// Move/resize the embedded mstsc window on Windows when the canvas area changes.
#[tauri::command]
pub async fn rdp_windows_reposition(
    embedded_sessions: State<'_, EmbeddedRdpSessionMap>,
    session_id: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let map = embedded_sessions.lock().unwrap();
        if let Some(session) = map.get(&session_id) {
            crate::rdp::windows_rdp::reposition(session, x, y, width, height);
        }
    }
    let _ = (embedded_sessions, session_id, x, y, width, height);
    Ok(())
}

/// Show or hide the embedded mstsc window (used when switching tabs on Windows).
#[tauri::command]
pub async fn rdp_windows_visibility(
    embedded_sessions: State<'_, EmbeddedRdpSessionMap>,
    session_id: String,
    visible: bool,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let map = embedded_sessions.lock().unwrap();
        if let Some(session) = map.get(&session_id) {
            if visible {
                crate::rdp::windows_rdp::show(session);
            } else {
                crate::rdp::windows_rdp::hide(session);
            }
        }
    }
    let _ = (embedded_sessions, session_id, visible);
    Ok(())
}

#[tauri::command]
pub async fn rdp_refresh_session(
    embedded_sessions: State<'_, EmbeddedRdpSessionMap>,
    session_id: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let map = embedded_sessions.lock().unwrap();
        if let Some(session) = map.get(&session_id) {
            session.refresh();
        }
    }
    let _ = (embedded_sessions, session_id);
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

    if *flavor == RdpFlavor::Mstsc {
        // Store credentials in Windows Credential Manager so mstsc picks them up
        if let Some(p) = password {
            let _ = std::process::Command::new("cmdkey")
                .args([
                    &format!("/add:{}", conn.host),
                    &format!("/user:{}", conn.username),
                    &format!("/pass:{p}"),
                ])
                .status();
        }
        cmd.arg(format!("/v:{}:{}", conn.host, conn.port));
        if conn.rdp_admin {
            cmd.arg("/admin");
        }
        return;
    }

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
