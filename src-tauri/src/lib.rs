mod commands;
mod db;
mod ftp;
mod rdp;
mod sftp;
mod ssh;
mod vnc;

use commands::connections::{
    delete_connection, delete_folder, delete_group, export_connections, export_selected_to_file,
    export_to_file, get_connections, get_folders, get_groups, import_connections, import_from_file,
    import_from_mremoteng, reorder_connections, rename_group, save_connection, save_folder,
    save_group, update_connection,
};
use commands::local_fs::{local_delete, local_get_home, local_get_parent, local_list_dir, local_mkdir};
use commands::ftp::{
    ftp_connect, ftp_delete, ftp_disconnect, ftp_download, ftp_list_dir, ftp_mkdir, ftp_pwd,
    ftp_rename, ftp_upload,
};
use commands::sessions::{
    connect_rdp, connect_ssh, copy_password, delete_password, disconnect_rdp, disconnect_ssh,
    has_password, rdp_get_linux_clipboard, rdp_key_input, rdp_mouse_input, rdp_refresh_session,
    rdp_resize_session, rdp_set_clipboard, rdp_status, resize_pty, save_password, send_input,
};
use commands::sftp::{
    sftp_connect, sftp_create_file, sftp_delete, sftp_disconnect, sftp_download, sftp_list_dir,
    sftp_mkdir, sftp_rename, sftp_upload,
};
use commands::vnc::{vnc_connect, vnc_disconnect, vnc_key_event, vnc_pointer_event};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

// ── Detached session store ────────────────────────────────────────────────────
// Transfers a live session_id from the main window to a detached window
// (tear-out) or vice-versa (dock-back), so the backend session survives.

type DetachedSessionStore = Mutex<HashMap<String, String>>;

fn new_detached_session_store() -> DetachedSessionStore {
    Mutex::new(HashMap::new())
}

#[tauri::command]
fn store_detached_session(
    state: tauri::State<DetachedSessionStore>,
    label: String,
    session_id: String,
) {
    state.lock().unwrap().insert(label, session_id);
}

#[tauri::command]
fn pop_detached_session(
    state: tauri::State<DetachedSessionStore>,
    label: String,
) -> Option<String> {
    state.lock().unwrap().remove(&label)
}

// ── Window helpers ────────────────────────────────────────────────────────────

#[tauri::command]
fn get_window_label(window: tauri::WebviewWindow) -> String {
    window.label().to_string()
}

#[tauri::command]
fn open_detached_window(
    app: tauri::AppHandle,
    connection_id: String,
    title: String,
) -> Result<(), String> {
    let label = format!("detached-{}", connection_id);
    if let Some(w) = app.get_webview_window(&label) {
        w.set_focus().ok();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title(title)
    .inner_size(1280.0, 800.0)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(new_detached_session_store())
        .manage(ssh::new_ssh_sessions())
        .manage(rdp::new_rdp_sessions())
        .manage(rdp::new_embedded_rdp_sessions())
        .manage(sftp::new_sftp_sessions())
        .manage(ftp::new_ftp_sessions())
        .manage(vnc::new_vnc_sessions())
        .setup(|app| {
            // Embed icon bytes at compile time, decode PNG → raw RGBA, set on window.
            let png = include_bytes!("../icons/icon.png");
            let img = image::load_from_memory(png)
                .expect("icon.png decode failed")
                .into_rgba8();
            let (w, h) = img.dimensions();
            let icon = tauri::image::Image::new_owned(img.into_raw(), w, h);
            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(icon).ok();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // connections
            get_connections,
            save_connection,
            update_connection,
            delete_connection,
            reorder_connections,
            get_folders,
            save_folder,
            delete_folder,
            export_connections,
            export_to_file,
            export_selected_to_file,
            import_connections,
            import_from_file,
            import_from_mremoteng,
            // groups
            get_groups,
            save_group,
            rename_group,
            delete_group,
            // Local filesystem
            local_list_dir,
            local_get_home,
            local_get_parent,
            local_mkdir,
            local_delete,
            // SSH
            connect_ssh,
            send_input,
            resize_pty,
            disconnect_ssh,
            // RDP
            connect_rdp,
            rdp_status,
            disconnect_rdp,
            rdp_mouse_input,
            rdp_key_input,
            rdp_resize_session,
            rdp_refresh_session,
            rdp_get_linux_clipboard,
            rdp_set_clipboard,
            // passwords
            save_password,
            delete_password,
            copy_password,
            has_password,
            // SFTP
            sftp_connect,
            sftp_list_dir,
            sftp_upload,
            sftp_download,
            sftp_mkdir,
            sftp_create_file,
            sftp_rename,
            sftp_delete,
            sftp_disconnect,
            // FTP
            ftp_connect,
            ftp_list_dir,
            ftp_upload,
            ftp_download,
            ftp_mkdir,
            ftp_delete,
            ftp_rename,
            ftp_pwd,
            ftp_disconnect,
            // VNC
            vnc_connect,
            vnc_key_event,
            vnc_pointer_event,
            vnc_disconnect,
            // Window management
            get_window_label,
            open_detached_window,
            store_detached_session,
            pop_detached_session,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Prevent the default close so we can clean up first.
                api.prevent_close();
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    // Send FTP QUIT to every open session (clean protocol-level goodbye).
                    {
                        let state = app.state::<ftp::FtpSessionMap>();
                        let mut map = state.lock().unwrap();
                        for (_, mut conn) in map.drain() {
                            conn.stream.quit().ok();
                        }
                    }
                    // Drop SSH sessions — closing the PTY master signals the
                    // shell to exit (SIGHUP), which logs the user out server-side.
                    app.state::<ssh::SshSessionMap>().lock().unwrap().clear();
                    // Drop SFTP sessions — closing the ssh2 Session sends TCP FIN,
                    // which the SSH server interprets as a clean disconnect.
                    app.state::<sftp::SftpSessionMap>().lock().unwrap().clear();
                    // RDP and VNC sessions are intentionally NOT cleared here:
                    // remote sessions remain active in "Disconnected" state on
                    // the server, so the user can reconnect without logging out.
                    app.exit(0);
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running OrbitalTerm");
}
