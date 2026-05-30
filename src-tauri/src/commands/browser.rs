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

    // Already open: reposition and show.
    if let Some(win) = app.get_webview_window(&label) {
        win.set_position(tauri::Position::Logical(LogicalPosition::new(x, y)))
            .map_err(|e| e.to_string())?;
        win.set_size(tauri::Size::Logical(LogicalSize::new(width, height)))
            .map_err(|e| e.to_string())?;
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().ok();
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

    let win = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
        .title(&conn.name)
        .decorations(false)
        .shadow(false)
        .skip_taskbar(true)
        .position(x, y)
        .inner_size(width, height)
        .proxy_url(proxy_url)
        .build()
        .map_err(|e| e.to_string())?;

    // Stop proxy when the window is closed by the user directly.
    let app_clone = app.clone();
    let conn_id = connection_id.clone();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let session = {
                let state = app_clone.state::<BrowserSessionMap>();
                let result = state.lock().unwrap().remove(&conn_id);
                result
            };
            if let Some(s) = session {
                stop_proxy(s);
            }
        }
    });

    Ok(())
}

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
    let Some(win) = app.get_webview_window(&label) else {
        return Ok(());
    };
    if !visible {
        win.hide().map_err(|e| e.to_string())?;
    } else {
        win.set_position(tauri::Position::Logical(LogicalPosition::new(x, y)))
            .map_err(|e| e.to_string())?;
        win.set_size(tauri::Size::Logical(LogicalSize::new(width, height)))
            .map_err(|e| e.to_string())?;
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().ok();
    }
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
    let session = {
        let result = sessions.lock().unwrap().remove(&connection_id);
        result
    };
    if let Some(s) = session {
        stop_proxy(s);
    }
    Ok(())
}
