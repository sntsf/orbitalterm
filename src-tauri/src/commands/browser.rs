use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager};

use crate::{
    browser::{start_proxy, stop_proxy, BrowserSessionMap},
    commands::sessions::load_connection,
};

fn build_url(raw: &str) -> Result<tauri::Url, String> {
    let s = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{}", raw)
    };
    s.parse().map_err(|e| format!("Invalid URL: {e}"))
}

/// Open (or reposition) a browser tab as a child webview embedded inside the main window.
/// x/y are in CSS logical pixels relative to the main window's viewport (from getBoundingClientRect).
#[tauri::command]
pub fn browser_open(
    connection_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    app: AppHandle,
    sessions: tauri::State<BrowserSessionMap>,
) -> Result<(), String> {
    let label = format!("browser-{}", connection_id);

    // Already open: just reposition/resize and show.
    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_bounds(tauri::Rect {
                position: tauri::Position::Logical(LogicalPosition::new(x, y)),
                size: tauri::Size::Logical(LogicalSize::new(width, height)),
            })
            .map_err(|e| e.to_string())?;
        webview.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let conn = load_connection(&connection_id)?;
    if conn.url.is_empty() {
        return Err("No URL configured for this browser connection.".into());
    }
    let url = build_url(&conn.url)?;

    let session = start_proxy(&conn.custom_hosts)?;
    let proxy_port = session.proxy_port;
    sessions.lock().unwrap().insert(connection_id.clone(), session);

    let proxy_url: tauri::Url = format!("http://127.0.0.1:{}", proxy_port).parse().unwrap();

    let main_win = app
        .get_webview_window("main")
        .ok_or("main window not found")?;

    let webview_builder = tauri::WebviewBuilder::new(&label, tauri::WebviewUrl::External(url))
        .proxy_url(proxy_url);

    // add_child lives on Window<R>, accessed via the underlying Webview reference.
    main_win
        .as_ref()
        .window()
        .add_child(
            webview_builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Reposition the embedded browser webview, or hide it when the tab is not visible.
#[tauri::command]
pub fn browser_set_position(
    connection_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
    app: AppHandle,
) -> Result<(), String> {
    let label = format!("browser-{}", connection_id);
    let Some(webview) = app.get_webview(&label) else {
        return Ok(());
    };
    if !visible {
        webview.hide().map_err(|e| e.to_string())?;
    } else {
        webview
            .set_bounds(tauri::Rect {
                position: tauri::Position::Logical(LogicalPosition::new(x, y)),
                size: tauri::Size::Logical(LogicalSize::new(width, height)),
            })
            .map_err(|e| e.to_string())?;
        webview.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Close and destroy the embedded browser webview.
#[tauri::command]
pub fn browser_close(
    connection_id: String,
    app: AppHandle,
    sessions: tauri::State<BrowserSessionMap>,
) -> Result<(), String> {
    let label = format!("browser-{}", connection_id);
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|e| e.to_string())?;
    }
    let session = sessions.lock().unwrap().remove(&connection_id);
    if let Some(s) = session {
        stop_proxy(s);
    }
    Ok(())
}
