import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { listen } from "@tauri-apps/api/event";
import {
  ChevronDown,
  ChevronRight,
  Edit3,
  Folder,
  FolderOpen,
  KeyRound,
  Laptop,
  Lock,
  Logs,
  Network,
  Plus,
  Search,
  Server,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
  Unplug,
  Eye,
  EyeOff,
  X,
  Settings2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  clearTerminalSessionCache,
  TerminalView,
  type TerminalKeywordSettings,
} from "@/components/terminal-view";
import { SftpView, clearSftpSessionCache } from "@/components/sftp-view";
import { TitleBar } from "@/components/title-bar";
import { VaultOverlay } from "@/components/vault-overlay";
import { ThemePicker } from "@/components/theme-picker";
import {
  formatSftpBannerLabel,
  formatSessionTabLabel,
  hostCardSubtitle,
  hostCardTitle,
  hostPasswordDisplay,
  redactConnectionLogLine,
} from "@/lib/privacy-display";

type Host = {
  id: string;
  group: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key";
  password?: string;
  privateKey?: string;
  passphrase?: string;
  tags: string[];
};

type SessionTab = {
  id: string;
  hostId: string;
  hostLabel: string;
  sessionId: string | null;
  disconnected: boolean;
  disconnectReason?: string;
};
type SshProgressPayload = { line: string };
type Screen = "hosts" | "terminal" | "sftp";
type HostStatus = "checking" | "online" | "offline" | "connecting";
type SidebarSection = "hosts" | "keychain" | "proxy" | "snippets" | "known" | "logs" | "settings";
type TerminalState = "empty" | "connecting" | "connected" | "disconnected" | "error";
type SftpState = "empty" | "connecting" | "connected" | "error";
type ShellStartResponse = { session_id: string };
type SshHostMetricsResponse = {
  cpu_model: string;
  cpu_usage_percent: number;
  ram_total_mb: number;
  ram_used_mb: number;
  upload_kbps: number;
  download_kbps: number;
};
type SftpConnectResponse = { session_id: string; home: string };
type SftpSessionInfo = { sessionId: string; home: string; hostLabel: string; hostId: string };
type SyncStatusResponse = { enabled: boolean; gist_id: string | null };
type SyncEnableResponse = { gist_id: string; sync_key: string };
type SyncPollResponse = { has_update: boolean; payload: string | null };
type UpdateCheckResponse = {
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  available_for_os: boolean;
  os: string;
  arch: string;
  release_url: string | null;
  asset_name: string | null;
  message: string;
};
type UpdateInstallResponse = {
  installer_path: string;
  message: string;
};
type ProxyType = "socks5" | "socks4" | "http" | "https";
type ProxyServer = {
  id: string;
  name: string;
  type: ProxyType;
  host: string;
  port: number;
  username: string;
  password: string;
};
type ProxyConfig = {
  enabled: boolean;
  activeServerId: string | null;
  applySsh: boolean;
  applyHttp: boolean;
  lockdown: boolean;
};
type ProxyStats = {
  totalBytes: number;
  serverBytes: Record<string, number>;
};
type ProxyStore = {
  servers: ProxyServer[];
  config: ProxyConfig;
  stats: ProxyStats;
};
type ProxyTestResponse = { ok: boolean; message: string };
type ProxyServerDraft = {
  id: string | null;
  name: string;
  type: ProxyType;
  host: string;
  port: string;
  username: string;
  password: string;
};

const defaultProxyConfig: ProxyConfig = {
  enabled: false,
  activeServerId: null,
  applySsh: true,
  applyHttp: true,
  lockdown: false,
};

const defaultProxyStore: ProxyStore = {
  servers: [],
  config: defaultProxyConfig,
  stats: { totalBytes: 0, serverBytes: {} },
};

const emptyProxyServerDraft: ProxyServerDraft = {
  id: null,
  name: "",
  type: "socks5",
  host: "",
  port: "1080",
  username: "",
  password: "",
};

function formatProxyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

type HostDraft = {
  id: string | null;
  group: string;
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: "password" | "key";
  password: string;
  privateKey: string;
  passphrase: string;
  tags: string;
};

const emptyDraft: HostDraft = {
  id: null,
  group: "Default",
  name: "",
  host: "",
  port: "22",
  username: "root",
  authMethod: "password",
  password: "",
  privateKey: "",
  passphrase: "",
  tags: "",
};

function hostStatusLabel(status: HostStatus): string {
  if (status === "checking" || status === "connecting") return "connecting";
  if (status === "online") return "connected";
  return "offline";
}

function reachabilityLabel(status: HostStatus | undefined): string | null {
  if (!status) return null;
  if (status === "checking" || status === "connecting") return "testing…";
  if (status === "online") return "reachable";
  return "unreachable";
}

function statusColor(status: HostStatus) {
  if (status === "online") return "text-emerald-400";
  if (status === "checking" || status === "connecting") return "text-amber-400";
  return "text-rose-400";
}

function statusDot(status: HostStatus) {
  if (status === "online") return "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]";
  if (status === "checking" || status === "connecting") {
    return "bg-amber-300 animate-pulse shadow-[0_0_8px_rgba(252,211,77,0.8)]";
  }
  return "bg-rose-400/80";
}

function hostConnectReq(host: Host) {
  return {
    host: host.host,
    port: host.port,
    username: host.username,
    password: host.password,
    privateKey: host.privateKey,
    passphrase: host.passphrase,
  };
}

type TopBarProps = {
  screen: Screen;
  onChangeScreen: (screen: Screen) => void;
  activeSessionCount: number;
  sftpConnected: boolean;
  onLock?: () => void;
  right?: ReactNode;
};

