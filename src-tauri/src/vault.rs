use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroize;

const VAULT_FILE: &str = "hosts.vault";
const VAULT_VERSION: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

#[derive(Debug, Serialize, Deserialize)]
struct VaultFile {
    version: u32,
    kdf: String,
    argon2_m_cost: u32,
    argon2_t_cost: u32,
    argon2_p_cost: u32,
    salt: String,
    nonce: String,
    ciphertext: String,
}

struct VaultState {
    key: Option<[u8; KEY_LEN]>,
    salt: Option<[u8; SALT_LEN]>,
}

impl VaultState {
    fn new() -> Self {
        Self {
            key: None,
            salt: None,
        }
    }

    fn clear(&mut self) {
        if let Some(mut k) = self.key.take() {
            k.zeroize();
        }
        self.salt = None;
    }
}

pub struct Vault {
    inner: Mutex<VaultState>,
}

impl Vault {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(VaultState::new()),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
}

fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create data dir {}: {}", dir.display(), e))?;
    Ok(dir.join(VAULT_FILE))
}

fn argon2_params() -> Result<Params, String> {
    // ~64 MiB memory, 3 iterations, 1 lane — strong for desktop apps.
    Params::new(64 * 1024, 3, 1, Some(KEY_LEN)).map_err(|e| e.to_string())
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], String> {
    let params = argon2_params()?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; KEY_LEN];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| format!("argon2: {}", e))?;
    Ok(out)
}

fn write_vault_file(path: &Path, key: &[u8; KEY_LEN], salt: &[u8; SALT_LEN], plaintext: &[u8]) -> Result<(), String> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("aes key: {}", e))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("encrypt: {}", e))?;

    let params = argon2_params()?;
    let file = VaultFile {
        version: VAULT_VERSION,
        kdf: "argon2id".to_string(),
        argon2_m_cost: params.m_cost(),
        argon2_t_cost: params.t_cost(),
        argon2_p_cost: params.p_cost(),
        salt: B64.encode(salt),
        nonce: B64.encode(nonce_bytes),
        ciphertext: B64.encode(&ciphertext),
    };

    let data = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;

    // Atomic write via temp file + rename.
    let tmp = path.with_extension("vault.tmp");
    fs::write(&tmp, &data).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename {}: {}", tmp.display(), e))?;
    Ok(())
}

fn decrypt_vault_file_with_key(path: &Path, key: &[u8; KEY_LEN]) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|e| format!("read vault blob {}: {}", path.display(), e))?;
    let file: VaultFile = serde_json::from_slice(&bytes).map_err(|e| format!("parse vault blob: {}", e))?;
    if file.version != VAULT_VERSION {
        return Err(format!("Unsupported vault version: {}", file.version));
    }
    let nonce_vec = B64.decode(file.nonce.as_bytes()).map_err(|e| e.to_string())?;
    if nonce_vec.len() != NONCE_LEN {
        return Err("Invalid nonce length".to_string());
    }
    let ciphertext = B64.decode(file.ciphertext.as_bytes()).map_err(|e| e.to_string())?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("aes key: {}", e))?;
    let nonce = Nonce::from_slice(&nonce_vec);
    cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "decrypt failed".to_string())
}

pub(crate) fn vault_write_encrypted_blob(
    app: &AppHandle,
    vault: &State<'_, Vault>,
    file_name: &str,
    plaintext: &[u8],
) -> Result<(), String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {}", e))?;
    fs::create_dir_all(&base).map_err(|e| format!("create data dir {}: {}", base.display(), e))?;
    let path = base.join(file_name);
    let inner = vault.inner.lock().map_err(|_| "Vault lock poisoned".to_string())?;
    let key = inner.key.ok_or_else(|| "Vault is locked".to_string())?;
    let salt = inner.salt.ok_or_else(|| "Vault is locked".to_string())?;
    write_vault_file(&path, &key, &salt, plaintext)
}

pub(crate) fn vault_read_encrypted_blob(
    app: &AppHandle,
    vault: &State<'_, Vault>,
    file_name: &str,
) -> Result<Option<Vec<u8>>, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {}", e))?;
    let path = base.join(file_name);
    if !path.exists() {
        return Ok(None);
    }
    let inner = vault.inner.lock().map_err(|_| "Vault lock poisoned".to_string())?;
    let key = inner.key.ok_or_else(|| "Vault is locked".to_string())?;
    let plain = decrypt_vault_file_with_key(&path, &key)?;
    Ok(Some(plain))
}

