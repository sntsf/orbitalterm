mod commands;
mod db;
mod rdp;
mod ssh;

use commands::connections::{
    delete_connection, delete_folder, export_connections, get_connections, get_folders,
    import_connections, save_connection, save_folder, update_connection,
};
use commands::sessions::{
    connect_rdp, connect_ssh, delete_password, disconnect_rdp, disconnect_ssh, has_password,
    rdp_status, resize_pty, save_password, send_input,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ssh::new_ssh_sessions())
        .manage(rdp::new_rdp_sessions())
        .invoke_handler(tauri::generate_handler![
            // connections
            get_connections,
            save_connection,
            update_connection,
            delete_connection,
            get_folders,
            save_folder,
            delete_folder,
            export_connections,
            import_connections,
            // sessions
            connect_ssh,
            send_input,
            resize_pty,
            disconnect_ssh,
            connect_rdp,
            rdp_status,
            disconnect_rdp,
            // passwords
            save_password,
            delete_password,
            has_password,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OrbitalTerm");
}
