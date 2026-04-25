use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use ssh2::{OpenFlags, OpenType, Session};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use std::time::Duration;
use tauri::State;
use tempfile::NamedTempFile;

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
    session: Arc<Mutex<Session>>,
    last_touch_ms: Arc<AtomicU64>,
}

pub struct SftpSessions {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, SftpSessionState>>,
}

impl SftpSessions {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            sessions: Mutex::new(HashMap::new()),
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
            if let Ok(session) = state.session.lock() {
                let _ = session.disconnect(None, "Idle timeout cleanup", None);
            }
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
            if let Ok(session) = state.session.lock() {
                let _ = session.disconnect(None, reason, None);
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn connect(req: &SftpConnectRequest) -> Result<Session> {
    let tcp = TcpStream::connect((req.host.as_str(), req.port)).with_context(|| {
        format!(
            "TCP connect failed to {}:{} (host unreachable / blocked port / wrong address)",
            req.host, req.port
        )
    })?;
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs(30)));
    let mut session = Session::new().context("Failed to create SSH session")?;
    session.set_tcp_stream(tcp);
    session.handshake().context("SSH handshake failed")?;

    if let Some(private_key) = &req.private_key {
        let mut key_file = NamedTempFile::new().context("Failed to create key temp file")?;
        key_file
            .write_all(private_key.as_bytes())
            .context("Failed to write key temp file")?;
        session
            .userauth_pubkey_file(
                &req.username,
                None,
                key_file.path(),
                req.passphrase.as_deref(),
            )
            .context("SSH key authentication failed")?;
    } else if let Some(password) = &req.password {
        crate::authenticate_password_fallback_session(&session, &req.username, password, || {})
            .context("SSH password authentication failed")?;
    } else {
        return Err(anyhow::anyhow!("Missing password or private key"));
    }

    if !session.authenticated() {
        return Err(anyhow::anyhow!("SSH authentication did not complete"));
    }
    session.set_keepalive(true, 30);
    Ok(session)
}

fn normalize(path: &str) -> String {
    if path.is_empty() {
        "/".to_string()
    } else {
        path.to_string()
    }
}

