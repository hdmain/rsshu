use anyhow::{Context, Result};
use russh::client::KeyboardInteractiveAuthResponse;
use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg};
use russh::Disconnect;
use russh_sftp::client::SftpSession;
use std::future::Future;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;
use std::time::Duration;
use tokio::runtime::Handle as TokioHandle;

pub type SshHandle = Handle<SshClientHandler>;

static SSH_RUNTIME: OnceLock<TokioHandle> = OnceLock::new();

fn ssh_runtime() -> &'static TokioHandle {
    SSH_RUNTIME.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("rsshu-ssh-rt".into())
            .spawn(move || {
                // Multi-thread so interactive shells keep running while SFTP transfers work.
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(4)
                    .thread_name("rsshu-ssh-worker")
                    .enable_all()
                    .build()
                    .expect("failed to create SSH runtime");
                tx.send(rt.handle().clone()).expect("ssh runtime handle");
                rt.block_on(std::future::pending::<()>());
            })
            .expect("failed to spawn SSH runtime thread");
        rx.recv().expect("SSH runtime thread exited before ready")
    })
}

/// Run an async SSH task on the dedicated SSH runtime thread.
/// Safe to call from Tauri's Tokio workers, blocking pool threads, or std threads.
pub fn block_on<F, T>(future: F) -> T
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let _ = ssh_runtime().spawn(async move {
        let _ = tx.send(future.await);
    });
    rx.recv().unwrap_or_else(|_| panic!("SSH runtime task dropped"))
}

/// Async variant — does not block the calling thread while the SSH task runs.
pub async fn run_async<F, T>(future: F) -> T
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    let _ = ssh_runtime().spawn(async move {
        let _ = tx.send(future.await);
    });
    rx.await.unwrap_or_else(|_| panic!("SSH runtime task dropped"))
}

#[derive(Clone)]
pub struct SshClientHandler;

impl client::Handler for SshClientHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[derive(Debug, Clone)]
pub struct SshConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

pub async fn connect_async(
    params: SshConnectParams,
    proxy_state: crate::proxy::ProxyState,
) -> Result<SshHandle> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(300)),
        ..Default::default()
    });
    let stream = crate::proxy::open_connection(&proxy_state, &params.host, params.port, true)
        .await
        .context("Failed to open connection (proxy or direct)")?;
    let mut handle = client::connect_stream(config, stream, SshClientHandler)
        .await
        .context("SSH connect failed")?;

    authenticate_inner(&mut handle, &params, || {}).await?;
    Ok(handle)
}

pub fn connect(
    params: &SshConnectParams,
    proxy_state: &crate::proxy::ProxyState,
) -> Result<SshHandle> {
    block_on(connect_async(params.clone(), proxy_state.clone()))
}

pub async fn authenticate_session(
    handle: &mut SshHandle,
    params: &SshConnectParams,
    before_keyboard_interactive: impl FnOnce(),
) -> Result<()> {
    authenticate_inner(handle, params, before_keyboard_interactive).await
}

async fn authenticate_inner(
    handle: &mut SshHandle,
    params: &SshConnectParams,
    before_keyboard_interactive: impl FnOnce(),
) -> Result<()> {
    if let Some(private_key) = &params.private_key {
        let key = decode_secret_key(private_key, params.passphrase.as_deref())
            .context("Failed to parse private key")?;
        let hash = handle
            .best_supported_rsa_hash()
            .await
            .context("Failed to query RSA hash algorithms")?
            .flatten();
        let auth = handle
            .authenticate_publickey(
                &params.username,
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            )
            .await
            .context("SSH key authentication failed")?;
        if !auth.success() {
            anyhow::bail!("SSH key authentication rejected by server");
        }
        return Ok(());
    }

    if let Some(password) = &params.password {
        authenticate_password_fallback(
            handle,
            &params.username,
            password,
            before_keyboard_interactive,
        )
        .await?;
        return Ok(());
    }

    anyhow::bail!("Missing password or private key");
}

/// Many OpenSSH+PAM setups disable the `password` auth method and only accept
/// `keyboard-interactive` (same password, different SSH message). Try both.
pub async fn authenticate_password_fallback(
    handle: &mut SshHandle,
    username: &str,
    password: &str,
    before_keyboard_interactive: impl FnOnce(),
) -> Result<()> {
    let password_auth = handle
        .authenticate_password(username, password)
        .await
        .context("SSH password authentication failed")?;
    if password_auth.success() {
        return Ok(());
    }

    before_keyboard_interactive();
    let mut response = handle
        .authenticate_keyboard_interactive_start(username, None)
        .await
        .context("SSH keyboard-interactive authentication failed to start")?;

    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                anyhow::bail!("SSH keyboard-interactive authentication rejected by server");
            }
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let answers: Vec<String> =
                    prompts.iter().map(|_| password.to_string()).collect();
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .context("SSH keyboard-interactive authentication failed")?;
            }
        }
    }
}

pub async fn disconnect_async(handle: &SshHandle, reason: &str) -> Result<()> {
    handle
        .disconnect(Disconnect::ByApplication, reason, "en")
        .await
        .context("SSH disconnect failed")?;
    Ok(())
}

pub fn disconnect_session(session: Arc<Mutex<SshHandle>>, reason: &str) -> Result<()> {
    let reason = reason.to_string();
    block_on(async move {
        let guard = session.lock().await;
        disconnect_async(&guard, &reason).await
    })
}

pub async fn open_sftp_session(handle: &SshHandle) -> Result<SftpSession> {
    let channel = handle
        .channel_open_session()
        .await
        .context("Failed to open SSH session channel for SFTP")?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .context("Failed to request SFTP subsystem")?;
    SftpSession::new(channel.into_stream())
        .await
        .context("Failed to initialize SFTP session")
}
