use anyhow::{anyhow, bail, Context, Result};
use reqwest::blocking::Client;
use reqwest::Proxy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll};
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::TlsConnector;
use uuid::Uuid;

const PROXY_FILE: &str = "proxy.json";
const STATS_FLUSH_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyServer {
    pub id: String,
    pub name: String,
    #[serde(default = "default_proxy_type", rename = "type")]
    pub proxy_type: String,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_proxy_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub active_server_id: Option<String>,
    #[serde(default = "default_true")]
    pub apply_ssh: bool,
    #[serde(default = "default_true")]
    pub apply_http: bool,
    #[serde(default)]
    pub lockdown: bool,
    /// When true, localhost / private LAN targets connect directly (no proxy).
    #[serde(default = "default_true")]
    pub bypass_local: bool,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            active_server_id: None,
            apply_ssh: true,
            apply_http: true,
            lockdown: false,
            bypass_local: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStats {
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(default)]
    pub server_bytes: HashMap<String, u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStore {
    #[serde(default)]
    pub servers: Vec<ProxyServer>,
    #[serde(default)]
    pub config: ProxyConfig,
    #[serde(default)]
    pub stats: ProxyStats,
}

impl Default for ProxyStore {
    fn default() -> Self {
        Self {
            servers: Vec::new(),
            config: ProxyConfig::default(),
            stats: ProxyStats::default(),
        }
    }
}

/// Legacy single-proxy format (migration).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProxySettings {
    #[serde(default)]
    enabled: bool,
    #[serde(default = "default_proxy_type", rename = "type")]
    proxy_type: String,
    #[serde(default)]
    host: String,
    #[serde(default = "default_proxy_port")]
    port: u16,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default = "default_true")]
    apply_ssh: bool,
    #[serde(default = "default_true")]
    apply_http: bool,
    #[serde(default)]
    lockdown: bool,
    #[serde(default = "default_true")]
    bypass_local: bool,
}

#[derive(Debug, Clone)]
pub struct ProxySettings {
    pub enabled: bool,
    pub active_server_id: Option<String>,
    pub proxy_type: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub apply_ssh: bool,
    pub apply_http: bool,
    pub lockdown: bool,
    pub bypass_local: bool,
}

fn default_proxy_type() -> String {
    "socks5".to_string()
}

fn default_proxy_port() -> u16 {
    1080
}

fn default_true() -> bool {
    true
}

impl ProxySettings {
    pub fn is_configured(&self) -> bool {
        self.enabled && !self.host.trim().is_empty() && self.port > 0
    }

    pub fn should_use_for(&self, for_ssh: bool) -> bool {
        self.is_configured() && (if for_ssh { self.apply_ssh } else { self.apply_http })
    }

    pub fn should_use_for_host(&self, for_ssh: bool, target_host: &str) -> bool {
        if self.bypass_local && is_local_or_private_host(target_host) {
            return false;
        }
        self.should_use_for(for_ssh)
    }

    pub fn lockdown_blocks(&self, for_ssh: bool) -> bool {
        self.lockdown && self.is_configured() && (if for_ssh { self.apply_ssh } else { self.apply_http })
    }

    pub fn lockdown_blocks_host(&self, for_ssh: bool, target_host: &str) -> bool {
        if self.bypass_local && is_local_or_private_host(target_host) {
            return false;
        }
        self.lockdown_blocks(for_ssh)
    }

    fn creds(&self) -> Option<(&str, &str)> {
        let u = self.username.trim();
        let p = self.password.trim();
        if u.is_empty() {
            None
        } else {
            Some((u, p))
        }
    }
}

/// True for localhost, loopback, and RFC1918 / link-local private addresses.
pub fn is_local_or_private_host(host: &str) -> bool {
    let h = host.trim().trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if h.is_empty() {
        return false;
    }
    if h == "localhost" || h == "localhost." || h.ends_with(".localhost") || h.ends_with(".local") {
        return true;
    }
    if h == "::1" || h == "0:0:0:0:0:0:0:1" {
        return true;
    }
    // Strip optional zone id from IPv6 link-local (fe80::1%eth0).
    let h = h.split('%').next().unwrap_or(&h);

    if let Ok(ip) = h.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => {
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 0x40 // 100.64/10 CGNAT
            }
            std::net::IpAddr::V6(v6) => {
                v6.is_loopback()
                    || (v6.segments()[0] & 0xfe00) == 0xfc00 // ULA fc00::/7
                    || (v6.segments()[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
            }
        };
    }

    false
}

