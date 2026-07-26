mod proxy;
mod sftp;
mod ssh_client;
mod sync;
mod vault;

use anyhow::{Context, Result};
use proxy::{build_http_client, load_proxy_settings, ProxyState};
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use ssh_client::{SshConnectParams, SshHandle};
use std::collections::HashMap;
use std::io::Write;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex as AsyncMutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri::webview::PageLoadEvent;

use sftp::SftpSessions;
use sync::SyncState;
use vault::Vault;

/// Shell/SFTP sessions with no activity for this long are closed by background cleanup.
const IDLE_SESSION_MAX_MS: u64 = 2 * 60 * 60 * 1000;

#[derive(Debug, Deserialize)]
struct SshConnectRequest {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SshShellRequest {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
}

#[derive(Debug, Serialize)]
struct SshHostMetricsResponse {
    cpu_model: String,
    cpu_usage_percent: f64,
    ram_total_mb: u64,
    ram_used_mb: u64,
    upload_kbps: f64,
    download_kbps: f64,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Serialize)]
struct UpdateCheckResponse {
    current_version: String,
    latest_version: Option<String>,
    update_available: bool,
    available_for_os: bool,
    os: String,
    arch: String,
    linux_distro: Option<String>,
    package_format: Option<String>,
    release_url: Option<String>,
    asset_name: Option<String>,
    message: String,
}

#[derive(Debug, Serialize)]
struct UpdateInstallResponse {
    installer_path: String,
    message: String,
}

const UPDATE_REPO: &str = "hdmain/rsshu";

#[derive(Debug, Serialize)]
struct SshShellStartResponse {
    session_id: String,
}

#[derive(Debug, Clone, Serialize)]
struct SshConnectionProgress {
    line: String,
}

fn emit_progress(app: &AppHandle, line: impl Into<String>) {
    let line = line.into();
    let _ = app.emit(
        "ssh-connection-progress",
        SshConnectionProgress { line: line.clone() },
    );
    println!("[ssh] progress {}", line);
}

fn ssh_connect_params(req: &SshConnectRequest) -> SshConnectParams {
    SshConnectParams {
        host: req.host.clone(),
        port: req.port,
        username: req.username.clone(),
        password: req.password.clone(),
        private_key: req.private_key.clone(),
        passphrase: req.passphrase.clone(),
    }
}

fn connect_ssh<F: Fn(&str) + Send + Sync + 'static>(
    req: &SshConnectRequest,
    proxy_state: &ProxyState,
    progress: F,
) -> Result<SshHandle> {
    println!(
        "[ssh] connect start host={} port={} user={} auth={}",
        req.host,
        req.port,
        req.username,
        if req.private_key.is_some() { "key" } else { "password" }
    );
    progress(&format!(
        "TCP: opening socket to {}:{}…",
        req.host, req.port
    ));
    {
        let s = proxy_state.effective_settings();
        if s.should_use_for_host(true, &req.host) {
            progress(&format!(
                "Proxy: tunneling via {} {}:{} → {}:{}…",
                s.proxy_type, s.host, s.port, req.host, req.port
            ));
        } else if s.lockdown_blocks_host(true, &req.host) {
            anyhow::bail!("Lockdown mode: direct SSH connections are blocked");
        } else if s.bypass_local && s.should_use_for(true) && proxy::is_local_or_private_host(&req.host)
        {
            progress(&format!(
                "Proxy: bypassed for local/private host {} — connecting directly…",
                req.host
            ));
        }
    }
    progress("SSH: connecting and negotiating…");
    let params = ssh_connect_params(req);

    let progress = Arc::new(progress);
    let key_auth = params.private_key.is_some();
    let handle = ssh_client::block_on({
        let progress = Arc::clone(&progress);
        let proxy = proxy_state.clone();
        async move {
            let config = std::sync::Arc::new(russh::client::Config {
                inactivity_timeout: Some(Duration::from_secs(300)),
                ..Default::default()
            });
            let stream = proxy::open_connection(&proxy, &params.host, params.port, true)
                .await
                .context("Failed to open connection (proxy or direct)")?;
            let mut handle = russh::client::connect_stream(
                config,
                stream,
                ssh_client::SshClientHandler,
            )
            .await
            .context("SSH connect failed")?;

            progress("SSH: handshake complete; authenticating…");
            if params.private_key.is_some() {
                progress("SSH: user authentication (public key)…");
            } else if params.password.is_some() {
                progress("SSH: user authentication (password)…");
            }

            if params.private_key.is_some() || params.password.is_some() {
                ssh_client::authenticate_session(&mut handle, &params, || {
                    progress("SSH: user authentication (keyboard-interactive)…");
                })
                .await?;
            } else {
                anyhow::bail!("Password or private key is required for SSH authentication");
            }

            Ok(handle)
        }
    })
    .with_context(|| {
        if key_auth {
            "SSH key authentication failed. Verify key and passphrase."
        } else {
            "SSH authentication failed. Verify username/password. (Plain password and keyboard-interactive were tried; many PAM setups only allow the latter.)"
        }
    })?;

    progress("SSH: authenticated.");
    println!(
        "[ssh] auth success host={} user={}",
        req.host, req.username
    );
    Ok(handle)
}

