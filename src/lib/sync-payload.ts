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

/** Parsed remote gist content. `settings: null` means legacy hosts-only sync. */
export type ParsedSyncPayload = {
  hosts: unknown[];
  settings: Partial<SyncSettings> | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseProxyConfig(raw: unknown): SyncProxyConfig {
  const config = isRecord(raw) ? raw : {};
  return {
    enabled: config.enabled === true,
    activeServerId:
      typeof config.activeServerId === "string"
        ? config.activeServerId
        : config.activeServerId === null
          ? null
          : null,
    applySsh: config.applySsh !== false,
    applyHttp: config.applyHttp !== false,
    lockdown: config.lockdown === true,
  };
}

function parseProxyType(raw: unknown): SyncProxyType {
  if (raw === "socks4" || raw === "socks5" || raw === "http" || raw === "https") {
    return raw;
  }
  return "socks5";
}

function parseProxyServers(raw: unknown): SyncProxyServer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((server) => ({
      id: typeof server.id === "string" ? server.id : "",
      name: typeof server.name === "string" ? server.name : "",
      type: parseProxyType(server.type),
      host: typeof server.host === "string" ? server.host : "",
      port: typeof server.port === "number" ? server.port : 0,
      username: typeof server.username === "string" ? server.username : "",
      password: typeof server.password === "string" ? server.password : "",
    }))
    .filter((server) => server.id.length > 0);
}

function extractPartialSettings(raw: unknown): Partial<SyncSettings> | null {
  if (!isRecord(raw) || !("settings" in raw)) return null;
  const settings = raw.settings;
  if (!isRecord(settings)) return null;

  const partial: Partial<SyncSettings> = {};

  if ("sftpHideDotfiles" in settings) {
    partial.sftpHideDotfiles = settings.sftpHideDotfiles === true;
  }
  if ("sftpOpenEditMode" in settings) {
    partial.sftpOpenEditMode = settings.sftpOpenEditMode === "confirm" ? "confirm" : "auto";
  }
  if ("privacyRedactHosts" in settings) {
    partial.privacyRedactHosts = settings.privacyRedactHosts === true;
  }
  if ("terminalHostInfoBar" in settings) {
    partial.terminalHostInfoBar = settings.terminalHostInfoBar !== false;
  }
  if ("tcprawEnabled" in settings) {
    partial.tcprawEnabled = settings.tcprawEnabled === true;
  }
  if ("autoInstallUpdates" in settings) {
    partial.autoInstallUpdates = settings.autoInstallUpdates === true;
  }
  if ("quickNavKey" in settings && typeof settings.quickNavKey === "string") {
    partial.quickNavKey = settings.quickNavKey;
  }
  if ("connectCounts" in settings && isRecord(settings.connectCounts)) {
    partial.connectCounts = settings.connectCounts as Record<string, { ssh: number; sftp: number }>;
  }
  if ("terminalKeywordSettings" in settings && isRecord(settings.terminalKeywordSettings)) {
    const keyword = settings.terminalKeywordSettings;
    const colors = isRecord(keyword.colors) ? keyword.colors : {};
    partial.terminalKeywordSettings = {
      enabled: keyword.enabled !== false,
      colors: {
        ...DEFAULT_TERMINAL_KEYWORD_SETTINGS.colors,
        ...(typeof colors.error === "string" ? { error: colors.error } : {}),
        ...(typeof colors.warning === "string" ? { warning: colors.warning } : {}),
        ...(typeof colors.ok === "string" ? { ok: colors.ok } : {}),
        ...(typeof colors.info === "string" ? { info: colors.info } : {}),
        ...(typeof colors.debug === "string" ? { debug: colors.debug } : {}),
        ...(typeof colors.network === "string" ? { network: colors.network } : {}),
      },
    };
  }
  if ("proxy" in settings && isRecord(settings.proxy)) {
    partial.proxy = {
      servers: parseProxyServers(settings.proxy.servers),
      config: parseProxyConfig(settings.proxy.config),
    };
  }

  return Object.keys(partial).length > 0 ? partial : null;
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

export function parseSyncPayload(raw: string): ParsedSyncPayload {
  const parsed: unknown = JSON.parse(raw || "{}");
  if (Array.isArray(parsed)) {
    return { hosts: parsed, settings: null };
  }
  if (isRecord(parsed) && "hosts" in parsed) {
    return {
      hosts: Array.isArray(parsed.hosts) ? parsed.hosts : [],
      settings: extractPartialSettings(parsed),
    };
  }
  return { hosts: [], settings: null };
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

export function persistPartialSyncSettings(settings: Partial<SyncSettings>): void {
  try {
    if (settings.sftpHideDotfiles !== undefined) {
      localStorage.setItem(
        SYNC_SETTINGS_KEYS.sftpHideDotfiles,
        settings.sftpHideDotfiles ? "1" : "0",
      );
    }
    if (settings.sftpOpenEditMode !== undefined) {
      localStorage.setItem(SYNC_SETTINGS_KEYS.sftpOpenEditMode, settings.sftpOpenEditMode);
    }
    if (settings.privacyRedactHosts !== undefined) {
      localStorage.setItem(
        SYNC_SETTINGS_KEYS.privacyRedactHosts,
        settings.privacyRedactHosts ? "1" : "0",
      );
    }
    if (settings.terminalHostInfoBar !== undefined) {
      localStorage.setItem(
        SYNC_SETTINGS_KEYS.terminalHostInfoBar,
        settings.terminalHostInfoBar ? "1" : "0",
      );
    }
    if (settings.tcprawEnabled !== undefined) {
      localStorage.setItem(SYNC_SETTINGS_KEYS.tcprawEnabled, settings.tcprawEnabled ? "1" : "0");
    }
    if (settings.autoInstallUpdates !== undefined) {
      localStorage.setItem(
        SYNC_SETTINGS_KEYS.autoInstallUpdates,
        settings.autoInstallUpdates ? "1" : "0",
      );
    }
    if (settings.quickNavKey !== undefined) {
      localStorage.setItem(SYNC_SETTINGS_KEYS.quickNavKey, settings.quickNavKey);
    }
    if (settings.connectCounts !== undefined) {
      localStorage.setItem(
        SYNC_SETTINGS_KEYS.connectCounts,
        JSON.stringify(settings.connectCounts),
      );
    }
    if (settings.terminalKeywordSettings !== undefined) {
      localStorage.setItem(
        SYNC_SETTINGS_KEYS.terminalKeywordSettings,
        JSON.stringify(settings.terminalKeywordSettings),
      );
    }
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