#[tauri::command]
pub fn sftp_connect(
    req: SftpConnectRequest,
    sessions: State<'_, SftpSessions>,
) -> Result<SftpConnectResponse, String> {
    println!(
        "[sftp] connect requested host={} port={} user={}",
        req.host, req.port, req.username
    );
    let session = connect(&req).map_err(|e| e.to_string())?;
    let sftp = session.sftp().map_err(|e| e.to_string())?;
    let home = match sftp.realpath(Path::new(".")) {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => "/".to_string(),
    };
    drop(sftp);

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

fn with_session<T, F: FnOnce(&Session) -> Result<T, String>>(
    sessions: &State<'_, SftpSessions>,
    session_id: &str,
    f: F,
) -> Result<T, String> {
    let handle = {
        let guard = sessions
            .sessions
            .lock()
            .map_err(|_| "Session lock poisoned".to_string())?;
        let state = guard
            .get(session_id)
            .ok_or_else(|| "SFTP session not found".to_string())?;
        state.last_touch_ms.store(now_ms(), Ordering::Relaxed);
        state.session.clone()
    };
    let session = handle
        .lock()
        .map_err(|_| "SFTP session busy".to_string())?;
    f(&session)
}

#[tauri::command]
pub fn sftp_read_file(
    session_id: String,
    path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<String, String> {
    with_session(&sessions, &session_id, |session| {
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        let mut remote = sftp
            .open(Path::new(&path))
            .map_err(|e| format!("open {}: {}", path, e))?;
        let mut bytes = Vec::new();
        remote
            .read_to_end(&mut bytes)
            .map_err(|e| format!("read {}: {}", path, e))?;
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
    with_session(&sessions, &session_id, |session| {
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        let flags = OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE;
        let mut remote = sftp
            .open_mode(Path::new(&path), flags, 0o644, OpenType::File)
            .map_err(|e| format!("open remote {}: {}", path, e))?;
        remote
            .write_all(content.as_bytes())
            .map_err(|e| format!("write remote {}: {}", path, e))?;
        Ok(content.len() as u64)
    })
}

#[tauri::command]
pub fn sftp_list(
    session_id: String,
    path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<Vec<SftpEntry>, String> {
    let path = normalize(&path);
    with_session(&sessions, &session_id, |session| {
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        let entries = sftp
            .readdir(Path::new(&path))
            .map_err(|e| format!("readdir {}: {}", path, e))?;
        let mut result: Vec<SftpEntry> = entries
            .into_iter()
            .map(|(p, stat)| {
                let name = p
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.to_string_lossy().to_string());
                let full = p.to_string_lossy().to_string();
                let file_type = stat.file_type();
                SftpEntry {
                    name,
                    path: full,
                    is_dir: file_type.is_dir(),
                    is_symlink: file_type.is_symlink(),
                    size: stat.size.unwrap_or(0),
                    mtime: stat.mtime.unwrap_or(0),
                    perm: stat.perm.unwrap_or(0),
                }
            })
            .filter(|e| e.name != "." && e.name != "..")
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
    with_session(&sessions, &session_id, |session| {
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        let p = sftp
            .realpath(Path::new(&path))
            .map_err(|e| format!("realpath {}: {}", path, e))?;
        Ok(p.to_string_lossy().to_string())
    })
}

#[tauri::command]
pub fn sftp_mkdir(
    session_id: String,
    path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<(), String> {
    with_session(&sessions, &session_id, |session| {
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        sftp.mkdir(Path::new(&path), 0o755)
            .map_err(|e| format!("mkdir {}: {}", path, e))
    })
}

#[tauri::command]
pub fn sftp_remove_file(
    session_id: String,
    path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<(), String> {
    with_session(&sessions, &session_id, |session| {
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        sftp.unlink(Path::new(&path))
            .map_err(|e| format!("unlink {}: {}", path, e))
    })
}

#[tauri::command]
pub fn sftp_remove_dir(
    session_id: String,
    path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<(), String> {
    with_session(&sessions, &session_id, |session| {
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        sftp.rmdir(Path::new(&path))
            .map_err(|e| format!("rmdir {}: {}", path, e))
    })
}

#[tauri::command]
pub fn sftp_rename(
    session_id: String,
    from: String,
    to: String,
    sessions: State<'_, SftpSessions>,
) -> Result<(), String> {
    with_session(&sessions, &session_id, |session| {
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        sftp.rename(Path::new(&from), Path::new(&to), None)
            .map_err(|e| format!("rename {} -> {}: {}", from, to, e))
    })
}

#[tauri::command]
pub fn sftp_download(
    session_id: String,
    remote_path: String,
    local_path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<u64, String> {
    println!(
        "[sftp] download id={} remote={} local={}",
        session_id, remote_path, local_path
    );
    let local = PathBuf::from(&local_path);
    if let Some(parent) = local.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create local dir {}: {}", parent.display(), e))?;
        }
    }
    with_session(&sessions, &session_id, |session| {
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        let mut remote = sftp
            .open(Path::new(&remote_path))
            .map_err(|e| format!("open {}: {}", remote_path, e))?;
        let mut file =
            File::create(&local).map_err(|e| format!("create {}: {}", local.display(), e))?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut total: u64 = 0;
        loop {
            match remote.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    file.write_all(&buf[..n])
                        .map_err(|e| format!("write local: {}", e))?;
                    total += n as u64;
                }
                Err(e) => return Err(format!("read remote: {}", e)),
            }
        }
        file.flush().map_err(|e| format!("flush: {}", e))?;
        Ok(total)
    })
}

#[tauri::command]
pub fn sftp_upload(
    session_id: String,
    local_path: String,
    remote_path: String,
    sessions: State<'_, SftpSessions>,
) -> Result<u64, String> {
    println!(
        "[sftp] upload id={} local={} remote={}",
        session_id, local_path, remote_path
    );
    with_session(&sessions, &session_id, |session| {
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        let mut file = File::open(&local_path)
            .map_err(|e| format!("open local {}: {}", local_path, e))?;
        let flags = OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE;
        let mut remote = sftp
            .open_mode(Path::new(&remote_path), flags, 0o644, OpenType::File)
            .map_err(|e| format!("open remote {}: {}", remote_path, e))?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut total: u64 = 0;
        loop {
            match file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    remote
                        .write_all(&buf[..n])
                        .map_err(|e| format!("write remote: {}", e))?;
                    total += n as u64;
                }
                Err(e) => return Err(format!("read local: {}", e)),
            }
        }
        Ok(total)
    })
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
        if let Ok(session) = state.session.lock() {
            let _ = session.disconnect(None, "Client closed SFTP", None);
        }
    }
    Ok(())
}