struct ShellSession {
    command_tx: UnboundedSender<WorkerCommand>,
    output_rx: Receiver<String>,
    is_alive: Arc<AtomicBool>,
    ssh_session: Arc<AsyncMutex<SshHandle>>,
    last_touch_ms: Arc<AtomicU64>,
}

enum WorkerCommand {
    Input(String),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(PartialEq)]
enum ShellIoEvent {
    Continue,
    Closed,
}

/// Drain queued keystrokes without starving channel reads (window updates arrive via `wait`).
async fn drain_shell_input(
    write: &russh::ChannelWriteHalf<russh::client::Msg>,
    pending: &mut Vec<u8>,
) -> Result<(), russh::Error> {
    while !pending.is_empty() {
        let writable = write
            .writable_packet_size()
            .await
            .min(pending.len())
            .min(8192);
        if writable == 0 {
            break;
        }
        write.data(&pending[..writable]).await?;
        pending.drain(..writable);
    }
    Ok(())
}

fn forward_channel_msg(msg: ChannelMsg, output_tx: &Sender<String>) -> ShellIoEvent {
    match msg {
        ChannelMsg::Data { data } => {
            let text = String::from_utf8_lossy(&data).to_string();
            let _ = output_tx.send(text);
            ShellIoEvent::Continue
        }
        ChannelMsg::ExtendedData { data, .. } => {
            let text = String::from_utf8_lossy(&data).to_string();
            let _ = output_tx.send(text);
            ShellIoEvent::Continue
        }
        ChannelMsg::Eof => {
            let _ = output_tx.send("\n[session closed]\n".to_string());
            ShellIoEvent::Closed
        }
        ChannelMsg::Close => ShellIoEvent::Closed,
        _ => ShellIoEvent::Continue,
    }
}

struct ShellSessions {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, ShellSession>>,
}

impl ShellSessions {
    fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    fn create_id(&self) -> String {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        format!("ssh-session-{id}")
    }

