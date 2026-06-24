use russh::ChannelMsg;
use tokio::sync::mpsc;
use rusqlite::params;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use serde::Serialize;

use crate::{
    commands::connections::Connection,
    db,
    rdp::{EmbeddedRdpSessionMap, RdpSessionMap},
    ssh::{SshCmd, SshSession, SshSessionMap},
    sftp::SshHandler,
};

// ── DB helper ────────────────────────────────────────────────────────────────

pub fn load_connection(id: &str) -> Result<Connection, String> {
    let db = db::open().map_err(|e| e.to_string())?;
    db.query_row(
        "SELECT id, name, type, host, port, username, auth_type, key_path,
                folder_id, notes, description, domain, rdp_admin, created_at, updated_at,
                sort_order, group_id, icon, url, custom_hosts, rdp_security, rdp_color_depth, tunnels,
                rdp_redirect_drives, rdp_gateway, proxy_jump, rdp_drive_path
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
                rdp_security: row.get::<_, String>(20).unwrap_or_else(|_| "negotiate".to_string()),
                rdp_color_depth: row.get::<_, i64>(21).unwrap_or(32),
                tunnels: row.get::<_, String>(22).unwrap_or_default(),
                rdp_redirect_drives: row.get::<_, i64>(23).unwrap_or(0) != 0,
                rdp_gateway: row.get::<_, String>(24).unwrap_or_default(),
                proxy_jump: row.get::<_, String>(25).unwrap_or_default(),
                rdp_drive_path: row.get::<_, String>(26).unwrap_or_default(),
            })
        },
    )
    .map_err(|e| e.to_string())
}

// ── Password storage (SQLite) ─────────────────────────────────────────────────

fn get_saved_password(connection_id: &str) -> Option<String> {
    let db = db::open().ok()?;
    let stored: String = db.query_row(
        "SELECT password FROM passwords WHERE connection_id = ?1",
        params![connection_id],
        |row| row.get(0),
    ).ok()?;
    Some(crate::crypto::decrypt(&stored))
}

pub fn get_saved_password_pub(connection_id: &str) -> Option<String> {
    get_saved_password(connection_id)
}

/// Returns the decrypted password for the UI (eye-button reveal). Empty string
/// when none is saved.
#[tauri::command]
pub async fn get_password(connection_id: String) -> Result<String, String> {
    Ok(get_saved_password(&connection_id).unwrap_or_default())
}

// ── Per-data-source master password (view lock) commands ────────────────────

fn group_verifier(group_id: &str) -> Option<String> {
    let db = db::open().ok()?;
    db.query_row(
        "SELECT verifier FROM group_master WHERE group_id = ?1",
        params![group_id],
        |row| row.get::<_, String>(0),
    ).ok()
}

/// Whether the given data source has a master password configured.
#[tauri::command]
pub async fn group_master_status(group_id: String) -> Result<bool, String> {
    Ok(group_verifier(&group_id).is_some())
}

