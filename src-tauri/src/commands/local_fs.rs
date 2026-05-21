use serde::Serialize;
use std::time::UNIX_EPOCH;

#[derive(Serialize, Clone)]
pub struct LocalEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
}

#[tauri::command]
pub async fn local_list_dir(path: String) -> Result<Vec<LocalEntry>, String> {
    let dir = std::path::Path::new(&path);
    let read = std::fs::read_dir(dir)
        .map_err(|e| format!("Cannot read dir: {e}"))?;

    let mut entries: Vec<LocalEntry> = Vec::new();
    for item in read {
        let item = item.map_err(|e| format!("Entry error: {e}"))?;
        let meta = item.metadata().map_err(|e| format!("Metadata error: {e}"))?;
        let name = item.file_name().to_string_lossy().to_string();
        let path_str = item.path().to_string_lossy().to_string();
        let size = if meta.is_file() { meta.len() } else { 0 };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        entries.push(LocalEntry {
            name,
            path: path_str,
            is_dir: meta.is_dir(),
            size,
            modified,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub async fn local_get_home() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".to_string())
}

#[tauri::command]
pub async fn local_mkdir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("Cannot create dir: {e}"))
}

#[tauri::command]
pub async fn local_get_parent(path: String) -> String {
    let p = std::path::Path::new(&path);
    p.parent()
        .map(|par| par.to_string_lossy().to_string())
        .unwrap_or(path)
}
