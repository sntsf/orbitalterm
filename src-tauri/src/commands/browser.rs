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

/// Convert viewport-relative CSS pixel coords to logical screen coords.
/// vx/vy come from getBoundingClientRect() in JS (window-relative, not screen-relative).
fn to_screen_logical(
    main_win: &tauri::WebviewWindow,
    vx: f64,
    vy: f64,
) -> Result<(f64, f64), String> {
    let inner = main_win.inner_position().map_err(|e| e.to_string())?;
    let scale = main_win.scale_factor().map_err(|e| e.to_string())?;
    Ok((inner.x as f64 / scale + vx, inner.y as f64 / scale + vy))
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

    let main_win = app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    let (sx, sy) = to_screen_logical(&main_win, x, y)?;

    // Already open: reposition and show.
    if let Some(win) = app.get_webview_window(&label) {
        win.set_position(tauri::Position::Logical(LogicalPosition::new(sx, sy)))
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

    // Build a borderless overlay window that looks embedded inside the main window.
    // transient_for keeps it above the main window and out of the taskbar on Linux.
    let builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
        .title(&conn.name)
        .decorations(false)
        .shadow(false)
        .skip_taskbar(true)
        .position(sx, sy)
        .inner_size(width, height)
        .proxy_url(proxy_url);

    // On Linux, make the overlay window a transient child of the main window so it
    // stays above it without being an independent taskbar entry.
    #[cfg(target_os = "linux")]
    let builder = builder.transient_for(&main_win).map_err(|e| e.to_string())?;

    let win = builder.build().map_err(|e| e.to_string())?;

    // Clean up proxy when the user closes the window directly.
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
        let main_win = app
            .get_webview_window("main")
            .ok_or("main window not found")?;
        let (sx, sy) = to_screen_logical(&main_win, x, y)?;
        win.set_position(tauri::Position::Logical(LogicalPosition::new(sx, sy)))
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