/// Create the master password for a data source (only when none exists yet).
#[tauri::command]
pub async fn group_master_create(group_id: String, password: String) -> Result<(), String> {
    if password.is_empty() {
        return Err("La contraseña maestra no puede estar vacía.".into());
    }
    if group_verifier(&group_id).is_some() {
        return Err("Esta fuente de datos ya tiene contraseña maestra.".into());
    }
    let verifier = crate::crypto::make_verifier(&password);
    let db = db::open().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO group_master (group_id, verifier) VALUES (?1, ?2)",
        params![group_id, verifier],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Change a data source's master password — requires the current one.
#[tauri::command]
pub async fn group_master_change(group_id: String, old_password: String, new_password: String) -> Result<(), String> {
    let Some(current) = group_verifier(&group_id) else {
        return Err("Esta fuente de datos no tiene contraseña maestra.".into());
    };
    if !crate::crypto::check_verifier(&old_password, &current) {
        return Err("La contraseña maestra actual es incorrecta.".into());
    }
    if new_password.is_empty() {
        return Err("La nueva contraseña maestra no puede estar vacía.".into());
    }
    let verifier = crate::crypto::make_verifier(&new_password);
    let db = db::open().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO group_master (group_id, verifier) VALUES (?1, ?2)",
        params![group_id, verifier],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Verify a candidate password for a data source (unlocks reveal for the session).
#[tauri::command]
pub async fn group_master_verify(group_id: String, password: String) -> Result<bool, String> {
    match group_verifier(&group_id) {
        Some(v) => Ok(crate::crypto::check_verifier(&password, &v)),
        None => Ok(false),
    }
}

/// One-time migration: encrypt any passwords still stored as plaintext.
pub fn migrate_plaintext_passwords() {
    let Ok(db) = db::open() else { return };
    let rows: Vec<(String, String)> = {
        let Ok(mut stmt) = db.prepare("SELECT connection_id, password FROM passwords") else { return };
        let Ok(mapped) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) else { return };
        mapped.filter_map(|r| r.ok()).collect()
    };
    for (id, pw) in rows {
        if !crate::crypto::is_encrypted(&pw) {
            let enc = crate::crypto::encrypt(&pw);
            db.execute(
                "UPDATE passwords SET password = ?1 WHERE connection_id = ?2",
                params![enc, id],
            ).ok();
        }
    }
}

#[tauri::command]
pub async fn save_password(connection_id: String, password: String) -> Result<(), String> {
    let db = db::open().map_err(|e| e.to_string())?;
    let enc = crate::crypto::encrypt(&password);
    db.execute(
        "INSERT OR REPLACE INTO passwords (connection_id, password) VALUES (?1, ?2)",
        params![connection_id, enc],
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

/// Sentinel error: the frontend should prompt for the missing username/password
/// and call `connect_ssh` again with them. Returned when a username is missing
/// or password auth has no password available.
pub const NEED_CREDENTIALS: &str = "NEED_CREDENTIALS";

/// Parse the per-connection tunnel spec. One tunnel per line:
///   "L <listenPort> <destHost> <destPort>"   (local forward, -L)
///   "R <bindPort> <destHost> <destPort>"     (remote forward, -R)
///   "D <listenPort>"                          (dynamic SOCKS5 proxy, -D)
/// Lines that are empty, comments (#) or malformed are ignored.
fn parse_tunnels(spec: &str) -> Vec<(char, u16, String, u16)> {
    spec.lines()
        .filter_map(|line| {
            let l = line.trim();
            if l.is_empty() || l.starts_with('#') {
                return None;
            }
            let p: Vec<&str> = l.split_whitespace().collect();
            let kind = p.first()?.chars().next()?.to_ascii_uppercase();
            if kind == 'D' {
                if p.len() != 2 { return None; }
                Some(('D', p[1].parse().ok()?, String::new(), 0))
            } else {
                if p.len() != 4 { return None; }
                Some((kind, p[1].parse().ok()?, p[2].to_string(), p[3].parse().ok()?))
            }
        })
        .collect()
}

/// Local port forward (-L): listen on 127.0.0.1:listen_port and tunnel each
/// accepted connection to dest_host:dest_port through the SSH session.
async fn local_forward(
    handle: Arc<russh::client::Handle<SshHandler>>,
    listen_port: u16,
    dest_host: String,
    dest_port: u16,
) {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", listen_port)).await {
        Ok(l) => l,
        Err(e) => { eprintln!("[ssh] tunnel -L {listen_port}: bind failed: {e}"); return; }
    };
    loop {
        let (mut socket, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(_) => break,
        };
        let h = Arc::clone(&handle);
        let dhost = dest_host.clone();
        tokio::spawn(async move {
            let channel = match h
                .channel_open_direct_tcpip(dhost, dest_port as u32, peer.ip().to_string(), peer.port() as u32)
                .await
            {
                Ok(c) => c,
                Err(_) => return,
            };
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
        });
    }
}

/// Dynamic forward (-D): a minimal SOCKS5 proxy on 127.0.0.1:listen_port that
/// tunnels each CONNECT request to its target through the SSH session.
async fn dynamic_forward(handle: Arc<russh::client::Handle<SshHandler>>, listen_port: u16) {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", listen_port)).await {
        Ok(l) => l,
        Err(e) => { eprintln!("[ssh] tunnel -D {listen_port}: bind failed: {e}"); return; }
    };
    loop {
        let socket = match listener.accept().await {
            Ok((s, _)) => s,
            Err(_) => break,
        };
        let h = Arc::clone(&handle);
        tokio::spawn(async move { let _ = socks5_serve(socket, h).await; });
    }
}

async fn socks5_serve(
    mut socket: tokio::net::TcpStream,
    handle: Arc<russh::client::Handle<SshHandler>>,
) -> std::io::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Greeting: VER, NMETHODS, METHODS...
    let mut hdr = [0u8; 2];
    socket.read_exact(&mut hdr).await?;
    if hdr[0] != 0x05 { return Ok(()); }
    let mut methods = vec![0u8; hdr[1] as usize];
    socket.read_exact(&mut methods).await?;
    socket.write_all(&[0x05, 0x00]).await?; // no authentication

    // Request: VER, CMD, RSV, ATYP, ADDR, PORT
    let mut req = [0u8; 4];
    socket.read_exact(&mut req).await?;
    if req[1] != 0x01 {
        // Only CONNECT is supported.
        socket.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
        return Ok(());
    }
    let host = match req[3] {
        0x01 => { let mut a = [0u8; 4];  socket.read_exact(&mut a).await?; std::net::Ipv4Addr::from(a).to_string() }
        0x04 => { let mut a = [0u8; 16]; socket.read_exact(&mut a).await?; std::net::Ipv6Addr::from(a).to_string() }
        0x03 => {
            let mut len = [0u8; 1];
            socket.read_exact(&mut len).await?;
            let mut d = vec![0u8; len[0] as usize];
            socket.read_exact(&mut d).await?;
            String::from_utf8_lossy(&d).to_string()
        }
        _ => { socket.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?; return Ok(()); }
    };
    let mut pbuf = [0u8; 2];
    socket.read_exact(&mut pbuf).await?;
    let port = u16::from_be_bytes(pbuf);

    match handle.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0).await {
        Ok(channel) => {
            socket.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
        }
        Err(_) => {
            socket.write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
        }
    }
    Ok(())
}

