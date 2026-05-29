use tauri::{AppHandle, Manager};

use crate::{
    browser::{start_proxy, stop_proxy, BrowserSessionMap},
    commands::sessions::load_connection,
};

#[tauri::command]
pub fn browser_open(
    connection_id: String,
    app: AppHandle,
    sessions: tauri::State<BrowserSessionMap>,
) -> Result<(), String> {
    let conn = load_connection(&connection_id)?;

    // If a window is already open for this connection, just focus it
    let label = format!("browser-{}", connection_id);
    if let Some(win) = app.get_webview_window(&label) {
        win.set_focus().ok();
        return Ok(());
    }

    // Start the custom-hosts proxy
    let session = start_proxy(&conn.custom_hosts)?;
    let proxy_port = session.proxy_port;

    sessions.lock().unwrap().insert(connection_id.clone(), session);

    // Build the URL (default to https:// if no scheme present)
    let raw_url = if conn.url.is_empty() {
        return Err("No URL configured for this browser connection.".into());
    } else {
        conn.url.clone()
    };
    let url_str = if raw_url.contains("://") {
        raw_url
    } else {
        format!("https://{}", raw_url)
    };
    let url: tauri::Url = url_str.parse().map_err(|e| format!("Invalid URL: {e}"))?;
    let proxy_url: tauri::Url = format!("http://127.0.0.1:{}", proxy_port).parse().unwrap();

    let win = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
        .title(&conn.name)
        .proxy_url(proxy_url)
        .inner_size(1280.0, 800.0)
        .build()
        .map_err(|e| e.to_string())?;

    // Clean up proxy when the browser window is closed
    let app_clone = app.clone();
    let conn_id_for_close = connection_id.clone();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let session = {
                let state = app_clone.state::<BrowserSessionMap>();
                state.lock().unwrap().remove(&conn_id_for_close)
            };
            if let Some(s) = session {
                stop_proxy(s);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn browser_close(
    connection_id: String,
    app: AppHandle,
    sessions: tauri::State<BrowserSessionMap>,
) -> Result<(), String> {
    let label = format!("browser-{}", connection_id);
    if let Some(win) = app.get_webview_window(&label) {
        win.destroy().ok();
    }
    if let Some(s) = sessions.lock().unwrap().remove(&connection_id) {
        stop_proxy(s);
    }
    Ok(())
}
