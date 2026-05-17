use rusqlite::{Connection, Result};
use std::path::PathBuf;
use dirs::data_dir;

pub fn db_path() -> PathBuf {
    let mut path = data_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("orbitalterm");
    std::fs::create_dir_all(&path).ok();
    path.push("orbitalterm.db");
    path
}

pub fn open() -> Result<Connection> {
    let conn = Connection::open(db_path())?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS folders (
            id          TEXT PRIMARY KEY NOT NULL,
            name        TEXT NOT NULL,
            parent_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS connections (
            id          TEXT PRIMARY KEY NOT NULL,
            name        TEXT NOT NULL,
            type        TEXT NOT NULL CHECK(type IN ('ssh','rdp')),
            host        TEXT NOT NULL,
            port        INTEGER NOT NULL,
            username    TEXT NOT NULL,
            auth_type   TEXT NOT NULL DEFAULT 'agent',
            key_path    TEXT NOT NULL DEFAULT '',
            folder_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
            notes       TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            domain      TEXT NOT NULL DEFAULT '',
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_connections_folder ON connections(folder_id);
        CREATE INDEX IF NOT EXISTS idx_connections_name   ON connections(name COLLATE NOCASE);
    ")?;

    // Idempotent migrations for existing DBs — errors mean column already exists
    conn.execute(
        "ALTER TABLE connections ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'agent'",
        [],
    ).ok();
    conn.execute(
        "ALTER TABLE connections ADD COLUMN key_path TEXT NOT NULL DEFAULT ''",
        [],
    ).ok();
    conn.execute(
        "ALTER TABLE connections ADD COLUMN description TEXT NOT NULL DEFAULT ''",
        [],
    ).ok();
    conn.execute(
        "ALTER TABLE connections ADD COLUMN domain TEXT NOT NULL DEFAULT ''",
        [],
    ).ok();

    Ok(())
}