struct ProxyMeter {
    inner: Arc<ProxyStateInner>,
    server_id: String,
}

impl ProxyMeter {
    fn add(&self, n: u64) {
        if n == 0 {
            return;
        }
        self.inner.record_bytes(&self.server_id, n);
    }
}

struct Counting<S> {
    inner: S,
    meter: ProxyMeter,
}

impl<S> Counting<S> {
    fn new(inner: S, meter: ProxyMeter) -> Self {
        Self { inner, meter }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Counting<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let poll = Pin::new(&mut self.as_mut().get_mut().inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &poll {
            let n = buf.filled().len().saturating_sub(before);
            self.meter.add(n as u64);
        }
        poll
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Counting<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let poll = Pin::new(&mut self.as_mut().get_mut().inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = poll {
            self.meter.add(n as u64);
        }
        poll
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.as_mut().get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.as_mut().get_mut().inner).poll_shutdown(cx)
    }
}

struct ProxyStateInner {
    store: Mutex<ProxyStore>,
    pending_flush: AtomicU64,
    app: Mutex<Option<AppHandle>>,
}

pub struct ProxyState {
    inner: Arc<ProxyStateInner>,
}

impl Clone for ProxyState {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl ProxyState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(ProxyStateInner {
                store: Mutex::new(ProxyStore::default()),
                pending_flush: AtomicU64::new(0),
                app: Mutex::new(None),
            }),
        }
    }

    pub fn bind_app(&self, app: AppHandle) {
        if let Ok(mut guard) = self.inner.app.lock() {
            *guard = Some(app);
        }
    }

    pub fn get_store(&self) -> ProxyStore {
        self.inner.store.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn set_store(&self, store: ProxyStore) -> Result<(), String> {
        let mut guard = self.inner.store.lock().map_err(|_| "proxy lock poisoned".to_string())?;
        *guard = store;
        Ok(())
    }

    pub fn effective_settings(&self) -> ProxySettings {
        let store = self.get_store();
        let server = store
            .config
            .active_server_id
            .as_ref()
            .and_then(|id| store.servers.iter().find(|s| &s.id == id));

        if let Some(s) = server {
            ProxySettings {
                enabled: store.config.enabled,
                active_server_id: Some(s.id.clone()),
                proxy_type: s.proxy_type.clone(),
                host: s.host.clone(),
                port: s.port,
                username: s.username.clone(),
                password: s.password.clone(),
                apply_ssh: store.config.apply_ssh,
                apply_http: store.config.apply_http,
                lockdown: store.config.lockdown,
                bypass_local: store.config.bypass_local,
            }
        } else {
            ProxySettings {
                enabled: store.config.enabled,
                active_server_id: None,
                proxy_type: default_proxy_type(),
                host: String::new(),
                port: default_proxy_port(),
                username: String::new(),
                password: String::new(),
                apply_ssh: store.config.apply_ssh,
                apply_http: store.config.apply_http,
                lockdown: store.config.lockdown,
                bypass_local: store.config.bypass_local,
            }
        }
    }

    fn meter(&self, server_id: &str) -> ProxyMeter {
        ProxyMeter {
            inner: Arc::clone(&self.inner),
            server_id: server_id.to_string(),
        }
    }

    fn record_bytes(&self, server_id: &str, n: u64) {
        self.inner.record_bytes(server_id, n);
    }

    pub fn record_http_bytes(&self, n: u64) {
        let id = self
            .effective_settings()
            .active_server_id
            .unwrap_or_else(|| "http".to_string());
        self.record_bytes(&id, n);
    }

    pub fn flush_to_disk(&self) -> Result<(), String> {
        self.inner.flush_to_disk()
    }
}

impl ProxyStateInner {
    fn record_bytes(&self, server_id: &str, n: u64) {
        if n == 0 {
            return;
        }
        if let Ok(mut guard) = self.store.lock() {
            guard.stats.total_bytes = guard.stats.total_bytes.saturating_add(n);
            let entry = guard.stats.server_bytes.entry(server_id.to_string()).or_insert(0);
            *entry = entry.saturating_add(n);
        }
        let pending = self.pending_flush.fetch_add(n, Ordering::Relaxed) + n;
        if pending >= STATS_FLUSH_BYTES {
            self.pending_flush.store(0, Ordering::Relaxed);
            if let Ok(app_guard) = self.app.lock() {
                if let Some(app) = app_guard.as_ref() {
                    let store = self.store.lock().map(|g| g.clone()).unwrap_or_default();
                    let _ = save_proxy_store(app, &store);
                }
            }
        }
    }

