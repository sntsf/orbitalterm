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
    pub auth_type: String,
    pub key_path: String,
    pub folder_id: Option<String>,
    pub notes: String,
    pub description: String,
    pub domain: String,
    pub rdp_admin: bool,
    pub created_at: String,
    pub updated_at: String,
    pub sort_order: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NewConnection {
    pub name: String,
    #[serde(rename = "type")]
    pub conn_type: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub auth_type: String,
    pub key_path: String,
    pub folder_id: Option<String>,
    pub notes: String,
    pub description: String,
    pub domain: String,
    #[serde(default)]
    pub rdp_admin: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReorderItem {
    pub id: String,
    pub sort_order: i64,
    pub folder_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub expanded: bool,
}

fn row_to_conn(row: &rusqlite::Row<'_>) -> rusqlite::Result<Connection> {
    Ok(Connection {
        id: row.get(0)?,
        name: row.get(1)?,
        conn_type: row.get(2)?,
        host: row.get(3)?,
        port: row.get(4)?,
        username: row.get(5)?,
        auth_type: row.get(6)?,
        key_path: row.get(7)?,
        folder_id: row.get(8)?,
        notes: row.get(9)?,
        description: row.get(10)?,
        domain: row.get(11)?,
        rdp_admin: row.get::<_, i64>(12).unwrap_or(0) != 0,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
        sort_order: row.get(15).unwrap_or(0),
    })
}

const SELECT_COLS: &str = "id, name, type, host, port, username, auth_type, key_path,
                           folder_id, notes, description, domain, rdp_admin, created_at, updated_at, sort_order";

#[tauri::command]
pub fn get_connections() -> Result<Vec<Connection>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SELECT_COLS} FROM connections ORDER BY sort_order ASC, name COLLATE NOCASE"
        ))
        .map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], row_to_conn)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    rows
}