#[tauri::command]
pub fn vault_status(app: AppHandle, vault: State<'_, Vault>) -> Result<VaultStatus, String> {
    let path = vault_path(&app)?;
    let initialized = path.exists();
    let inner = vault.inner.lock().map_err(|_| "Vault lock poisoned".to_string())?;
    Ok(VaultStatus {
        initialized,
        unlocked: inner.key.is_some(),
    })
}

#[tauri::command]
pub fn vault_init(
    app: AppHandle,
    vault: State<'_, Vault>,
    password: String,
) -> Result<(), String> {
    if password.len() < 8 {
        return Err("Master password must be at least 8 characters".to_string());
    }
    let path = vault_path(&app)?;
    if path.exists() {
        return Err("Vault already exists. Use unlock instead.".to_string());
    }

    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let key = derive_key(&password, &salt)?;
    write_vault_file(&path, &key, &salt, b"[]")?;

    let mut inner = vault.inner.lock().map_err(|_| "Vault lock poisoned".to_string())?;
    inner.clear();
    inner.key = Some(key);
    inner.salt = Some(salt);
    Ok(())
}

#[tauri::command]
pub fn vault_unlock(
    app: AppHandle,
    vault: State<'_, Vault>,
    password: String,
) -> Result<String, String> {
    let path = vault_path(&app)?;
    if !path.exists() {
        return Err("Vault not initialized".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| format!("read vault: {}", e))?;
    let file: VaultFile = serde_json::from_slice(&bytes).map_err(|e| format!("parse vault: {}", e))?;
    if file.version != VAULT_VERSION {
        return Err(format!("Unsupported vault version: {}", file.version));
    }

    let salt_vec = B64.decode(file.salt.as_bytes()).map_err(|e| e.to_string())?;
    let salt: [u8; SALT_LEN] = salt_vec
        .as_slice()
        .try_into()
        .map_err(|_| "Invalid salt length".to_string())?;
    let nonce_vec = B64.decode(file.nonce.as_bytes()).map_err(|e| e.to_string())?;
    if nonce_vec.len() != NONCE_LEN {
        return Err("Invalid nonce length".to_string());
    }
    let ciphertext = B64.decode(file.ciphertext.as_bytes()).map_err(|e| e.to_string())?;

    let key = derive_key(&password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("aes key: {}", e))?;
    let nonce = Nonce::from_slice(&nonce_vec);
    let plain = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "Incorrect password or corrupted vault".to_string())?;

    let text = String::from_utf8(plain).map_err(|e| format!("invalid utf8: {}", e))?;

    let mut inner = vault.inner.lock().map_err(|_| "Vault lock poisoned".to_string())?;
    inner.clear();
    inner.key = Some(key);
    inner.salt = Some(salt);
    Ok(text)
}

#[tauri::command]
pub fn vault_lock(vault: State<'_, Vault>) -> Result<(), String> {
    let mut inner = vault.inner.lock().map_err(|_| "Vault lock poisoned".to_string())?;
    inner.clear();
    Ok(())
}

#[tauri::command]
pub fn vault_save(
    app: AppHandle,
    vault: State<'_, Vault>,
    hosts_json: String,
) -> Result<(), String> {
    let path = vault_path(&app)?;
    let inner = vault.inner.lock().map_err(|_| "Vault lock poisoned".to_string())?;
    let key = inner
        .key
        .ok_or_else(|| "Vault is locked".to_string())?;
    let salt = inner
        .salt
        .ok_or_else(|| "Vault is locked".to_string())?;
    write_vault_file(&path, &key, &salt, hosts_json.as_bytes())
}

#[tauri::command]
pub fn vault_change_password(
    app: AppHandle,
    vault: State<'_, Vault>,
    new_password: String,
    hosts_json: String,
) -> Result<(), String> {
    if new_password.len() < 8 {
        return Err("Master password must be at least 8 characters".to_string());
    }
    // Keep this whole operation under one lock to avoid TOCTOU races.
    let mut inner = vault.inner.lock().map_err(|_| "Vault lock poisoned".to_string())?;
    if inner.key.is_none() {
        return Err("Vault is locked".to_string());
    }
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let key = derive_key(&new_password, &salt)?;
    let path = vault_path(&app)?;
    write_vault_file(&path, &key, &salt, hosts_json.as_bytes())?;

    inner.clear();
    inner.key = Some(key);
    inner.salt = Some(salt);
    Ok(())
}
