use std::sync::Arc;
use tauri::AppHandle;

use crate::{
    browser::{new_browser_sessions, start_reverse_proxy, stop_proxy, BrowserSessionMap, TargetConfig},
    commands::sessions::load_connection,
};

fn parse_target(url: &str) -> Result<(String, String, u16), String> {
    let full = if url.contains("://") {
        url.to_owned()
    } else {
        format!("http://{}", url)
    };
    let parsed: reqwest::Url = full.parse().map_err(|e| format!("Invalid URL: {e}"))?;
    let scheme = parsed.scheme().to_owned();
    let host = parsed.host_str().ok_or("No host in URL")?.to_owned();
    let port = parsed
        .port()
        .unwrap_or(if scheme == "https" { 443 } else { 80 });
    Ok((scheme, host, port))
}

/// Start (or reuse) the reverse proxy for a browser connection.
/// Returns the loopback port the iframe should connect to.
#[tauri::command]
pub fn browser_open(
    connection_id: String,
    _app: AppHandle,
    sessions: tauri::State<BrowserSessionMap>,
) -> Result<u16, String> {
    // Return existing port if already running
    if let Some(s) = sessions.lock().unwrap().get(&connection_id) {
        return Ok(s.proxy_port);
    }

    let conn = load_connection(&connection_id)?;
    if conn.url.is_empty() {
        return Err("No URL configured for this browser connection.".into());
    }

    let (scheme, host, port) = parse_target(&conn.url)?;
    let config = Arc::new(TargetConfig::new(scheme, host, port));
    let session = start_reverse_proxy(config)?;
    let proxy_port = session.proxy_port;
    sessions.lock().unwrap().insert(connection_id, session);
    Ok(proxy_port)
}

/// Stop the reverse proxy for a browser connection.
#[tauri::command]
pub fn browser_close(
    connection_id: String,
    _app: AppHandle,
    sessions: tauri::State<BrowserSessionMap>,
) -> Result<(), String> {
    if let Some(session) = sessions.lock().unwrap().remove(&connection_id) {
        stop_proxy(session);
    }
    Ok(())
}

// browser_set_position is no longer needed (iframe is DOM-embedded)
// kept as a no-op so existing lib.rs registrations compile cleanly.
#[tauri::command]
pub fn browser_set_position() -> Result<(), String> {
    Ok(())
}