    fn flush_to_disk(&self) -> Result<(), String> {
        self.pending_flush.store(0, Ordering::Relaxed);
        let app = self
            .app
            .lock()
            .map_err(|_| "proxy lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "App handle not bound".to_string())?;
        let store = self.store.lock().map(|g| g.clone()).unwrap_or_default();
        save_proxy_store(&app, &store)
    }
}

fn proxy_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create data dir {}: {e}", dir.display()))?;
    Ok(dir.join(PROXY_FILE))
}

fn migrate_legacy(legacy: LegacyProxySettings) -> ProxyStore {
    let mut store = ProxyStore::default();
    store.config.enabled = legacy.enabled;
    store.config.apply_ssh = legacy.apply_ssh;
    store.config.apply_http = legacy.apply_http;
    store.config.lockdown = legacy.lockdown;
    store.config.bypass_local = legacy.bypass_local;

    if !legacy.host.trim().is_empty() {
        let id = Uuid::new_v4().to_string();
        store.servers.push(ProxyServer {
            id: id.clone(),
            name: format!("{}:{}", legacy.host, legacy.port),
            proxy_type: legacy.proxy_type,
            host: legacy.host,
            port: legacy.port,
            username: legacy.username,
            password: legacy.password,
        });
        if legacy.enabled {
            store.config.active_server_id = Some(id);
        }
    }
    store
}

fn parse_proxy_file(bytes: &[u8]) -> Result<ProxyStore, String> {
    if let Ok(store) = serde_json::from_slice::<ProxyStore>(bytes) {
        return Ok(store);
    }
    let legacy: LegacyProxySettings =
        serde_json::from_slice(bytes).map_err(|e| format!("parse proxy config: {e}"))?;
    Ok(migrate_legacy(legacy))
}

pub fn load_proxy_settings(app: &AppHandle, state: &ProxyState) -> Result<(), String> {
    state.bind_app(app.clone());
    let path = proxy_path(app)?;
    if !path.exists() {
        return Ok(());
    }
    let bytes = fs::read(path).map_err(|e| format!("read proxy config: {e}"))?;
    let store = parse_proxy_file(&bytes)?;
    state.set_store(store)
}