#[tauri::command]
pub fn save_connection(conn: NewConnection) -> Result<Connection, String> {
    let db = db::open().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let sort_order: i64 = db.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM connections",
        [],
        |row| row.get(0),
    ).unwrap_or(0);
    db.execute(
        "INSERT INTO connections (id, name, type, host, port, username, auth_type, key_path, folder_id, notes, description, domain, rdp_admin, sort_order)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![id, conn.name, conn.conn_type, conn.host, conn.port,
                conn.username, conn.auth_type, conn.key_path, conn.folder_id, conn.notes,
                conn.description, conn.domain, conn.rdp_admin as i64, sort_order],
    )
    .map_err(|e| e.to_string())?;

    db.query_row(
        &format!("SELECT {SELECT_COLS} FROM connections WHERE id=?1"),
        params![id],
        row_to_conn,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_connection(conn: Connection) -> Result<Connection, String> {
    let db = db::open().map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE connections SET name=?1,type=?2,host=?3,port=?4,username=?5,
         auth_type=?6,key_path=?7,folder_id=?8,notes=?9,description=?10,domain=?11,
         rdp_admin=?12,updated_at=datetime('now') WHERE id=?13",
        params![conn.name, conn.conn_type, conn.host, conn.port, conn.username,
                conn.auth_type, conn.key_path, conn.folder_id, conn.notes,
                conn.description, conn.domain, conn.rdp_admin as i64, conn.id],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
pub fn delete_connection(id: String) -> Result<(), String> {
    let db = db::open().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM connections WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn reorder_connections(updates: Vec<ReorderItem>) -> Result<(), String> {
    let db = db::open().map_err(|e| e.to_string())?;
    for item in updates {
        db.execute(
            "UPDATE connections SET sort_order=?1, folder_id=?2, updated_at=datetime('now') WHERE id=?3",
            params![item.sort_order, item.folder_id, item.id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_folders() -> Result<Vec<Folder>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, parent_id FROM folders ORDER BY name COLLATE NOCASE")
        .map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        Ok(Folder { id: row.get(0)?, name: row.get(1)?, parent_id: row.get(2)?, expanded: true })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string());
    rows
}

#[tauri::command]
pub fn save_folder(name: String, parent_id: Option<String>) -> Result<Folder, String> {
    let db = db::open().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO folders (id, name, parent_id) VALUES (?1,?2,?3)",
        params![id, name, parent_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(Folder { id, name, parent_id, expanded: true })
}

#[tauri::command]
pub fn delete_folder(id: String) -> Result<(), String> {
    let db = db::open().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM folders WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Export ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn export_connections() -> Result<String, String> {
    let conns = get_connections()?;
    let folders = get_folders()?;
    let db = db::open().map_err(|e| e.to_string())?;

    // Attach saved password for every connection that has one
    let conns_with_pw: Vec<serde_json::Value> = conns.iter().map(|c| {
        let pw: Option<String> = db.query_row(
            "SELECT password FROM passwords WHERE connection_id = ?1",
            params![c.id],
            |row| row.get(0),
        ).ok();
        let mut v = serde_json::to_value(c).unwrap_or_default();
        if let Some(p) = pw {
            v["password"] = serde_json::Value::String(p);
        }
        v
    }).collect();

    serde_json::to_string_pretty(&serde_json::json!({
        "version": 2,
        "connections": conns_with_pw,
        "folders": folders,
    }))
    .map_err(|e| e.to_string())
}

// ── Import JSON ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn import_connections(json: String) -> Result<usize, String> {
    let value: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let db = db::open().map_err(|e| e.to_string())?;
    let mut count = 0usize;

    // Import folders first (preserving IDs so connection→folder links stay valid)
    if let Some(folders) = value["folders"].as_array() {
        for f in folders {
            let _ = db.execute(
                "INSERT OR IGNORE INTO folders (id, name, parent_id) VALUES (?1, ?2, ?3)",
                params![
                    f["id"].as_str().unwrap_or(""),
                    f["name"].as_str().unwrap_or("Imported Folder"),
                    f["parent_id"].as_str(),
                ],
            );
        }
    }

    let conns = value["connections"].as_array().ok_or("missing connections")?;
    for item in conns {
        let id = Uuid::new_v4().to_string();
        let ok = db.execute(
            "INSERT OR IGNORE INTO connections
             (id,name,type,host,port,username,auth_type,key_path,folder_id,notes,description,domain)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                id,
                item["name"].as_str().unwrap_or("Imported"),
                item["type"].as_str().unwrap_or("ssh"),
                item["host"].as_str().unwrap_or(""),
                item["port"].as_i64().unwrap_or(22),
                item["username"].as_str().unwrap_or(""),
                item["auth_type"].as_str().unwrap_or("password"),
                item["key_path"].as_str().unwrap_or(""),
                item["folder_id"].as_str(),
                item["notes"].as_str().unwrap_or(""),
                item["description"].as_str().unwrap_or(""),
                item["domain"].as_str().unwrap_or(""),
            ],
        ).is_ok();

        if ok {
            // Save password if present in the export
            if let Some(pw) = item["password"].as_str() {
                if !pw.is_empty() {
                    let _ = db.execute(
                        "INSERT OR REPLACE INTO passwords (connection_id, password) VALUES (?1, ?2)",
                        params![id, pw],
                    );
                }
            }
            count += 1;
        }
    }
    Ok(count)
}

// ── Import mRemoteNG XML ──────────────────────────────────────────────────────

fn mrng_protocol_to_type(proto: &str) -> &'static str {
    match proto.to_uppercase().as_str() {
        "SSH2" | "SSH1"              => "ssh",
        "RDP"                        => "rdp",
        "VNC"                        => "vnc",
        "FTP"                        => "ftp",
        "SFTP"                       => "sftp",
        _                            => "ssh",
    }
}

fn mrng_default_port(conn_type: &str) -> i64 {
    match conn_type {
        "ssh"  => 22,
        "rdp"  => 3389,
        "vnc"  => 5900,
        "ftp"  => 21,
        "sftp" => 22,
        _      => 22,
    }
}

/// Recurse into mRemoteNG XML tree.
/// `parent_folder_id` = the OrbitalTerm folder ID to put children into (None = root).
fn mrng_process_node(
    node: roxmltree::Node,
    parent_folder_id: Option<&str>,
    db: &rusqlite::Connection,
    count: &mut usize,
) {
    for child in node.children().filter(|n| n.is_element() && n.has_tag_name("Node")) {
        let node_type = child.attribute("Type").unwrap_or("");
        let name = child.attribute("Name").unwrap_or("Imported");

        match node_type {
            "Container" => {
                // Create a folder and recurse
                let folder_id = Uuid::new_v4().to_string();
                let _ = db.execute(
                    "INSERT OR IGNORE INTO folders (id, name, parent_id) VALUES (?1, ?2, ?3)",
                    params![folder_id, name, parent_folder_id],
                );
                mrng_process_node(child, Some(&folder_id), db, count);
            }
            "Connection" => {
                let proto = child.attribute("Protocol").unwrap_or("SSH2");
                let conn_type = mrng_protocol_to_type(proto);
                let host = child.attribute("Hostname").unwrap_or("");
                let port: i64 = child.attribute("Port")
                    .and_then(|p| p.parse().ok())
                    .unwrap_or_else(|| mrng_default_port(conn_type));
                let username = child.attribute("Username").unwrap_or("");
                let description = child.attribute("Description").unwrap_or("");
                let domain = child.attribute("Domain").unwrap_or("");
                let rdp_admin = child.attribute("RDPAuthenticationLevel")
                    .map(|v| v == "2")
                    .unwrap_or(false);

                let id = Uuid::new_v4().to_string();
                let ok = db.execute(
                    "INSERT OR IGNORE INTO connections
                     (id,name,type,host,port,username,auth_type,key_path,folder_id,notes,description,domain,rdp_admin)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                    params![
                        id, name, conn_type, host, port, username,
                        "password", "", parent_folder_id,
                        "", description, domain,
                        rdp_admin as i64,
                    ],
                ).is_ok();
                if ok { *count += 1; }
            }
            _ => {}
        }
    }
}

#[tauri::command]
pub fn import_from_mremoteng(path: String) -> Result<usize, String> {
    let xml = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let doc = roxmltree::Document::parse(&xml).map_err(|e| e.to_string())?;
    let db = db::open().map_err(|e| e.to_string())?;
    let mut count = 0usize;
    mrng_process_node(doc.root_element(), None, &db, &mut count);
    Ok(count)
}

// ── File helpers ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn export_to_file(path: String) -> Result<(), String> {
    let json = export_connections()?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_from_file(path: String) -> Result<usize, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // Detect format by file extension
    if path.to_lowercase().ends_with(".xml") {
        import_from_mremoteng(path)
    } else {
        import_connections(content)
    }
}
