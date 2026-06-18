import type { TerminalKeywordSettings } from "@/components/terminal-view";

export const SYNC_SETTINGS_KEYS = {
  sftpHideDotfiles: "rsshu.settings.sftpHideDotfiles",
  sftpOpenEditMode: "rsshu.settings.sftpOpenEditMode",
  privacyRedactHosts: "rsshu.settings.privacyRedactHosts",
  terminalHostInfoBar: "rsshu.settings.terminalHostInfoBar",
  tcprawEnabled: "rsshu.settings.tcprawEnabled",
  autoInstallUpdates: "rsshu.settings.autoInstallUpdates",
  quickNavKey: "rsshu.settings.quickNavKey",
  connectCounts: "rsshu.connectCounts",
  terminalKeywordSettings: "rsshu.settings.terminalKeywordSettings",
} as const;

export type SyncProxyType = "socks5" | "socks4" | "http" | "https";

export type SyncProxyServer = {
  id: string;
  name: string;
  type: SyncProxyType;
  host: string;
  port: number;
  username: string;
  password: string;
};

export type SyncProxyConfig = {
  enabled: boolean;
  activeServerId: string | null;
  applySsh: boolean;
  applyHttp: boolean;
  lockdown: boolean;
};

export type SyncSettings = {
  sftpHideDotfiles: boolean;
  sftpOpenEditMode: "auto" | "confirm";
  privacyRedactHosts: boolean;
  terminalHostInfoBar: boolean;
  tcprawEnabled: boolean;
  autoInstallUpdates: boolean;
  quickNavKey: string;
  connectCounts: Record<string, { ssh: number; sftp: number }>;
  terminalKeywordSettings: TerminalKeywordSettings;
  proxy: {
    servers: SyncProxyServer[];
    config: SyncProxyConfig;
  };
};

export type SyncPayload = {
  version: 1;
  hosts: unknown[];
  settings: SyncSettings;
};

export const DEFAULT_TERMINAL_KEYWORD_SETTINGS: TerminalKeywordSettings = {
  enabled: true,
  colors: {
    error: "#ff5f66",
    warning: "#ffd84d",
    ok: "#7ce38b",
    info: "#3da5ff",
    debug: "#8f8cff",
    network: "#e061b3",
  },
};

export const EMPTY_SYNC_PAYLOAD: SyncPayload = {
  version: 1,
  hosts: [],
  settings: {
    sftpHideDotfiles: false,
    sftpOpenEditMode: "auto",
    privacyRedactHosts: false,
    terminalHostInfoBar: true,
    tcprawEnabled: false,
    autoInstallUpdates: false,
    quickNavKey: "F2",
    connectCounts: {},
    terminalKeywordSettings: DEFAULT_TERMINAL_KEYWORD_SETTINGS,
    proxy: {
      servers: [],
      config: {
        enabled: false,
        activeServerId: null,
        applySsh: true,
        applyHttp: true,
        lockdown: false,
      },
    },
  },
};

function readBool(key: string, defaultValue = false): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return defaultValue;
    if (v === "1" || v === "true") return true;
    if (v === "0" || v === "false") return false;
  } catch {
    // ignore
  }
  return defaultValue;
}

function readTerminalKeywordSettings(): TerminalKeywordSettings {
  try {
    const raw = localStorage.getItem(SYNC_SETTINGS_KEYS.terminalKeywordSettings);
    if (!raw) return DEFAULT_TERMINAL_KEYWORD_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<TerminalKeywordSettings>;
    return {
      enabled: parsed.enabled ?? DEFAULT_TERMINAL_KEYWORD_SETTINGS.enabled,
      colors: {
        ...DEFAULT_TERMINAL_KEYWORD_SETTINGS.colors,
        ...(parsed.colors ?? {}),
      },
    };
  } catch {
    return DEFAULT_TERMINAL_KEYWORD_SETTINGS;
  }
}

function readConnectCounts(): Record<string, { ssh: number; sftp: number }> {
  try {
    const raw = localStorage.getItem(SYNC_SETTINGS_KEYS.connectCounts);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, { ssh: number; sftp: number }>;
  } catch {
    return {};
  }
}

export function buildSyncPayload(input: {
  hosts: unknown[];
  sftpHideDotfiles: boolean;
  sftpOpenEditMode: "auto" | "confirm";
  privacyRedactHosts: boolean;
  terminalHostInfoBar: boolean;
  tcprawEnabled: boolean;
  autoInstallUpdates: boolean;
  quickNavKey: string;
  connectCounts: Record<string, { ssh: number; sftp: number }>;
  terminalKeywordSettings: TerminalKeywordSettings;
  proxyServers: SyncProxyServer[];
  proxyConfig: SyncProxyConfig;
}): SyncPayload {
  return {
    version: 1,
    hosts: input.hosts,
    settings: {
      sftpHideDotfiles: input.sftpHideDotfiles,
      sftpOpenEditMode: input.sftpOpenEditMode,
      privacyRedactHosts: input.privacyRedactHosts,
      terminalHostInfoBar: input.terminalHostInfoBar,
      tcprawEnabled: input.tcprawEnabled,
      autoInstallUpdates: input.autoInstallUpdates,
      quickNavKey: input.quickNavKey,
      connectCounts: input.connectCounts,
      terminalKeywordSettings: input.terminalKeywordSettings,
      proxy: {
        servers: input.proxyServers,
        config: input.proxyConfig,
      },
    },
  };
}