/// Parse a ProxyJump spec "[user@]host[:port]".
fn parse_jump(spec: &str, default_user: &str) -> (String, String, u16) {
    let s = spec.trim();
    let (user, rest) = match s.split_once('@') {
        Some((u, r)) => (u.to_string(), r),
        None => (default_user.to_string(), s),
    };
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(22)),
        None => (rest.to_string(), 22u16),
    };
    (user, host, port)
}

/// Authenticate a russh session with a connection's credentials. Used for the
/// bastion in ProxyJump (the target uses the richer inline flow with prompts).
async fn ssh_authenticate(
    sh: &mut russh::client::Handle<SshHandler>,
    username: &str,
    connection: &Connection,
    password: Option<String>,
) -> Result<(), String> {
    match connection.auth_type.as_str() {
        "key" => {
            if connection.key_path.is_empty() { return Err("Bastion key path is empty".to_string()); }
            let key = russh_keys::load_secret_key(std::path::Path::new(&connection.key_path), None)
                .map_err(|e| format!("Bastion key load failed: {e}"))?;
            let ok = sh.authenticate_publickey(username, Arc::new(key)).await
                .map_err(|e| format!("Bastion key auth failed: {e}"))?;
            if !ok { return Err("Bastion key rejected".to_string()); }
        }
        "agent" => {
            let mut agent = russh_keys::agent::client::AgentClient::connect_env().await
                .map_err(|e| format!("Bastion agent unavailable: {e}"))?;
            let identities = agent.request_identities().await
                .map_err(|e| format!("Bastion agent identities failed: {e}"))?;
            let mut ok = false;
            for key in identities {
                let (a, r) = sh.authenticate_future(username, key, agent).await;
                agent = a;
                if let Ok(true) = r { ok = true; break; }
            }
            if !ok { return Err("Bastion agent rejected".to_string()); }
        }
        _ => {
            let Some(pw) = password else { return Err("Bastion password required".to_string()); };
            let ok = sh.authenticate_password(username, pw).await
                .map_err(|e| format!("Bastion password auth failed: {e}"))?;
            if !ok { return Err("Bastion password rejected".to_string()); }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn connect_ssh(
    app: AppHandle,
    sessions: State<'_, SshSessionMap>,
    connection_id: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<String, String> {
    let connection = load_connection(&connection_id)?;

    // Effective username: explicit (prompt) → saved → none (ask the frontend).
    // Resolved here but NOT enforced yet — we attempt the TCP transport first so
    // an offline/unreachable host fails with a network error instead of
    // pointlessly prompting for credentials a dead box will never accept.
    let username_opt = username
        .filter(|u| !u.is_empty())
        .or_else(|| if connection.username.is_empty() { None } else { Some(connection.username.clone()) });

    // Parse port-forwarding tunnels up front: remote (-R) routing must be known
    // when the connection handler is created.
    let tunnels = parse_tunnels(&connection.tunnels);
    let mut forwards = std::collections::HashMap::new();
    for (kind, listen_port, dest_host, dest_port) in &tunnels {
        if *kind == 'R' {
            forwards.insert(*listen_port as u32, (dest_host.clone(), *dest_port));
        }
    }

    let config = Arc::new(russh::client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    });
    let addr = (connection.host.as_str(), connection.port as u16);
    let handler = SshHandler {
        host: connection.host.clone(),
        port: connection.port as u16,
        forwards,
    };

    // Connect directly, or via a bastion (ProxyJump) when configured. The jump
    // session is kept alive in SshSession for the lifetime of this connection.
    // The transport is established BEFORE we require a username, so a host that
    // is off / out of network reports a connection error rather than a
    // credential prompt.
    let (mut sh, jump_handle) = if connection.proxy_jump.trim().is_empty() {
        let sh = russh::client::connect(config, addr, handler)
            .await
            .map_err(|e| format!("SSH connect failed: {e}"))?;
        (sh, None)
    } else {
        // ProxyJump needs a username to default the bastion user, so it must be
        // known before we can reach the target through the bastion.
        let Some(ref username) = username_opt else { return Err(NEED_CREDENTIALS.to_string()); };
        let (juser, jhost, jport) = parse_jump(&connection.proxy_jump, username);
        let jconfig = Arc::new(russh::client::Config {
            keepalive_interval: Some(std::time::Duration::from_secs(30)),
            ..Default::default()
        });
        let jhandler = SshHandler { host: jhost.clone(), port: jport, ..Default::default() };
        let mut jump = russh::client::connect(jconfig, (jhost.as_str(), jport), jhandler)
            .await
            .map_err(|e| format!("Bastion connect failed: {e}"))?;
        let jpw = password.clone().or_else(|| get_saved_password(&connection_id));
        ssh_authenticate(&mut jump, &juser, &connection, jpw).await?;
        let channel = jump
            .channel_open_direct_tcpip(connection.host.clone(), connection.port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| format!("Bastion → target channel failed: {e}"))?;
        let sh = russh::client::connect_stream(config, channel.into_stream(), handler)
            .await
            .map_err(|e| format!("SSH connect via bastion failed: {e}"))?;
        (sh, Some(Arc::new(jump)))
    };

    // Transport is up — NOW require a username (prompt only reaches a live host).
    let Some(username) = username_opt else { return Err(NEED_CREDENTIALS.to_string()); };

    // One russh session authenticates ONCE; the terminal shell and any SFTP
    // browser then share it (MobaXterm-style single session).
    match connection.auth_type.as_str() {
        "key" => {
            if connection.key_path.is_empty() {
                return Err("Key path is empty".to_string());
            }
            let key = russh_keys::load_secret_key(std::path::Path::new(&connection.key_path), None)
                .map_err(|e| format!("Failed to load private key: {e}"))?;
            let ok = sh
                .authenticate_publickey(&username, Arc::new(key))
                .await
                .map_err(|e| format!("Key auth failed: {e}"))?;
            if !ok { return Err("Key authentication rejected by server".to_string()); }
        }
        "agent" => {
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
                let (returned_agent, result) = sh.authenticate_future(&username, key, agent).await;
                agent = returned_agent;
                match result {
                    Ok(true) => { authenticated = true; break; }
                    Ok(false) => {}
                    Err(e) => return Err(format!("Agent auth attempt failed: {e}")),
                }
            }
            if !authenticated { return Err("SSH agent authentication rejected by server".to_string()); }
        }
        // default: password
        _ => {
            let Some(pw) = password.or_else(|| get_saved_password(&connection_id)) else {
                return Err(NEED_CREDENTIALS.to_string());
            };
            let ok = sh
                .authenticate_password(&username, pw)
                .await
                .map_err(|e| format!("Password auth failed: {e}"))?;
            if !ok { return Err("AUTH_FAILED".to_string()); }
        }
    }

    // Ask the server to listen for each remote (-R) tunnel. Incoming forwarded
    // connections are routed to the local destination by the handler.
    for (kind, listen_port, _dest_host, _dest_port) in &tunnels {
        if *kind == 'R' {
            let _ = sh.tcpip_forward("", *listen_port as u32).await;
        }
    }

    // Open the interactive shell channel (PTY + shell).
    let mut channel = sh
        .channel_open_session()
        .await
        .map_err(|e| format!("Channel open failed: {e}"))?;
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(|e| format!("PTY request failed: {e}"))?;
    channel
        .request_shell(false)
        .await
        .map_err(|e| format!("Shell request failed: {e}"))?;

    let session_id = Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<SshCmd>();
    let handle = Arc::new(sh);

    // Pump task: owns the shell channel. Streams remote output to the frontend
    // and applies input/resize commands. Ends when the channel closes or the
    // session is dropped (sender closed on disconnect).
    let app2 = app.clone();
    let sid2 = session_id.clone();
    tokio::spawn(async move {
        let mut channel = channel;
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) => {
                        let s = String::from_utf8_lossy(&data).to_string();
                        let _ = app2.emit(&format!("ssh-data-{sid2}"), &s);
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let s = String::from_utf8_lossy(&data).to_string();
                        let _ = app2.emit(&format!("ssh-data-{sid2}"), &s);
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                cmd = rx.recv() => match cmd {
                    Some(SshCmd::Data(d)) => { let _ = channel.data(&d[..]).await; }
                    Some(SshCmd::Resize(c, r)) => { let _ = channel.window_change(c, r, 0, 0).await; }
                    None => break,
                },
            }
        }
        let _ = app2.emit(&format!("ssh-closed-{sid2}"), ());
    });

    // Set up local (-L) forwards as background tasks (aborted on disconnect).
    // Remote (-R) forwards were already requested above and are routed by the
    // handler. Dynamic (-D / SOCKS) comes in a later wave.
    let mut tunnel_tasks = Vec::new();
    for (kind, listen_port, dest_host, dest_port) in tunnels {
        match kind {
            'L' => {
                let task = tokio::spawn(local_forward(Arc::clone(&handle), listen_port, dest_host, dest_port));
                tunnel_tasks.push(task.abort_handle());
            }
            'D' => {
                let task = tokio::spawn(dynamic_forward(Arc::clone(&handle), listen_port));
                tunnel_tasks.push(task.abort_handle());
            }
            _ => {}
        }
    }

    sessions.lock().unwrap().insert(session_id.clone(), SshSession { tx, handle, tunnel_tasks, _jump: jump_handle });
    Ok(session_id)
}

