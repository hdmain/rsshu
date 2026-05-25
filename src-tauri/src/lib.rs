mod sftp;
mod ssh_client;
mod sync;
mod vault;

use anyhow::{Context, Result};
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use ssh_client::{SshConnectParams, SshHandle};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex as AsyncMutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

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
    progress("SSH: connecting and negotiating…");
    let params = ssh_connect_params(req);

    let progress = Arc::new(progress);
    let key_auth = params.private_key.is_some();
    let handle = ssh_client::block_on({
        let progress = Arc::clone(&progress);
        async move {
            let config = std::sync::Arc::new(russh::client::Config {
                inactivity_timeout: Some(Duration::from_secs(300)),
                ..Default::default()
            });
            let mut handle = russh::client::connect(
                config,
                (params.host.as_str(), params.port),
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

#[tauri::command]
async fn ssh_test_connection(req: SshConnectRequest) -> Result<String, String> {
    println!(
        "[ssh] test connection requested host={} port={} user={}",
        req.host, req.port, req.username
    );
    let req_for_connect = SshConnectRequest {
        host: req.host.clone(),
        port: req.port,
        username: req.username.clone(),
        password: req.password.clone(),
        private_key: req.private_key.clone(),
        passphrase: req.passphrase.clone(),
    };
    tauri::async_runtime::spawn_blocking(move || connect_ssh(&req_for_connect, |_| {}))
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
) -> Result<SshShellStartResponse, String> {
    println!(
        "[ssh] start shell requested host={} port={} user={}",
        req.host, req.port, req.username
    );
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
        let handle = connect_ssh(&connect_req, move |line| emit_progress(&app_connect, line))
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

                if last_input_log.elapsed() >= Duration::from_millis(250) {
                    if input_bytes_since_log > 0 {
                        println!(
                            "[ssh] input traffic session_id={} bytes_250ms={}",
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
sleep 1;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(ShellSessions::new())
        .manage(SftpSessions::new())
        .manage(Vault::new())
        .manage(SyncState::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            ssh_test_connection,
            ssh_start_shell,
            ssh_send_input,
            ssh_resize_pty,
            ssh_read_output,
            ssh_close_shell,
            ssh_fetch_host_metrics,
            sftp::sftp_connect,
            sftp::sftp_list,
            sftp::sftp_realpath,
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
            file_metadata,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(30));
                let shell_reaped = app_handle
                    .state::<ShellSessions>()
                    .reap_idle_sessions(IDLE_SESSION_MAX_MS);
                let sftp_reaped = app_handle
                    .state::<SftpSessions>()
                    .reap_idle_sessions(IDLE_SESSION_MAX_MS);
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
