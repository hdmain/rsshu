import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  ShieldCheck,
  Terminal,
  Trash2,
  Unplug,
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
import { SftpView } from "@/components/sftp-view";
import { TitleBar } from "@/components/title-bar";
import { VaultOverlay } from "@/components/vault-overlay";
import {
  formatSftpBannerLabel,
  formatSessionTabLabel,
  hostCardSubtitle,
  hostCardTitle,
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
type HostStatus = "online" | "offline" | "connecting";
type SidebarSection = "hosts" | "keychain" | "forwarding" | "snippets" | "known" | "logs" | "settings";
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

function statusColor(status: HostStatus) {
  if (status === "online") return "text-emerald-400";
  if (status === "connecting") return "text-amber-300";
  return "text-rose-400";
}

function statusDot(status: HostStatus) {
  if (status === "online") return "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]";
  if (status === "connecting") return "bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.8)]";
  return "bg-rose-400/80";
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
    <header className="relative z-20 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-gradient-to-r from-[#0a1120] via-[#0b1326] to-[#0a1120] px-4 backdrop-blur">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-sky-500 to-indigo-500 shadow-[0_0_12px_rgba(56,189,248,0.35)]">
          <Terminal className="h-4 w-4 text-white" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold tracking-wide text-slate-100">RSSHU</p>
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">SSH / SFTP Console</p>
        </div>
        <div className="mx-2 hidden h-6 w-px bg-white/10 md:block" />
        <div className="hidden items-center rounded-full border border-white/10 bg-white/5 p-1 text-xs md:flex">
          <button
            onClick={() => onChangeScreen("hosts")}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 transition ${
              screen === "hosts" ? "bg-sky-500/20 text-sky-200" : "text-slate-300 hover:text-white"
            }`}
          >
            <Server className="h-3.5 w-3.5" />
            Hosts
          </button>
          <button
            onClick={() => onChangeScreen("terminal")}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 transition ${
              screen === "terminal" ? "bg-sky-500/20 text-sky-200" : "text-slate-300 hover:text-white"
            }`}
          >
            <Terminal className="h-3.5 w-3.5" />
            Terminal
            {activeSessionCount > 0 ? (
              <span className="ml-1 rounded-full bg-sky-500/30 px-1.5 text-[10px] font-medium text-sky-100">
                {activeSessionCount}
              </span>
            ) : null}
          </button>
          <button
            onClick={() => onChangeScreen("sftp")}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 transition ${
              screen === "sftp" ? "bg-sky-500/20 text-sky-200" : "text-slate-300 hover:text-white"
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
            <div className="mx-1 h-6 w-px bg-white/10" />
            <button
              type="button"
              onClick={onLock}
              title="Lock vault"
              className="flex h-9 w-9 items-center justify-center rounded-md border border-white/10 bg-white/5 text-slate-300 transition hover:border-sky-400/40 hover:bg-sky-500/15 hover:text-sky-200"
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
    if (percent > 90) return "text-rose-300";
    if (percent > 75) return "text-amber-300";
    return "text-slate-300";
  }

  const [screen, setScreen] = useState<Screen>("hosts");
  const [hosts, setHosts] = useState<Host[]>([]);
  const [hostStatuses, setHostStatuses] = useState<Record<string, HostStatus>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [sidebarSection, setSidebarSection] = useState<SidebarSection>("hosts");
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [isHostModalOpen, setIsHostModalOpen] = useState(false);
  const [draft, setDraft] = useState<HostDraft>(emptyDraft);
  const [tabs, setTabs] = useState<SessionTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
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
  const [sftpHideDotfiles, setSftpHideDotfiles] = useState(false);
  const [sftpOpenEditMode, setSftpOpenEditMode] = useState<"auto" | "confirm">("auto");
  const [privacyRedactHosts, setPrivacyRedactHosts] = useState(false);
  const [showTerminalHostInfoBar, setShowTerminalHostInfoBar] = useState(true);
  const [hostMetrics, setHostMetrics] = useState<SshHostMetricsResponse | null>(null);
  const [hostMetricsLoading, setHostMetricsLoading] = useState(false);
  const [hostMetricsError, setHostMetricsError] = useState("");

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
          setHostStatuses(
            Object.fromEntries((parsed as Host[]).map((host) => [host.id, "offline" as HostStatus])),
          );
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
            setHostStatuses(
              Object.fromEntries((parsed as Host[]).map((host) => [host.id, "offline" as HostStatus])),
            );
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
      setHostStatuses({});
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
      setHostStatuses(Object.fromEntries(parsed.map((host) => [host.id, "offline" as HostStatus])));
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
    setHostStatuses({});
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
        setHostStatuses(
          Object.fromEntries((parsed as Host[]).map((host) => [host.id, "offline" as HostStatus])),
        );
      }
      setSyncInfo("Pulled latest data from GitHub Gist.");
    } catch (err) {
      setSyncError(String(err));
    } finally {
      setSyncBusy(false);
    }
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

    let cancelled = false;
    const fetchMetrics = async () => {
      try {
        setHostMetricsLoading(true);
        setHostMetricsError("");
        const metrics = await invoke<SshHostMetricsResponse>("ssh_fetch_host_metrics", {
          sessionId: activeTab.sessionId,
        });
        if (cancelled) return;
        setHostMetrics(metrics);
      } catch (error) {
        if (cancelled) return;
        setHostMetricsError(String(error));
      } finally {
        if (!cancelled) setHostMetricsLoading(false);
      }
    };

    void fetchMetrics();
    const timer = window.setInterval(() => void fetchMetrics(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [showTerminalHostInfoBar, screen, terminalState, activeTab?.sessionId]);

  const sidebarItems: Array<{ key: SidebarSection; label: string; icon: ReactNode }> = [
    { key: "hosts", label: "Hosts", icon: <Server className="h-4 w-4" /> },
    { key: "keychain", label: "Keychain", icon: <KeyRound className="h-4 w-4" /> },
    { key: "forwarding", label: "Port Forwarding", icon: <Network className="h-4 w-4" /> },
    { key: "snippets", label: "Snippets", icon: <Terminal className="h-4 w-4" /> },
    { key: "known", label: "Known Hosts", icon: <Laptop className="h-4 w-4" /> },
    { key: "logs", label: "Logs", icon: <Logs className="h-4 w-4" /> },
    { key: "settings", label: "Settings", icon: <Settings2 className="h-4 w-4" /> },
  ];

  function toggleGroup(groupName: string) {
    setCollapsedGroups((prev) => ({ ...prev, [groupName]: !prev[groupName] }));
  }

  function openNewHostModal() {
    setDraft(emptyDraft);
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
    setHostStatuses((prev) => ({ ...prev, [nextHost.id]: prev[nextHost.id] ?? "offline" }));
    setActiveHostId(nextHost.id);
    setIsHostModalOpen(false);
  }

  function deleteHost(hostId: string) {
    setHosts((prev) => prev.filter((item) => item.id !== hostId));
    setHostStatuses((prev) => {
      const next = { ...prev };
      delete next[hostId];
      return next;
    });
  }

  async function testConnection(host: Host) {
    setHostStatuses((prev) => ({ ...prev, [host.id]: "connecting" }));
    try {
      await invoke("ssh_test_connection", {
        req: {
          host: host.host,
          port: host.port,
          username: host.username,
          password: host.password,
          privateKey: host.privateKey,
          passphrase: host.passphrase,
        },
      });
      setHostStatuses((prev) => ({ ...prev, [host.id]: "online" }));
    } catch {
      setHostStatuses((prev) => ({ ...prev, [host.id]: "offline" }));
    }
  }

  const handleSessionLost = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab?.sessionId) return;
      const sid = tab.sessionId;
      const hid = tab.hostId;
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
      setHostStatuses((prev) => ({ ...prev, [hid]: "offline" }));
    },
    [tabs, activeTabId]
  );

  async function startShellForHost(host: Host, existingTabId: string | null) {
    let unlisten: (() => void) | undefined;
    setSshProgressLines([]);
    setReconnectError("");
    setTerminalState("connecting");
    setTerminalError("");
    setHostStatuses((prev) => ({ ...prev, [host.id]: "connecting" }));
    setIsLoading(true);
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
      const label = `${host.name} (${host.username}@${host.host})`;
      if (existingTabId) {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === existingTabId
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
        setActiveTabId(existingTabId);
      } else {
        const tab: SessionTab = {
          id: crypto.randomUUID(),
          hostId: host.id,
          hostLabel: label,
          sessionId: response.session_id,
          disconnected: false,
        };
        setTabs((prev) => [tab, ...prev]);
        setActiveTabId(tab.id);
      }
      setTerminalState("connected");
      setHostStatuses((prev) => ({ ...prev, [host.id]: "online" }));
    } catch (error) {
      const msg = String(error);
      if (existingTabId) {
        setReconnectError(msg);
        setTerminalState("disconnected");
      } else {
        setTerminalState("error");
        setTerminalError(msg);
      }
      setHostStatuses((prev) => ({ ...prev, [host.id]: "offline" }));
    } finally {
      unlisten?.();
      setIsLoading(false);
    }
  }

  async function connectHost(host: Host) {
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
    if (nextTabs.length === 0) {
      setTerminalState("empty");
      setScreen("hosts");
    } else if (nextActive?.disconnected || !nextActive?.sessionId) {
      setTerminalState("disconnected");
    } else {
      setTerminalState("connected");
    }
  }

  const appShell =
    "flex h-screen w-screen flex-col overflow-hidden bg-[radial-gradient(circle_at_top,_#0e1a33_0%,_#050912_55%,_#03060d_100%)] text-foreground";

  if (vaultStatus !== "unlocked") {
    return (
      <div className={appShell}>
        <TitleBar />
        {vaultStatus === "loading" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-slate-400">
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
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <Input
                  className="h-9 w-64 pl-7 text-xs"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search host, tag, group"
                />
              </div>
              <Button size="sm" onClick={openNewHostModal}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                New Host
              </Button>
            </>
          }
        />

        <main className="grid flex-1 min-h-0 grid-cols-[240px_1fr] overflow-hidden">
          <aside className="flex flex-col border-r border-white/10 bg-[#070c18]/80 p-3 backdrop-blur">
            <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Navigation
            </p>
            <div className="space-y-1">
              {sidebarItems.map((item) => (
                <button
                  key={item.key}
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition ${
                    sidebarSection === item.key
                      ? "bg-sky-500/15 text-sky-200 ring-1 ring-sky-500/20"
                      : "text-slate-300 hover:bg-white/5 hover:text-white"
                  }`}
                  onClick={() => setSidebarSection(item.key)}
                >
                  <span className={sidebarSection === item.key ? "text-sky-300" : "text-slate-400"}>
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              ))}
            </div>
            <Separator className="my-4 bg-white/10" />
            <div className="px-2 text-[10px] uppercase tracking-[0.18em] text-slate-500">Summary</div>
            <div className="mt-2 space-y-1.5 px-2 text-xs text-slate-300">
              <div className="flex justify-between">
                <span>Total hosts</span>
                <span className="font-medium text-slate-100">{hosts.length}</span>
              </div>
              <div className="flex justify-between">
                <span>Open sessions</span>
                <span className="font-medium text-slate-100">{tabs.length}</span>
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
                    <Card className="border-white/10 bg-white/[0.03]">
                      <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-500/10 text-sky-300">
                          <Server className="h-5 w-5" />
                        </div>
                        <p className="text-sm font-medium text-slate-100">No hosts yet</p>
                        <p className="max-w-xs text-xs text-slate-400">
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
                      className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset]"
                    >
                      <button
                        className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-slate-200 hover:bg-white/[0.03]"
                        onClick={() => toggleGroup(groupName)}
                      >
                        <span className="flex items-center gap-2">
                          {collapsedGroups[groupName] ? (
                            <ChevronRight className="h-4 w-4 text-slate-400" />
                          ) : (
                            <ChevronDown className="h-4 w-4 text-slate-400" />
                          )}
                          <Folder className="h-4 w-4 text-sky-300" />
                          {groupName}
                        </span>
                        <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-300">
                          {list.length}
                        </Badge>
                      </button>
                      {!collapsedGroups[groupName] ? (
                        <div className="divide-y divide-white/5 border-t border-white/5">
                          {list.map((host) => {
                            const hostStatus = hostStatuses[host.id] ?? "offline";
                            return (
                              <div
                                key={host.id}
                                className="group flex items-center justify-between px-4 py-3 transition hover:bg-white/[0.04]"
                              >
                                <div className="flex min-w-0 items-center gap-3">
                                  <span className={`h-2 w-2 rounded-full ${statusDot(hostStatus)}`} />
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-slate-100">
                                      {hostCardTitle(host, privacyRedactHosts)}
                                    </p>
                                    <p className="truncate text-xs text-slate-400">
                                      {hostCardSubtitle(host, privacyRedactHosts)}
                                    </p>
                                  </div>
                                  {host.tags.length > 0 ? (
                                    <div className="ml-2 hidden gap-1 lg:flex">
                                      {host.tags.slice(0, 3).map((tag) => (
                                        <Badge
                                          key={tag}
                                          variant="outline"
                                          className="border-white/10 bg-white/5 text-[10px] text-slate-300"
                                        >
                                          {tag}
                                        </Badge>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                                <div className="ml-2 flex items-center gap-2">
                                  <span className={`hidden text-xs sm:inline ${statusColor(hostStatus)}`}>
                                    {hostStatus}
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
                                    title="Test connection"
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
              ) : sidebarSection === "settings" ? (
                <div className="max-w-2xl space-y-4">
                  <Card className="border-white/10 bg-[#1f2740]/80 shadow-xl">
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-slate-100">Keyword highlighting</CardTitle>
                        <button
                          type="button"
                          aria-label="Toggle keyword highlighting"
                          onClick={() =>
                            setTerminalKeywordSettings((prev) => ({ ...prev, enabled: !prev.enabled }))
                          }
                          className={`relative h-6 w-11 rounded-full transition ${
                            terminalKeywordSettings.enabled ? "bg-emerald-500" : "bg-slate-600"
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
                          <p className="text-sm font-medium text-slate-100">{label}</p>
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
                            className="h-8 w-14 cursor-pointer rounded-md border border-white/10 bg-transparent p-0"
                          />
                        </div>
                      ))}
                    </CardContent>
                  </Card>

                  <Card className="border-white/10 bg-[#1f2740]/80 shadow-xl">
                    <CardHeader>
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5 text-slate-300">
                            <EyeOff className="h-4 w-4" />
                          </div>
                          <div className="min-w-0">
                            <CardTitle className="text-slate-100">Hide hosts and IPs in the UI</CardTitle>
                            <CardDescription className="text-slate-400">
                              Masks addresses on the host list, in terminal tabs, in the SSH connect log, and on
                              disconnected / SFTP headers. Vault data and the edit-host form stay full.
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
                            privacyRedactHosts ? "bg-sky-500" : "bg-slate-600"
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
                        <p className="text-sm text-slate-300">
                          Does not change what is sent over SSH — only what is drawn on screen outside the host editor.
                        </p>
                        <div className="flex items-center justify-between rounded-md border border-white/10 bg-white/[0.02] px-3 py-2">
                          <div>
                            <p className="text-sm font-medium text-slate-100">Terminal host info bar</p>
                            <p className="text-xs text-slate-400">
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
                              showTerminalHostInfoBar ? "bg-sky-500" : "bg-slate-600"
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

                  <Card className="border-white/10 bg-[#1f2740]/80 shadow-xl">
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <div>
                          <CardTitle className="text-slate-100">SFTP</CardTitle>
                          <CardDescription className="text-slate-400">File browser and open-file behaviour.</CardDescription>
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
                            sftpHideDotfiles ? "bg-sky-500" : "bg-slate-600"
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
                      <p className="text-sm text-slate-300">
                        Hide file and folder names that start with <span className="font-mono">.</span> in the SFTP
                        view.
                      </p>
                      <div className="space-y-2">
                        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                          After you double-click a file (opens in an external app)
                        </p>
                        <div className="space-y-2">
                          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-white/5 bg-white/[0.02] p-2 text-sm text-slate-200 hover:bg-white/[0.04]">
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
                          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-white/5 bg-white/[0.02] p-2 text-sm text-slate-200 hover:bg-white/[0.04]">
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
                            <span>Require <strong className="font-medium text-slate-100">Save to server</strong> in the app to upload your edits</span>
                          </label>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-white/10 bg-[#1f2740]/80 shadow-xl">
                    <CardHeader>
                      <CardTitle className="text-slate-100">Cloud Sync (GitHub Gist)</CardTitle>
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
                      {syncError ? <p className="text-xs text-rose-300">{syncError}</p> : null}
                      <p className="text-xs text-slate-400">
                        Once sync is on, any change to your hosts is automatically written to the Gist. On
                        another machine, use the same Gist ID and Sync key, then click Pull Now.
                      </p>
                    </CardContent>
                  </Card>
                </div>
              ) : (
                <Card className="border-white/10 bg-white/[0.03]">
                  <CardContent className="py-10 text-sm text-slate-300">
                    {sidebarSection.charAt(0).toUpperCase() + sidebarSection.slice(1)} view coming soon.
                  </CardContent>
                </Card>
              )}
            </div>
          </section>
        </main>

        {isHostModalOpen ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
            <Card className="w-full max-w-xl border-white/10 bg-[#0a1120]">
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
                  <Input type="password" placeholder="Password" value={draft.password} onChange={(e) => setDraft((prev) => ({ ...prev, password: e.target.value }))} />
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
            <div className="flex flex-1 items-center justify-center bg-[#050912]">
              <div className="flex flex-col items-center gap-2 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/5 text-slate-400">
                  <FolderOpen className="h-5 w-5" />
                </div>
                <p className="text-sm text-slate-300">No SFTP session</p>
                <p className="text-xs text-slate-500">Browse files on a remote server.</p>
                <Button size="sm" variant="outline" className="mt-2" onClick={() => setScreen("hosts")}>
                  <Server className="mr-1.5 h-3.5 w-3.5" />
                  Pick a host
                </Button>
              </div>
            </div>
          ) : null}
          {sftpState === "connecting" ? (
            <div className="flex flex-1 items-center justify-center bg-[#050912]">
              <p className="text-sm text-amber-300">Connecting to SFTP…</p>
            </div>
          ) : null}
          {sftpState === "error" ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-[#050912] px-6 text-center">
              <p className="max-w-xl text-sm text-rose-300">{sftpError}</p>
              <Button size="sm" variant="outline" onClick={() => setScreen("hosts")}>
                Back to hosts
              </Button>
            </div>
          ) : null}
          {sftpState === "connected" && sftpSession ? (
            <SftpView
              sessionId={sftpSession.sessionId}
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
        <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-white/10 bg-[#070c18]/70 px-2">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className={`group flex h-7 items-center gap-2 rounded-md border px-2.5 text-xs transition ${
                  isActive
                    ? "border-sky-400/40 bg-sky-500/15 text-sky-100 shadow-[0_0_0_1px_rgba(56,189,248,0.15)]"
                    : "border-white/5 bg-white/[0.03] text-slate-300 hover:bg-white/[0.06] hover:text-white"
                }`}
              >
                <button
                  className="flex items-center gap-2"
                  onClick={() => {
                    setActiveTabId(tab.id);
                    if (tab.disconnected || !tab.sessionId) {
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
                          ? "bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.9)]"
                          : "bg-emerald-400/80"
                    }`}
                  />
                  <span className="max-w-[220px] truncate">
                    {formatSessionTabLabel(
                      hosts.find((h) => h.id === tab.hostId),
                      tab.hostLabel,
                      privacyRedactHosts,
                    )}
                  </span>
                </button>
                <button
                  className="rounded p-0.5 text-slate-400 opacity-60 hover:bg-white/10 hover:text-white hover:opacity-100"
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
          <div className="flex flex-1 items-center justify-center bg-[#050912]">
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/5 text-slate-400">
                <Terminal className="h-5 w-5" />
              </div>
              <p className="text-sm text-slate-300">No active session</p>
              <p className="text-xs text-slate-500">Pick a host to open a terminal.</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => setScreen("hosts")}>
                <Server className="mr-1.5 h-3.5 w-3.5" />
                Go to Hosts
              </Button>
            </div>
          </div>
        ) : null}
        {terminalState === "connecting" ? (
          <div className="flex flex-1 flex-col items-center justify-center bg-[#050912] px-6 py-8">
            <div className="w-full max-w-lg rounded-lg border border-sky-500/20 bg-black/40 px-4 py-3 font-mono text-[13px] leading-relaxed shadow-[0_0_40px_rgba(14,165,233,0.08)]">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-sky-300/90">
                SSH connection
              </p>
              <div className="max-h-[min(50vh,320px)] space-y-1 overflow-y-auto text-slate-300">
                {sshProgressLines.length === 0 ? (
                  <p className="animate-pulse text-slate-500">Waiting for host…</p>
                ) : (
                  sshProgressLines.map((line, i) => (
                    <p
                      key={`${i}-${line.slice(0, 24)}`}
                      className={`border-l-2 border-transparent pl-2 transition-all duration-300 ${
                        i === sshProgressLines.length - 1
                          ? "border-sky-400/70 text-sky-100"
                          : "text-slate-400"
                      }`}
                    >
                      <span className="select-none text-slate-600">{">"} </span>
                      {redactConnectionLogLine(line, hosts, privacyRedactHosts)}
                    </p>
                  ))
                )}
              </div>
            </div>
            <p className="mt-4 text-xs text-slate-500">Stages mirror the Rust SSH client (TCP → KEX → auth → shell).</p>
          </div>
        ) : null}
        {terminalState === "error" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-[#050912] px-6 text-center">
            <p className="max-w-xl text-sm text-rose-300">{terminalError}</p>
            <Button size="sm" variant="outline" onClick={() => setScreen("hosts")}>
              <Server className="mr-1.5 h-3.5 w-3.5" />
              Hosts
            </Button>
          </div>
        ) : null}
        {terminalState === "disconnected" && activeTab?.disconnected ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-[#050912] px-6">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-500/25 bg-amber-500/10 text-amber-200">
              <Unplug className="h-7 w-7" />
            </div>
            <div className="max-w-md text-center">
              <p className="text-lg font-medium tracking-tight text-slate-100">Disconnected</p>
              {activeTab.disconnectReason ? (
                <p className="mt-2 text-sm text-slate-400">{activeTab.disconnectReason}</p>
              ) : null}
              {reconnectError ? (
                <p className="mt-3 rounded-md border border-rose-500/30 bg-rose-950/40 px-3 py-2 text-left text-xs text-rose-200">
                  {reconnectError}
                </p>
              ) : null}
              <p className="mt-2 text-xs text-slate-500">
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
              <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-white/10 bg-[#070c18]/95 px-3 text-[11px] text-slate-300">
                <span className="truncate text-slate-400">
                  {activeTabHost
                    ? formatSessionTabLabel(activeTabHost, activeTab.hostLabel, privacyRedactHosts)
                    : "Host details unavailable"}
                </span>
                <div className="flex shrink-0 items-center gap-3">
                  {hostMetricsLoading && !hostMetrics && !hostMetricsError ? (
                    <span className="text-slate-500">Fetching host metrics…</span>
                  ) : null}
                  {!hostMetricsLoading && hostMetricsError ? (
                    <span className="max-w-[480px] truncate text-amber-300">
                      CPU/RAM unavailable: {hostMetricsError}
                    </span>
                  ) : null}
                  {hostMetrics ? (
                    <>
                      <span className={`truncate ${metricColor(hostMetrics.cpu_usage_percent)}`}>
                        CPU {hostMetrics.cpu_usage_percent.toFixed(1)}%
                      </span>
                      <span className="max-w-[320px] truncate text-slate-400">{hostMetrics.cpu_model}</span>
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
                        <span className="truncate text-slate-500">RAM n/a</span>
                      )}
                      <span className="truncate text-slate-300">
                        Down {hostMetrics.download_kbps >= 1024
                          ? `${(hostMetrics.download_kbps / 1024).toFixed(2)} MB/s`
                          : `${hostMetrics.download_kbps.toFixed(1)} KB/s`}
                      </span>
                      <span className="truncate text-slate-300">
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