    fn reap_idle_sessions(&self, max_idle_ms: u64) -> usize {
        let now = now_ms();
        let mut stale: Vec<ShellSession> = Vec::new();
        if let Ok(mut guard) = self.sessions.lock() {
            let ids: Vec<String> = guard
                .iter()
                .filter_map(|(id, s)| {
                    let last = s.last_touch_ms.load(Ordering::Relaxed);
                    if now.saturating_sub(last) > max_idle_ms {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
                .collect();
            for id in ids {
                if let Some(sess) = guard.remove(&id) {
                    stale.push(sess);
                }
            }
        }
        for session in &stale {
            let _ = session.command_tx.send(WorkerCommand::Close);
        }
        stale.len()
    }

    fn close_all(&self, reason: &str) {
        let sessions = if let Ok(mut guard) = self.sessions.lock() {
            guard.drain().map(|(_, s)| s).collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        for session in sessions {
            let _ = session.command_tx.send(WorkerCommand::Close);
            let _ = ssh_client::disconnect_session(Arc::clone(&session.ssh_session), reason);
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn current_update_os() -> String {
    std::env::consts::OS.to_string()
}

fn current_update_arch() -> String {
    std::env::consts::ARCH.to_string()
}

#[derive(Debug, Clone)]
struct LinuxDistroInfo {
    id: String,
    name: String,
    id_like: Vec<String>,
}

fn parse_os_release(content: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let value = value.trim().trim_matches('"');
            map.insert(key.trim().to_string(), value.to_string());
        }
    }
    map
}

fn detect_linux_distro() -> Option<LinuxDistroInfo> {
    if std::env::consts::OS != "linux" {
        return None;
    }
    let content = std::fs::read_to_string("/etc/os-release").ok()?;
    let map = parse_os_release(&content);
    let id = map.get("ID")?.clone();
    let name = map
        .get("PRETTY_NAME")
        .or_else(|| map.get("NAME"))
        .cloned()
        .unwrap_or_else(|| id.clone());
    let id_like = map
        .get("ID_LIKE")
        .map(|value| {
            value
                .split_whitespace()
                .map(|part| part.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(LinuxDistroInfo { id, name, id_like })
}

fn is_debian_based(distro: &LinuxDistroInfo) -> bool {
    let id = distro.id.to_ascii_lowercase();
    if id == "debian" {
        return true;
    }
    if distro
        .id_like
        .iter()
        .any(|like| like.eq_ignore_ascii_case("debian"))
    {
        return true;
    }
    // Ubuntu derivatives (Mint, Pop!_OS, etc.) usually declare ID_LIKE=ubuntu.
    id == "ubuntu"
        || distro
            .id_like
            .iter()
            .any(|like| like.eq_ignore_ascii_case("ubuntu"))
}

fn package_format_from_asset(name: &str) -> Option<String> {
    let n = name.to_ascii_lowercase();
    if n.ends_with(".deb") {
        Some("deb".to_string())
    } else if n.ends_with(".appimage") {
        Some("appimage".to_string())
    } else if n.ends_with(".msi") {
        Some("msi".to_string())
    } else if n.ends_with(".exe") {
        Some("exe".to_string())
    } else {
        None
    }
}

fn asset_install_priority(
    name: &str,
    os: &str,
    arch: &str,
    linux_distro: Option<&LinuxDistroInfo>,
) -> Option<u8> {
    let n = name.to_ascii_lowercase();
    if !asset_matches_arch(&n, arch) {
        return None;
    }

    match os {
        "windows" => {
            if n.ends_with(".exe") && n.contains("setup") {
                Some(0)
            } else if n.ends_with(".msi") {
                Some(1)
            } else if n.ends_with(".exe") {
                Some(2)
            } else {
                None
            }
        }
        "linux" => {
            let debian_based = linux_distro.map(is_debian_based).unwrap_or(false);
            if debian_based {
                if n.ends_with(".deb") {
                    Some(0)
                } else if n.ends_with(".appimage") {
                    Some(1)
                } else {
                    None
                }
            } else if n.ends_with(".appimage") {
                Some(0)
            } else if n.ends_with(".deb") {
                Some(1)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn matching_update_asset(
    release: &GithubRelease,
    os: &str,
    arch: &str,
) -> Option<GithubReleaseAsset> {
    let linux_distro = detect_linux_distro();
    let linux_ref = linux_distro.as_ref();
    release
        .assets
        .iter()
        .filter_map(|asset| {
            asset_install_priority(&asset.name, os, arch, linux_ref).map(|priority| (priority, asset))
        })
        .min_by_key(|(priority, _)| *priority)
        .map(|(_, asset)| asset.clone())
}

fn normalize_version(version: &str) -> &str {
    version.trim().trim_start_matches('v')
}

fn version_parts(version: &str) -> Vec<u64> {
    normalize_version(version)
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .filter_map(|p| p.parse::<u64>().ok())
        .collect()
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    let latest_parts = version_parts(latest);
    let current_parts = version_parts(current);
    let len = latest_parts.len().max(current_parts.len());
    for i in 0..len {
        let l = latest_parts.get(i).copied().unwrap_or(0);
        let c = current_parts.get(i).copied().unwrap_or(0);
        if l != c {
            return l > c;
        }
    }
    false
}

fn asset_matches_arch(name: &str, arch: &str) -> bool {
    let n = name.to_ascii_lowercase();
    match arch {
        "x86_64" => {
            !n.contains("aarch64")
                && !n.contains("arm64")
                && (n.contains("x64") || n.contains("x86_64") || n.contains("amd64"))
        }
        "aarch64" => n.contains("aarch64") || n.contains("arm64"),
        _ => n.contains(arch),
    }
}

fn fetch_latest_release(proxy_state: &ProxyState) -> Result<GithubRelease> {
    let url = format!("https://api.github.com/repos/{UPDATE_REPO}/releases/latest");
    let res = build_http_client(proxy_state)
        .map_err(|e| anyhow::anyhow!(e))?
        .get(url)
        .header(
            reqwest::header::USER_AGENT,
            format!("RSSHU/{}", env!("CARGO_PKG_VERSION")),
        )
        .send()
        .context("Failed to query GitHub Releases")?
        .error_for_status()
        .context("GitHub Releases returned an error")?;
    let bytes = res.bytes().context("Failed to read GitHub release response")?;
    proxy_state.record_http_bytes(bytes.len() as u64);
    serde_json::from_slice(&bytes).context("Failed to parse GitHub release response")
}

fn build_update_check_response(release: GithubRelease) -> UpdateCheckResponse {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let latest_version = normalize_version(&release.tag_name).to_string();
    let os = current_update_os();
    let arch = current_update_arch();
    let linux_distro = detect_linux_distro();
    let linux_distro_label = linux_distro.as_ref().map(|d| d.name.clone());
    let asset = matching_update_asset(&release, &os, &arch);
    let package_format = asset
        .as_ref()
        .and_then(|a| package_format_from_asset(&a.name));
    let available_for_os = asset.is_some();
    let newer = is_newer_version(&latest_version, &current_version);
    let update_available = newer && available_for_os;

    let target_label = if let Some(ref distro_name) = linux_distro_label {
        if let Some(ref format) = package_format {
            format!("{distro_name} ({format}, {arch})")
        } else {
            format!("{distro_name} ({arch})")
        }
    } else {
        format!("{os}-{arch}")
    };

    let message = if update_available {
        format!("Update {latest_version} is available for {target_label}.")
    } else if newer {
        format!("Update {latest_version} exists, but no installer asset matches {target_label}.")
    } else {
        format!("RSSHU is up to date for {target_label}.")
    };

    UpdateCheckResponse {
        current_version,
        latest_version: Some(latest_version),
        update_available,
        available_for_os,
        os,
        arch,
        linux_distro: linux_distro_label,
        package_format,
        release_url: Some(release.html_url),
        asset_name: asset.map(|a| a.name),
        message,
    }
}

fn check_update_blocking(proxy_state: &ProxyState) -> Result<(UpdateCheckResponse, Option<GithubReleaseAsset>)> {
    let release = fetch_latest_release(proxy_state)?;
    let os = current_update_os();
    let arch = current_update_arch();
    let asset = matching_update_asset(&release, &os, &arch);
    let response = build_update_check_response(release);
    Ok((response, asset))
}

fn safe_asset_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn download_update_asset(
    app: &AppHandle,
    asset: &GithubReleaseAsset,
    proxy_state: &ProxyState,
) -> Result<std::path::PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .context("Failed to resolve app cache directory")?
        .join("updates");
    std::fs::create_dir_all(&dir).context("Failed to create update cache directory")?;
    let path = dir.join(safe_asset_filename(&asset.name));
    let bytes = build_http_client(proxy_state)
        .map_err(|e| anyhow::anyhow!(e))?
        .get(&asset.browser_download_url)
        .header(
            reqwest::header::USER_AGENT,
            format!("RSSHU/{}", env!("CARGO_PKG_VERSION")),
        )
        .send()
        .context("Failed to download update installer")?
        .error_for_status()
        .context("Update installer download returned an error")?
        .bytes()
        .context("Failed to read update installer")?;
    proxy_state.record_http_bytes(bytes.len() as u64);
    let mut file = std::fs::File::create(&path).context("Failed to create update installer file")?;
    file.write_all(&bytes)
        .context("Failed to write update installer file")?;
    Ok(path)
}

#[cfg(target_os = "windows")]
fn launch_update_installer(path: &std::path::Path) -> Result<String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if name.ends_with(".msi") {
        Command::new("msiexec")
            .arg("/i")
            .arg(path)
            .arg("/passive")
            .arg("/norestart")
            .spawn()
            .context("Failed to start MSI installer")?;
        return Ok("Started the Windows MSI installer.".to_string());
    }

    Command::new(path)
        .arg("/S")
        .spawn()
        .context("Failed to start Windows installer")?;
    Ok("Started the Windows installer.".to_string())
}

#[cfg(target_os = "linux")]
fn launch_update_installer(path: &std::path::Path) -> Result<String> {
    use std::os::unix::fs::PermissionsExt;

    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if name.ends_with(".appimage") {
        let mut perms = std::fs::metadata(path)
            .context("Failed to read AppImage metadata")?
            .permissions();
        perms.set_mode(perms.mode() | 0o755);
        std::fs::set_permissions(path, perms).context("Failed to mark AppImage executable")?;
        Command::new(path)
            .spawn()
            .context("Failed to launch AppImage update")?;
        return Ok("Downloaded and launched the AppImage update.".to_string());
    }

    if name.ends_with(".deb") {
        let quoted_path = path.to_string_lossy().replace('\'', "'\\''");
        let installer = format!("apt install -y '{quoted_path}' || dpkg -i '{quoted_path}'");
        Command::new("pkexec")
            .args(["sh", "-c", &installer])
            .spawn()
            .context("Failed to start Debian package installer with pkexec")?;
        return Ok("Started the Debian package installer.".to_string());
    }

    anyhow::bail!("No automatic installer is available for this OS asset: {name}");
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn launch_update_installer(path: &std::path::Path) -> Result<String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    anyhow::bail!("No automatic installer is available for this OS asset: {name}");
}

#[tauri::command]
async fn ssh_test_connection(
    req: SshConnectRequest,
    proxy_state: State<'_, ProxyState>,
) -> Result<String, String> {
    println!(
        "[ssh] test connection requested host={} port={} user={}",
        req.host, req.port, req.username
    );
    let proxy = (*proxy_state).clone();
    let req_for_connect = SshConnectRequest {
        host: req.host.clone(),
        port: req.port,
        username: req.username.clone(),
        password: req.password.clone(),
        private_key: req.private_key.clone(),
        passphrase: req.passphrase.clone(),
    };
    tauri::async_runtime::spawn_blocking(move || connect_ssh(&req_for_connect, &proxy, |_| {}))
        .await
        .map_err(|e| format!("Connection worker thread failed: {e}"))?
        .map(|_| format!("Connected to {}@{}:{}", req.username, req.host, req.port))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_start_shell(
    app: AppHandle,
    req: SshShellRequest,
    sessions: State<'_, ShellSessions>,
    proxy_state: State<'_, ProxyState>,
) -> Result<SshShellStartResponse, String> {
    println!(
        "[ssh] start shell requested host={} port={} user={}",
        req.host, req.port, req.username
    );
    let proxy = (*proxy_state).clone();
    let connect_req = SshConnectRequest {
        host: req.host.clone(),
        port: req.port,
        username: req.username.clone(),
        password: req.password.clone(),
        private_key: req.private_key.clone(),
        passphrase: req.passphrase.clone(),
    };
    let app_for_progress = app.clone();
    let (handle, channel) = tauri::async_runtime::spawn_blocking(move || {
        let app_connect = app_for_progress.clone();
        let handle = connect_ssh(&connect_req, &proxy, move |line| emit_progress(&app_connect, line))
            .map_err(|e| e.to_string())?;
        emit_progress(&app_for_progress, "Shell: opening session channel…");
        ssh_client::block_on(async move {
            let channel = handle
                .channel_open_session()
                .await
                .map_err(|e| format!("Failed to open SSH channel: {e}"))?;
            emit_progress(&app_for_progress, "Shell: requesting PTY (xterm)…");
            channel
                .request_pty(true, "xterm", 120, 40, 0, 0, &[])
                .await
                .map_err(|e| format!("Failed to request PTY: {e}"))?;
            emit_progress(&app_for_progress, "Shell: starting interactive session…");
            channel
                .request_shell(true)
                .await
                .map_err(|e| format!("Failed to start shell: {e}"))?;
            emit_progress(&app_for_progress, "Shell: ready.");
            Ok::<_, String>((handle, channel))
        })
    })
    .await
    .map_err(|e| format!("SSH connect worker thread failed: {e}"))?
    .map_err(|e| e.to_string())?;

    let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel::<WorkerCommand>();
    let (output_tx, output_rx) = mpsc::channel::<String>();
    let is_alive = Arc::new(AtomicBool::new(true));
    let shared_session = Arc::new(AsyncMutex::new(handle));
    let last_touch_ms = Arc::new(AtomicU64::new(now_ms()));
    let session_id = sessions.create_id();
    println!("[ssh] shell session allocated id={}", session_id);
    let worker_session_id = session_id.clone();
    let worker_alive = Arc::clone(&is_alive);
    let worker_ssh = Arc::clone(&shared_session);
    let worker_log_id = worker_session_id.clone();

    thread::spawn(move || {
        println!(
            "[ssh] worker thread started session_id={}",
            worker_session_id
        );
        ssh_client::block_on(async move {
            let (mut read_half, write_half) = channel.split();
            let mut pending_input: Vec<u8> = Vec::new();
            let mut last_keepalive = Instant::now();
            let mut last_input_log = Instant::now();
            let mut input_bytes_since_log: usize = 0;
            let mut closed = false;

            while !closed {
                if last_keepalive.elapsed() >= Duration::from_secs(10) {
                    if let Ok(ssh) = worker_ssh.try_lock() {
                        let _ = ssh.send_keepalive(false).await;
                    }
                    last_keepalive = Instant::now();
                }

                tokio::select! {
                    biased;

                    cmd = command_rx.recv() => {
                        match cmd {
                            Some(WorkerCommand::Close) => {
                                println!(
                                    "[ssh] close requested session_id={}",
                                    worker_session_id
                                );
                                closed = true;
                            }
                            Some(WorkerCommand::Resize { cols, rows }) => {
                                if cols > 0 && rows > 0 {
                                    let _ = write_half.window_change(cols, rows, 0, 0).await;
                                }
                            }
                            Some(WorkerCommand::Input(input)) => {
                                pending_input.extend_from_slice(input.as_bytes());
                                input_bytes_since_log += input.len();
                            }
                            None => closed = true,
                        }
                    }

                    msg = read_half.wait(), if !closed => {
                        match msg {
                            Some(m) => {
                                if forward_channel_msg(m, &output_tx) == ShellIoEvent::Closed {
                                    closed = true;
                                }
                            }
                            None => closed = true,
                        }
                    }

                    write_result = drain_shell_input(&write_half, &mut pending_input),
                        if !pending_input.is_empty() && !closed =>
                    {
                        if let Err(err) = write_result {
                            eprintln!(
                                "[ssh] write failed session_id={} err={}",
                                worker_session_id, err
                            );
                            let _ = output_tx
                                .send("\n[error] failed to write to shell\n".to_string());
                            closed = true;
                        }
                    }
                }

                if last_input_log.elapsed() >= Duration::from_millis(100) {
                    if input_bytes_since_log > 0 {
                        println!(
                            "[ssh] input traffic session_id={} bytes_100ms={}",
                            worker_session_id, input_bytes_since_log
                        );
                        input_bytes_since_log = 0;
                    }
                    last_input_log = Instant::now();
                }
            }

            let _ = write_half.close().await;
            let ssh = worker_ssh.lock().await;
            let _ = ssh_client::disconnect_async(&ssh, "Client closed shell").await;
        });
        worker_alive.store(false, Ordering::SeqCst);
        println!("[ssh] worker thread ended session_id={}", worker_log_id);
    });

    let mut guard = sessions.sessions.lock().map_err(|_| "Session lock poisoned")?;
    guard.insert(
        session_id.clone(),
        ShellSession {
            command_tx,
            output_rx,
            is_alive,
            ssh_session: shared_session,
            last_touch_ms,
        },
    );

    Ok(SshShellStartResponse { session_id })
}

#[tauri::command]
async fn ssh_fetch_host_metrics(
    session_id: String,
    sessions: State<'_, ShellSessions>,
) -> Result<SshHostMetricsResponse, String> {
    let shared_session = {
        let guard = sessions.sessions.lock().map_err(|_| "Session lock poisoned")?;
        let session = guard
            .get(&session_id)
            .ok_or_else(|| "Session not found".to_string())?;
        if !session.is_alive.load(Ordering::SeqCst) {
            return Err("Session is closed".to_string());
        }
        Arc::clone(&session.ssh_session)
    };

    tauri::async_runtime::spawn_blocking(move || {
        ssh_client::block_on(async move {
            let handle = shared_session.lock().await;
            ssh_fetch_host_metrics_async(&handle).await
        })
    })
        .await
        .map_err(|e| format!("Metrics worker thread failed: {e}"))?
}

#[tauri::command]
async fn app_check_update(proxy_state: State<'_, ProxyState>) -> Result<UpdateCheckResponse, String> {
    let proxy = (*proxy_state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        check_update_blocking(&proxy)
            .map(|(response, _)| response)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Update check worker thread failed: {e}"))?
}

#[tauri::command]
async fn app_install_update(
    app: AppHandle,
    proxy_state: State<'_, ProxyState>,
) -> Result<UpdateInstallResponse, String> {
    let proxy = (*proxy_state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (check, asset) = check_update_blocking(&proxy).map_err(|e| e.to_string())?;
        if !check.update_available {
            return Err(check.message);
        }
        let asset = asset.ok_or_else(|| {
            format!(
                "No installer asset matches {}-{}.",
                check.os, check.arch
            )
        })?;
        let path = download_update_asset(&app, &asset, &proxy).map_err(|e| e.to_string())?;
        let message = launch_update_installer(&path).map_err(|e| e.to_string())?;
        Ok(UpdateInstallResponse {
            installer_path: path.to_string_lossy().to_string(),
            message,
        })
    })
    .await
    .map_err(|e| format!("Update install worker thread failed: {e}"))?
}

async fn ssh_fetch_host_metrics_async(handle: &SshHandle) -> Result<SshHostMetricsResponse, String> {
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed to open metrics channel: {e}"))?;
        let command = r#"sh -lc "
cpu_model=\$(grep -m1 -E '^(model name|Hardware|Processor)[[:space:]]*:' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//');
[ -n \"\$cpu_model\" ] || cpu_model=Unknown;
read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat;
total1=\$((user+nice+system+idle+iowait+irq+softirq+steal));
idle1=\$((idle+iowait));
rx1=\$(awk -F'[: ]+' 'NR>2 && \$1 !~ /^lo$/ {rx+=\$3} END {print rx+0}' /proc/net/dev 2>/dev/null);
tx1=\$(awk -F'[: ]+' 'NR>2 && \$1 !~ /^lo$/ {tx+=\$11} END {print tx+0}' /proc/net/dev 2>/dev/null);
sleep 0.5;
read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat;
total2=\$((user+nice+system+idle+iowait+irq+softirq+steal));
idle2=\$((idle+iowait));
rx2=\$(awk -F'[: ]+' 'NR>2 && \$1 !~ /^lo$/ {rx+=\$3} END {print rx+0}' /proc/net/dev 2>/dev/null);
tx2=\$(awk -F'[: ]+' 'NR>2 && \$1 !~ /^lo$/ {tx+=\$11} END {print tx+0}' /proc/net/dev 2>/dev/null);
dt=\$((total2-total1));
di=\$((idle2-idle1));
if [ \"\$dt\" -gt 0 ]; then
  cpu_usage=\$(awk -v dt=\"\$dt\" -v di=\"\$di\" 'BEGIN { printf \"%.1f\", (dt-di)*100/dt }');
else
  cpu_usage=0.0;
fi;
drx=\$((rx2-rx1));
dtx=\$((tx2-tx1));
[ \"\$drx\" -ge 0 ] || drx=0;
[ \"\$dtx\" -ge 0 ] || dtx=0;
download_kbps=\$(awk -v b=\"\$drx\" 'BEGIN { printf \"%.1f\", b/1024 }');
upload_kbps=\$(awk -v b=\"\$dtx\" 'BEGIN { printf \"%.1f\", b/1024 }');
mem_total=\$(awk '/MemTotal:/ {print \$2; exit}' /proc/meminfo 2>/dev/null);
mem_avail=\$(awk '/MemAvailable:/ {print \$2; found=1; exit} END {if(!found) print \"\"}' /proc/meminfo 2>/dev/null);
[ -n \"\$mem_avail\" ] || mem_avail=\$(awk '/MemFree:/ {f=\$2} /Buffers:/ {b=\$2} /Cached:/ {c=\$2} END {if(f==\"\") f=0; if(b==\"\") b=0; if(c==\"\") c=0; print f+b+c}' /proc/meminfo 2>/dev/null);
[ -n \"\$mem_total\" ] || mem_total=\$(free -k 2>/dev/null | awk '/^Mem:/ {print \$2; exit}');
[ -n \"\$mem_avail\" ] || mem_avail=\$(free -k 2>/dev/null | awk '/^Mem:/ {if(\$7!=\"\") print \$7; else print \$4; exit}');
[ -n \"\$mem_total\" ] || mem_total=0;
[ -n \"\$mem_avail\" ] || mem_avail=0;
echo \"cpu_model=\$cpu_model\";
echo \"cpu_usage_percent=\$cpu_usage\";
echo \"mem_total_kb=\$mem_total\";
echo \"mem_available_kb=\$mem_avail\";
echo \"upload_kbps=\$upload_kbps\";
echo \"download_kbps=\$download_kbps\";
""#;
        channel
            .exec(true, command)
            .await
            .map_err(|e| format!("Failed to execute metrics command: {e}"))?;

        let mut out = String::new();
        let mut exit_seen = false;
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    out.push_str(&String::from_utf8_lossy(&data));
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    out.push_str(&String::from_utf8_lossy(&data));
                }
                Some(ChannelMsg::ExitStatus { .. }) => {
                    exit_seen = true;
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                Some(_) if exit_seen => break,
                Some(_) => {}
            }
        }
        let _ = channel.close().await;

        let mut kv: HashMap<String, String> = HashMap::new();
        for line in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
            if let Some((k, v)) = line.split_once('=') {
                kv.insert(k.trim().to_string(), v.trim().to_string());
            }
        }

        let cpu_model = kv
            .get("cpu_model")
            .filter(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| "Unknown".to_string());
        let cpu_usage_percent = kv
            .get("cpu_usage_percent")
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0);
        let mem_total_kb = kv
            .get("mem_total_kb")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let mem_available_kb = kv
            .get("mem_available_kb")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let upload_kbps = kv
            .get("upload_kbps")
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0);
        let download_kbps = kv
            .get("download_kbps")
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0);
        let ram_total_mb = mem_total_kb / 1024;
        let ram_available_mb = mem_available_kb / 1024;
        let ram_used_mb = ram_total_mb.saturating_sub(ram_available_mb);

    Ok(SshHostMetricsResponse {
        cpu_model,
        cpu_usage_percent,
        ram_total_mb,
        ram_used_mb,
        upload_kbps,
        download_kbps,
    })
}

#[tauri::command]
fn ssh_send_input(
    session_id: String,
    input: String,
    sessions: State<'_, ShellSessions>,
) -> Result<(), String> {
    let guard = sessions.sessions.lock().map_err(|_| "Session lock poisoned")?;
    let session = guard
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    session.last_touch_ms.store(now_ms(), Ordering::Relaxed);
    if !session.is_alive.load(Ordering::SeqCst) {
        return Err("Session is closed".to_string());
    }
    session
        .command_tx
        .send(WorkerCommand::Input(input))
        .map_err(|_| "Failed to send input to session".to_string())
}

#[tauri::command]
fn ssh_resize_pty(
    session_id: String,
    cols: u32,
    rows: u32,
    sessions: State<'_, ShellSessions>,
) -> Result<(), String> {
    let guard = sessions.sessions.lock().map_err(|_| "Session lock poisoned")?;
    let session = guard
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    session.last_touch_ms.store(now_ms(), Ordering::Relaxed);
    if !session.is_alive.load(Ordering::SeqCst) {
        return Err("Session is closed".to_string());
    }
    session
        .command_tx
        .send(WorkerCommand::Resize { cols, rows })
        .map_err(|_| "Failed to send resize command".to_string())
}

#[tauri::command]
fn ssh_read_output(
    session_id: String,
    sessions: State<'_, ShellSessions>,
) -> Result<Vec<String>, String> {
    let guard = sessions.sessions.lock().map_err(|_| "Session lock poisoned")?;
    let session = guard
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    session.last_touch_ms.store(now_ms(), Ordering::Relaxed);
    if !session.is_alive.load(Ordering::SeqCst) {
        return Err("Session is closed".to_string());
    }

    let mut chunks = Vec::new();
    loop {
        match session.output_rx.try_recv() {
            Ok(chunk) => chunks.push(chunk),
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => break,
        }
    }
    Ok(chunks)
}

#[derive(Debug, Serialize)]
struct FileMetadata {
    mtime: u64,
    size: u64,
}

/// Local file mtime (unix seconds) and size for change detection.
#[tauri::command]
fn file_metadata(path: String) -> Result<FileMetadata, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(FileMetadata {
        mtime,
        size: meta.len(),
    })
}

#[tauri::command]
fn ssh_close_shell(session_id: String, sessions: State<'_, ShellSessions>) -> Result<(), String> {
    println!("[ssh] close command session_id={}", session_id);
    let mut guard = sessions.sessions.lock().map_err(|_| "Session lock poisoned")?;
    let Some(session) = guard.remove(&session_id) else {
        return Ok(());
    };
    session
        .command_tx
        .send(WorkerCommand::Close)
        .map_err(|_| "Failed to close shell".to_string())
}

static SPLASH_SHOWN: AtomicBool = AtomicBool::new(false);

fn show_splash_window(app: &AppHandle) -> Result<(), String> {
    if SPLASH_SHOWN.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let splash = app
        .get_webview_window("splashscreen")
        .ok_or("splashscreen window not found")?;
    splash.show().map_err(|e| e.to_string())?;
    splash.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn show_splashscreen(app: AppHandle) -> Result<(), String> {
    show_splash_window(&app)
}

#[tauri::command]
fn splash_is_shown() -> bool {
    SPLASH_SHOWN.load(Ordering::SeqCst)
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("empty path".into());
    }
    std::fs::write(&path, contents.as_bytes()).map_err(|e| format!("write {}: {e}", path))
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("empty path".into());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(ShellSessions::new())
        .manage(SftpSessions::new())
        .manage(Vault::new())
        .manage(SyncState::new())
        .manage(ProxyState::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_page_load(|webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            match webview.label() {
                "splashscreen" => {
                    let _ = show_splash_window(webview.app_handle());
                }
                "main" => {
                    let _ = webview.show();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            show_splashscreen,
            splash_is_shown,
            write_text_file,
            read_text_file,
            ssh_test_connection,
            ssh_start_shell,
            ssh_send_input,
            ssh_resize_pty,
            ssh_read_output,
            ssh_close_shell,
            ssh_fetch_host_metrics,
            app_check_update,
            app_install_update,
            sftp::sftp_connect,
            sftp::sftp_list,
            sftp::sftp_realpath,
            sftp::sftp_exists,
            sftp::sftp_mkdir,
            sftp::sftp_remove_file,
            sftp::sftp_remove_dir,
            sftp::sftp_rename,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_read_file,
            sftp::sftp_write_file,
            sftp::sftp_disconnect,
            vault::vault_status,
            vault::vault_init,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_save,
            vault::vault_change_password,
            sync::sync_status,
            sync::sync_enable,
            sync::sync_disable,
            sync::sync_push,
            sync::sync_pull,
            sync::sync_poll_updates,
            sync::sync_export_transfer_key,
            sync::sync_import_transfer_key,
            file_metadata,
            proxy::proxy_get,
            proxy::proxy_set_config,
            proxy::proxy_upsert_server,
            proxy::proxy_delete_server,
            proxy::proxy_import_sync,
            proxy::proxy_test,
        ])
        .setup(|app| {
            let proxy_state = app.state::<ProxyState>();
            if let Err(e) = load_proxy_settings(&app.handle(), &proxy_state) {
                eprintln!("[proxy] failed to load settings: {e}");
            }
            let app_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(30));
                let shell_reaped = app_handle
                    .state::<ShellSessions>()
                    .reap_idle_sessions(IDLE_SESSION_MAX_MS);
                let sftp_reaped = app_handle
                    .state::<SftpSessions>()
                    .reap_idle_sessions(IDLE_SESSION_MAX_MS);
                app_handle.state::<SftpSessions>().send_keepalives();
                if shell_reaped > 0 || sftp_reaped > 0 {
                    println!(
                        "[cleanup] reaped idle sessions shell={} sftp={}",
                        shell_reaped, sftp_reaped
                    );
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |app, event| {
        if matches!(event, RunEvent::Exit) {
            app.state::<ShellSessions>().close_all("App exiting");
            app.state::<SftpSessions>().disconnect_all("App exiting");
        }
    });
}
