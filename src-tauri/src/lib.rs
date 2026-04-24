mod sftp;
mod sync;
mod vault;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use ssh2::{KeyboardInteractivePrompt, Prompt, Session};
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tempfile::NamedTempFile;

use sftp::SftpSessions;
use sync::SyncState;
use vault::Vault;

/// Many OpenSSH+PAM setups disable the `password` auth method and only accept
/// `keyboard-interactive` (same password, different SSH message). Try both.
struct PasswordKeyboardInteractive<'a> {
    password: &'a str,
}

impl KeyboardInteractivePrompt for PasswordKeyboardInteractive<'_> {
    fn prompt<'b>(
        &mut self,
        _username: &str,
        _instructions: &str,
        prompts: &[Prompt<'b>],
    ) -> Vec<String> {
        prompts
            .iter()
            .map(|_| self.password.to_string())
            .collect()
    }
}

pub(crate) fn authenticate_password_fallback_session(
    session: &Session,
    username: &str,
    password: &str,
    before_keyboard_interactive: impl FnOnce(),
) -> Result<()> {
    let _ = session.userauth_password(username, password);
    if session.authenticated() {
        return Ok(());
    }
    before_keyboard_interactive();
    let mut kbd = PasswordKeyboardInteractive { password };
    session
        .userauth_keyboard_interactive(username, &mut kbd)
        .context("SSH keyboard-interactive authentication failed")?;
    if !session.authenticated() {
        return Err(anyhow::anyhow!(
            "SSH authentication did not complete after password and keyboard-interactive attempts"
        ));
    }
    Ok(())
}

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

fn connect_ssh<F: Fn(&str)>(req: &SshConnectRequest, progress: F) -> Result<Session> {
    println!(
        "[ssh] connect start host={} port={} user={} auth={}",
        req.host,
        req.port,
        req.username,
        if req.private_key.is_some() { "key" } else { "password" }
    );
    // Use default libssh2 algorithm lists (same path as our SFTP connector). We previously
    // set method_pref; an incorrect list can make handshake fail with "Unable to exchange
    // encryption keys" even on modern OpenSSH servers.
    progress(&format!(
        "TCP: opening socket to {}:{}…",
        req.host, req.port
    ));
    let mut handshake_error: Option<anyhow::Error> = None;
    let mut session: Option<Session> = None;
    for attempt in 1..=3 {
        if attempt > 1 {
            progress(&format!(
                "SSH: handshake failed, new TCP attempt {}/3…",
                attempt
            ));
        }
        let tcp = TcpStream::connect((req.host.as_str(), req.port)).with_context(|| {
            format!(
                "TCP connect failed to {}:{} (host unreachable / blocked port / wrong address)",
                req.host, req.port
            )
        })?;
        let _ = tcp.set_read_timeout(Some(Duration::from_secs(15)));
        let _ = tcp.set_write_timeout(Some(Duration::from_secs(15)));
        progress("TCP: connected.");
        progress("SSH: creating libssh2 session…");
        let mut s = Session::new().context("Failed to create SSH session")?;
        s.set_tcp_stream(tcp);
        progress("SSH: key exchange / protocol handshake (KEX)…");
        match s.handshake() {
            Ok(_) => {
                progress("SSH: handshake complete; transport encrypted.");
                session = Some(s);
                handshake_error = None;
                break;
            }
            Err(err) => {
                eprintln!(
                    "[ssh] handshake attempt {}/3 failed host={} port={} err={}",
                    attempt, req.host, req.port, err
                );
                handshake_error = Some(anyhow::anyhow!(err.to_string()));
                if attempt < 3 {
                    progress("SSH: waiting before handshake retry…");
                    thread::sleep(Duration::from_millis(250));
                }
            }
        }
    }
    if let Some(err) = handshake_error {
        return Err(anyhow::anyhow!(
            "SSH handshake failed for {}:{} after 3 attempts: {}. If SFTP in this app works for the same host, report this: default libssh2 negotiation should not fail on OpenSSH 10 with ed25519 host keys.",
            req.host,
            req.port,
            err
        ));
    }
    let session = session.context("SSH handshake missing session after success")?;

    if let Some(private_key) = &req.private_key {
        progress("SSH: user authentication (public key)…");
        let mut key_file = NamedTempFile::new().context("Failed to create key temp file")?;
        key_file
            .write_all(private_key.as_bytes())
            .context("Failed to write private key temp file")?;
        session
            .userauth_pubkey_file(
                &req.username,
                None,
                key_file.path(),
                req.passphrase.as_deref(),
            )
            .context("SSH key authentication failed. Verify key and passphrase.")?;
    } else if let Some(password) = &req.password {
        progress("SSH: user authentication (password)…");
        authenticate_password_fallback_session(&session, &req.username, password, || {
            progress("SSH: user authentication (keyboard-interactive)…");
        })
        .with_context(|| {
            "SSH authentication failed. Verify username/password. (Plain password and keyboard-interactive were tried; many PAM setups only allow the latter.)"
        })?;
    } else {
        return Err(anyhow::anyhow!(
            "Password is required in this MVP build. Key auth can be added next."
        ));
    }

    if !session.authenticated() {
        return Err(anyhow::anyhow!("SSH authentication did not complete"));
    }

    progress("SSH: authenticated.");
    println!(
        "[ssh] auth success host={} user={}",
        req.host, req.username
    );
    Ok(session)
}

