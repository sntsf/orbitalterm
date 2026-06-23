//! Password encryption at rest.
//!
//! Saved passwords are encrypted with AES-256-GCM before being written to the
//! SQLite database. The key is a random 256-bit value generated on first run
//! and stored in `secret.key` next to the database (0600 on Unix). This
//! protects the password column if the `.db` file alone is copied/leaked;
//! someone with full filesystem access to both files can still decrypt (there
//! is no master password — that's the trade-off for the eye-button reveal and
//! unattended reconnects working without prompting).
//!
//! Stored format: `enc:v1:` + base64(nonce[12] || ciphertext+tag). Values
//! without the prefix are treated as legacy plaintext so old databases keep
//! working until they're re-encrypted.

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};

const PREFIX: &str = "enc:v1:";

fn key_path() -> PathBuf {
    let mut p = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("orbitalterm");
    std::fs::create_dir_all(&p).ok();
    p.push("secret.key");
    p
}

fn load_or_create_key() -> Vec<u8> {
    let path = key_path();
    if let Ok(bytes) = fs::read(&path) {
        if bytes.len() == 32 {
            return bytes;
        }
    }
    let key = Aes256Gcm::generate_key(&mut OsRng);
    let bytes = key.to_vec();
    if fs::write(&path, &bytes).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
    }
    bytes
}

fn key() -> &'static Vec<u8> {
    static KEY: OnceLock<Vec<u8>> = OnceLock::new();
    KEY.get_or_init(load_or_create_key)
}

fn cipher() -> Aes256Gcm {
    Aes256Gcm::new_from_slice(key()).expect("32-byte key")
}

/// True if a stored value is already in the encrypted format.
pub fn is_encrypted(stored: &str) -> bool {
    stored.starts_with(PREFIX)
}

/// Encrypt a plaintext password to the `enc:v1:` storage format. On any
/// (unexpected) failure the plaintext is returned so a password is never lost.
pub fn encrypt(plaintext: &str) -> String {
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    match cipher().encrypt(&nonce, plaintext.as_bytes()) {
        Ok(ct) => {
            let mut buf = Vec::with_capacity(nonce.len() + ct.len());
            buf.extend_from_slice(&nonce);
            buf.extend_from_slice(&ct);
            format!("{PREFIX}{}", STANDARD.encode(buf))
        }
        Err(_) => plaintext.to_string(),
    }
}

/// Decrypt a stored value. Values without the `enc:v1:` prefix are returned
/// as-is (legacy plaintext). A corrupt/undecryptable value yields "".
pub fn decrypt(stored: &str) -> String {
    let Some(b64) = stored.strip_prefix(PREFIX) else {
        return stored.to_string();
    };
    let Ok(data) = STANDARD.decode(b64) else {
        return String::new();
    };
    if data.len() < 12 + 16 {
        return String::new();
    }
    let (nonce_bytes, ct) = data.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    match cipher().decrypt(nonce, ct) {
        Ok(pt) => String::from_utf8(pt).unwrap_or_default(),
        Err(_) => String::new(),
    }
}

// ── Master password (view lock) ─────────────────────────────────────────────
//
// A separate "view lock": gates revealing connection passwords in the UI. It
// does NOT protect the stored passwords (those use the key above so connections
// keep working unattended) — it's shoulder-surfing protection. The verifier is
// a PBKDF2 hash kept in `master.lock` next to the DB, so a user who forgets it
// can reset the lock by deleting that one file WITHOUT losing any connection.

const MASTER_ITERS: u32 = 200_000;

fn master_path() -> PathBuf {
    let mut p = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("orbitalterm");
    std::fs::create_dir_all(&p).ok();
    p.push("master.lock");
    p
}

fn pbkdf2_hash(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut hash = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), salt, MASTER_ITERS, &mut hash);
    hash
}

/// Whether a master password (view lock) has been configured.
pub fn master_is_set() -> bool {
    master_path().exists()
}

/// Store/overwrite the master password verifier (random salt + PBKDF2 hash).
pub fn master_set(password: &str) -> Result<(), String> {
    // Reuse the AES key generator for 16 random salt bytes.
    let rnd = Aes256Gcm::generate_key(&mut OsRng);
    let salt = &rnd[..16];
    let hash = pbkdf2_hash(password, salt);
    let mut buf = Vec::with_capacity(48);
    buf.extend_from_slice(salt);
    buf.extend_from_slice(&hash);
    fs::write(master_path(), STANDARD.encode(buf)).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(master_path(), fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Verify a candidate master password against the stored verifier.
pub fn master_verify(password: &str) -> bool {
    let Ok(content) = fs::read_to_string(master_path()) else {
        return false;
    };
    let Ok(data) = STANDARD.decode(content.trim()) else {
        return false;
    };
    if data.len() != 48 {
        return false;
    }
    let (salt, expected) = data.split_at(16);
    pbkdf2_hash(password, salt).as_slice() == expected
}

