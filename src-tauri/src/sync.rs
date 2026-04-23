use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, AUTHORIZATION, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const SYNC_FILE: &str = "sync.json";
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const GIST_FILENAME: &str = "rsshu-sync.txt";

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SyncConfig {
    enabled: bool,
    gist_id: String,
    key_b64: String,
    github_token: String,
}

#[derive(Default)]
struct SyncRuntime {
    config: Option<SyncConfig>,
    last_payload: Option<String>,
    last_uuid: Option<String>,
}

pub struct SyncState {
    inner: Mutex<SyncRuntime>,
}

impl SyncState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SyncRuntime::default()),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SyncStatus {
    pub enabled: bool,
    pub gist_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SyncEnableRequest {
    pub github_token: String,
    pub gist_id: Option<String>,
    pub sync_key: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SyncEnableResponse {
    pub gist_id: String,
    pub sync_key: String,
}

#[derive(Debug, Serialize)]
pub struct SyncPollResponse {
    pub has_update: bool,
    pub payload: Option<String>,
}

fn sync_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create data dir {}: {}", dir.display(), e))?;
    Ok(dir.join(SYNC_FILE))
}

fn read_sync_config(app: &AppHandle) -> Result<Option<SyncConfig>, String> {
    let path = sync_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|e| format!("read sync config: {e}"))?;
    let cfg: SyncConfig = serde_json::from_slice(&bytes).map_err(|e| format!("parse sync config: {e}"))?;
    Ok(Some(cfg))
}

fn write_sync_config(app: &AppHandle, cfg: &SyncConfig) -> Result<(), String> {
    let path = sync_path(app)?;
    let bytes = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, bytes).map_err(|e| format!("write sync config: {e}"))
}

fn decode_key(key: &str) -> Result<[u8; KEY_LEN], String> {
    let raw = B64.decode(key.as_bytes()).map_err(|e| format!("invalid sync key: {e}"))?;
    raw.as_slice()
        .try_into()
        .map_err(|_| "sync key must be 256-bit (32 bytes)".to_string())
}

fn encrypt_note_payload(key: &[u8; KEY_LEN], plaintext: &str) -> Result<String, String> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("aes key: {e}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("encrypt failed: {e}"))?;
    let mut packed = nonce_bytes.to_vec();
    packed.extend_from_slice(&ciphertext);
    Ok(B64.encode(packed))
}