struct ShellSession {
    command_tx: Sender<WorkerCommand>,
    output_rx: Receiver<String>,
    is_alive: Arc<AtomicBool>,
    ssh_session: Arc<Mutex<Session>>,
}

enum WorkerCommand {
    Input(String),
    Resize { cols: u32, rows: u32 },
    Close,
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
}

#[tauri::command]
fn ssh_test_connection(req: SshConnectRequest) -> Result<String, String> {
    println!(
        "[ssh] test connection requested host={} port={} user={}",
        req.host, req.port, req.username
    );
    connect_ssh(&req, |_| {})
        .map(|_| format!("Connected to {}@{}:{}", req.username, req.host, req.port))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ssh_start_shell(
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
    let session = connect_ssh(&connect_req, |line| emit_progress(&app_for_progress, line))
        .map_err(|e| e.to_string())?;
    let session = session;
    session.set_keepalive(true, 20);
    emit_progress(&app, "Shell: opening session channel…");
    let mut channel = session
        .channel_session()
        .map_err(|e| format!("Failed to open SSH channel: {e}"))?;
    emit_progress(&app, "Shell: requesting PTY (xterm)…");
    channel
        .request_pty("xterm", None, Some((120, 40, 0, 0)))
        .map_err(|e| format!("Failed to request PTY: {e}"))?;
    emit_progress(&app, "Shell: starting interactive session…");
    channel
        .shell()
        .map_err(|e| format!("Failed to start shell: {e}"))?;
    emit_progress(&app, "Shell: ready.");

    let (command_tx, command_rx) = mpsc::channel::<WorkerCommand>();
    let (output_tx, output_rx) = mpsc::channel::<String>();
    let is_alive = Arc::new(AtomicBool::new(true));
    let shared_session = Arc::new(Mutex::new(session.clone()));
    let session_id = sessions.create_id();
    println!("[ssh] shell session allocated id={}", session_id);
    let worker_session_id = session_id.clone();
    let worker_alive = Arc::clone(&is_alive);

    thread::spawn(move || {
        println!(
            "[ssh] worker thread started session_id={}",
            worker_session_id
        );
        let session = session;
        let mut channel = channel;
        let mut buf = [0_u8; 8192];
        let mut pending_input: Vec<u8> = Vec::new();
        let mut last_keepalive = Instant::now();
        let mut last_input_log = Instant::now();
        let mut input_bytes_since_log: usize = 0;
        let mut consecutive_transport_errors = 0_u8;
        let mut consecutive_write_errors = 0_u8;
        session.set_blocking(false);

        loop {
            match command_rx.try_recv() {
                Ok(WorkerCommand::Close) => {
                        println!(
                            "[ssh] close requested session_id={}",
                            worker_session_id
                        );
                        let _ = channel.close();
                        break;
                }
                Ok(WorkerCommand::Resize { cols, rows }) => {
                    if cols > 0 && rows > 0 {
                        let _ = channel.request_pty_size(cols, rows, None, None);
                    }
                }
                Ok(WorkerCommand::Input(input)) => {
                    pending_input.extend_from_slice(input.as_bytes());
                    input_bytes_since_log += input.len();
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => break,
            }

            if !pending_input.is_empty() {
                // Non-blocking write: send as much as possible and retry next ticks.
                let max_chunk = pending_input.len().min(1024);
                match channel.write(&pending_input[..max_chunk]) {
                    Ok(written) => {
                        if written > 0 {
                            pending_input.drain(..written);
                        }
                        consecutive_write_errors = 0;
                    }
                    Err(err) => {
                        if err.kind() == ErrorKind::WouldBlock {
                            // Not ready yet; try again after a short sleep below.
                        } else {
                            // libssh2 occasionally surfaces transient internal errors
                            // (e.g. "Failure while draining incoming flow",
                            // "Would block", "transport read") during non-blocking
                            // writes when an incoming packet is mid-flight. These
                            // are recoverable; tolerate a burst before giving up.
                            let err_text = err.to_string().to_lowercase();
                            let is_transient = err_text.contains("drain")
                                || err_text.contains("would block")
                                || err_text.contains("transport read")
                                || err_text.contains("try again")
                                || err_text.contains("timed out");
                            if is_transient {
                                consecutive_write_errors =
                                    consecutive_write_errors.saturating_add(1);
                                if consecutive_write_errors < 32 {
                                    eprintln!(
                                        "[ssh] write transient session_id={} err={} retry={}",
                                        worker_session_id, err, consecutive_write_errors
                                    );
                                    thread::sleep(Duration::from_millis(80));
                                } else {
                                    eprintln!(
                                        "[ssh] write failed session_id={} err={}",
                                        worker_session_id, err
                                    );
                                    let _ = output_tx.send(
                                        "\n[error] failed to write to shell\n".to_string(),
                                    );
                                    break;
                                }
                            } else {
                                eprintln!(
                                    "[ssh] write failed session_id={} err={}",
                                    worker_session_id, err
                                );
                                let _ = output_tx
                                    .send("\n[error] failed to write to shell\n".to_string());
                                break;
                            }
                        }
                    }
                }
            }

            if last_input_log.elapsed() >= Duration::from_millis(250) {
                if input_bytes_since_log > 0 {
                    for _ in 0..input_bytes_since_log {
                        println!(
                            "[ssh] input traffic session_id={} bytes_250ms=1",
                            worker_session_id
                        );
                    }
                    input_bytes_since_log = 0;
                }
                last_input_log = Instant::now();
            }

            match channel.read(&mut buf) {
                Ok(0) => {
                    if channel.eof() {
                        let _ = output_tx.send("\n[session closed]\n".to_string());
                        break;
                    }
                }
                Ok(n) => {
                    consecutive_transport_errors = 0;
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = output_tx.send(text);
                }
                Err(err) => {
                    let err_text = err.to_string().to_lowercase();
                    if err.kind() != ErrorKind::WouldBlock {
                        // Transient libssh2 read spikes ("Transport read", "Failure
                        // while draining incoming flow", spurious "Would block" text
                        // messages) can appear under load; tolerate a burst before
                        // dropping the session.
                        let is_transient = err_text.contains("transport read")
                            || err_text.contains("drain")
                            || err_text.contains("would block")
                            || err_text.contains("try again")
                            || err_text.contains("timed out");
                        if is_transient {
                            consecutive_transport_errors =
                                consecutive_transport_errors.saturating_add(1);
                            if consecutive_transport_errors < 16 {
                                thread::sleep(Duration::from_millis(120));
                                continue;
                            }
                        }
                        eprintln!("[ssh] read failed session_id={} err={}", worker_session_id, err);
                        let _ = output_tx.send(format!("\n[error] {}\n", err));
                        break;
                    }
                }
            }

            if last_keepalive.elapsed() >= Duration::from_secs(10) {
                let _ = session.keepalive_send();
                last_keepalive = Instant::now();
            }

            thread::sleep(Duration::from_millis(30));
        }

        let _ = session.disconnect(None, "Client closed shell", None);
        worker_alive.store(false, Ordering::SeqCst);
        println!("[ssh] worker thread ended session_id={}", worker_session_id);
    });

    let mut guard = sessions.sessions.lock().map_err(|_| "Session lock poisoned")?;
    guard.insert(
        session_id.clone(),
        ShellSession {
            command_tx,
            output_rx,
            is_alive,
            ssh_session: shared_session,
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
        let guard = shared_session
            .lock()
            .map_err(|_| "Session lock poisoned".to_string())?;
        ssh_fetch_host_metrics_blocking(&guard)
    })
        .await
        .map_err(|e| format!("Metrics worker thread failed: {e}"))?
}

fn ssh_fetch_host_metrics_blocking(session: &Session) -> Result<SshHostMetricsResponse, String> {
    fn is_ssh_would_block(err: &ssh2::Error) -> bool {
        matches!(err.code(), ssh2::ErrorCode::Session(code) if code == -37)
            || err.to_string().to_lowercase().contains("would block")
    }

    fn retry_ssh_call<T, F>(mut f: F, what: &str) -> Result<T, String>
    where
        F: FnMut() -> Result<T, ssh2::Error>,
    {
        let mut last_err: Option<ssh2::Error> = None;
        for _ in 0..120 {
            match f() {
                Ok(v) => return Ok(v),
                Err(err) if is_ssh_would_block(&err) => {
                    last_err = Some(err);
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(err) => return Err(format!("{what}: {err}")),
            }
        }
        Err(format!(
            "{what}: {}",
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "timeout waiting for SSH readiness".to_string())
        ))
    }

    let mut channel = retry_ssh_call(|| session.channel_session(), "Failed to open metrics channel")?;
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
    retry_ssh_call(
        || channel.exec(command),
        "Failed to execute metrics command",
    )?;
    let mut out = String::new();
    let mut buf = [0_u8; 4096];
    loop {
        match channel.read(&mut buf) {
            Ok(0) => {
                if channel.eof() {
                    break;
                }
            }
            Ok(n) => out.push_str(&String::from_utf8_lossy(&buf[..n])),
            Err(err) if err.kind() == ErrorKind::WouldBlock => {}
            Err(err) => return Err(format!("Failed to read metrics output: {err}")),
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    let _ = channel.wait_close();

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
    tauri::Builder::default()
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