#[tauri::command]
pub async fn send_input(
    sessions: State<'_, SshSessionMap>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let tx = {
        let map = sessions.lock().unwrap();
        map.get(&session_id).ok_or("Session not found")?.tx.clone()
    };
    tx.send(SshCmd::Data(data.into_bytes())).map_err(|_| "SSH session closed".to_string())
}

#[tauri::command]
pub async fn resize_pty(
    sessions: State<'_, SshSessionMap>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let tx = {
        let map = sessions.lock().unwrap();
        map.get(&session_id).ok_or("Session not found")?.tx.clone()
    };
    tx.send(SshCmd::Resize(cols as u32, rows as u32)).map_err(|_| "SSH session closed".to_string())
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
        // Folder shared into the session as a drive. Only when the connection
        // opted in (rdp_redirect_drives); empty custom path → user's Downloads.
        let shared_folder: Option<String> = if connection.rdp_redirect_drives {
            let p = connection.rdp_drive_path.trim();
            if p.is_empty() {
                dirs::download_dir()
                    .or_else(dirs::home_dir)
                    .map(|d| d.to_string_lossy().into_owned())
            } else {
                Some(p.to_string())
            }
        } else {
            None
        };
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
            &connection.rdp_security,
            connection.rdp_color_depth as u16,
            shared_folder.as_deref(),
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
        let session_id = Uuid::new_v4().to_string();

        let session = crate::rdp::windows_rdp::launch(
            app.clone(),
            &session_id,
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
            &connection.rdp_security,
            connection.rdp_color_depth as i32,
            connection.rdp_redirect_drives,
            &connection.rdp_gateway,
        )?;

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
    // Try, in order: explicit utf-8 text, plain text, then whatever wl-paste
    // offers by default. Restricting to "text/plain" alone misses apps that
    // only advertise "text/plain;charset=utf-8", which returned nothing.
    let attempts: [&[&str]; 3] = [
        &["--no-newline", "--type", "text/plain;charset=utf-8"],
        &["--no-newline", "--type", "text/plain"],
        &["--no-newline"],
    ];
    for args in attempts {
        if let Ok(o) = std::process::Command::new("wl-paste")
            .args(args)
            .stderr(std::process::Stdio::null())
            .output()
        {
            if o.status.success() {
                if let Ok(s) = String::from_utf8(o.stdout) {
                    if !s.is_empty() { return Some(s); }
                }
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

/// Show a native Win32 popup menu for an RDP tab.  The menu window is created
/// at the OS level (Win32 menu layer), which sits above the WS_POPUP RDP window
/// in z-order, so the RDP session remains visible during the interaction.
/// Returns the selected action ("reconnect" | "close") or null if dismissed.
#[tauri::command]
pub async fn show_rdp_tab_menu(
    window: tauri::WebviewWindow,
    x: i32,
    y: i32,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            AppendMenuW, CreatePopupMenu, DestroyMenu, SetForegroundWindow,
            TrackPopupMenuEx, MF_SEPARATOR, MF_STRING,
            TPM_NONOTIFY, TPM_RETURNCMD, TPM_RIGHTBUTTON,
        };
        use windows::core::w;

        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let hwnd_raw = hwnd.0 as isize;
        let (tx, rx) = std::sync::mpsc::sync_channel::<Option<String>>(1);

        window.run_on_main_thread(move || {
            let hwnd = HWND(hwnd_raw as *mut _);
            let result = unsafe {
                let Ok(hmenu) = CreatePopupMenu() else {
                    let _ = tx.send(None);
                    return;
                };
                AppendMenuW(hmenu, MF_STRING, 1, w!("Reconectar")).ok();
                AppendMenuW(hmenu, MF_SEPARATOR, 0, w!("")).ok();
                AppendMenuW(hmenu, MF_STRING, 2, w!("Cerrar")).ok();
                // SetForegroundWindow is required so the menu disappears when
                // the user clicks outside (standard Win32 popup menu pattern).
                SetForegroundWindow(hwnd).ok();
                let cmd = TrackPopupMenuEx(
                    hmenu,
                    (TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY).0,
                    x, y,
                    hwnd,
                    None,
                );
                DestroyMenu(hmenu).ok();
                match cmd.0 {
                    1 => Some("reconnect".to_string()),
                    2 => Some("close".to_string()),
                    _ => None,
                }
            };
            let _ = tx.send(result);
        }).map_err(|e| e.to_string())?;

        return rx.recv().map_err(|e| e.to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, x, y);
        Ok(None)
    }
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

/// Carve a rectangular hole in the RDP WS_POPUP so an HTML menu (sidebar context menu or
/// menubar dropdown) rendered inside WebView2 shows through without hiding the RDP.
/// `rect` is `[vp_x, vp_y, vp_w, vp_h]` in WebView2 viewport coordinates from
/// `getBoundingClientRect()`.  Pass null/None to restore the full visible region.
#[tauri::command]
pub async fn rdp_windows_set_menu_region(
    embedded_sessions: State<'_, EmbeddedRdpSessionMap>,
    session_id: String,
    rect: Option<[i32; 4]>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let map = embedded_sessions.lock().unwrap();
        if let Some(session) = map.get(&session_id) {
            crate::rdp::windows_rdp::set_menu_region(session, rect);
        }
    }
    let _ = (embedded_sessions, session_id, rect);
    Ok(())
}

/// Transfer a live COM/mstscax RDP session to a new owner window by updating GWLP_HWNDPARENT.
#[tauri::command]
pub async fn rdp_windows_reparent(
    window: tauri::WebviewWindow,
    embedded_sessions: State<'_, EmbeddedRdpSessionMap>,
    session_id: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let parent_hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let map = embedded_sessions.lock().unwrap();
        if let Some(session) = map.get(&session_id) {
            crate::rdp::windows_rdp::reparent(session, parent_hwnd, x, y, width, height);
        }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, embedded_sessions, session_id, x, y, width, height);
        Ok(())
    }
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
