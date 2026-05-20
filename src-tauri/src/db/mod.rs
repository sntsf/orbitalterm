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

        CREATE TABLE IF NOT EXISTS passwords (
            connection_id TEXT PRIMARY KEY NOT NULL,
            password      TEXT NOT NULL
        );
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
    conn.execute(
        "ALTER TABLE connections ADD COLUMN rdp_admin INTEGER NOT NULL DEFAULT 0",
        [],
    ).ok();
    conn.execute(
        "ALTER TABLE connections ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
        [],
    ).ok();

    // Schema version migration: remove restrictive CHECK(type IN ('ssh','rdp'))
    conn.execute_batch("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL DEFAULT 0);")?;
    conn.execute("INSERT OR IGNORE INTO schema_version (version) VALUES (0)", [])?;
    let ver: i64 = conn.query_row("SELECT version FROM schema_version", [], |r| r.get(0))?;
    if ver < 1 {
        conn.execute_batch("
            PRAGMA foreign_keys=OFF;
            CREATE TABLE IF NOT EXISTS connections_new (
                id          TEXT PRIMARY KEY NOT NULL,
                name        TEXT NOT NULL,
                type        TEXT NOT NULL,
                host        TEXT NOT NULL,
                port        INTEGER NOT NULL,
                username    TEXT NOT NULL DEFAULT '',
                auth_type   TEXT NOT NULL DEFAULT 'agent',
                key_path    TEXT NOT NULL DEFAULT '',
                folder_id   TEXT,
                notes       TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                domain      TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT OR IGNORE INTO connections_new SELECT id,name,type,host,port,username,
                COALESCE(auth_type,'agent'),COALESCE(key_path,''),folder_id,
                COALESCE(notes,''),COALESCE(description,''),COALESCE(domain,''),created_at,updated_at
            FROM connections;
            DROP TABLE connections;
            ALTER TABLE connections_new RENAME TO connections;
            CREATE INDEX IF NOT EXISTS idx_connections_folder ON connections(folder_id);
            CREATE INDEX IF NOT EXISTS idx_connections_name ON connections(name COLLATE NOCASE);
            PRAGMA foreign_keys=ON;
            UPDATE schema_version SET version=1;
        ")?;
    }

    Ok(())
}