fn decrypt_note_payload(key: &[u8; KEY_LEN], packed_b64: &str) -> Result<String, String> {
    let packed = B64
        .decode(packed_b64.as_bytes())
        .map_err(|e| format!("invalid encrypted payload: {e}"))?;
    if packed.len() <= NONCE_LEN {
        return Err("encrypted payload too short".to_string());
    }
    let (nonce_bytes, ciphertext) = packed.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("aes key: {e}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    let plain = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "decrypt failed (wrong key or corrupted payload)".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("invalid utf8: {e}"))
}

fn make_note(plaintext: &str, key: &[u8; KEY_LEN]) -> Result<(String, String), String> {
    let uuid = Uuid::new_v4().to_string();
    let encrypted = encrypt_note_payload(key, plaintext)?;
    Ok((uuid.clone(), format!("{uuid},\n{encrypted}")))
}

fn parse_note(note: &str, key: &[u8; KEY_LEN]) -> Result<(String, String), String> {
    let mut lines = note.lines();
    let first = lines.next().ok_or_else(|| "empty sync note".to_string())?;
    if !first.contains(',') {
        return Err("invalid sync note header".to_string());
    }
    let uuid = first.trim_end_matches(',').trim().to_string();
    if uuid.is_empty() {
        return Err("empty sync uuid".to_string());
    }
    let encrypted = lines.next().ok_or_else(|| "missing encrypted payload".to_string())?;
    let payload = decrypt_note_payload(key, encrypted.trim())?;
    Ok((uuid, payload))
}

fn client() -> Result<Client, String> {
    Client::builder()
        .build()
        .map_err(|e| format!("http client init failed: {e}"))
}

fn gist_headers(req: reqwest::blocking::RequestBuilder, token: &str) -> reqwest::blocking::RequestBuilder {
    req.header(USER_AGENT, "rsshu-sync")
        .header(ACCEPT, "application/vnd.github+json")
        .header(AUTHORIZATION, format!("Bearer {token}"))
}

fn create_gist(token: &str, note_content: &str) -> Result<String, String> {
    let body = json!({
      "description": "RSSHU encrypted sync note",
      "public": false,
      "files": { GIST_FILENAME: { "content": note_content } }
    });
    let res = gist_headers(client()?.post("https://api.github.com/gists"), token)
        .json(&body)
        .send()
        .map_err(|e| format!("create gist failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("create gist failed status {}", res.status()));
    }
    let value: serde_json::Value = res.json().map_err(|e| format!("parse gist response: {e}"))?;
    value["id"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "missing gist id".to_string())
}

fn update_gist(token: &str, gist_id: &str, note_content: &str) -> Result<(), String> {
    let body = json!({
      "files": { GIST_FILENAME: { "content": note_content } }
    });
    let url = format!("https://api.github.com/gists/{gist_id}");
    let res = gist_headers(client()?.patch(url), token)
        .json(&body)
        .send()
        .map_err(|e| format!("update gist failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("update gist failed status {}", res.status()));
    }
    Ok(())
}

fn fetch_gist_note(token: &str, gist_id: &str) -> Result<String, String> {
    let url = format!("https://api.github.com/gists/{gist_id}");
    let res = gist_headers(client()?.get(url), token)
        .send()
        .map_err(|e| format!("fetch gist failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("fetch gist failed status {}", res.status()));
    }
    let value: serde_json::Value = res.json().map_err(|e| format!("parse gist response: {e}"))?;
    value["files"][GIST_FILENAME]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "gist file content missing".to_string())
}

#[tauri::command]
pub fn sync_status(app: AppHandle, sync: State<'_, SyncState>) -> Result<SyncStatus, String> {
    let cfg = {
        let mut inner = sync.inner.lock().map_err(|_| "Sync lock poisoned".to_string())?;
        if inner.config.is_none() {
            inner.config = read_sync_config(&app)?;
        }
        inner.config.clone()
    };
    Ok(SyncStatus {
        enabled: cfg.as_ref().map(|c| c.enabled).unwrap_or(false),
        gist_id: cfg.map(|c| c.gist_id),
    })
}

#[tauri::command]
pub fn sync_enable(
    app: AppHandle,
    sync: State<'_, SyncState>,
    req: SyncEnableRequest,
) -> Result<SyncEnableResponse, String> {
    if req.github_token.trim().is_empty() {
        return Err("GitHub token is required".to_string());
    }
    let key = if let Some(existing) = req.sync_key.as_ref().filter(|v| !v.trim().is_empty()) {
        decode_key(existing)?
    } else {
        let mut raw = [0u8; KEY_LEN];
        rand::thread_rng().fill_bytes(&mut raw);
        raw
    };
    let key_b64 = B64.encode(key);
    let gist_id = if let Some(g) = req.gist_id.as_ref().filter(|v| !v.trim().is_empty()) {
        g.to_string()
    } else {
        let (_, note) = make_note("[]", &key)?;
        create_gist(&req.github_token, &note)?
    };
    let cfg = SyncConfig {
        enabled: true,
        gist_id: gist_id.clone(),
        key_b64: key_b64.clone(),
        github_token: req.github_token,
    };
    write_sync_config(&app, &cfg)?;
    let mut inner = sync.inner.lock().map_err(|_| "Sync lock poisoned".to_string())?;
    inner.config = Some(cfg);
    inner.last_payload = None;
    inner.last_uuid = None;
    Ok(SyncEnableResponse {
        gist_id,
        sync_key: key_b64,
    })
}

#[tauri::command]
pub fn sync_disable(app: AppHandle, sync: State<'_, SyncState>) -> Result<(), String> {
    let path = sync_path(&app)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("remove sync config: {e}"))?;
    }
    let mut inner = sync.inner.lock().map_err(|_| "Sync lock poisoned".to_string())?;
    inner.config = None;
    inner.last_payload = None;
    inner.last_uuid = None;
    Ok(())
}

#[tauri::command]
pub fn sync_push(app: AppHandle, sync: State<'_, SyncState>, hosts_json: String) -> Result<(), String> {
    let (cfg, should_skip) = {
        let mut inner = sync.inner.lock().map_err(|_| "Sync lock poisoned".to_string())?;
        if inner.config.is_none() {
            inner.config = read_sync_config(&app)?;
        }
        let Some(cfg) = inner.config.clone() else {
            return Ok(());
        };
        if !cfg.enabled {
            return Ok(());
        }
        let skip = inner.last_payload.as_ref().map(|v| v == &hosts_json).unwrap_or(false);
        (cfg, skip)
    };
    if should_skip {
        return Ok(());
    }
    let key = decode_key(&cfg.key_b64)?;
    let (uuid, note) = make_note(&hosts_json, &key)?;
    update_gist(&cfg.github_token, &cfg.gist_id, &note)?;
    let mut inner = sync.inner.lock().map_err(|_| "Sync lock poisoned".to_string())?;
    inner.last_payload = Some(hosts_json);
    inner.last_uuid = Some(uuid);
    Ok(())
}

#[tauri::command]
pub fn sync_pull(app: AppHandle, sync: State<'_, SyncState>) -> Result<String, String> {
    let cfg = {
        let mut inner = sync.inner.lock().map_err(|_| "Sync lock poisoned".to_string())?;
        if inner.config.is_none() {
            inner.config = read_sync_config(&app)?;
        }
        inner
            .config
            .clone()
            .ok_or_else(|| "Sync is not configured".to_string())?
    };
    let key = decode_key(&cfg.key_b64)?;
    let note = fetch_gist_note(&cfg.github_token, &cfg.gist_id)?;
    let (uuid, payload) = parse_note(&note, &key)?;
    let mut inner = sync.inner.lock().map_err(|_| "Sync lock poisoned".to_string())?;
    inner.last_payload = Some(payload.clone());
    inner.last_uuid = Some(uuid);
    Ok(payload)
}

#[tauri::command]
pub fn sync_poll_updates(app: AppHandle, sync: State<'_, SyncState>) -> Result<SyncPollResponse, String> {
    let (cfg, last_uuid) = {
        let mut inner = sync.inner.lock().map_err(|_| "Sync lock poisoned".to_string())?;
        if inner.config.is_none() {
            inner.config = read_sync_config(&app)?;
        }
        let Some(cfg) = inner.config.clone() else {
            return Ok(SyncPollResponse {
                has_update: false,
                payload: None,
            });
        };
        if !cfg.enabled {
            return Ok(SyncPollResponse {
                has_update: false,
                payload: None,
            });
        }
        (cfg, inner.last_uuid.clone())
    };

    let key = decode_key(&cfg.key_b64)?;
    let note = fetch_gist_note(&cfg.github_token, &cfg.gist_id)?;
    let (remote_uuid, payload) = parse_note(&note, &key)?;

    if Some(remote_uuid.clone()) == last_uuid {
        return Ok(SyncPollResponse {
            has_update: false,
            payload: None,
        });
    }

    let mut inner = sync.inner.lock().map_err(|_| "Sync lock poisoned".to_string())?;
    inner.last_uuid = Some(remote_uuid);
    inner.last_payload = Some(payload.clone());
    Ok(SyncPollResponse {
        has_update: true,
        payload: Some(payload),
    })
}
