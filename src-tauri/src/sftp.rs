use crate::ssh_client::{self, SshConnectParams, SshHandle};
use anyhow::Result;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Deserialize)]
pub struct SftpConnectRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SftpConnectResponse {
    pub session_id: String,
    pub home: String,
}

#[derive(Debug, Serialize)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mtime: u64,
    pub perm: u32,
}

pub struct SftpSessionState {
    session: Arc<Mutex<SshHandle>>,
    last_touch_ms: Arc<AtomicU64>,
}

pub struct SftpSessions {
    next_id: AtomicU64,
    sessions: StdMutex<HashMap<String, SftpSessionState>>,
}

impl SftpSessions {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            sessions: StdMutex::new(HashMap::new()),
        }
    }

    fn create_id(&self) -> String {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        format!("sftp-session-{id}")
    }

    pub fn reap_idle_sessions(&self, max_idle_ms: u64) -> usize {
        let now = now_ms();
        let mut stale: Vec<SftpSessionState> = Vec::new();
        if let Ok(mut guard) = self.sessions.lock() {
            let ids: Vec<String> = guard
                .iter()
                .filter_map(|(id, st)| {
                    let last = st.last_touch_ms.load(Ordering::Relaxed);
                    if now.saturating_sub(last) > max_idle_ms {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
                .collect();
            for id in ids {
                if let Some(state) = guard.remove(&id) {
                    stale.push(state);
                }
            }
        }
        let count = stale.len();
        for state in stale {
            let _ = ssh_client::disconnect_session(state.session, "Idle timeout cleanup");
        }
        count
    }

    pub fn disconnect_all(&self, reason: &str) {
        let sessions = if let Ok(mut guard) = self.sessions.lock() {
            guard.drain().map(|(_, s)| s).collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        for state in sessions {
            let _ = ssh_client::disconnect_session(state.session, reason);
        }
    }

    pub fn send_keepalives(&self) {
        let sessions: Vec<Arc<Mutex<SshHandle>>> = if let Ok(guard) = self.sessions.lock() {
            guard.values().map(|s| Arc::clone(&s.session)).collect()
        } else {
            return;
        };
        for session in sessions {
            let session = Arc::clone(&session);
            std::thread::spawn(move || {
                ssh_client::block_on(async move {
                    if let Ok(handle) = session.try_lock() {
                        let _ = handle.send_keepalive(false).await;
                    }
                });
            });
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn connect_params(req: &SftpConnectRequest) -> SshConnectParams {
    SshConnectParams {
        host: req.host.clone(),
        port: req.port,
        username: req.username.clone(),
        password: req.password.clone(),
        private_key: req.private_key.clone(),
        passphrase: req.passphrase.clone(),
    }
}

#[tauri::command]
pub async fn sftp_connect(
    req: SftpConnectRequest,
    sessions: State<'_, SftpSessions>,
    proxy_state: State<'_, crate::proxy::ProxyState>,
) -> Result<SftpConnectResponse, String> {
    println!(
        "[sftp] connect requested host={} port={} user={}",
        req.host, req.port, req.username
    );
    let proxy = (*proxy_state).clone();
    let params = connect_params(&req);
    let (session, home) = ssh_client::run_async(async move {
        let session = ssh_client::connect_async(params, proxy).await?;
        let sftp = ssh_client::open_sftp_session(&session).await?;
        let home = sftp
            .canonicalize(".")
            .await
            .unwrap_or_else(|_| "/".to_string());
        Ok::<(SshHandle, String), anyhow::Error>((session, home))
    })
    .await
    .map_err(|e| e.to_string())?;

    let id = sessions.create_id();
    println!("[sftp] session allocated id={} home={}", id, home);
    let mut guard = sessions
        .sessions
        .lock()
        .map_err(|_| "Session lock poisoned".to_string())?;
    guard.insert(
        id.clone(),
        SftpSessionState {
            session: Arc::new(Mutex::new(session)),
            last_touch_ms: Arc::new(AtomicU64::new(now_ms())),
        },
    );
    Ok(SftpConnectResponse {
        session_id: id,
        home,
    })
}

fn sftp_ssh_session(
    sessions: &State<'_, SftpSessions>,
    session_id: &str,
) -> Result<Arc<Mutex<SshHandle>>, String> {
    let guard = sessions
        .sessions
        .lock()
        .map_err(|_| "Session lock poisoned".to_string())?;
    let state = guard
        .get(session_id)
        .ok_or_else(|| "SFTP session not found".to_string())?;
    state.last_touch_ms.store(now_ms(), Ordering::Relaxed);
    Ok(state.session.clone())
}

#[tauri::command]
pub fn sftp_read_file(
    session_id: String,
    path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<String, String> {
    let session = sftp_ssh_session(&sessions, &session_id)?;
    ssh_client::block_on(async move {
        let handle = session.lock().await;
        let sftp = ssh_client::open_sftp_session(&handle)
            .await
            .map_err(|e| e.to_string())?;
        let bytes = sftp
            .read(&path)
            .await
            .map_err(|e| format!("read {path}: {e}"))?;
        String::from_utf8(bytes).map_err(|_| "File is not valid UTF-8 text".to_string())
    })
}

#[tauri::command]
pub fn sftp_write_file(
    session_id: String,
    path: String,
    content: String,
    sessions: State<'_, SftpSessions>,
) -> Result<u64, String> {
    let session = sftp_ssh_session(&sessions, &session_id)?;
    ssh_client::block_on(async move {
        let handle = session.lock().await;
        let sftp = ssh_client::open_sftp_session(&handle)
            .await
            .map_err(|e| e.to_string())?;
        sftp.write(&path, content.as_bytes())
            .await
            .map_err(|e| format!("write remote {path}: {e}"))?;
        Ok(content.len() as u64)
    })
}

fn normalize(path: &str) -> String {
    if path.is_empty() {
        "/".to_string()
    } else {
        path.to_string()
    }
}

#[tauri::command]
pub fn sftp_list(
    session_id: String,
    path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<Vec<SftpEntry>, String> {
    let path = normalize(&path);
    let session = sftp_ssh_session(&sessions, &session_id)?;
    ssh_client::block_on(async move {
        let handle = session.lock().await;
        let sftp = ssh_client::open_sftp_session(&handle)
            .await
            .map_err(|e| e.to_string())?;
        let entries = sftp
            .read_dir(&path)
            .await
            .map_err(|e| format!("readdir {path}: {e}"))?;
        let mut result: Vec<SftpEntry> = entries
            .map(|entry| {
                let meta = entry.metadata();
                SftpEntry {
                    name: entry.file_name(),
                    path: entry.path(),
                    is_dir: meta.is_dir(),
                    is_symlink: meta.is_symlink(),
                    size: meta.size.unwrap_or(0),
                    mtime: meta.mtime.unwrap_or(0) as u64,
                    perm: meta.permissions.unwrap_or(0),
                }
            })
            .collect();
        result.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(result)
    })
}

#[tauri::command]
pub fn sftp_realpath(
    session_id: String,
    path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<String, String> {
    let path = normalize(&path);
    let session = sftp_ssh_session(&sessions, &session_id)?;
    ssh_client::block_on(async move {
        let handle = session.lock().await;
        let sftp = ssh_client::open_sftp_session(&handle)
            .await
            .map_err(|e| e.to_string())?;
        sftp.canonicalize(&path)
            .await
            .map_err(|e| format!("realpath {path}: {e}"))
    })
}

#[tauri::command]
pub async fn sftp_exists(
    session_id: String,
    path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<bool, String> {
    let path = normalize(&path);
    let session = sftp_ssh_session(&sessions, &session_id)?;
    ssh_client::run_async(async move {
        let handle = session.lock().await;
        let sftp = ssh_client::open_sftp_session(&handle)
            .await
            .map_err(|e| e.to_string())?;
        sftp.try_exists(&path)
            .await
            .map_err(|e| format!("exists {path}: {e}"))
    })
    .await
}

#[tauri::command]
pub fn sftp_mkdir(
    session_id: String,
    path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<(), String> {
    let session = sftp_ssh_session(&sessions, &session_id)?;
    ssh_client::block_on(async move {
        let handle = session.lock().await;
        let sftp = ssh_client::open_sftp_session(&handle)
            .await
            .map_err(|e| e.to_string())?;
        sftp.create_dir(&path)
            .await
            .map_err(|e| format!("mkdir {path}: {e}"))
    })
}

#[tauri::command]
pub fn sftp_remove_file(
    session_id: String,
    path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<(), String> {
    let session = sftp_ssh_session(&sessions, &session_id)?;
    ssh_client::block_on(async move {
        let handle = session.lock().await;
        let sftp = ssh_client::open_sftp_session(&handle)
            .await
            .map_err(|e| e.to_string())?;
        sftp.remove_file(&path)
            .await
            .map_err(|e| format!("unlink {path}: {e}"))
    })
}

#[tauri::command]
pub fn sftp_remove_dir(
    session_id: String,
    path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<(), String> {
    let session = sftp_ssh_session(&sessions, &session_id)?;
    ssh_client::block_on(async move {
        let handle = session.lock().await;
        let sftp = ssh_client::open_sftp_session(&handle)
            .await
            .map_err(|e| e.to_string())?;
        sftp.remove_dir(&path)
            .await
            .map_err(|e| format!("rmdir {path}: {e}"))
    })
}

#[tauri::command]
pub fn sftp_rename(
    session_id: String,
    from: String,
    to: String,
    sessions: State<'_, SftpSessions>,
) -> Result<(), String> {
    let session = sftp_ssh_session(&sessions, &session_id)?;
    ssh_client::block_on(async move {
        let handle = session.lock().await;
        let sftp = ssh_client::open_sftp_session(&handle)
            .await
            .map_err(|e| e.to_string())?;
        sftp.rename(&from, &to)
            .await
            .map_err(|e| format!("rename {from} -> {to}: {e}"))
    })
}

#[tauri::command]
pub async fn sftp_download(
    session_id: String,
    remote_path: String,
    local_path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<u64, String> {
    println!(
        "[sftp] download id={} remote={} local={}",
        session_id, remote_path, local_path
    );
    let local = std::path::PathBuf::from(&local_path);
    if let Some(parent) = local.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create local dir {}: {}", parent.display(), e))?;
        }
    }
    let session = sftp_ssh_session(&sessions, &session_id)?;
    ssh_client::run_async(async move {
        let handle = session.lock().await;
        let sftp = ssh_client::open_sftp_session(&handle)
            .await
            .map_err(|e| e.to_string())?;
        let mut remote = sftp
            .open(&remote_path)
            .await
            .map_err(|e| format!("open {remote_path}: {e}"))?;
        let mut file = tokio::fs::File::create(&local)
            .await
            .map_err(|e| format!("create {}: {}", local.display(), e))?;
        let mut total: u64 = 0;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = remote
                .read(&mut buf)
                .await
                .map_err(|e| format!("read remote: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])
                .await
                .map_err(|e| format!("write local: {e}"))?;
            total += n as u64;
            tokio::task::yield_now().await;
        }
        file.flush()
            .await
            .map_err(|e| format!("flush: {e}"))?;
        Ok(total)
    })
    .await
}

#[tauri::command]
pub async fn sftp_upload(
    session_id: String,
    local_path: String,
    remote_path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<u64, String> {
    println!(
        "[sftp] upload id={} local={} remote={}",
        session_id, local_path, remote_path
    );
    let session = sftp_ssh_session(&sessions, &session_id)?;
    ssh_client::run_async(async move {
        let handle = session.lock().await;
        let sftp = ssh_client::open_sftp_session(&handle)
            .await
            .map_err(|e| e.to_string())?;
        let mut file = tokio::fs::File::open(&local_path)
            .await
            .map_err(|e| format!("open local {local_path}: {e}"))?;
        let flags = OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE;
        let mut remote = sftp
            .open_with_flags(&remote_path, flags)
            .await
            .map_err(|e| format!("open remote {remote_path}: {e}"))?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut total: u64 = 0;
        loop {
            let n = file
                .read(&mut buf)
                .await
                .map_err(|e| format!("read local: {e}"))?;
            if n == 0 {
                break;
            }
            remote
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("write remote: {e}"))?;
            total += n as u64;
            // Yield so interactive SSH sessions on the same runtime stay responsive.
            tokio::task::yield_now().await;
        }
        Ok(total)
    })
    .await
}

#[tauri::command]
pub fn sftp_disconnect(
    session_id: String,
    sessions: State<'_, SftpSessions>,
) -> Result<(), String> {
    println!("[sftp] disconnect id={}", session_id);
    let mut guard = sessions
        .sessions
        .lock()
        .map_err(|_| "Session lock poisoned".to_string())?;
    if let Some(state) = guard.remove(&session_id) {
        let _ = ssh_client::disconnect_session(state.session, "Client closed SFTP");
    }
    Ok(())
}
