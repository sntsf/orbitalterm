use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Connection {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub conn_type: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub folder_id: Option<String>,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NewConnection {
    pub name: String,
    #[serde(rename = "type")]
    pub conn_type: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub folder_id: Option<String>,
    pub notes: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub expanded: bool,
}

#[tauri::command]
pub fn get_connections() -> Result<Vec<Connection>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, type, host, port, username, folder_id, notes, created_at, updated_at
             FROM connections ORDER BY name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map([], |row| {
            Ok(Connection {
                id: row.get(0)?,
                name: row.get(1)?,
                conn_type: row.get(2)?,
                host: row.get(3)?,
                port: row.get(4)?,
                username: row.get(5)?,
                folder_id: row.get(6)?,
                notes: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(items)
}

#[tauri::command]
pub fn save_connection(conn: NewConnection) -> Result<Connection, String> {
    let db = db::open().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO connections (id, name, type, host, port, username, folder_id, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, conn.name, conn.conn_type, conn.host, conn.port, conn.username, conn.folder_id, conn.notes],
    )
    .map_err(|e| e.to_string())?;

    let saved: Connection = db
        .query_row(
            "SELECT id, name, type, host, port, username, folder_id, notes, created_at, updated_at
             FROM connections WHERE id = ?1",
            params![id],
            |row| Ok(Connection {
                id: row.get(0)?,
                name: row.get(1)?,
                conn_type: row.get(2)?,
                host: row.get(3)?,
                port: row.get(4)?,
                username: row.get(5)?,
                folder_id: row.get(6)?,
                notes: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            }),
        )
        .map_err(|e| e.to_string())?;

    Ok(saved)
}

#[tauri::command]
pub fn update_connection(conn: Connection) -> Result<Connection, String> {
    let db = db::open().map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE connections SET name=?1, type=?2, host=?3, port=?4, username=?5,
         folder_id=?6, notes=?7, updated_at=datetime('now') WHERE id=?8",
        params![conn.name, conn.conn_type, conn.host, conn.port, conn.username, conn.folder_id, conn.notes, conn.id],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
pub fn delete_connection(id: String) -> Result<(), String> {
    let db = db::open().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM connections WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_folders() -> Result<Vec<Folder>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, parent_id FROM folders ORDER BY name COLLATE NOCASE")
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map([], |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                expanded: true,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(items)
}

#[tauri::command]
pub fn save_folder(name: String, parent_id: Option<String>) -> Result<Folder, String> {
    let db = db::open().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO folders (id, name, parent_id) VALUES (?1, ?2, ?3)",
        params![id, name, parent_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(Folder { id, name, parent_id, expanded: true })
}

#[tauri::command]
pub fn delete_folder(id: String) -> Result<(), String> {
    let db = db::open().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM folders WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn export_connections() -> Result<String, String> {
    let conns = get_connections()?;
    let folders = get_folders()?;
    let export = serde_json::json!({
        "version": 1,
        "connections": conns,
        "folders": folders,
    });
    serde_json::to_string_pretty(&export).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_connections(json: String) -> Result<usize, String> {
    let value: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| e.to_string())?;

    let conns = value["connections"]
        .as_array()
        .ok_or("missing connections array")?;

    let db = db::open().map_err(|e| e.to_string())?;
    let mut count = 0usize;

    for item in conns {
        let id = Uuid::new_v4().to_string();
        if db.execute(
            "INSERT OR IGNORE INTO connections (id, name, type, host, port, username, folder_id, notes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                item["name"].as_str().unwrap_or("Imported"),
                item["type"].as_str().unwrap_or("ssh"),
                item["host"].as_str().unwrap_or(""),
                item["port"].as_i64().unwrap_or(22),
                item["username"].as_str().unwrap_or(""),
                item["folder_id"].as_str(),
                item["notes"].as_str().unwrap_or(""),
            ],
        ).is_ok() {
            count += 1;
        }
    }

    Ok(count)
}