pub fn save_proxy_store(app: &AppHandle, store: &ProxyStore) -> Result<(), String> {
    let path = proxy_path(app)?;
    let bytes =
        serde_json::to_vec_pretty(store).map_err(|e| format!("serialize proxy config: {e}"))?;
    fs::write(path, bytes).map_err(|e| format!("write proxy config: {e}"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestResponse {
    pub ok: bool,
    pub message: String,
}

pub enum ProxyStream {
    Direct(TcpStream),
    Socks5(Counting<tokio_socks::tcp::Socks5Stream<TcpStream>>),
    Socks4(Counting<tokio_socks::tcp::Socks4Stream<TcpStream>>),
    Http(Counting<PrefixedStream<TcpStream>>),
    Https(Counting<PrefixedStream<tokio_rustls::client::TlsStream<TcpStream>>>),
}

pub struct PrefixedStream<S> {
    inner: S,
    prefix: Vec<u8>,
    prefix_pos: usize,
}

impl<S> PrefixedStream<S> {
    fn new(inner: S, prefix: Vec<u8>) -> Self {
        Self {
            inner,
            prefix,
            prefix_pos: 0,
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for PrefixedStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.as_mut().get_mut();
        if this.prefix_pos < this.prefix.len() {
            let remaining = &this.prefix[this.prefix_pos..];
            let to_copy = remaining.len().min(buf.remaining());
            buf.put_slice(&remaining[..to_copy]);
            this.prefix_pos += to_copy;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for PrefixedStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.as_mut().get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.as_mut().get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.as_mut().get_mut().inner).poll_shutdown(cx)
    }
}

impl AsyncRead for ProxyStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            ProxyStream::Direct(s) => Pin::new(s).poll_read(cx, buf),
            ProxyStream::Socks5(s) => Pin::new(s).poll_read(cx, buf),
            ProxyStream::Socks4(s) => Pin::new(s).poll_read(cx, buf),
            ProxyStream::Http(s) => Pin::new(s).poll_read(cx, buf),
            ProxyStream::Https(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for ProxyStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            ProxyStream::Direct(s) => Pin::new(s).poll_write(cx, buf),
            ProxyStream::Socks5(s) => Pin::new(s).poll_write(cx, buf),
            ProxyStream::Socks4(s) => Pin::new(s).poll_write(cx, buf),
            ProxyStream::Http(s) => Pin::new(s).poll_write(cx, buf),
            ProxyStream::Https(s) => Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            ProxyStream::Direct(s) => Pin::new(s).poll_flush(cx),
            ProxyStream::Socks5(s) => Pin::new(s).poll_flush(cx),
            ProxyStream::Socks4(s) => Pin::new(s).poll_flush(cx),
            ProxyStream::Http(s) => Pin::new(s).poll_flush(cx),
            ProxyStream::Https(s) => Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            ProxyStream::Direct(s) => Pin::new(s).poll_shutdown(cx),
            ProxyStream::Socks5(s) => Pin::new(s).poll_shutdown(cx),
            ProxyStream::Socks4(s) => Pin::new(s).poll_shutdown(cx),
            ProxyStream::Http(s) => Pin::new(s).poll_shutdown(cx),
            ProxyStream::Https(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

fn proxy_addr_from(settings: &ProxySettings) -> String {
    format!("{}:{}", settings.host.trim(), settings.port)
}

fn target_addr(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

async fn read_connect_response(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(4096);
    let mut tmp = [0u8; 1024];
    loop {
        let n = stream
            .read(&mut tmp)
            .await
            .context("Failed to read proxy CONNECT response")?;
        if n == 0 {
            bail!("Proxy closed connection before CONNECT response");
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 8192 {
            bail!("Proxy CONNECT response headers too large");
        }
    }
    Ok(buf)
}

fn split_connect_response(raw: &[u8]) -> Result<(String, Vec<u8>)> {
    let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") else {
        bail!("Incomplete proxy CONNECT response");
    };
    let header_bytes = &raw[..pos];
    let status_line = std::str::from_utf8(header_bytes)
        .context("Invalid proxy CONNECT response encoding")?
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    if !status_line.contains(" 200 ") {
        bail!("Proxy CONNECT failed: {status_line}");
    }
    Ok((status_line, raw[pos + 4..].to_vec()))
}

async fn http_connect(settings: &ProxySettings, target_host: &str, target_port: u16) -> Result<PrefixedStream<TcpStream>> {
    let mut stream = TcpStream::connect(proxy_addr_from(settings))
        .await
        .with_context(|| format!("Failed to connect to HTTP proxy {}", proxy_addr_from(settings)))?;

    let target = target_addr(target_host, target_port);
    let mut request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some((user, pass)) = settings.creds() {
        use base64::Engine;
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("Connection: keep-alive\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .context("Failed to send HTTP CONNECT request")?;

    let raw = read_connect_response(&mut stream).await?;
    let (_status, prefix) = split_connect_response(&raw)?;
    Ok(PrefixedStream::new(stream, prefix))
}

async fn https_connect(
    settings: &ProxySettings,
    target_host: &str,
    target_port: u16,
) -> Result<PrefixedStream<tokio_rustls::client::TlsStream<TcpStream>>> {
    let tcp = TcpStream::connect(proxy_addr_from(settings))
        .await
        .with_context(|| format!("Failed to connect to HTTPS proxy {}", proxy_addr_from(settings)))?;

    let mut root_store = tokio_rustls::rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = tokio_rustls::rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    let connector = TlsConnector::from(std::sync::Arc::new(config));
    let server_name = ServerName::try_from(settings.host.trim())
        .map_err(|_| anyhow!("Invalid HTTPS proxy hostname"))?
        .to_owned();
    let mut tls = connector
        .connect(server_name, tcp)
        .await
        .context("TLS handshake with HTTPS proxy failed")?;

    let target = target_addr(target_host, target_port);
    let mut request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some((user, pass)) = settings.creds() {
        use base64::Engine;
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("Connection: keep-alive\r\n\r\n");
    tls.write_all(request.as_bytes())
        .await
        .context("Failed to send HTTPS proxy CONNECT request")?;

    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    loop {
        let n = tls
            .read(&mut tmp)
            .await
            .context("Failed to read HTTPS proxy CONNECT response")?;
        if n == 0 {
            bail!("HTTPS proxy closed connection before CONNECT response");
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 8192 {
            bail!("HTTPS proxy CONNECT response headers too large");
        }
    }
    let (_status, prefix) = split_connect_response(&buf)?;
    Ok(PrefixedStream::new(tls, prefix))
}

async fn connect_via_proxy(
    settings: &ProxySettings,
    target_host: &str,
    target_port: u16,
    meter: ProxyMeter,
) -> Result<ProxyStream> {
    let proxy = proxy_addr_from(settings);
    let target = target_addr(target_host, target_port);
    match settings.proxy_type.as_str() {
        "socks5" => {
            let stream = if let Some((user, pass)) = settings.creds() {
                tokio_socks::tcp::Socks5Stream::connect_with_password(proxy.as_str(), target.clone(), user, pass)
                    .await
            } else {
                tokio_socks::tcp::Socks5Stream::connect(proxy.as_str(), target).await
            }
            .map_err(|e| anyhow!("SOCKS5 proxy tunnel failed: {e}"))?;
            Ok(ProxyStream::Socks5(Counting::new(stream, meter)))
        }
        "socks4" => {
            let stream = if settings.username.trim().is_empty() {
                tokio_socks::tcp::Socks4Stream::connect(proxy.as_str(), target).await
            } else {
                tokio_socks::tcp::Socks4Stream::connect_with_userid(
                    proxy.as_str(),
                    target,
                    settings.username.trim(),
                )
                .await
            }
            .map_err(|e| anyhow!("SOCKS4 proxy tunnel failed: {e}"))?;
            Ok(ProxyStream::Socks4(Counting::new(stream, meter)))
        }
        "http" => {
            let stream = http_connect(settings, target_host, target_port).await?;
            Ok(ProxyStream::Http(Counting::new(stream, meter)))
        }
        "https" => {
            let stream = https_connect(settings, target_host, target_port).await?;
            Ok(ProxyStream::Https(Counting::new(stream, meter)))
        }
        other => bail!("Unsupported proxy type: {other}"),
    }
}

pub async fn open_connection(
    state: &ProxyState,
    target_host: &str,
    target_port: u16,
    for_ssh: bool,
) -> Result<ProxyStream> {
    let settings = state.effective_settings();
    if settings.should_use_for_host(for_ssh, target_host) {
        let server_id = settings
            .active_server_id
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        return connect_via_proxy(&settings, target_host, target_port, state.meter(&server_id)).await;
    }
    if settings.lockdown_blocks_host(for_ssh, target_host) {
        bail!("Lockdown mode: direct connections are blocked — configure and enable the proxy");
    }
    let stream = TcpStream::connect((target_host, target_port))
        .await
        .with_context(|| format!("Direct TCP connect to {target_host}:{target_port} failed"))?;
    Ok(ProxyStream::Direct(stream))
}

fn proxy_url_for_reqwest(settings: &ProxySettings) -> Result<String> {
    let host = settings.host.trim();
    if host.is_empty() {
        bail!("Proxy host is empty");
    }
    let scheme = match settings.proxy_type.as_str() {
        "socks5" => "socks5",
        "socks4" => "socks4",
        "http" => "http",
        "https" => "https",
        other => bail!("Unsupported proxy type for HTTP client: {other}"),
    };
    if let Some((user, pass)) = settings.creds() {
        Ok(format!("{scheme}://{user}:{pass}@{host}:{}", settings.port))
    } else {
        Ok(format!("{scheme}://{host}:{}", settings.port))
    }
}

pub fn build_http_client(state: &ProxyState) -> Result<Client, String> {
    let settings = state.effective_settings();
    let mut builder = Client::builder();
    if settings.should_use_for(false) {
        let url = proxy_url_for_reqwest(&settings).map_err(|e| e.to_string())?;
        let proxy = Proxy::all(&url).map_err(|e| format!("Invalid proxy URL: {e}"))?;
        builder = builder.proxy(proxy);
    } else if settings.lockdown_blocks(false) {
        return Err("Lockdown mode: HTTP traffic must use the proxy".to_string());
    }
    builder
        .build()
        .map_err(|e| format!("http client init failed: {e}"))
}

fn settings_from_server(server: &ProxyServer, config: &ProxyConfig) -> ProxySettings {
    ProxySettings {
        enabled: config.enabled,
        active_server_id: Some(server.id.clone()),
        proxy_type: server.proxy_type.clone(),
        host: server.host.clone(),
        port: server.port,
        username: server.username.clone(),
        password: server.password.clone(),
        apply_ssh: config.apply_ssh,
        apply_http: config.apply_http,
        lockdown: config.lockdown,
        bypass_local: config.bypass_local,
    }
}

pub async fn test_proxy_server(server: &ProxyServer, config: &ProxyConfig) -> ProxyTestResponse {
    let settings = settings_from_server(server, config);
    if server.host.trim().is_empty() || server.port == 0 {
        return ProxyTestResponse {
            ok: false,
            message: "Proxy server host/port is not configured".to_string(),
        };
    }
    match connect_via_proxy(
        &settings,
        "api.github.com",
        443,
        ProxyMeter {
            inner: Arc::new(ProxyStateInner {
                store: Mutex::new(ProxyStore::default()),
                pending_flush: AtomicU64::new(0),
                app: Mutex::new(None),
            }),
            server_id: server.id.clone(),
        },
    )
    .await
    {
        Ok(_) => ProxyTestResponse {
            ok: true,
            message: format!(
                "Connected to api.github.com:443 via {} {}:{}",
                server.proxy_type, server.host, server.port
            ),
        },
        Err(e) => ProxyTestResponse {
            ok: false,
            message: format!("Proxy test failed: {e:#}"),
        },
    }
}

#[tauri::command]
pub fn proxy_get(state: State<'_, ProxyState>) -> Result<ProxyStore, String> {
    let _ = state.flush_to_disk();
    Ok(state.get_store())
}

#[tauri::command]
pub fn proxy_set_config(
    app: AppHandle,
    state: State<'_, ProxyState>,
    config: ProxyConfig,
) -> Result<ProxyStore, String> {
    let mut store = state.get_store();
    store.config = config;
    state.set_store(store.clone())?;
    save_proxy_store(&app, &store)?;
    Ok(store)
}

#[tauri::command]
pub fn proxy_upsert_server(
    app: AppHandle,
    state: State<'_, ProxyState>,
    server: ProxyServer,
) -> Result<ProxyStore, String> {
    let mut store = state.get_store();
    if server.id.trim().is_empty() {
        let new_id = Uuid::new_v4().to_string();
        let mut entry = server;
        entry.id = new_id.clone();
        if entry.name.trim().is_empty() {
            entry.name = format!("{}:{}", entry.host, entry.port);
        }
        store.servers.push(entry);
        if store.config.active_server_id.is_none() {
            store.config.active_server_id = Some(new_id);
        }
    } else if let Some(existing) = store.servers.iter_mut().find(|s| s.id == server.id) {
        *existing = server;
    } else {
        let mut entry = server;
        if entry.name.trim().is_empty() {
            entry.name = format!("{}:{}", entry.host, entry.port);
        }
        store.servers.push(entry);
    }
    state.set_store(store.clone())?;
    save_proxy_store(&app, &store)?;
    Ok(store)
}

#[tauri::command]
pub fn proxy_delete_server(
    app: AppHandle,
    state: State<'_, ProxyState>,
    id: String,
) -> Result<ProxyStore, String> {
    let mut store = state.get_store();
    store.servers.retain(|s| s.id != id);
    store.stats.server_bytes.remove(&id);
    if store.config.active_server_id.as_deref() == Some(id.as_str()) {
        store.config.active_server_id = store.servers.first().map(|s| s.id.clone());
    }
    state.set_store(store.clone())?;
    save_proxy_store(&app, &store)?;
    Ok(store)
}

#[tauri::command]
pub fn proxy_import_sync(
    app: AppHandle,
    state: State<'_, ProxyState>,
    servers: Vec<ProxyServer>,
    config: ProxyConfig,
) -> Result<ProxyStore, String> {
    let mut store = state.get_store();
    store.servers = servers;
    store.config = config;
    state.set_store(store.clone())?;
    save_proxy_store(&app, &store)?;
    Ok(store)
}

#[tauri::command]
pub async fn proxy_test(
    state: State<'_, ProxyState>,
    server_id: Option<String>,
) -> Result<ProxyTestResponse, String> {
    let store = state.get_store();
    let server = if let Some(id) = server_id {
        store
            .servers
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| "Proxy server not found".to_string())?
    } else {
        let id = store
            .config
            .active_server_id
            .clone()
            .ok_or_else(|| "No active proxy server selected".to_string())?;
        store
            .servers
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| "Active proxy server not found".to_string())?
    };
    Ok(test_proxy_server(&server, &store.config).await)
}
