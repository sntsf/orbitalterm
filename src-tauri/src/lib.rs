mod commands;
mod db;

use commands::connections::{
    delete_connection, delete_folder, export_connections, get_connections, get_folders,
    import_connections, save_connection, save_folder, update_connection,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_connections,
            save_connection,
            update_connection,
            delete_connection,
            get_folders,
            save_folder,
            delete_folder,
            export_connections,
            import_connections,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OrbitalTerm");
}
