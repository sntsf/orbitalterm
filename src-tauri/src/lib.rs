mod commands;
mod db;
mod rdp;
mod sftp;
mod ssh;

use commands::connections::{
    delete_connection, delete_folder, export_connections, get_connections, get_folders,
    import_connections, save_connection, save_folder, update_connection,
};
use commands::sessions::{
    connect_rdp, connect_ssh, delete_password, disconnect_rdp, disconnect_ssh, has_password,
    rdp_key_input, rdp_mouse_input, rdp_resize_session, rdp_status, resize_pty, save_password,
    send_input,
};
use commands::sftp::{
    sftp_connect, sftp_delete, sftp_disconnect, sftp_list_dir, sftp_mkdir, sftp_upload,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ssh::new_ssh_sessions())
        .manage(rdp::new_rdp_sessions())
        .manage(rdp::new_embedded_rdp_sessions())
        .manage(sftp::new_sftp_sessions())
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
            rdp_mouse_input,
            rdp_key_input,
            rdp_resize_session,
            // passwords
            save_password,
            delete_password,
            has_password,
            // sftp
            sftp_connect,
            sftp_list_dir,
            sftp_upload,
            sftp_mkdir,
            sftp_delete,
            sftp_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OrbitalTerm");
}
