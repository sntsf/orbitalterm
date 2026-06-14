use rusqlite::{Connection, Result};
use std::path::PathBuf;
use dirs::data_dir;
use uuid::Uuid;

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

    if ver < 2 {
        // Create groups table
        conn.execute_batch("
            CREATE TABLE IF NOT EXISTS groups (
                id   TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL
            );
        ")?;

        // Add group_id columns (errors mean already exists)
        conn.execute(
            "ALTER TABLE folders ADD COLUMN group_id TEXT NOT NULL DEFAULT ''",
            [],
        ).ok();
        conn.execute(
            "ALTER TABLE connections ADD COLUMN group_id TEXT NOT NULL DEFAULT ''",
            [],
        ).ok();

        // Create default group only if table is empty
        let group_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM groups", [], |r| r.get(0)
        ).unwrap_or(0);
        let default_group_id = if group_count == 0 {
            let gid = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO groups (id, name) VALUES (?1, 'Conexiones')",
                rusqlite::params![gid],
            )?;
            gid
        } else {
            conn.query_row("SELECT id FROM groups LIMIT 1", [], |r| r.get(0))?
        };

        // Update all existing folders and connections with the default group id
        conn.execute(
            "UPDATE folders SET group_id = ?1 WHERE group_id = ''",
            rusqlite::params![default_group_id],
        )?;
        conn.execute(
            "UPDATE connections SET group_id = ?1 WHERE group_id = ''",
            rusqlite::params![default_group_id],
        )?;

        conn.execute("UPDATE schema_version SET version=2", [])?;
    }

    if ver < 3 {
        conn.execute(
            "ALTER TABLE connections ADD COLUMN icon TEXT NOT NULL DEFAULT ''",
            [],
        ).ok();
        conn.execute("UPDATE schema_version SET version=3", [])?;
    }

    if ver < 4 {
        conn.execute(
            "ALTER TABLE connections ADD COLUMN url TEXT NOT NULL DEFAULT ''",
            [],
        ).ok();
        conn.execute(
            "ALTER TABLE connections ADD COLUMN custom_hosts TEXT NOT NULL DEFAULT ''",
            [],
        ).ok();
        conn.execute("UPDATE schema_version SET version=4", [])?;
    }

    if ver < 5 {
        conn.execute(
            "ALTER TABLE connections ADD COLUMN rdp_security TEXT NOT NULL DEFAULT 'negotiate'",
            [],
        ).ok();
        conn.execute(
            "ALTER TABLE connections ADD COLUMN rdp_color_depth INTEGER NOT NULL DEFAULT 32",
            [],
        ).ok();
        conn.execute("UPDATE schema_version SET version=5", [])?;
    }

    // Idempotent: add sort_order to folders (error = column already exists, safe to ignore)
    conn.execute(
        "ALTER TABLE folders ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
        [],
    ).ok();

    if ver < 6 {
        // Seed sort_order for existing folders. Each folder gets a negative value based
        // on its alphabetical rank within its parent scope, so existing folders stay before
        // existing connections (sort_order 0+) and new items (MIN-1) land above all.
        conn.execute_batch("
            UPDATE folders SET sort_order = (
                SELECT -COUNT(*) * 10 FROM folders f2
                WHERE f2.group_id = folders.group_id
                  AND (f2.parent_id = folders.parent_id OR (f2.parent_id IS NULL AND folders.parent_id IS NULL))
                  AND f2.name COLLATE NOCASE <= folders.name COLLATE NOCASE
            )
            WHERE sort_order = 0;
        ")?;
        conn.execute("UPDATE schema_version SET version=6", [])?;
    }

    if ver < 7 {
        // Folders and groups gain a description and a color (used to tint their
        // icon) so they can be edited in the properties panel.
        conn.execute("ALTER TABLE folders ADD COLUMN description TEXT NOT NULL DEFAULT ''", []).ok();
        conn.execute("ALTER TABLE folders ADD COLUMN color TEXT NOT NULL DEFAULT ''", []).ok();
        conn.execute("ALTER TABLE groups  ADD COLUMN description TEXT NOT NULL DEFAULT ''", []).ok();
        conn.execute("ALTER TABLE groups  ADD COLUMN color TEXT NOT NULL DEFAULT ''", []).ok();
        conn.execute("UPDATE schema_version SET version=7", [])?;
    }

    if ver < 8 {
        // SSH port-forwarding tunnels (one spec per line).
        conn.execute("ALTER TABLE connections ADD COLUMN tunnels TEXT NOT NULL DEFAULT ''", []).ok();
        conn.execute("UPDATE schema_version SET version=8", [])?;
    }

    if ver < 9 {
        // RDP: local drive redirection + RD Gateway host.
        conn.execute("ALTER TABLE connections ADD COLUMN rdp_redirect_drives INTEGER NOT NULL DEFAULT 0", []).ok();
        conn.execute("ALTER TABLE connections ADD COLUMN rdp_gateway TEXT NOT NULL DEFAULT ''", []).ok();
        conn.execute("UPDATE schema_version SET version=9", [])?;
    }

    Ok(())
}
