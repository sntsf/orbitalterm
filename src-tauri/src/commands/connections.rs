use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Group {
    pub id: String,
    pub name: String,
}

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
    pub group_id: String,
    pub icon: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub custom_hosts: String,
    #[serde(default = "default_rdp_security")]
    pub rdp_security: String,
    #[serde(default = "default_rdp_color_depth")]
    pub rdp_color_depth: i64,
}

fn default_rdp_security() -> String { "negotiate".to_string() }
fn default_rdp_color_depth() -> i64 { 32 }

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
    #[serde(default)]
    pub group_id: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub custom_hosts: String,
    #[serde(default = "default_rdp_security")]
    pub rdp_security: String,
    #[serde(default = "default_rdp_color_depth")]
    pub rdp_color_depth: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReorderItem {
    pub id: String,
    pub sort_order: i64,
    pub folder_id: Option<String>,
    pub group_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FolderReorderItem {
    pub id: String,
    pub sort_order: i64,
    pub parent_id: Option<String>,
    pub group_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub expanded: bool,
    pub group_id: String,
    pub sort_order: i64,
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
        group_id: row.get::<_, String>(16).unwrap_or_default(),
        icon: row.get::<_, String>(17).unwrap_or_default(),
        url: row.get::<_, String>(18).unwrap_or_default(),
        custom_hosts: row.get::<_, String>(19).unwrap_or_default(),
        rdp_security: row.get::<_, String>(20).unwrap_or_else(|_| "negotiate".to_string()),
        rdp_color_depth: row.get::<_, i64>(21).unwrap_or(32),
    })
}