export function buildSyncPayloadJson(input: Parameters<typeof buildSyncPayload>[0]): string {
  return JSON.stringify(buildSyncPayload(input));
}

export function parseSyncPayload(raw: string): SyncPayload {
  const parsed: unknown = JSON.parse(raw || "{}");
  if (Array.isArray(parsed)) {
    return {
      ...EMPTY_SYNC_PAYLOAD,
      hosts: parsed,
    };
  }
  if (typeof parsed === "object" && parsed !== null && "hosts" in parsed) {
    const payload = parsed as Partial<SyncPayload>;
    const settings = payload.settings ?? EMPTY_SYNC_PAYLOAD.settings;
    return {
      version: 1,
      hosts: Array.isArray(payload.hosts) ? payload.hosts : [],
      settings: {
        ...EMPTY_SYNC_PAYLOAD.settings,
        ...settings,
        terminalKeywordSettings: {
          ...DEFAULT_TERMINAL_KEYWORD_SETTINGS,
          ...(settings.terminalKeywordSettings ?? {}),
          colors: {
            ...DEFAULT_TERMINAL_KEYWORD_SETTINGS.colors,
            ...(settings.terminalKeywordSettings?.colors ?? {}),
          },
        },
        proxy: {
          servers: settings.proxy?.servers ?? [],
          config: {
            ...EMPTY_SYNC_PAYLOAD.settings.proxy.config,
            ...(settings.proxy?.config ?? {}),
          },
        },
        connectCounts: settings.connectCounts ?? {},
      },
    };
  }
  return EMPTY_SYNC_PAYLOAD;
}

export function persistSyncSettings(settings: SyncSettings): void {
  try {
    localStorage.setItem(
      SYNC_SETTINGS_KEYS.sftpHideDotfiles,
      settings.sftpHideDotfiles ? "1" : "0",
    );
    localStorage.setItem(SYNC_SETTINGS_KEYS.sftpOpenEditMode, settings.sftpOpenEditMode);
    localStorage.setItem(
      SYNC_SETTINGS_KEYS.privacyRedactHosts,
      settings.privacyRedactHosts ? "1" : "0",
    );
    localStorage.setItem(
      SYNC_SETTINGS_KEYS.terminalHostInfoBar,
      settings.terminalHostInfoBar ? "1" : "0",
    );
    localStorage.setItem(SYNC_SETTINGS_KEYS.tcprawEnabled, settings.tcprawEnabled ? "1" : "0");
    localStorage.setItem(
      SYNC_SETTINGS_KEYS.autoInstallUpdates,
      settings.autoInstallUpdates ? "1" : "0",
    );
    localStorage.setItem(SYNC_SETTINGS_KEYS.quickNavKey, settings.quickNavKey);
    localStorage.setItem(
      SYNC_SETTINGS_KEYS.connectCounts,
      JSON.stringify(settings.connectCounts),
    );
    localStorage.setItem(
      SYNC_SETTINGS_KEYS.terminalKeywordSettings,
      JSON.stringify(settings.terminalKeywordSettings),
    );
  } catch {
    // ignore
  }
}

export function loadPersistedSyncSettings(): Partial<SyncSettings> {
  let sftpOpenEditMode: "auto" | "confirm" = "auto";
  try {
    const v = localStorage.getItem(SYNC_SETTINGS_KEYS.sftpOpenEditMode);
    if (v === "confirm") sftpOpenEditMode = "confirm";
  } catch {
    // ignore
  }

  let quickNavKey = "F2";
  try {
    const v = localStorage.getItem(SYNC_SETTINGS_KEYS.quickNavKey);
    if (v) quickNavKey = v;
  } catch {
    // ignore
  }

  return {
    sftpHideDotfiles: readBool(SYNC_SETTINGS_KEYS.sftpHideDotfiles),
    sftpOpenEditMode,
    privacyRedactHosts: readBool(SYNC_SETTINGS_KEYS.privacyRedactHosts),
    terminalHostInfoBar: readBool(SYNC_SETTINGS_KEYS.terminalHostInfoBar, true),
    tcprawEnabled: readBool(SYNC_SETTINGS_KEYS.tcprawEnabled),
    autoInstallUpdates: readBool(SYNC_SETTINGS_KEYS.autoInstallUpdates),
    quickNavKey,
    connectCounts: readConnectCounts(),
    terminalKeywordSettings: readTerminalKeywordSettings(),
  };
}