function TopBar({ screen, onChangeScreen, activeSessionCount, sftpConnected, onLock, right }: TopBarProps) {
  return (
    <header className="app-header relative z-20 flex h-14 shrink-0 items-center justify-between gap-4 px-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="hidden items-center rounded-full border app-chrome-border bg-muted/30 p-1 text-xs md:flex">
          <button
            onClick={() => onChangeScreen("hosts")}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 transition ${
              screen === "hosts" ? "app-nav-active" : "app-chrome-muted hover:app-chrome-text"
            }`}
          >
            <Server className="h-3.5 w-3.5" />
            Hosts
          </button>
          <button
            onClick={() => onChangeScreen("terminal")}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 transition ${
              screen === "terminal" ? "app-nav-active" : "app-chrome-muted hover:app-chrome-text"
            }`}
          >
            <Terminal className="h-3.5 w-3.5" />
            Terminal
            {activeSessionCount > 0 ? (
              <span className="ml-1 rounded-full app-accent-bg px-1.5 text-[10px] font-medium">
                {activeSessionCount}
              </span>
            ) : null}
          </button>
          <button
            onClick={() => onChangeScreen("sftp")}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 transition ${
              screen === "sftp" ? "app-nav-active" : "app-chrome-muted hover:app-chrome-text"
            }`}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            SFTP
            {sftpConnected ? (
              <span className="ml-1 h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
            ) : null}
          </button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {right}
        {onLock ? (
          <>
            <div className="mx-1 h-6 w-px app-chrome-border bg-[currentColor]" />
            <button
              type="button"
              onClick={onLock}
              title="Lock vault"
              className="app-chrome-muted flex h-9 w-9 items-center justify-center rounded-md border app-chrome-border bg-muted/30 transition hover:app-nav-active"
            >
              <Lock className="h-4 w-4" />
            </button>
          </>
        ) : null}
      </div>
    </header>
  );
}

type VaultUiState = "loading" | "new" | "locked" | "unlocked";

function App() {
  function metricColor(percent: number): string {
    if (percent > 90) return "text-destructive";
    if (percent > 75) return "text-amber-400";
    return "app-text-muted";
  }

  const [screen, setScreen] = useState<Screen>("hosts");
  const [hosts, setHosts] = useState<Host[]>([]);
  const [connectingHosts, setConnectingHosts] = useState<Record<string, boolean>>({});
  const [hostReachability, setHostReachability] = useState<Record<string, HostStatus>>({});
  const [checkingAllHosts, setCheckingAllHosts] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [sidebarSection, setSidebarSection] = useState<SidebarSection>("hosts");
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [isHostModalOpen, setIsHostModalOpen] = useState(false);
  const [showHostModalPassword, setShowHostModalPassword] = useState(false);
  const [revealedHostPasswords, setRevealedHostPasswords] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<HostDraft>(emptyDraft);
  const [tabs, setTabs] = useState<SessionTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const activeTabIdRef = useRef<string | null>(null);
  const [terminalState, setTerminalState] = useState<TerminalState>("empty");
  const [terminalError, setTerminalError] = useState("");
  const [sshProgressLines, setSshProgressLines] = useState<string[]>([]);
  const [reconnectError, setReconnectError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sftpSession, setSftpSession] = useState<SftpSessionInfo | null>(null);
  const [sftpState, setSftpState] = useState<SftpState>("empty");
  const [sftpError, setSftpError] = useState("");
  const [vaultStatus, setVaultStatus] = useState<VaultUiState>("loading");
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultError, setVaultError] = useState("");
  const skipNextSaveRef = useRef(false);
  const reachabilityProbeGenRef = useRef(0);
  const [terminalKeywordSettings, setTerminalKeywordSettings] = useState<TerminalKeywordSettings>({
    enabled: true,
    colors: {
      error: "#ff5f66",
      warning: "#ffd84d",
      ok: "#7ce38b",
      info: "#3da5ff",
      debug: "#8f8cff",
      network: "#e061b3",
    },
  });
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [syncInfo, setSyncInfo] = useState("");
  const [syncToken, setSyncToken] = useState("");
  const [syncGistId, setSyncGistId] = useState("");
  const [syncKey, setSyncKey] = useState("");
  const [syncReadyForPush, setSyncReadyForPush] = useState(false);
  const SFTP_HIDE_DOTFILES_KEY = "rsshu.settings.sftpHideDotfiles";
  const SFTP_OPEN_EDIT_KEY = "rsshu.settings.sftpOpenEditMode";
  const PRIVACY_REDACT_HOSTS_KEY = "rsshu.settings.privacyRedactHosts";
  const TERMINAL_HOST_INFO_BAR_KEY = "rsshu.settings.terminalHostInfoBar";
  const TCPRAW_ENABLED_KEY = "rsshu.settings.tcprawEnabled";
  const AUTO_INSTALL_UPDATES_KEY = "rsshu.settings.autoInstallUpdates";
  const QUICK_NAV_KEY_STORAGE = "rsshu.settings.quickNavKey";
  const CONNECT_COUNTS_KEY = "rsshu.connectCounts";
  /** Remote metrics script sleeps 0.5s for CPU/network delta; poll slightly above that. */
  const HOST_METRICS_POLL_MS = 2000;
  const [sftpHideDotfiles, setSftpHideDotfiles] = useState(false);
  const [sftpOpenEditMode, setSftpOpenEditMode] = useState<"auto" | "confirm">("auto");
  const [privacyRedactHosts, setPrivacyRedactHosts] = useState(false);
  const [showTerminalHostInfoBar, setShowTerminalHostInfoBar] = useState(true);
  const [tcprawEnabled, setTcprawEnabled] = useState(false);
  const [tcprawCode, setTcprawCode] = useState<string | null>(null);
  const [autoInstallUpdates, setAutoInstallUpdates] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResponse | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [updateInfo, setUpdateInfo] = useState("");
  const [proxyStore, setProxyStore] = useState<ProxyStore>(defaultProxyStore);
  const [proxyConfigDraft, setProxyConfigDraft] = useState<ProxyConfig>(defaultProxyConfig);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [proxyInfo, setProxyInfo] = useState("");
  const [proxyError, setProxyError] = useState("");
  const [isProxyServerModalOpen, setIsProxyServerModalOpen] = useState(false);
  const [proxyServerDraft, setProxyServerDraft] = useState<ProxyServerDraft>(emptyProxyServerDraft);
  const [showProxyPassword, setShowProxyPassword] = useState(false);
  const [quickNavKey, setQuickNavKey] = useState("F2");
  const [capturingKey, setCapturingKey] = useState(false);
  const [connectCounts, setConnectCounts] = useState<Record<string, { ssh: number; sftp: number }>>(
    () => {
      try {
        const raw = localStorage.getItem(CONNECT_COUNTS_KEY);
        if (raw) return JSON.parse(raw) as Record<string, { ssh: number; sftp: number }>;
      } catch { /* ignore */ }
      return {};
    },
  );
  const [hostMetrics, setHostMetrics] = useState<SshHostMetricsResponse | null>(null);
  const [hostMetricsLoading, setHostMetricsLoading] = useState(false);
  const [hostMetricsError, setHostMetricsError] = useState("");
  const hostMetricsInFlightRef = useRef(false);
  const hostMetricsFirstLoadRef = useRef(true);
  const autoUpdateCheckedRef = useRef(false);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    try {
      const v = localStorage.getItem(PRIVACY_REDACT_HOSTS_KEY);
      if (v === "1" || v === "true") setPrivacyRedactHosts(true);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      const v = localStorage.getItem(TERMINAL_HOST_INFO_BAR_KEY);
      if (v === "0" || v === "false") setShowTerminalHostInfoBar(false);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      const v = localStorage.getItem(SFTP_HIDE_DOTFILES_KEY);
      if (v === "1" || v === "true") setSftpHideDotfiles(true);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      const v = localStorage.getItem(SFTP_OPEN_EDIT_KEY);
      if (v === "confirm") setSftpOpenEditMode("confirm");
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      const v = localStorage.getItem(TCPRAW_ENABLED_KEY);
      if (v === "1" || v === "true") setTcprawEnabled(true);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      const v = localStorage.getItem(AUTO_INSTALL_UPDATES_KEY);
      if (v === "1" || v === "true") setAutoInstallUpdates(true);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void invoke<ProxyStore>("proxy_get")
      .then((store) => {
        setProxyStore(store);
        setProxyConfigDraft(store.config);
      })
      .catch(() => {
        // ignore — backend may not be ready yet
      });
  }, []);

  useEffect(() => {
    if (sidebarSection !== "proxy") return;
    const timer = window.setInterval(() => {
      void invoke<ProxyStore>("proxy_get")
        .then((store) => {
          setProxyStore((prev) => ({
            ...prev,
            stats: store.stats,
          }));
        })
        .catch(() => {
          // ignore
        });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [sidebarSection]);

  useEffect(() => {
    if (!autoInstallUpdates || autoUpdateCheckedRef.current) return;
    autoUpdateCheckedRef.current = true;
    void checkForUpdates(true);
  }, [autoInstallUpdates]);

  useEffect(() => {
    try {
      const v = localStorage.getItem(QUICK_NAV_KEY_STORAGE);
      if (v) setQuickNavKey(v);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const status = await invoke<{ initialized: boolean; unlocked: boolean }>("vault_status");
        if (status.unlocked) {
          setVaultStatus("unlocked");
        } else if (status.initialized) {
          setVaultStatus("locked");
        } else {
          setVaultStatus("new");
        }
      } catch (err) {
        setVaultError(String(err));
        setVaultStatus("new");
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const status = await invoke<SyncStatusResponse>("sync_status");
        setSyncEnabled(status.enabled);
        if (status.gist_id) {
          setSyncGistId(status.gist_id);
        }
      } catch (err) {
        console.error("[sync] status failed", err);
      }
    })();
  }, []);

  useEffect(() => {
    if (vaultStatus !== "unlocked") return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    const handle = window.setTimeout(() => {
      void invoke("vault_save", { hostsJson: JSON.stringify(hosts) }).catch((err) => {
        console.error("[vault] save failed", err);
      });
    }, 150);
    return () => window.clearTimeout(handle);
  }, [hosts, vaultStatus]);

  useEffect(() => {
    if (vaultStatus !== "unlocked" || !syncEnabled || !syncReadyForPush) return;
    const handle = window.setTimeout(() => {
      void invoke("sync_push", { hostsJson: JSON.stringify(hosts) }).catch((err) => {
        console.error("[sync] push failed", err);
      });
    }, 300);
    return () => window.clearTimeout(handle);
  }, [hosts, vaultStatus, syncEnabled, syncReadyForPush]);

  useEffect(() => {
    if (vaultStatus !== "unlocked" || !syncEnabled) {
      setSyncReadyForPush(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const json = await invoke<string>("sync_pull");
        if (cancelled) return;
        const parsed = JSON.parse(json || "[]");
        if (Array.isArray(parsed)) {
          setHosts(parsed as Host[]);
          setSyncInfo("Startup sync completed (pulled from cloud).");
        }
        setSyncReadyForPush(true);
      } catch (err) {
        if (cancelled) return;
        setSyncError(String(err));
        setSyncReadyForPush(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultStatus, syncEnabled]);

  useEffect(() => {
    if (vaultStatus !== "unlocked" || !syncEnabled || !syncReadyForPush) return;
    const interval = window.setInterval(() => {
      void (async () => {
        try {
          const poll = await invoke<SyncPollResponse>("sync_poll_updates");
          if (!poll.has_update || !poll.payload) return;
          const parsed = JSON.parse(poll.payload || "[]");
          if (Array.isArray(parsed)) {
            setHosts(parsed as Host[]);
            setSyncInfo("Cloud update detected and imported.");
          }
        } catch (err) {
          console.error("[sync] poll failed", err);
        }
      })();
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [vaultStatus, syncEnabled, syncReadyForPush]);

  async function handleVaultInit(password: string) {
    setVaultBusy(true);
    setVaultError("");
    try {
      await invoke("vault_init", { password });
      skipNextSaveRef.current = true;
      setHosts([]);
      setHostReachability({});
      setConnectingHosts({});
      setVaultStatus("unlocked");
    } catch (err) {
      setVaultError(String(err));
    } finally {
      setVaultBusy(false);
    }
  }

  async function handleVaultUnlock(password: string) {
    setVaultBusy(true);
    setVaultError("");
    try {
      const json = await invoke<string>("vault_unlock", { password });
      let parsed: Host[] = [];
      try {
        const raw = JSON.parse(json || "[]");
        if (Array.isArray(raw)) {
          parsed = raw as Host[];
        }
      } catch {
        parsed = [];
      }
      skipNextSaveRef.current = true;
      setHosts(parsed);
      setVaultStatus("unlocked");
    } catch (err) {
      setVaultError(String(err));
    } finally {
      setVaultBusy(false);
    }
  }

  async function handleVaultLock() {
    try {
      await invoke("vault_lock");
    } catch {
      // best-effort
    }
    if (sftpSession) {
      try {
        await invoke("sftp_disconnect", { sessionId: sftpSession.sessionId });
      } catch {
        // best-effort
      }
      clearSftpSessionCache(sftpSession.sessionId, sftpSession.hostId);
    }
    for (const tab of tabs) {
      if (!tab.sessionId) continue;
      try {
        await invoke("ssh_close_shell", { sessionId: tab.sessionId });
      } catch {
        // best-effort
      }
    }
    skipNextSaveRef.current = true;
    setHosts([]);
    setHostReachability({});
    setConnectingHosts({});
    setTabs([]);
    setActiveTabId(null);
    setTerminalState("empty");
    setSftpSession(null);
    setSftpState("empty");
    setScreen("hosts");
    setVaultError("");
    setVaultStatus("locked");
    setSyncReadyForPush(false);
  }

  async function enableSync() {
    setSyncBusy(true);
    setSyncError("");
    setSyncInfo("");
    try {
      const res = await invoke<SyncEnableResponse>("sync_enable", {
        req: {
          github_token: syncToken,
          gist_id: syncGistId || null,
          sync_key: syncKey || null,
        },
      });
      setSyncEnabled(true);
      setSyncReadyForPush(false);
      setSyncGistId(res.gist_id);
      setSyncKey(res.sync_key);
      setSyncInfo("Sync enabled. Save this key for second computer.");
    } catch (err) {
      setSyncError(String(err));
    } finally {
      setSyncBusy(false);
    }
  }

  async function disableSync() {
    setSyncBusy(true);
    setSyncError("");
    setSyncInfo("");
    try {
      await invoke("sync_disable");
      setSyncEnabled(false);
      setSyncReadyForPush(false);
      setSyncInfo("Sync disabled.");
    } catch (err) {
      setSyncError(String(err));
    } finally {
      setSyncBusy(false);
    }
  }

  async function pullFromCloud() {
    setSyncBusy(true);
    setSyncError("");
    setSyncInfo("");
    try {
      const json = await invoke<string>("sync_pull");
      const parsed = JSON.parse(json || "[]");
      if (Array.isArray(parsed)) {
        setHosts(parsed as Host[]);
      }
      setSyncInfo("Pulled latest data from GitHub Gist.");
    } catch (err) {
      setSyncError(String(err));
    } finally {
      setSyncBusy(false);
    }
  }

  async function installLatestUpdate() {
    setUpdateBusy(true);
    setUpdateError("");
    setUpdateInfo("Downloading installer…");
    try {
      const res = await invoke<UpdateInstallResponse>("app_install_update");
      setUpdateInfo(res.message);
    } catch (err) {
      setUpdateError(String(err));
      setUpdateInfo("");
    } finally {
      setUpdateBusy(false);
    }
  }

  async function checkForUpdates(installWhenAvailable = false) {
    setUpdateBusy(true);
    setUpdateError("");
    setUpdateInfo("");
    try {
      const res = await invoke<UpdateCheckResponse>("app_check_update");
      setUpdateCheck(res);
      setUpdateInfo(res.message);
      if (installWhenAvailable && res.update_available) {
        await installLatestUpdate();
      }
    } catch (err) {
      setUpdateError(String(err));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function saveProxyConfig() {
    setProxyBusy(true);
    setProxyError("");
    setProxyInfo("");
    try {
      const store = await invoke<ProxyStore>("proxy_set_config", { config: proxyConfigDraft });
      setProxyStore(store);
      setProxyConfigDraft(store.config);
      setProxyInfo("Proxy options saved.");
    } catch (err) {
      setProxyError(String(err));
    } finally {
      setProxyBusy(false);
    }
  }

  async function saveProxyServer() {
    setProxyBusy(true);
    setProxyError("");
    setProxyInfo("");
    try {
      const port = Number.parseInt(proxyServerDraft.port, 10);
      if (!proxyServerDraft.host.trim() || !port) {
        throw new Error("Host and port are required.");
      }
      const server: ProxyServer = {
        id: proxyServerDraft.id ?? "",
        name: proxyServerDraft.name.trim() || `${proxyServerDraft.host}:${port}`,
        type: proxyServerDraft.type,
        host: proxyServerDraft.host.trim(),
        port,
        username: proxyServerDraft.username,
        password: proxyServerDraft.password,
      };
      const store = await invoke<ProxyStore>("proxy_upsert_server", { server });
      setProxyStore(store);
      setProxyConfigDraft(store.config);
      setIsProxyServerModalOpen(false);
      setProxyServerDraft(emptyProxyServerDraft);
      setProxyInfo(server.id ? "Proxy server updated." : "Proxy server added.");
    } catch (err) {
      setProxyError(String(err));
    } finally {
      setProxyBusy(false);
    }
  }

  async function deleteProxyServer(id: string) {
    setProxyBusy(true);
    setProxyError("");
    setProxyInfo("");
    try {
      const store = await invoke<ProxyStore>("proxy_delete_server", { id });
      setProxyStore(store);
      setProxyConfigDraft(store.config);
      setProxyInfo("Proxy server removed.");
    } catch (err) {
      setProxyError(String(err));
    } finally {
      setProxyBusy(false);
    }
  }

  async function testProxyConnection(serverId?: string) {
    setProxyBusy(true);
    setProxyError("");
    setProxyInfo("");
    try {
      const result = await invoke<ProxyTestResponse>("proxy_test", { serverId: serverId ?? null });
      if (result.ok) {
        setProxyInfo(result.message);
      } else {
        setProxyError(result.message);
      }
    } catch (err) {
      setProxyError(String(err));
    } finally {
      setProxyBusy(false);
    }
  }

  function openNewProxyServerModal() {
    setProxyServerDraft(emptyProxyServerDraft);
    setShowProxyPassword(false);
    setIsProxyServerModalOpen(true);
  }

  function openEditProxyServerModal(server: ProxyServer) {
    setProxyServerDraft({
      id: server.id,
      name: server.name,
      type: server.type,
      host: server.host,
      port: String(server.port),
      username: server.username,
      password: server.password,
    });
    setShowProxyPassword(false);
    setIsProxyServerModalOpen(true);
  }

  const filteredHosts = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return hosts;
    return hosts.filter(
      (h) =>
        h.name.toLowerCase().includes(term) ||
        h.host.toLowerCase().includes(term) ||
        h.group.toLowerCase().includes(term) ||
        h.tags.some((t) => t.toLowerCase().includes(term)),
    );
  }, [hosts, search]);

  const groupedHosts = useMemo(() => {
    return filteredHosts.reduce<Record<string, Host[]>>((acc, host) => {
      if (!acc[host.group]) acc[host.group] = [];
      acc[host.group].push(host);
      return acc;
    }, {});
  }, [filteredHosts]);

  const hostConnectionStatus = useMemo(() => {
    const map: Record<string, HostStatus> = {};
    for (const host of hosts) {
      if (connectingHosts[host.id]) {
        map[host.id] = "checking";
      } else if (
        tabs.some((t) => t.hostId === host.id && t.sessionId && !t.disconnected) ||
        (sftpSession?.hostId === host.id && sftpState === "connected")
      ) {
        map[host.id] = "online";
      } else {
        map[host.id] = "offline";
      }
    }
    return map;
  }, [hosts, connectingHosts, tabs, sftpSession, sftpState]);

  const setHostConnecting = useCallback((hostId: string, connecting: boolean) => {
    setConnectingHosts((prev) => {
      if (connecting) return { ...prev, [hostId]: true };
      const next = { ...prev };
      delete next[hostId];
      return next;
    });
  }, []);

  const checkAllHostsReachability = useCallback(async (hostList: Host[]) => {
    if (hostList.length === 0) return;
    const gen = ++reachabilityProbeGenRef.current;
    setCheckingAllHosts(true);
    setHostReachability((prev) => {
      const next = { ...prev };
      for (const h of hostList) next[h.id] = "checking";
      return next;
    });

    const pending = [...hostList];
    try {
      while (pending.length > 0) {
        if (reachabilityProbeGenRef.current !== gen) return;
        const batch = pending.splice(0, 3);
        await Promise.all(
          batch.map(async (host) => {
            if (reachabilityProbeGenRef.current !== gen) return;
            try {
              await invoke("ssh_test_connection", { req: hostConnectReq(host) });
              if (reachabilityProbeGenRef.current === gen) {
                setHostReachability((prev) => ({ ...prev, [host.id]: "online" }));
              }
            } catch {
              if (reachabilityProbeGenRef.current === gen) {
                setHostReachability((prev) => ({ ...prev, [host.id]: "offline" }));
              }
            }
          }),
        );
      }
    } finally {
      if (reachabilityProbeGenRef.current === gen) {
        setCheckingAllHosts(false);
      }
    }
  }, []);

  const activeHost = useMemo(
    () => hosts.find((item) => item.id === activeHostId) ?? filteredHosts[0] ?? null,
    [hosts, filteredHosts, activeHostId],
  );

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? null, [tabs, activeTabId]);
  const activeTabHost = useMemo(
    () => hosts.find((item) => item.id === activeTab?.hostId) ?? null,
    [hosts, activeTab?.hostId],
  );

  useEffect(() => {
    if (
      !showTerminalHostInfoBar ||
      screen !== "terminal" ||
      terminalState !== "connected" ||
      !activeTab?.sessionId
    ) {
      setHostMetrics(null);
      setHostMetricsError("");
      setHostMetricsLoading(false);
      return;
    }

    hostMetricsFirstLoadRef.current = true;
    let cancelled = false;
    const fetchMetrics = async () => {
      if (hostMetricsInFlightRef.current) return;
      hostMetricsInFlightRef.current = true;
      const showLoading = hostMetricsFirstLoadRef.current;
      try {
        if (showLoading) setHostMetricsLoading(true);
        setHostMetricsError("");
        const metrics = await invoke<SshHostMetricsResponse>("ssh_fetch_host_metrics", {
          sessionId: activeTab.sessionId,
        });
        if (cancelled) return;
        setHostMetrics(metrics);
        hostMetricsFirstLoadRef.current = false;
      } catch (error) {
        if (cancelled) return;
        setHostMetricsError(String(error));
      } finally {
        hostMetricsInFlightRef.current = false;
        if (!cancelled && showLoading) setHostMetricsLoading(false);
      }
    };

    void fetchMetrics();
    const timer = window.setInterval(() => void fetchMetrics(), HOST_METRICS_POLL_MS);
    return () => {
      cancelled = true;
      hostMetricsInFlightRef.current = false;
      window.clearInterval(timer);
    };
  }, [showTerminalHostInfoBar, screen, terminalState, activeTab?.sessionId]);

  useEffect(() => {
    if (!tcprawEnabled || screen !== "terminal" || terminalState !== "connected" || !activeTab?.sessionId) {
      setTcprawCode(null);
      return;
    }
    const poll = window.setInterval(() => {
      void readText()
        .then((text: string) => {
          const trimmed = (text ?? "").trim();
          setTcprawCode(/^\d{6}$/.test(trimmed) ? trimmed : null);
        })
        .catch(() => setTcprawCode(null));
    }, 600);
    return () => window.clearInterval(poll);
  }, [tcprawEnabled, screen, terminalState, activeTab?.sessionId]);

  // Build a "Ctrl+Alt+X"-style label from a KeyboardEvent.
  function buildKeyCombo(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.metaKey) parts.push("Meta");
    if (e.shiftKey) parts.push("Shift");
    if (!["Control", "Alt", "Shift", "Meta"].includes(e.key)) parts.push(e.key);
    return parts.join("+");
  }

  // Build a "Mouse4"-style label from a MouseEvent (extra buttons only).
  function buildMouseCombo(e: MouseEvent): string {
    return `Mouse${e.button}`;
  }

  // Whether the stored shortcut is a mouse-button binding.
  function isMouseCombo(combo: string): boolean {
    return combo.startsWith("Mouse");
  }

  // Quick-capture: grab the next keydown or extra mousedown and save as shortcut.
  useEffect(() => {
    if (!capturingKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const combo = buildKeyCombo(e);
      setQuickNavKey(combo);
      try { localStorage.setItem(QUICK_NAV_KEY_STORAGE, combo); } catch { /* ignore */ }
      setCapturingKey(false);
    };
    const onMouse = (e: MouseEvent) => {
      // Only capture extra buttons (≥ 3); leave left/right/middle alone.
      if (e.button < 3) return;
      e.preventDefault();
      e.stopPropagation();
      const combo = buildMouseCombo(e);
      setQuickNavKey(combo);
      try { localStorage.setItem(QUICK_NAV_KEY_STORAGE, combo); } catch { /* ignore */ }
      setCapturingKey(false);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("mousedown", onMouse, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("mousedown", onMouse, { capture: true });
    };
  }, [capturingKey]);

  // Global quick-nav: cycle terminal ↔ SFTP, triggered by key or extra mouse button.
  useEffect(() => {
    if (vaultStatus !== "unlocked") return;
    const navigate = () => {
      if (screen === "terminal") {
        setScreen("sftp");
      } else if (tabs.length > 0) {
        setScreen("terminal");
        if (!activeTab?.sessionId || activeTab.disconnected) {
          setTerminalState("disconnected");
        } else {
          setTerminalState("connected");
        }
      } else {
        setScreen("sftp");
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (isMouseCombo(quickNavKey)) return;
      if (buildKeyCombo(e) !== quickNavKey) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      navigate();
    };
    const onMouse = (e: MouseEvent) => {
      if (!isMouseCombo(quickNavKey)) return;
      if (buildMouseCombo(e) !== quickNavKey) return;
      e.preventDefault();
      navigate();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouse);
    };
  }, [vaultStatus, quickNavKey, screen, tabs, activeTab]);

  function bumpCount(hostId: string, type: "ssh" | "sftp") {
    setConnectCounts((prev) => {
      const cur = prev[hostId] ?? { ssh: 0, sftp: 0 };
      const next = { ...prev, [hostId]: { ...cur, [type]: cur[type] + 1 } };
      try { localStorage.setItem(CONNECT_COUNTS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  const topHosts = useMemo(() => {
    return hosts
      .map((h) => ({ host: h, total: (connectCounts[h.id]?.ssh ?? 0) + (connectCounts[h.id]?.sftp ?? 0) }))
      .filter(({ total }) => total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 3)
      .map(({ host }) => host);
  }, [hosts, connectCounts]);

  const sidebarItems: Array<{ key: SidebarSection; label: string; icon: ReactNode }> = [
    { key: "hosts", label: "Hosts", icon: <Server className="h-4 w-4" /> },
    { key: "keychain", label: "Keychain", icon: <KeyRound className="h-4 w-4" /> },
    { key: "proxy", label: "Proxy", icon: <Network className="h-4 w-4" /> },
    { key: "snippets", label: "Snippets", icon: <Terminal className="h-4 w-4" /> },
    { key: "known", label: "Known Hosts", icon: <Laptop className="h-4 w-4" /> },
    { key: "logs", label: "Logs", icon: <Logs className="h-4 w-4" /> },
    { key: "settings", label: "Settings", icon: <Settings2 className="h-4 w-4" /> },
  ];

  function toggleGroup(groupName: string) {
    setCollapsedGroups((prev) => ({ ...prev, [groupName]: !prev[groupName] }));
  }

  function toggleHostPasswordReveal(hostId: string) {
    setRevealedHostPasswords((prev) => ({ ...prev, [hostId]: !prev[hostId] }));
  }

  function openNewHostModal() {
    setDraft(emptyDraft);
    setShowHostModalPassword(false);
    setIsHostModalOpen(true);
  }

  function openEditHostModal(host: Host) {
    setDraft({
      id: host.id,
      group: host.group,
      name: host.name,
      host: host.host,
      port: String(host.port),
      username: host.username,
      authMethod: host.authMethod,
      password: host.password ?? "",
      privateKey: host.privateKey ?? "",
      passphrase: host.passphrase ?? "",
      tags: host.tags.join(","),
    });
    setShowHostModalPassword(false);
    setIsHostModalOpen(true);
  }

  function saveHostFromModal() {
    const parsedPort = Number(draft.port);
    if (!draft.name || !draft.host || !draft.username || Number.isNaN(parsedPort)) {
      return;
    }
    if (draft.authMethod === "password" && !draft.password) {
      return;
    }
    if (draft.authMethod === "key" && !draft.privateKey) {
      return;
    }

    const nextHost: Host = {
      id: draft.id ?? crypto.randomUUID(),
      group: draft.group || "Default",
      name: draft.name,
      host: draft.host,
      port: parsedPort,
      username: draft.username,
      authMethod: draft.authMethod,
      password: draft.authMethod === "password" ? draft.password : undefined,
      privateKey: draft.authMethod === "key" ? draft.privateKey : undefined,
      passphrase: draft.authMethod === "key" ? draft.passphrase : undefined,
      tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    };

    setHosts((prev) => {
      if (!draft.id) return [nextHost, ...prev];
      return prev.map((item) => (item.id === draft.id ? nextHost : item));
    });
    setActiveHostId(nextHost.id);
    setIsHostModalOpen(false);
  }

  function deleteHost(hostId: string) {
    setHosts((prev) => prev.filter((item) => item.id !== hostId));
    setHostReachability((prev) => {
      const next = { ...prev };
      delete next[hostId];
      return next;
    });
    setConnectCounts((prev) => {
      const next = { ...prev };
      delete next[hostId];
      try { localStorage.setItem(CONNECT_COUNTS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  async function testConnection(host: Host) {
    setHostReachability((prev) => ({ ...prev, [host.id]: "connecting" }));
    try {
      await invoke("ssh_test_connection", { req: hostConnectReq(host) });
      setHostReachability((prev) => ({ ...prev, [host.id]: "online" }));
    } catch {
      setHostReachability((prev) => ({ ...prev, [host.id]: "offline" }));
    }
  }

  const handleSessionLost = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab?.sessionId) return;
      const sid = tab.sessionId;
      clearTerminalSessionCache(sid);
      void invoke("ssh_close_shell", { sessionId: sid }).catch(() => {});
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                sessionId: null,
                disconnected: true,
                disconnectReason:
                  "The SSH session closed (remote ended the shell, network interruption, or transport error).",
              }
            : t
        )
      );
      if (activeTabId === tabId) {
        setTerminalState("disconnected");
      }
    },
    [tabs, activeTabId]
  );

  function sessionTabLabel(host: Host): string {
    return `${host.name} (${host.username}@${host.host})`;
  }

  async function startShellForHost(host: Host, existingTabId: string | null) {
    let unlisten: (() => void) | undefined;
    const label = sessionTabLabel(host);
    let targetTabId = existingTabId;
    setSshProgressLines([]);
    setReconnectError("");
    setTerminalState("connecting");
    setTerminalError("");
    setHostConnecting(host.id, true);
    setIsLoading(true);
    if (targetTabId) {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === targetTabId
            ? {
                ...t,
                hostId: host.id,
                hostLabel: label,
                disconnected: false,
                disconnectReason: undefined,
              }
            : t
        )
      );
      setActiveTabId(targetTabId);
      activeTabIdRef.current = targetTabId;
    } else {
      const tab: SessionTab = {
        id: crypto.randomUUID(),
        hostId: host.id,
        hostLabel: label,
        sessionId: null,
        disconnected: false,
      };
      targetTabId = tab.id;
      setTabs((prev) => [tab, ...prev]);
      setActiveTabId(tab.id);
      activeTabIdRef.current = tab.id;
    }
    try {
      unlisten = await listen<SshProgressPayload>("ssh-connection-progress", (event) => {
        const p = event.payload as SshProgressPayload | undefined;
        const line = p?.line;
        if (!line) return;
        setSshProgressLines((prev) => [...prev, line]);
      });
      const response = await invoke<ShellStartResponse>("ssh_start_shell", {
        req: {
          host: host.host,
          port: host.port,
          username: host.username,
          password: host.password,
          privateKey: host.privateKey,
          passphrase: host.passphrase,
        },
      });
      if (targetTabId) {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === targetTabId
              ? {
                  ...t,
                  hostId: host.id,
                  hostLabel: label,
                  sessionId: response.session_id,
                  disconnected: false,
                  disconnectReason: undefined,
                }
              : t
          )
        );
      }
      if (activeTabIdRef.current === targetTabId) {
        setTerminalState("connected");
      }
    } catch (error) {
      const msg = String(error);
      if (targetTabId) {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === targetTabId
              ? {
                  ...t,
                  sessionId: null,
                  disconnected: true,
                  disconnectReason: "SSH connection failed before the shell opened.",
                }
              : t
          )
        );
        if (activeTabIdRef.current === targetTabId) {
          setReconnectError(msg);
          setTerminalState("disconnected");
        }
      } else {
        setTerminalState("error");
        setTerminalError(msg);
      }
    } finally {
      setHostConnecting(host.id, false);
      unlisten?.();
      setIsLoading(false);
    }
  }

  async function connectHost(host: Host) {
    bumpCount(host.id, "ssh");
    setScreen("terminal");
    await startShellForHost(host, null);
  }

  async function reconnectActiveTab() {
    const tab = activeTab;
    if (!tab?.disconnected) return;
    const host = hosts.find((h) => h.id === tab.hostId);
    if (!host) return;
    await startShellForHost(host, tab.id);
  }

  async function openSftpForHost(host: Host) {
    bumpCount(host.id, "sftp");
    if (sftpSession) {
      try {
        await invoke("sftp_disconnect", { sessionId: sftpSession.sessionId });
      } catch {
        // best-effort
      }
    }
    setScreen("sftp");
    setSftpState("connecting");
    setSftpError("");
    setSftpSession(null);
    setHostConnecting(host.id, true);
    try {
      const response = await invoke<SftpConnectResponse>("sftp_connect", {
        req: {
          host: host.host,
          port: host.port,
          username: host.username,
          password: host.password,
          privateKey: host.privateKey,
          passphrase: host.passphrase,
        },
      });
      setSftpSession({
        sessionId: response.session_id,
        home: response.home,
        hostLabel: `${host.name} (${host.username}@${host.host})`,
        hostId: host.id,
      });
      setSftpState("connected");
    } catch (error) {
      setSftpError(String(error));
      setSftpState("error");
    } finally {
      setHostConnecting(host.id, false);
    }
  }

  async function disconnectSftp() {
    if (!sftpSession) {
      setSftpState("empty");
      return;
    }
    try {
      await invoke("sftp_disconnect", { sessionId: sftpSession.sessionId });
    } catch {
      // best-effort
    }
    clearSftpSessionCache(sftpSession.sessionId, sftpSession.hostId);
    setSftpSession(null);
    setSftpState("empty");
  }

  async function closeTab(tabId: string) {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    if (tab.sessionId) {
      try {
        await invoke("ssh_close_shell", { sessionId: tab.sessionId });
      } catch {
        // Best-effort close.
      }
      clearTerminalSessionCache(tab.sessionId);
    }
    const nextTabs = tabs.filter((item) => item.id !== tabId);
    const nextActiveId = nextTabs[0]?.id ?? null;
    const nextActive = nextActiveId ? nextTabs.find((t) => t.id === nextActiveId) ?? null : null;
    setTabs(nextTabs);
    setActiveTabId(nextActiveId);
    activeTabIdRef.current = nextActiveId;
    if (nextTabs.length === 0) {
      setTerminalState("empty");
      setScreen("hosts");
    } else if (nextActive?.disconnected || !nextActive?.sessionId) {
      setTerminalState("disconnected");
    } else {
      setTerminalState("connected");
    }
  }

  const appShell = "app-shell flex h-screen w-screen flex-col overflow-hidden";

  if (vaultStatus !== "unlocked") {
    return (
      <div className={appShell}>
        <TitleBar />
        {vaultStatus === "loading" ? (
          <div className="app-text-muted flex min-h-0 flex-1 items-center justify-center text-sm">
            Loading vault…
          </div>
        ) : (
          <VaultOverlay
            mode={vaultStatus === "new" ? "new" : "locked"}
            submitting={vaultBusy}
            error={vaultError}
            onSubmit={(password) =>
              vaultStatus === "new" ? handleVaultInit(password) : handleVaultUnlock(password)
            }
          />
        )}
      </div>
    );
  }

  if (screen === "hosts") {
    return (
      <div className={appShell}>
        <TitleBar />
        <TopBar
          screen={screen}
          onChangeScreen={setScreen}
          activeSessionCount={tabs.length}
          sftpConnected={!!sftpSession}
          onLock={() => void handleVaultLock()}
          right={
            <>
              <div className="relative hidden md:block">
                <Search className="app-icon-muted pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
                <Input
                  className="h-9 w-64 pl-7 text-xs"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search host, tag, group"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={checkingAllHosts || hosts.length === 0}
                onClick={() => void checkAllHostsReachability(hosts)}
                title="SSH test every host (reachability only)"
              >
                <RefreshCw
                  className={`mr-1.5 h-3.5 w-3.5 ${checkingAllHosts ? "animate-spin" : ""}`}
                />
                Check all
              </Button>
              <Button size="sm" onClick={openNewHostModal}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                New Host
              </Button>
            </>
          }
        />

        <main className="grid flex-1 min-h-0 grid-cols-[240px_1fr] overflow-hidden">
          <aside className="app-sidebar flex flex-col p-3">
            <p className="app-text-muted mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.18em]">
              Navigation
            </p>
            <div className="space-y-1">
              {sidebarItems.map((item) => (
                <button
                  key={item.key}
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition ${
                    sidebarSection === item.key
                      ? "app-nav-active"
                      : "app-chrome-muted app-chrome-hover hover:bg-muted/40"
                  }`}
                  onClick={() => setSidebarSection(item.key)}
                >
                  <span className={sidebarSection === item.key ? "app-accent-text" : "app-chrome-muted"}>
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              ))}
            </div>
            <Separator className="my-4 bg-white/10" />
            <div className="app-text-muted px-2 text-[10px] uppercase tracking-[0.18em]">Summary</div>
            <div className="app-text-muted mt-2 space-y-1.5 px-2 text-xs">
              <div className="flex justify-between">
                <span>Total hosts</span>
                <span className="app-text-strong font-medium">{hosts.length}</span>
              </div>
              <div className="flex justify-between">
                <span>Open sessions</span>
                <span className="app-text-strong font-medium">{tabs.length}</span>
              </div>
            </div>
          </aside>

          <section className="min-h-0 overflow-y-auto p-4">
            <div className="mx-auto max-w-5xl space-y-4">
              {sidebarSection === "hosts" ? (
                <>
                  <div className="flex items-center justify-between md:hidden">
                    <div className="relative w-full max-w-md">
                      <Search className="absolute left-2 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        className="pl-8"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search host, tag, group"
                      />
                    </div>
                  </div>

                  {Object.keys(groupedHosts).length === 0 ? (
                    <Card className="app-card">
                      <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                        <div className="app-accent-bg flex h-10 w-10 items-center justify-center rounded-full">
                          <Server className="h-5 w-5" />
                        </div>
                        <p className="app-text-strong text-sm font-medium">No hosts yet</p>
                        <p className="app-text-muted max-w-xs text-xs">
                          Add your first SSH host to get started.
                        </p>
                        <Button size="sm" onClick={openNewHostModal}>
                          <Plus className="mr-1.5 h-3.5 w-3.5" />
                          Add host
                        </Button>
                      </CardContent>
                    </Card>
                  ) : null}

                  {Object.entries(groupedHosts).map(([groupName, list]) => (
                    <div
                      key={groupName}
                      className="app-card overflow-hidden rounded-xl shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset]"
                    >
                      <button
                        className="app-text-strong app-soft-hover flex w-full items-center justify-between px-4 py-3 text-sm font-medium"
                        onClick={() => toggleGroup(groupName)}
                      >
                        <span className="flex items-center gap-2">
                          {collapsedGroups[groupName] ? (
                            <ChevronRight className="app-icon-muted h-4 w-4" />
                          ) : (
                            <ChevronDown className="app-icon-muted h-4 w-4" />
                          )}
                          <Folder className="app-icon-accent h-4 w-4" />
                          {groupName}
                        </span>
                        <Badge variant="outline" className="app-chrome-border app-soft app-text-muted">
                          {list.length}
                        </Badge>
                      </button>
                      {!collapsedGroups[groupName] ? (
                        <div className="divide-y divide-border border-t border-border">
                          {list.map((host) => {
                            const hostStatus = hostConnectionStatus[host.id] ?? "offline";
                            const reachStatus = hostReachability[host.id];
                            const reachLabel = reachabilityLabel(reachStatus);
                            const passwordLabel = hostPasswordDisplay(
                              host,
                              privacyRedactHosts,
                              !!revealedHostPasswords[host.id],
                            );
                            return (
                              <div
                                key={host.id}
                                className="group flex items-center justify-between px-4 py-3 transition app-soft-hover"
                              >
                                <div className="flex min-w-0 items-center gap-3">
                                  <span className={`h-2 w-2 rounded-full ${statusDot(hostStatus)}`} />
                                  <div className="min-w-0">
                                    <p className="app-text-strong truncate text-sm font-medium">
                                      {hostCardTitle(host, privacyRedactHosts)}
                                    </p>
                                    <p className="app-text-muted truncate text-xs">
                                      {hostCardSubtitle(host, privacyRedactHosts)}
                                    </p>
                                    {passwordLabel ? (
                                      <div className="mt-0.5 flex items-center gap-1.5">
                                        <KeyRound className="app-icon-muted h-3 w-3 shrink-0" />
                                        <span className="app-text-muted truncate font-mono text-[11px]">
                                          {passwordLabel}
                                        </span>
                                        {!privacyRedactHosts && host.password ? (
                                          <button
                                            type="button"
                                            className="app-icon-muted app-soft-hover shrink-0 rounded p-0.5"
                                            title={
                                              revealedHostPasswords[host.id]
                                                ? "Hide password"
                                                : "Show password"
                                            }
                                            onClick={() => toggleHostPasswordReveal(host.id)}
                                          >
                                            {revealedHostPasswords[host.id] ? (
                                              <EyeOff className="h-3 w-3" />
                                            ) : (
                                              <Eye className="h-3 w-3" />
                                            )}
                                          </button>
                                        ) : null}
                                      </div>
                                    ) : host.authMethod === "key" ? (
                                      <p className="app-text-muted mt-0.5 text-[11px]">Private key</p>
                                    ) : null}
                                  </div>
                                  {host.tags.length > 0 ? (
                                    <div className="ml-2 hidden gap-1 lg:flex">
                                      {host.tags.slice(0, 3).map((tag) => (
                                        <Badge
                                          key={tag}
                                          variant="outline"
                                          className="app-chrome-border app-soft app-text-muted text-[10px]"
                                        >
                                          {tag}
                                        </Badge>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                                <div className="ml-2 flex items-center gap-2">
                                  <span className={`hidden text-xs capitalize sm:inline ${statusColor(hostStatus)}`}>
                                    {hostStatusLabel(hostStatus)}
                                    {reachLabel ? (
                                      <span className="app-text-muted normal-case"> · {reachLabel}</span>
                                    ) : null}
                                  </span>
                                  <Button size="sm" onClick={() => void connectHost(host)}>
                                    Connect
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => void openSftpForHost(host)}
                                    title="Browse files (SFTP)"
                                  >
                                    <FolderOpen className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={isLoading}
                                    onClick={() => void testConnection(host)}
                                    title="Test SSH reachability (does not open a session)"
                                  >
                                    <ShieldCheck className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => openEditHostModal(host)}
                                    title="Edit"
                                  >
                                    <Edit3 className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => deleteHost(host.id)}
                                    title="Delete"
                                  >
                                    <Trash2 className="h-4 w-4 text-rose-400" />
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </>
              ) : sidebarSection === "proxy" ? (
                <div className="grid max-w-6xl gap-4 xl:grid-cols-2">
                  <Card className="app-panel border shadow-xl">
                    <CardHeader>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <CardTitle className="app-text-strong">Active proxy</CardTitle>
                          <CardDescription className="app-text-muted">
                            Choose which proxy server to use and how traffic is routed.
                          </CardDescription>
                        </div>
                        <button
                          type="button"
                          aria-label="Enable proxy"
                          onClick={() =>
                            setProxyConfigDraft((prev) => ({ ...prev, enabled: !prev.enabled }))
                          }
                          className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                            proxyConfigDraft.enabled ? "app-toggle-on" : "app-toggle-off"
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
                              proxyConfigDraft.enabled ? "left-[22px]" : "left-0.5"
                            }`}
                          />
                        </button>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-1.5">
                        <p className="app-text-muted text-xs font-medium uppercase tracking-wide">
                          Proxy server
                        </p>
                        <select
                          value={proxyConfigDraft.activeServerId ?? ""}
                          onChange={(e) =>
                            setProxyConfigDraft((prev) => ({
                              ...prev,
                              activeServerId: e.target.value || null,
                            }))
                          }
                          className="app-card app-chrome-border app-text-strong h-9 w-full rounded-md border px-2 text-sm"
                        >
                          <option value="">— select server —</option>
                          {proxyStore.servers.map((server) => (
                            <option key={server.id} value={server.id}>
                              {server.name} ({server.type.toUpperCase()} {server.host}:{server.port})
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="app-card app-soft grid gap-2 rounded-md px-3 py-3 sm:grid-cols-2">
                        <div>
                          <p className="app-text-muted text-xs">Total through all proxies</p>
                          <p className="app-text-strong font-mono text-lg">
                            {formatProxyBytes(proxyStore.stats.totalBytes)}
                          </p>
                        </div>
                        <div>
                          <p className="app-text-muted text-xs">Selected proxy</p>
                          <p className="app-text-strong font-mono text-lg">
                            {proxyConfigDraft.activeServerId
                              ? formatProxyBytes(
                                  proxyStore.stats.serverBytes[proxyConfigDraft.activeServerId] ?? 0,
                                )
                              : "—"}
                          </p>
                        </div>
                      </div>

                      <div className="space-y-2">
                        {[
                          {
                            key: "applySsh" as const,
                            title: "Apply to SSH / SFTP",
                            desc: "Tunnel SSH and SFTP connections through the proxy.",
                          },
                          {
                            key: "applyHttp" as const,
                            title: "Apply to HTTP traffic",
                            desc: "GitHub sync, update checks, and installer downloads.",
                          },
                          {
                            key: "lockdown" as const,
                            title: "Lockdown (no direct fallback)",
                            desc: "Block direct connections when proxy is enabled for that scope.",
                          },
                        ].map(({ key, title, desc }) => (
                          <div
                            key={key}
                            className="app-card app-soft flex items-center justify-between rounded-md px-3 py-2"
                          >
                            <div className="min-w-0 pr-3">
                              <p className="app-text-strong text-sm font-medium">{title}</p>
                              <p className="app-text-muted text-xs">{desc}</p>
                            </div>
                            <button
                              type="button"
                              aria-label={title}
                              onClick={() =>
                                setProxyConfigDraft((prev) => ({ ...prev, [key]: !prev[key] }))
                              }
                              className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                                proxyConfigDraft[key] ? "app-toggle-on" : "app-toggle-off"
                              }`}
                            >
                              <span
                                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
                                  proxyConfigDraft[key] ? "left-[22px]" : "left-0.5"
                                }`}
                              />
                            </button>
                          </div>
                        ))}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" disabled={proxyBusy} onClick={() => void saveProxyConfig()}>
                          Save options
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            proxyBusy ||
                            !proxyConfigDraft.activeServerId ||
                            proxyStore.servers.length === 0
                          }
                          onClick={() => void testProxyConnection(proxyConfigDraft.activeServerId ?? undefined)}
                        >
                          Test selected
                        </Button>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="app-panel border shadow-xl">
                    <CardHeader>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <CardTitle className="app-text-strong">Proxy servers</CardTitle>
                          <CardDescription className="app-text-muted">
                            Add SOCKS5, SOCKS4, HTTP, or HTTPS proxy servers. Credentials are stored locally on disk.
                          </CardDescription>
                        </div>
                        <Button size="sm" onClick={openNewProxyServerModal}>
                          <Plus className="mr-1.5 h-3.5 w-3.5" />
                          Add
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {proxyStore.servers.length === 0 ? (
                        <p className="app-text-muted py-6 text-center text-sm">
                          No proxy servers yet. Click Add to create one.
                        </p>
                      ) : (
                        proxyStore.servers.map((server) => (
                          <div
                            key={server.id}
                            className={`app-card app-soft rounded-md px-3 py-3 ${
                              proxyConfigDraft.activeServerId === server.id
                                ? "ring-1 ring-emerald-500/40"
                                : ""
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="app-text-strong truncate font-medium">{server.name}</p>
                                <p className="app-text-muted truncate font-mono text-xs">
                                  {server.type.toUpperCase()} · {server.host}:{server.port}
                                </p>
                                <p className="app-text-muted mt-1 text-xs">
                                  {formatProxyBytes(proxyStore.stats.serverBytes[server.id] ?? 0)} transferred
                                </p>
                              </div>
                              <div className="flex shrink-0 items-center gap-1">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={proxyBusy}
                                  onClick={() => openEditProxyServerModal(server)}
                                >
                                  <Edit3 className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={proxyBusy}
                                  onClick={() => void testProxyConnection(server.id)}
                                >
                                  <RefreshCw className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={proxyBusy}
                                  onClick={() => void deleteProxyServer(server.id)}
                                >
                                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                      {proxyInfo ? <p className="text-xs text-emerald-400">{proxyInfo}</p> : null}
                      {proxyError ? <p className="text-xs text-destructive">{proxyError}</p> : null}
                    </CardContent>
                  </Card>
                </div>
              ) : sidebarSection === "settings" ? (
                <div className="max-w-2xl space-y-4">
                  <Card className="app-panel border shadow-xl">
                    <CardHeader>
                      <CardTitle>Appearance</CardTitle>
                      <CardDescription>
                        Choose a color theme for the app shell, panels, and terminal.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ThemePicker />
                    </CardContent>
                  </Card>

                  <Card className="app-panel border shadow-xl">
                    <CardHeader>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <CardTitle className="app-text-strong">App updates</CardTitle>
                          <CardDescription className="app-text-muted">
                            Checks GitHub Releases and only installs assets matching this OS and CPU architecture.
                          </CardDescription>
                        </div>
                        <button
                          type="button"
                          aria-label="Auto-install matching app updates"
                          onClick={() => {
                            setAutoInstallUpdates((v) => {
                              const next = !v;
                              try {
                                localStorage.setItem(AUTO_INSTALL_UPDATES_KEY, next ? "1" : "0");
                              } catch {
                                // ignore
                              }
                              return next;
                            });
                          }}
                          className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                            autoInstallUpdates ? "app-toggle-on" : "app-toggle-off"
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
                              autoInstallUpdates ? "left-[22px]" : "left-0.5"
                            }`}
                          />
                        </button>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="grid gap-2 text-xs sm:grid-cols-2">
                        <div className="app-card app-soft rounded-md px-3 py-2">
                          <p className="app-text-muted">Current version</p>
                          <p className="app-text-strong font-mono">
                            {updateCheck?.current_version ?? "not checked"}
                          </p>
                        </div>
                        <div className="app-card app-soft rounded-md px-3 py-2">
                          <p className="app-text-muted">Platform checked</p>
                          <p className="app-text-strong font-mono">
                            {updateCheck ? `${updateCheck.os}-${updateCheck.arch}` : "not checked"}
                          </p>
                        </div>
                        <div className="app-card app-soft rounded-md px-3 py-2">
                          <p className="app-text-muted">Latest version</p>
                          <p className="app-text-strong font-mono">
                            {updateCheck?.latest_version ?? "not checked"}
                          </p>
                        </div>
                        <div className="app-card app-soft rounded-md px-3 py-2">
                          <p className="app-text-muted">Installer asset</p>
                          <p className="app-text-strong truncate font-mono">
                            {updateCheck?.asset_name ?? "none selected"}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={updateBusy}
                          onClick={() => void checkForUpdates(autoInstallUpdates)}
                        >
                          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${updateBusy ? "animate-spin" : ""}`} />
                          Check updates
                        </Button>
                        <Button
                          size="sm"
                          disabled={updateBusy || !updateCheck?.update_available}
                          onClick={() => void installLatestUpdate()}
                        >
                          Download & install
                        </Button>
                        <span className="app-text-muted text-xs">
                          Auto-install {autoInstallUpdates ? "enabled" : "disabled"}
                        </span>
                      </div>
                      {updateInfo ? <p className="text-xs text-emerald-400">{updateInfo}</p> : null}
                      {updateError ? <p className="text-xs text-destructive">{updateError}</p> : null}
                    </CardContent>
                  </Card>

                  <Card className="app-panel border shadow-xl">
                    <CardHeader>
                      <CardTitle className="app-text-strong">Quick navigation shortcut</CardTitle>
                      <CardDescription className="app-text-muted">
                        Press this key anywhere in the app to jump between Terminal and SFTP.
                        If no terminal tab is open, pressing it will switch to SFTP.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center gap-3">
                        <kbd className="app-card app-text-strong inline-flex min-w-[2.5rem] items-center justify-center rounded px-2.5 py-1 font-mono text-sm shadow-sm">
                          {quickNavKey}
                        </kbd>
                        {capturingKey ? (
                          <span className="animate-pulse text-sm text-amber-400">Press any key…</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setCapturingKey(true)}
                          >
                            Change
                          </Button>
                        )}
                        {capturingKey ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setCapturingKey(false)}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                      <p className="app-text-muted mt-2 text-xs">
                        On Terminal → switches to SFTP. On any other screen → switches to Terminal.
                        Supports keyboard keys, combos (e.g. Ctrl+F2) and extra mouse buttons (Mouse3 and above).
                      </p>
                    </CardContent>
                  </Card>

                  <Card className="app-panel border shadow-xl">
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <CardTitle className="app-text-strong">Keyword highlighting</CardTitle>
                        <button
                          type="button"
                          aria-label="Toggle keyword highlighting"
                          onClick={() =>
                            setTerminalKeywordSettings((prev) => ({ ...prev, enabled: !prev.enabled }))
                          }
                          className={`relative h-6 w-11 rounded-full transition ${
                            terminalKeywordSettings.enabled ? "app-toggle-on" : "app-toggle-off"
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
                              terminalKeywordSettings.enabled ? "left-[22px]" : "left-0.5"
                            }`}
                          />
                        </button>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {[
                        ["error", "Error"],
                        ["warning", "Warning"],
                        ["ok", "OK"],
                        ["info", "Info"],
                        ["debug", "Debug"],
                        ["network", "IP address & MAC"],
                      ].map(([key, label]) => (
                        <div key={key} className="flex items-center justify-between">
                          <p className="app-text-strong text-sm font-medium">{label}</p>
                          <input
                            type="color"
                            value={
                              terminalKeywordSettings.colors[
                                key as keyof TerminalKeywordSettings["colors"]
                              ]
                            }
                            onChange={(e) =>
                              setTerminalKeywordSettings((prev) => ({
                                ...prev,
                                colors: {
                                  ...prev.colors,
                                  [key]: e.target.value,
                                },
                              }))
                            }
                            className="app-chrome-border h-8 w-14 cursor-pointer rounded-md border bg-transparent p-0"
                          />
                        </div>
                      ))}
                    </CardContent>
                  </Card>

                  <Card className="app-panel border shadow-xl">
                    <CardHeader>
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground">
                            <EyeOff className="h-4 w-4" />
                          </div>
                          <div className="min-w-0">
                            <CardTitle className="app-text-strong">Hide hosts and IPs in the UI</CardTitle>
                            <CardDescription className="app-text-muted">
                              Masks addresses and saved passwords on the host list, in terminal tabs, in the SSH
                              connect log, and on disconnected / SFTP headers. Vault data and the edit-host form
                              stay full unless you reveal them there.
                            </CardDescription>
                          </div>
                        </div>
                        <button
                          type="button"
                          aria-label="Toggle hiding hosts and IP addresses in the interface"
                          onClick={() => {
                            setPrivacyRedactHosts((v) => {
                              const next = !v;
                              try {
                                localStorage.setItem(PRIVACY_REDACT_HOSTS_KEY, next ? "1" : "0");
                              } catch {
                                // ignore
                              }
                              return next;
                            });
                          }}
                          className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                            privacyRedactHosts ? "app-toggle-on" : "app-toggle-off"
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
                              privacyRedactHosts ? "left-[22px]" : "left-0.5"
                            }`}
                          />
                        </button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        <p className="app-text-muted text-sm">
                          Does not change what is sent over SSH — only what is drawn on screen outside the host editor.
                        </p>
                        <div className="app-card app-soft flex items-center justify-between rounded-md px-3 py-2">
                          <div>
                            <p className="app-text-strong text-sm font-medium">Terminal host info bar</p>
                            <p className="app-text-muted text-xs">
                              Shows host label + remote CPU and RAM usage at the bottom of terminal view.
                            </p>
                          </div>
                          <button
                            type="button"
                            aria-label="Toggle terminal host info bar"
                            onClick={() => {
                              setShowTerminalHostInfoBar((v) => {
                                const next = !v;
                                try {
                                  localStorage.setItem(TERMINAL_HOST_INFO_BAR_KEY, next ? "1" : "0");
                                } catch {
                                  // ignore
                                }
                                return next;
                              });
                            }}
                            className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                              showTerminalHostInfoBar ? "app-toggle-on" : "app-toggle-off"
                            }`}
                          >
                            <span
                              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
                                showTerminalHostInfoBar ? "left-[22px]" : "left-0.5"
                              }`}
                            />
                          </button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="app-panel border shadow-xl">
                    <CardHeader>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <CardTitle className="app-text-strong">tcpraw addon</CardTitle>
                          <CardDescription className="app-text-muted">
                            When a 6-digit code is copied to the clipboard, a quick-action button appears in the
                            terminal status bar to run <span className="app-text-strong font-mono">tcpraw get &lt;code&gt;</span>.
                          </CardDescription>
                        </div>
                        <button
                          type="button"
                          aria-label="Toggle tcpraw addon"
                          onClick={() => {
                            setTcprawEnabled((v) => {
                              const next = !v;
                              try {
                                localStorage.setItem(TCPRAW_ENABLED_KEY, next ? "1" : "0");
                              } catch {
                                // ignore
                              }
                              if (!next) setTcprawCode(null);
                              return next;
                            });
                          }}
                          className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                            tcprawEnabled ? "app-toggle-on" : "app-toggle-off"
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
                              tcprawEnabled ? "left-[22px]" : "left-0.5"
                            }`}
                          />
                        </button>
                      </div>
                    </CardHeader>
                  </Card>

                  <Card className="app-panel border shadow-xl">
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <div>
                          <CardTitle className="app-text-strong">SFTP</CardTitle>
                          <CardDescription className="app-text-muted">File browser and open-file behaviour.</CardDescription>
                        </div>
                        <button
                          type="button"
                          aria-label="Hide dotfiles in SFTP list"
                          onClick={() => {
                            setSftpHideDotfiles((v) => {
                              const next = !v;
                              try {
                                localStorage.setItem(SFTP_HIDE_DOTFILES_KEY, next ? "1" : "0");
                              } catch {
                                // ignore
                              }
                              return next;
                            });
                          }}
                          className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                            sftpHideDotfiles ? "app-toggle-on" : "app-toggle-off"
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
                              sftpHideDotfiles ? "left-[22px]" : "left-0.5"
                            }`}
                          />
                        </button>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <p className="app-text-muted text-sm">
                        Hide file and folder names that start with <span className="font-mono">.</span> in the SFTP
                        view.
                      </p>
                      <div className="space-y-2">
                        <p className="app-text-muted text-xs font-medium uppercase tracking-wide">
                          After you double-click a file (opens in an external app)
                        </p>
                        <div className="space-y-2">
                          <label className="app-card app-soft app-soft-hover app-text-strong flex cursor-pointer items-start gap-2 rounded-md p-2 text-sm">
                            <input
                              type="radio"
                              className="mt-0.5"
                              name="sftpOpenEdit"
                              checked={sftpOpenEditMode === "auto"}
                              onChange={() => {
                                setSftpOpenEditMode("auto");
                                try {
                                  localStorage.setItem(SFTP_OPEN_EDIT_KEY, "auto");
                                } catch {
                                  // ignore
                                }
                              }}
                            />
                            <span>Upload changes automatically (shortly after the file is saved on disk)</span>
                          </label>
                          <label className="app-card app-soft app-soft-hover app-text-strong flex cursor-pointer items-start gap-2 rounded-md p-2 text-sm">
                            <input
                              type="radio"
                              className="mt-0.5"
                              name="sftpOpenEdit"
                              checked={sftpOpenEditMode === "confirm"}
                              onChange={() => {
                                setSftpOpenEditMode("confirm");
                                try {
                                  localStorage.setItem(SFTP_OPEN_EDIT_KEY, "confirm");
                                } catch {
                                  // ignore
                                }
                              }}
                            />
                            <span>Require <strong className="app-text-strong font-medium">Save to server</strong> in the app to upload your edits</span>
                          </label>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="app-panel border shadow-xl">
                    <CardHeader>
                      <CardTitle className="app-text-strong">Cloud Sync (GitHub Gist)</CardTitle>
                      <CardDescription>
                        Auto-sync encrypted hosts data. Note format: random UUID + AES-256 encrypted payload.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <Input
                        type="password"
                        placeholder="GitHub token (gist scope)"
                        value={syncToken}
                        onChange={(e) => setSyncToken(e.target.value)}
                      />
                      <Input
                        placeholder="Gist ID (leave empty to create new)"
                        value={syncGistId}
                        onChange={(e) => setSyncGistId(e.target.value)}
                      />
                      <Input
                        placeholder="Sync key (base64 256-bit) - paste on second computer"
                        value={syncKey}
                        onChange={(e) => setSyncKey(e.target.value)}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button disabled={syncBusy} onClick={() => void enableSync()}>
                          {syncEnabled ? "Update Sync" : "Enable Sync"}
                        </Button>
                        <Button disabled={syncBusy || !syncEnabled} variant="outline" onClick={() => void pullFromCloud()}>
                          Pull Now
                        </Button>
                        <Button disabled={syncBusy || !syncEnabled} variant="outline" onClick={() => void disableSync()}>
                          Disable
                        </Button>
                      </div>
                      {syncInfo ? <p className="text-xs text-emerald-300">{syncInfo}</p> : null}
                      {syncError ? <p className="text-xs text-destructive">{syncError}</p> : null}
                      <p className="app-text-muted text-xs">
                        Once sync is on, any change to your hosts is automatically written to the Gist. On
                        another machine, use the same Gist ID and Sync key, then click Pull Now.
                      </p>
                    </CardContent>
                  </Card>
                </div>
              ) : (
                <Card className="app-card">
                  <CardContent className="app-text-muted py-10 text-sm">
                    {sidebarSection.charAt(0).toUpperCase() + sidebarSection.slice(1)} view coming soon.
                  </CardContent>
                </Card>
              )}
            </div>
          </section>
        </main>

        {isProxyServerModalOpen ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
            <Card className="app-modal w-full max-w-xl border">
              <CardHeader>
                <CardTitle>{proxyServerDraft.id ? "Edit proxy server" : "Add proxy server"}</CardTitle>
                <CardDescription>SOCKS5, SOCKS4, HTTP, or HTTPS proxy endpoint.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  placeholder="Display name (optional)"
                  value={proxyServerDraft.name}
                  onChange={(e) => setProxyServerDraft((prev) => ({ ...prev, name: e.target.value }))}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <p className="app-text-muted text-xs font-medium uppercase tracking-wide">Type</p>
                    <select
                      value={proxyServerDraft.type}
                      onChange={(e) =>
                        setProxyServerDraft((prev) => ({
                          ...prev,
                          type: e.target.value as ProxyType,
                        }))
                      }
                      className="app-card app-chrome-border app-text-strong h-9 w-full rounded-md border px-2 text-sm"
                    >
                      <option value="socks5">SOCKS5</option>
                      <option value="socks4">SOCKS4</option>
                      <option value="http">HTTP</option>
                      <option value="https">HTTPS</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <p className="app-text-muted text-xs font-medium uppercase tracking-wide">Port</p>
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      value={proxyServerDraft.port}
                      onChange={(e) => setProxyServerDraft((prev) => ({ ...prev, port: e.target.value }))}
                    />
                  </div>
                </div>
                <Input
                  placeholder="Host (127.0.0.1 or proxy.example.com)"
                  value={proxyServerDraft.host}
                  onChange={(e) => setProxyServerDraft((prev) => ({ ...prev, host: e.target.value }))}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    placeholder={
                      proxyServerDraft.type === "socks4" ? "SOCKS4 user ID (optional)" : "Username (optional)"
                    }
                    value={proxyServerDraft.username}
                    onChange={(e) => setProxyServerDraft((prev) => ({ ...prev, username: e.target.value }))}
                  />
                  <div className="relative">
                    <Input
                      type={showProxyPassword ? "text" : "password"}
                      placeholder={
                        proxyServerDraft.type === "socks4" ? "Not used by SOCKS4" : "Password (optional)"
                      }
                      disabled={proxyServerDraft.type === "socks4"}
                      value={proxyServerDraft.password}
                      onChange={(e) => setProxyServerDraft((prev) => ({ ...prev, password: e.target.value }))}
                      className="pr-9"
                    />
                    <button
                      type="button"
                      aria-label={showProxyPassword ? "Hide password" : "Show password"}
                      disabled={proxyServerDraft.type === "socks4"}
                      onClick={() => setShowProxyPassword((v) => !v)}
                      className="app-text-muted absolute right-2 top-1/2 -translate-y-1/2 disabled:opacity-40"
                    >
                      {showProxyPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setIsProxyServerModalOpen(false);
                      setProxyServerDraft(emptyProxyServerDraft);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button disabled={proxyBusy} onClick={() => void saveProxyServer()}>
                    {proxyServerDraft.id ? "Save" : "Add server"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        ) : null}

        {isHostModalOpen ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
            <Card className="app-modal w-full max-w-xl border">
              <CardHeader>
                <CardTitle>{draft.id ? "Edit Host" : "Add Host"}</CardTitle>
                <CardDescription>Create or update server connection.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input placeholder="Group" value={draft.group} onChange={(e) => setDraft((prev) => ({ ...prev, group: e.target.value }))} />
                <Input placeholder="Name" value={draft.name} onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))} />
                <Input placeholder="Hostname / IP" value={draft.host} onChange={(e) => setDraft((prev) => ({ ...prev, host: e.target.value }))} />
                <div className="grid grid-cols-2 gap-2">
                  <Input placeholder="Port" value={draft.port} onChange={(e) => setDraft((prev) => ({ ...prev, port: e.target.value }))} />
                  <Input placeholder="Username" value={draft.username} onChange={(e) => setDraft((prev) => ({ ...prev, username: e.target.value }))} />
                </div>
                <Input placeholder="Tags (comma separated)" value={draft.tags} onChange={(e) => setDraft((prev) => ({ ...prev, tags: e.target.value }))} />
                <div className="grid grid-cols-2 gap-2">
                  <Button variant={draft.authMethod === "password" ? "default" : "outline"} onClick={() => setDraft((prev) => ({ ...prev, authMethod: "password" }))}>
                    Password
                  </Button>
                  <Button variant={draft.authMethod === "key" ? "default" : "outline"} onClick={() => setDraft((prev) => ({ ...prev, authMethod: "key" }))}>
                    Private Key
                  </Button>
                </div>
                {draft.authMethod === "password" ? (
                  <div className="relative">
                    <Input
                      type={showHostModalPassword ? "text" : "password"}
                      placeholder="Password"
                      value={draft.password}
                      onChange={(e) => setDraft((prev) => ({ ...prev, password: e.target.value }))}
                      className="pr-10 font-mono"
                    />
                    <button
                      type="button"
                      className="app-icon-muted app-soft-hover absolute right-2 top-1/2 -translate-y-1/2 rounded p-1"
                      title={showHostModalPassword ? "Hide password" : "Show password"}
                      onClick={() => setShowHostModalPassword((v) => !v)}
                    >
                      {showHostModalPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                ) : (
                  <>
                    <textarea className="min-h-28 w-full rounded-md border border-input bg-background p-3 text-xs" placeholder="Paste private key" value={draft.privateKey} onChange={(e) => setDraft((prev) => ({ ...prev, privateKey: e.target.value }))} />
                    <Input type="password" placeholder="Passphrase (optional)" value={draft.passphrase} onChange={(e) => setDraft((prev) => ({ ...prev, passphrase: e.target.value }))} />
                  </>
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setIsHostModalOpen(false)}>Cancel</Button>
                  <Button onClick={saveHostFromModal}>Save</Button>
                </div>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    );
  }

  if (screen === "sftp") {
    return (
      <div className={appShell}>
        <TitleBar />
        <TopBar
          screen={screen}
          onChangeScreen={setScreen}
          activeSessionCount={tabs.length}
          sftpConnected={!!sftpSession}
          onLock={() => void handleVaultLock()}
          right={
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={!activeHost || sftpState === "connecting"}
                onClick={() => activeHost && void openSftpForHost(activeHost)}
              >
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                {sftpSession ? "Reconnect" : "Connect"}
              </Button>
              <Button size="sm" onClick={() => setScreen("hosts")}>
                <Server className="mr-1.5 h-3.5 w-3.5" />
                Hosts
              </Button>
            </>
          }
        />
        <section className="relative flex min-h-0 flex-1 overflow-hidden">
          {sftpState === "empty" ? (
            <div className="app-surface flex flex-1 items-center justify-center">
              <div className="flex flex-col items-center gap-4 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
                  <FolderOpen className="h-5 w-5" />
                </div>
                <div>
                  <p className="app-text-strong text-sm">No SFTP session</p>
                  <p className="app-text-muted text-xs">Browse files on a remote server.</p>
                </div>
                {topHosts.length > 0 ? (
                  <div className="w-full min-w-[260px] max-w-xs space-y-2">
                    <p className="app-text-muted text-[10px] uppercase tracking-wider">Quick connect</p>
                    {topHosts.map((host) => (
                      <div key={host.id} className="app-card app-soft flex items-center justify-between gap-2 rounded-md px-3 py-2">
                        <div className="min-w-0 text-left">
                          <p className="app-text-strong truncate text-xs font-medium">{host.name}</p>
                          <p className="app-text-muted truncate text-[10px]">{host.username}@{host.host}:{host.port}</p>
                        </div>
                        <div className="flex shrink-0 gap-1.5">
                          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => void openSftpForHost(host)}>
                            <FolderOpen className="mr-1 h-3 w-3" />SFTP
                          </Button>
                          <Button size="sm" className="h-7 px-2 text-[10px]" onClick={() => void connectHost(host)}>
                            <Terminal className="mr-1 h-3 w-3" />SSH
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => setScreen("hosts")}>
                  <Server className="mr-1.5 h-3.5 w-3.5" />
                  All hosts
                </Button>
              </div>
            </div>
          ) : null}
          {sftpState === "connecting" ? (
            <div className="app-surface flex flex-1 items-center justify-center">
              <p className="text-sm text-amber-400">Connecting to SFTP…</p>
            </div>
          ) : null}
          {sftpState === "error" ? (
            <div className="app-surface flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="max-w-xl text-sm text-destructive">{sftpError}</p>
              <Button size="sm" variant="outline" onClick={() => setScreen("hosts")}>
                Back to hosts
              </Button>
            </div>
          ) : null}
          {sftpState === "connected" && sftpSession ? (
            <SftpView
              sessionId={sftpSession.sessionId}
              hostId={sftpSession.hostId}
              home={sftpSession.home}
              hostLabel={formatSftpBannerLabel(
                hosts.find((h) => h.id === sftpSession.hostId),
                sftpSession.hostLabel,
                privacyRedactHosts,
              )}
              hideDotfiles={sftpHideDotfiles}
              openEditMode={sftpOpenEditMode}
              onDisconnect={() => void disconnectSftp()}
            />
          ) : null}
        </section>
      </div>
    );
  }

  return (
    <div className={appShell}>
      <TitleBar />
      <TopBar
        screen={screen}
        onChangeScreen={setScreen}
        activeSessionCount={tabs.length}
        sftpConnected={!!sftpSession}
        onLock={() => void handleVaultLock()}
        right={
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!activeHost || isLoading}
              onClick={() => activeHost && void connectHost(activeHost)}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              New Tab
            </Button>
            <Button size="sm" onClick={() => setScreen("hosts")}>
              <Server className="mr-1.5 h-3.5 w-3.5" />
              Hosts
            </Button>
          </>
        }
      />

      {tabs.length > 0 ? (
        <div className="app-sidebar flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-2">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className={`group flex h-7 min-w-24 max-w-[220px] items-center gap-2 rounded-md border px-2.5 text-xs transition ${
                  isActive
                    ? "app-nav-active shadow-[0_0_0_1px_rgb(var(--app-accent)/0.15)]"
                    : "app-chrome-border border bg-muted/20 app-chrome-muted hover:bg-muted/40 hover:text-foreground"
                }`}
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onClick={() => {
                    setActiveTabId(tab.id);
                    activeTabIdRef.current = tab.id;
                    if (!tab.sessionId && !tab.disconnected) {
                      setTerminalState("connecting");
                    } else if (tab.disconnected || !tab.sessionId) {
                      setTerminalState("disconnected");
                    } else {
                      setTerminalState("connected");
                    }
                  }}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      tab.disconnected || !tab.sessionId
                        ? "bg-amber-400/90 shadow-[0_0_6px_rgba(251,191,36,0.45)]"
                        : isActive
                          ? "bg-[rgb(var(--app-accent))] shadow-[0_0_6px_rgb(var(--app-accent)/0.9)]"
                          : "bg-emerald-400/80"
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {formatSessionTabLabel(
                      hosts.find((h) => h.id === tab.hostId),
                      tab.hostLabel,
                      privacyRedactHosts,
                    )}
                  </span>
                </button>
                <button
                  className="app-icon-muted app-soft-hover rounded p-0.5 opacity-60 hover:opacity-100"
                  onClick={() => void closeTab(tab.id)}
                  title="Close tab"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      <section className="relative flex min-h-0 flex-1 overflow-hidden">
        {terminalState === "empty" ? (
          <div className="app-surface flex flex-1 items-center justify-center">
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
                <Terminal className="h-5 w-5" />
              </div>
              <div>
                <p className="app-text-strong text-sm">No active session</p>
                <p className="app-text-muted text-xs">Pick a host to open a terminal.</p>
              </div>
              {topHosts.length > 0 ? (
                <div className="w-full min-w-[260px] max-w-xs space-y-2">
                  <p className="app-text-muted text-[10px] uppercase tracking-wider">Quick connect</p>
                  {topHosts.map((host) => (
                    <div key={host.id} className="app-card app-soft flex items-center justify-between gap-2 rounded-md px-3 py-2">
                      <div className="min-w-0 text-left">
                        <p className="app-text-strong truncate text-xs font-medium">{host.name}</p>
                        <p className="app-text-muted truncate text-[10px]">{host.username}@{host.host}:{host.port}</p>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => void openSftpForHost(host)}>
                          <FolderOpen className="mr-1 h-3 w-3" />SFTP
                        </Button>
                        <Button size="sm" className="h-7 px-2 text-[10px]" onClick={() => void connectHost(host)}>
                          <Terminal className="mr-1 h-3 w-3" />SSH
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              <Button size="sm" variant="outline" onClick={() => setScreen("hosts")}>
                <Server className="mr-1.5 h-3.5 w-3.5" />
                All hosts
              </Button>
            </div>
          </div>
        ) : null}
        {terminalState === "connecting" ? (
          <div className="app-surface flex flex-1 flex-col items-center justify-center px-6 py-8">
            <div className="app-card bg-black/40 w-full max-w-lg rounded-lg px-4 py-3 font-mono text-[13px] leading-relaxed shadow-[0_0_40px_rgba(14,165,233,0.08)]">
              <p className="app-icon-accent mb-2 text-[11px] font-semibold uppercase tracking-wider">
                SSH connection
              </p>
              <div className="app-text-muted max-h-[min(50vh,320px)] space-y-1 overflow-y-auto">
                {sshProgressLines.length === 0 ? (
                  <p className="app-text-muted animate-pulse">Waiting for host…</p>
                ) : (
                  sshProgressLines.map((line, i) => (
                    <p
                      key={`${i}-${line.slice(0, 24)}`}
                      className={`border-l-2 border-transparent pl-2 transition-all duration-300 ${
                        i === sshProgressLines.length - 1
                          ? "border-[rgb(var(--app-accent)/0.7)] app-text-strong"
                          : "app-text-muted"
                      }`}
                    >
                      <span className="app-text-muted select-none">{">"} </span>
                      {redactConnectionLogLine(line, hosts, privacyRedactHosts)}
                    </p>
                  ))
                )}
              </div>
            </div>
            <p className="app-text-muted mt-4 text-xs">Stages mirror the Rust SSH client (TCP → KEX → auth → shell).</p>
          </div>
        ) : null}
        {terminalState === "error" ? (
          <div className="app-surface flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="max-w-xl text-sm text-destructive">{terminalError}</p>
            <Button size="sm" variant="outline" onClick={() => setScreen("hosts")}>
              <Server className="mr-1.5 h-3.5 w-3.5" />
              Hosts
            </Button>
          </div>
        ) : null}
        {terminalState === "disconnected" && activeTab?.disconnected ? (
          <div className="app-surface flex flex-1 flex-col items-center justify-center gap-5 px-6">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10 text-amber-400">
              <Unplug className="h-7 w-7" />
            </div>
            <div className="max-w-md text-center">
              <p className="app-text-strong text-lg font-medium tracking-tight">Disconnected</p>
              {activeTab.disconnectReason ? (
                <p className="app-text-muted mt-2 text-sm">{activeTab.disconnectReason}</p>
              ) : null}
              {reconnectError ? (
                <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-left text-xs text-destructive">
                  {reconnectError}
                </p>
              ) : null}
              <p className="app-text-muted mt-2 text-xs">
                {formatSessionTabLabel(
                  hosts.find((h) => h.id === activeTab.hostId),
                  activeTab.hostLabel,
                  privacyRedactHosts,
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" onClick={() => void reconnectActiveTab()} disabled={isLoading}>
                Reconnect
              </Button>
              <Button size="sm" variant="outline" onClick={() => void closeTab(activeTab.id)} disabled={isLoading}>
                Close tab
              </Button>
            </div>
          </div>
        ) : null}
        {terminalState === "connected" && activeTab?.sessionId ? (
          <div className="flex h-full w-full flex-col">
            <div className="min-h-0 flex-1">
              <TerminalView
                tabId={activeTab.id}
                sessionId={activeTab.sessionId}
                keywordSettings={terminalKeywordSettings}
                onDisconnected={handleSessionLost}
              />
            </div>
            {showTerminalHostInfoBar ? (
              <div className="app-sidebar flex h-8 shrink-0 items-center justify-between gap-3 border-t px-3 text-[11px] app-chrome-muted">
                <span className="app-text-muted truncate">
                  {activeTabHost
                    ? formatSessionTabLabel(activeTabHost, activeTab.hostLabel, privacyRedactHosts)
                    : "Host details unavailable"}
                </span>
                <div className="flex shrink-0 items-center gap-3">
                  {tcprawEnabled && tcprawCode ? (
                    <button
                      type="button"
                      title={`Run: tcpraw get ${tcprawCode}`}
                      className="app-banner-info flex items-center gap-1.5 rounded border px-2 py-0.5 text-[10px] font-medium transition active:scale-95"
                      onClick={() => {
                        if (!activeTab.sessionId) return;
                        void invoke("ssh_send_input", {
                          sessionId: activeTab.sessionId,
                          input: `tcpraw get ${tcprawCode}\r`,
                        });
                      }}
                    >
                      tcpraw get <span className="font-mono tracking-widest">{tcprawCode}</span>
                    </button>
                  ) : null}
                  {hostMetricsLoading && !hostMetrics && !hostMetricsError ? (
                    <span className="app-text-muted">Fetching host metrics…</span>
                  ) : null}
                  {!hostMetricsLoading && hostMetricsError ? (
                    <span className="max-w-[480px] truncate text-amber-400">
                      CPU/RAM unavailable: {hostMetricsError}
                    </span>
                  ) : null}
                  {hostMetrics ? (
                    <>
                      <span className={`truncate ${metricColor(hostMetrics.cpu_usage_percent)}`}>
                        CPU {hostMetrics.cpu_usage_percent.toFixed(1)}%
                      </span>
                      <span className="app-text-muted max-w-[320px] truncate">{hostMetrics.cpu_model}</span>
                      {hostMetrics.ram_total_mb > 0 ? (
                        <span
                          className={`truncate ${metricColor(
                            (hostMetrics.ram_used_mb / hostMetrics.ram_total_mb) * 100,
                          )}`}
                        >
                          RAM {(hostMetrics.ram_used_mb / 1024).toFixed(2)} /{" "}
                          {(hostMetrics.ram_total_mb / 1024).toFixed(2)} GB
                        </span>
                      ) : (
                        <span className="app-text-muted truncate">RAM n/a</span>
                      )}
                      <span className="app-text-muted truncate">
                        Down {hostMetrics.download_kbps >= 1024
                          ? `${(hostMetrics.download_kbps / 1024).toFixed(2)} MB/s`
                          : `${hostMetrics.download_kbps.toFixed(1)} KB/s`}
                      </span>
                      <span className="app-text-muted truncate">
                        Up {hostMetrics.upload_kbps >= 1024
                          ? `${(hostMetrics.upload_kbps / 1024).toFixed(2)} MB/s`
                          : `${hostMetrics.upload_kbps.toFixed(1)} KB/s`}
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

export default App;