const SELECT_COLS: &str = "id, name, type, host, port, username, auth_type, key_path,
                           folder_id, notes, description, domain, rdp_admin, created_at, updated_at,
                           sort_order, group_id, icon, url, custom_hosts, rdp_security, rdp_color_depth";

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

    // Determine group_id: inherit from folder if folder_id is set, else use provided group_id
    let group_id = if let Some(ref fid) = conn.folder_id {
        db.query_row(
            "SELECT group_id FROM folders WHERE id = ?1",
            params![fid],
            |row| row.get::<_, String>(0),
        ).unwrap_or_else(|_| conn.group_id.clone())
    } else {
        conn.group_id.clone()
    };

    // New connection goes to the top of its context, above connections AND folders.
    let sort_order: i64 = if let Some(ref fid) = conn.folder_id {
        db.query_row(
            "SELECT COALESCE(MIN(sort_order), 1) - 1 FROM (
                SELECT sort_order FROM connections WHERE folder_id = ?1
                UNION ALL
                SELECT sort_order FROM folders WHERE parent_id = ?1
            )",
            params![fid],
            |row| row.get(0),
        ).unwrap_or(0)
    } else {
        db.query_row(
            "SELECT COALESCE(MIN(sort_order), 1) - 1 FROM (
                SELECT sort_order FROM connections WHERE folder_id IS NULL AND group_id = ?1
                UNION ALL
                SELECT sort_order FROM folders WHERE parent_id IS NULL AND group_id = ?1
            )",
            params![group_id],
            |row| row.get(0),
        ).unwrap_or(0)
    };
    db.execute(
        "INSERT INTO connections (id, name, type, host, port, username, auth_type, key_path, folder_id, notes, description, domain, rdp_admin, sort_order, group_id, icon, url, custom_hosts, rdp_security, rdp_color_depth)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
        params![id, conn.name, conn.conn_type, conn.host, conn.port,
                conn.username, conn.auth_type, conn.key_path, conn.folder_id, conn.notes,
                conn.description, conn.domain, conn.rdp_admin as i64, sort_order, group_id,
                conn.icon, conn.url, conn.custom_hosts, conn.rdp_security, conn.rdp_color_depth],
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
         rdp_admin=?12,icon=?13,url=?14,custom_hosts=?15,rdp_security=?16,rdp_color_depth=?17,
         updated_at=datetime('now') WHERE id=?18",
        params![conn.name, conn.conn_type, conn.host, conn.port, conn.username,
                conn.auth_type, conn.key_path, conn.folder_id, conn.notes,
                conn.description, conn.domain, conn.rdp_admin as i64, conn.icon,
                conn.url, conn.custom_hosts, conn.rdp_security, conn.rdp_color_depth, conn.id],
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
            "UPDATE connections SET sort_order=?1, folder_id=?2, group_id=?3, updated_at=datetime('now') WHERE id=?4",
            params![item.sort_order, item.folder_id, item.group_id, item.id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn reorder_folders(updates: Vec<FolderReorderItem>) -> Result<(), String> {
    let db = db::open().map_err(|e| e.to_string())?;
    for item in updates {
        db.execute(
            "UPDATE folders SET sort_order=?1, parent_id=?2, group_id=?3 WHERE id=?4",
            params![item.sort_order, item.parent_id, item.group_id, item.id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn collect_subfolders(db: &rusqlite::Connection, parent_id: &str, result: &mut Vec<String>) -> Result<(), String> {
    let mut stmt = db.prepare("SELECT id FROM folders WHERE parent_id = ?1")
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt.query_map(params![parent_id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    for id in ids {
        collect_subfolders(db, &id, result)?;
        result.push(id);
    }
    Ok(())
}

/// Move a folder (and all its descendants + their connections) to the root of a target group.
#[tauri::command]
pub fn move_folder_to_group(folder_id: String, target_group_id: String) -> Result<(), String> {
    let db = db::open().map_err(|e| e.to_string())?;

    // Collect all descendant folder IDs
    let mut subfolder_ids: Vec<String> = Vec::new();
    collect_subfolders(&db, &folder_id, &mut subfolder_ids)?;

    // Place root folder at the top of the target group root scope
    let sort_order: i64 = db.query_row(
        "SELECT COALESCE(MIN(sort_order), 1) - 1 FROM (
            SELECT sort_order FROM connections WHERE folder_id IS NULL AND group_id = ?1
            UNION ALL
            SELECT sort_order FROM folders WHERE parent_id IS NULL AND group_id = ?1
        )",
        params![target_group_id],
        |row| row.get(0),
    ).unwrap_or(-1);

    // Move the root folder to target group at root level
    db.execute(
        "UPDATE folders SET group_id=?1, parent_id=NULL, sort_order=?2 WHERE id=?3",
        params![target_group_id, sort_order, folder_id],
    ).map_err(|e| e.to_string())?;

    // Update group_id for all subfolders (keep their relative parent_id)
    for sid in &subfolder_ids {
        db.execute(
            "UPDATE folders SET group_id=?1 WHERE id=?2",
            params![target_group_id, sid],
        ).map_err(|e| e.to_string())?;
    }

    // Update group_id for all connections inside the moved folder tree
    let mut all_folder_ids = vec![folder_id];
    all_folder_ids.extend(subfolder_ids);
    for fid in &all_folder_ids {
        db.execute(
            "UPDATE connections SET group_id=?1 WHERE folder_id=?2",
            params![target_group_id, fid],
        ).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn get_folders() -> Result<Vec<Folder>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, parent_id, group_id, sort_order FROM folders ORDER BY sort_order ASC, name COLLATE NOCASE")
        .map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        Ok(Folder {
            id: row.get(0)?,
            name: row.get(1)?,
            parent_id: row.get(2)?,
            expanded: true,
            group_id: row.get::<_, String>(3).unwrap_or_default(),
            sort_order: row.get(4).unwrap_or(0),
        })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string());
    rows
}

#[tauri::command]
pub fn save_folder(name: String, parent_id: Option<String>, group_id: Option<String>) -> Result<Folder, String> {
    let db = db::open().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();

    // If parent_id is set, inherit group_id from parent folder
    let resolved_group_id = if let Some(ref pid) = parent_id {
        db.query_row(
            "SELECT group_id FROM folders WHERE id = ?1",
            params![pid],
            |row| row.get::<_, String>(0),
        ).unwrap_or_else(|_| group_id.clone().unwrap_or_default())
    } else {
        group_id.ok_or_else(|| "group_id is required for root folders".to_string())?
    };

    // New folder appears at the top of its context (unified sort with connections).
    let sort_order: i64 = if let Some(ref pid) = parent_id {
        db.query_row(
            "SELECT COALESCE(MIN(sort_order), 1) - 1 FROM (
                SELECT sort_order FROM connections WHERE folder_id = ?1
                UNION ALL
                SELECT sort_order FROM folders WHERE parent_id = ?1
            )",
            params![pid],
            |row| row.get(0),
        ).unwrap_or(-1)
    } else {
        db.query_row(
            "SELECT COALESCE(MIN(sort_order), 1) - 1 FROM (
                SELECT sort_order FROM connections WHERE folder_id IS NULL AND group_id = ?1
                UNION ALL
                SELECT sort_order FROM folders WHERE parent_id IS NULL AND group_id = ?1
            )",
            params![resolved_group_id],
            |row| row.get(0),
        ).unwrap_or(-1)
    };

    db.execute(
        "INSERT INTO folders (id, name, parent_id, group_id, sort_order) VALUES (?1,?2,?3,?4,?5)",
        params![id, name, parent_id, resolved_group_id, sort_order],
    )
    .map_err(|e| e.to_string())?;
    Ok(Folder { id, name, parent_id, expanded: true, group_id: resolved_group_id, sort_order })
}

#[tauri::command]
pub fn delete_folder(id: String) -> Result<(), String> {
    let db = db::open().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM folders WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Groups ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_groups() -> Result<Vec<Group>, String> {
    let conn = db::open().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name FROM groups ORDER BY rowid DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(Group { id: row.get(0)?, name: row.get(1)? })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string());
    rows
}

#[tauri::command]
pub fn save_group(name: String) -> Result<Group, String> {
    let db = db::open().map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO groups (id, name) VALUES (?1, ?2)",
        params![id, name],
    )
    .map_err(|e| e.to_string())?;
    Ok(Group { id, name })
}

#[tauri::command]
pub fn rename_group(id: String, name: String) -> Result<(), String> {
    let db = db::open().map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE groups SET name = ?1 WHERE id = ?2",
        params![name, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_group(id: String) -> Result<(), String> {
    let db = db::open().map_err(|e| e.to_string())?;
    // Delete connections inside folders of this group
    db.execute(
        "DELETE FROM connections WHERE folder_id IN (SELECT id FROM folders WHERE group_id = ?1)",
        params![id],
    ).map_err(|e| e.to_string())?;
    // Delete root connections of this group
    db.execute(
        "DELETE FROM connections WHERE group_id = ?1 AND folder_id IS NULL",
        params![id],
    ).map_err(|e| e.to_string())?;
    // Delete folders of this group
    db.execute(
        "DELETE FROM folders WHERE group_id = ?1",
        params![id],
    ).map_err(|e| e.to_string())?;
    // Delete the group itself
    db.execute("DELETE FROM groups WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Export ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn export_connections() -> Result<String, String> {
    let conns = get_connections()?;
    let folders = get_folders()?;
    let groups = get_groups()?;
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
        "version": 3,
        "groups": groups,
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

    // Get default group id for backward compat
    let default_group_id: String = db.query_row(
        "SELECT id FROM groups LIMIT 1",
        [],
        |r| r.get(0),
    ).unwrap_or_default();

    // Build group id mapping: old id -> new id
    let mut group_id_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    if let Some(groups) = value["groups"].as_array() {
        for g in groups {
            let old_id = g["id"].as_str().unwrap_or("").to_string();
            let new_id = Uuid::new_v4().to_string();
            let name = g["name"].as_str().unwrap_or("Imported Group");
            let _ = db.execute(
                "INSERT OR IGNORE INTO groups (id, name) VALUES (?1, ?2)",
                params![new_id, name],
            );
            group_id_map.insert(old_id, new_id);
        }
    }

    // Import folders first (preserving IDs so connection→folder links stay valid)
    if let Some(folders) = value["folders"].as_array() {
        for f in folders {
            let old_group_id = f["group_id"].as_str().unwrap_or("").to_string();
            let resolved_group_id = if old_group_id.is_empty() {
                default_group_id.clone()
            } else {
                group_id_map.get(&old_group_id).cloned().unwrap_or_else(|| default_group_id.clone())
            };
            let _ = db.execute(
                "INSERT OR IGNORE INTO folders (id, name, parent_id, group_id) VALUES (?1, ?2, ?3, ?4)",
                params![
                    f["id"].as_str().unwrap_or(""),
                    f["name"].as_str().unwrap_or("Imported Folder"),
                    f["parent_id"].as_str(),
                    resolved_group_id,
                ],
            );
        }
    }

    let conns = value["connections"].as_array().ok_or("missing connections")?;
    for item in conns {
        let id = Uuid::new_v4().to_string();
        let old_group_id = item["group_id"].as_str().unwrap_or("").to_string();
        let resolved_group_id = if old_group_id.is_empty() {
            default_group_id.clone()
        } else {
            group_id_map.get(&old_group_id).cloned().unwrap_or_else(|| default_group_id.clone())
        };
        let ok = db.execute(
            "INSERT OR IGNORE INTO connections
             (id,name,type,host,port,username,auth_type,key_path,folder_id,notes,description,domain,group_id)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
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
                resolved_group_id,
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

/// mRemoteNG's default password used to encrypt the per-connection password
/// fields when the user doesn't set a custom one.
const MRNG_DEFAULT_PASSWORD: &str = "mR3m";

/// Decrypt a single mRemoteNG password field.
///
/// Layout of the Base64-decoded blob (AES-GCM / "Confidential" engine):
///   [ salt: 16 ][ nonce: 16 ][ ciphertext + tag ]
/// The key is PBKDF2-HMAC-SHA1(password, salt, iterations) → 32 bytes, and the
/// salt is also fed in as the GCM associated data. Returns `None` on any
/// failure (wrong password, corrupt data) so the import can continue without
/// that password rather than aborting the whole migration.
fn mrng_decrypt_password(b64: &str, password: &str, iterations: u32) -> Option<String> {
    use aes_gcm::aead::{consts::U16, generic_array::GenericArray, Aead, KeyInit, Payload};
    use aes_gcm::{aes::Aes256, AesGcm};
    use base64::{engine::general_purpose::STANDARD, Engine};

    let data = STANDARD.decode(b64.trim()).ok()?;
    if data.len() < 16 + 16 + 16 {
        return None; // need at least salt + nonce + tag
    }
    let (salt, rest) = data.split_at(16);
    let (nonce, ciphertext) = rest.split_at(16);

    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), salt, iterations, &mut key);

    type Aes256Gcm16 = AesGcm<Aes256, U16>;
    let cipher = Aes256Gcm16::new(GenericArray::from_slice(&key));
    let plaintext = cipher
        .decrypt(GenericArray::from_slice(nonce), Payload { msg: ciphertext, aad: salt })
        .ok()?;
    String::from_utf8(plaintext).ok()
}

/// Map an mRemoteNG protocol to an OrbitalTerm connection type. Returns `None`
/// for protocols OrbitalTerm can't represent (Telnet, RAW, ICA, …) so we don't
/// create useless connections.
fn mrng_protocol_to_type(proto: &str) -> Option<&'static str> {
    match proto.to_uppercase().as_str() {
        "SSH2" | "SSH1" => Some("ssh"),
        "RDP"           => Some("rdp"),
        "VNC"           => Some("vnc"),
        "HTTP" | "HTTPS" => Some("browser"),
        _               => None,
    }
}

fn mrng_default_port(conn_type: &str) -> i64 {
    match conn_type {
        "ssh"     => 22,
        "rdp"     => 3389,
        "vnc"     => 5900,
        "browser" => 443,
        _         => 22,
    }
}

/// Pick an OrbitalTerm icon key, preferring mRemoteNG's icon name when it maps
/// to one of ours, otherwise falling back to a sensible default per type.
fn mrng_icon(icon: &str, conn_type: &str) -> &'static str {
    match icon.to_lowercase().as_str() {
        "linux" | "putty"                 => "linux",
        "remote desktop" | "windows" | "workstation" => "windows",
        "domain controller"              => "activedir",
        "file server" | "backup"          => "fileserver",
        "mail server" | "web server"      => "webserver",
        "database"                        => "database",
        _ => match conn_type {
            "ssh"     => "linux",
            "rdp"     => "windows",
            "vnc"     => "vnc",
            "browser" => "browser",
            _         => "windows",
        },
    }
}

/// Progress payload emitted to the frontend during a (potentially large) import
/// so it can render a non-blocking progress indicator.
#[derive(Serialize, Clone)]
struct ImportProgress {
    name: String,
    done: usize,
    total: usize,
}

/// Count how many `Connection` nodes the tree holds, for progress totals.
fn mrng_count_connections(node: roxmltree::Node) -> usize {
    node.children()
        .filter(|n| n.is_element() && n.has_tag_name("Node"))
        .map(|child| match child.attribute("Type").unwrap_or("") {
            "Connection" => 1,
            "Container" => mrng_count_connections(child),
            _ => 0,
        })
        .sum()
}

struct MrngCtx<'a> {
    db: &'a rusqlite::Connection,
    group_id: &'a str,
    password: &'a str,
    iterations: u32,
    count: usize,             // connections actually inserted
    processed: usize,         // connection nodes seen (incl. skipped) — drives %
    total: usize,
    last_emit: usize,
    app: Option<&'a tauri::AppHandle>,
    name: &'a str,
}

impl MrngCtx<'_> {
    /// Emit a throttled progress event (every ~20 nodes, plus the final one).
    fn maybe_emit(&mut self) {
        let Some(app) = self.app else { return };
        if self.processed - self.last_emit >= 20 || self.processed >= self.total {
            use tauri::Emitter;
            self.last_emit = self.processed;
            let _ = app.emit("mrng-import-progress", ImportProgress {
                name: self.name.to_string(),
                done: self.processed,
                total: self.total,
            });
        }
    }
}

/// Recurse into the mRemoteNG XML tree, translating only the fields OrbitalTerm
/// actually uses and dropping the rest of mRemoteNG's extensive per-node config.
/// `parent_folder_id` = the OrbitalTerm folder ID to put children into (None = root).
fn mrng_process_node(node: roxmltree::Node, parent_folder_id: Option<&str>, ctx: &mut MrngCtx) {
    for child in node.children().filter(|n| n.is_element() && n.has_tag_name("Node")) {
        let node_type = child.attribute("Type").unwrap_or("");
        let name = child.attribute("Name").unwrap_or("Imported");

        match node_type {
            "Container" => {
                let folder_id = Uuid::new_v4().to_string();
                let _ = ctx.db.execute(
                    "INSERT OR IGNORE INTO folders (id, name, parent_id, group_id) VALUES (?1, ?2, ?3, ?4)",
                    params![folder_id, name, parent_folder_id, ctx.group_id],
                );
                mrng_process_node(child, Some(&folder_id), ctx);
            }
            "Connection" => {
                ctx.processed += 1;
                ctx.maybe_emit();
                let proto = child.attribute("Protocol").unwrap_or("SSH2");
                let conn_type = match mrng_protocol_to_type(proto) {
                    Some(t) => t,
                    None => continue, // unsupported protocol — skip, don't create junk
                };
                let host = child.attribute("Hostname").unwrap_or("");
                let port: i64 = child.attribute("Port")
                    .and_then(|p| p.parse().ok())
                    .unwrap_or_else(|| mrng_default_port(conn_type));
                let username = child.attribute("Username").unwrap_or("");
                // mRemoteNG stores the note in `Descr`, not `Description`.
                let description = child.attribute("Descr").unwrap_or("");
                let domain = child.attribute("Domain").unwrap_or("");
                let icon = mrng_icon(child.attribute("Icon").unwrap_or(""), conn_type);
                // For HTTP/HTTPS turn the host into a browser URL.
                let url = match conn_type {
                    "browser" if !host.is_empty() => {
                        let scheme = if proto.eq_ignore_ascii_case("https") { "https" } else { "http" };
                        format!("{scheme}://{host}")
                    }
                    _ => String::new(),
                };

                // Decrypt the password if present; on failure import without it.
                let password = child.attribute("Password")
                    .filter(|p| !p.is_empty())
                    .and_then(|p| mrng_decrypt_password(p, ctx.password, ctx.iterations));

                let id = Uuid::new_v4().to_string();
                let ok = ctx.db.execute(
                    "INSERT OR IGNORE INTO connections
                     (id,name,type,host,port,username,auth_type,key_path,folder_id,notes,description,domain,group_id,icon,url)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                    params![
                        id, name, conn_type, host, port, username,
                        "password", "", parent_folder_id,
                        "", description, domain, ctx.group_id, icon, url,
                    ],
                ).is_ok();

                if ok {
                    if let Some(pw) = password {
                        if !pw.is_empty() {
                            let _ = ctx.db.execute(
                                "INSERT OR REPLACE INTO passwords (connection_id, password) VALUES (?1, ?2)",
                                params![id, pw],
                            );
                        }
                    }
                    ctx.count += 1;
                }
            }
            _ => {}
        }
    }
}

/// Core mRemoteNG import. When `app` is provided, throttled progress events are
/// emitted as `mrng-import-progress`. Runs synchronously; callers that need it
/// off the UI thread spawn it on a background thread (see the command below).
fn run_mrng_import(
    app: Option<&tauri::AppHandle>,
    path: &str,
    password: Option<String>,
) -> Result<usize, String> {
    let xml = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let doc = roxmltree::Document::parse(&xml).map_err(|e| e.to_string())?;
    let root = doc.root_element();

    // Whole-file encryption is a different format we don't support yet.
    if root.attribute("FullFileEncryption").map(|v| v == "true").unwrap_or(false) {
        return Err("This mRemoteNG file uses full-file encryption, which isn't supported. Re-export with 'Encrypt complete connection file' disabled.".into());
    }

    let iterations: u32 = root.attribute("KdfIterations")
        .and_then(|v| v.parse().ok())
        .unwrap_or(1000);
    let pw = password.unwrap_or_else(|| MRNG_DEFAULT_PASSWORD.to_string());

    // The migration lands in its own fresh connections DB (group), named after
    // the imported file, instead of polluting the user's existing DB.
    let group_name = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("mRemoteNG")
        .to_string();

    let total = mrng_count_connections(root);
    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit("mrng-import-progress", ImportProgress { name: group_name.clone(), done: 0, total });
    }

    let mut db = db::open().map_err(|e| e.to_string())?;

    // One transaction for the whole tree — large files (thousands of nodes)
    // import in a fraction of the time vs. per-row autocommit.
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let group_id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO groups (id, name) VALUES (?1, ?2)",
        params![group_id, group_name],
    ).map_err(|e| e.to_string())?;

    let mut ctx = MrngCtx {
        db: &tx,
        group_id: &group_id,
        password: &pw,
        iterations,
        count: 0,
        processed: 0,
        total,
        last_emit: 0,
        app,
        name: &group_name,
    };
    mrng_process_node(root, None, &mut ctx);
    let count = ctx.count;
    tx.commit().map_err(|e| e.to_string())?;

    if let Some(app) = app {
        use tauri::Emitter;
        let _ = app.emit("mrng-import-progress", ImportProgress { name: group_name, done: total, total });
    }
    Ok(count)
}

/// Imports an mRemoteNG file on a background thread so the UI (and any live RDP
/// session) stays responsive. Progress, completion and errors are delivered via
/// the `mrng-import-progress` / `mrng-import-done` / `mrng-import-error` events.
#[tauri::command]
pub fn import_from_mremoteng(app: tauri::AppHandle, path: String, password: Option<String>) {
    std::thread::spawn(move || {
        use tauri::Emitter;
        match run_mrng_import(Some(&app), &path, password) {
            Ok(count) => { let _ = app.emit("mrng-import-done", count); }
            Err(e)    => { let _ = app.emit("mrng-import-error", e); }
        }
    });
}

// ── File helpers ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn export_to_file(path: String) -> Result<(), String> {
    let json = export_connections()?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

// ── Selective export ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn export_selected_to_file(
    group_ids: Vec<String>,
    include_passwords: bool,
    path: String,
) -> Result<usize, String> {
    let all_folders = get_folders()?;
    let all_conns = get_connections()?;
    let all_groups = get_groups()?;
    let db = db::open().map_err(|e| e.to_string())?;

    let group_set: std::collections::HashSet<&str> =
        group_ids.iter().map(|s| s.as_str()).collect();

    // All folders that belong to the selected groups
    let exported_folder_ids: std::collections::HashSet<String> = all_folders
        .iter()
        .filter(|f| group_set.contains(f.group_id.as_str()))
        .map(|f| f.id.clone())
        .collect();

    let exported_folders: Vec<&Folder> = all_folders
        .iter()
        .filter(|f| group_set.contains(f.group_id.as_str()))
        .collect();

    let exported_groups: Vec<&Group> = all_groups
        .iter()
        .filter(|g| group_set.contains(g.id.as_str()))
        .collect();

    // Connections: in a selected group's folder OR root connection of a selected group
    let exported_conns: Vec<serde_json::Value> = all_conns
        .iter()
        .filter(|c| match &c.folder_id {
            Some(fid) => exported_folder_ids.contains(fid),
            None => group_set.contains(c.group_id.as_str()),
        })
        .map(|c| {
            let mut v = serde_json::to_value(c).unwrap_or_default();
            if include_passwords {
                let pw: Option<String> = db.query_row(
                    "SELECT password FROM passwords WHERE connection_id = ?1",
                    params![c.id],
                    |row| row.get(0),
                ).ok();
                if let Some(p) = pw {
                    v["password"] = serde_json::Value::String(p);
                }
            }
            v
        })
        .collect();

    let count = exported_conns.len();
    let json = serde_json::to_string_pretty(&serde_json::json!({
        "version": 3,
        "groups": exported_groups,
        "connections": exported_conns,
        "folders": exported_folders,
    }))
    .map_err(|e| e.to_string())?;

    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub fn import_from_file(path: String) -> Result<usize, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // Detect format by file extension
    if path.to_lowercase().ends_with(".xml") {
        run_mrng_import(None, &path, None)
    } else {
        import_connections(content)
    }
}
