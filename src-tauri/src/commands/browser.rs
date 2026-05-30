use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewBuilder};

use crate::{
    browser::{start_proxy, stop_proxy, BrowserSessionMap},
    commands::sessions::load_connection,
};

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

    // If the child webview already exists (e.g. after a re-mount), just reposition it.
    if let Some(wv) = app.get_webview(&label) {
        wv.set_bounds(tauri::Rect {
            position: tauri::Position::Logical(LogicalPosition::new(x, y)),
            size: tauri::Size::Logical(LogicalSize::new(width, height)),
        })
        .map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let conn = load_connection(&connection_id)?;

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

    let session = start_proxy(&conn.custom_hosts)?;
    let proxy_port = session.proxy_port;
    sessions.lock().unwrap().insert(connection_id.clone(), session);

    let proxy_url: tauri::Url = format!("http://127.0.0.1:{}", proxy_port).parse().unwrap();

    let main_win = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    main_win
        .window()
        .add_child(
            WebviewBuilder::new(&label, tauri::WebviewUrl::External(url))
                .proxy_url(proxy_url),
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn browser_set_bounds(
    connection_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    app: AppHandle,
) -> Result<(), String> {
    let label = format!("browser-{}", connection_id);
    let Some(wv) = app.get_webview(&label) else {
        return Ok(());
    };

    if width < 2.0 || height < 2.0 {
        wv.hide().map_err(|e| e.to_string())?;
    } else {
        wv.set_bounds(tauri::Rect {
            position: tauri::Position::Logical(LogicalPosition::new(x, y)),
            size: tauri::Size::Logical(LogicalSize::new(width, height)),
        })
        .map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
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
    if let Some(wv) = app.get_webview(&label) {
        wv.close().map_err(|e| e.to_string())?;
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
