import {
  buildSyncPayload,
  parseSyncPayload,
  type ParsedSyncPayload,
  type SyncPayload,
  type SyncProxyConfig,
  type SyncProxyServer,
} from "@/lib/sync-payload";
import type { TerminalKeywordSettings } from "@/components/terminal-view";
import {
  getStoredCustomTheme,
  getStoredThemeId,
  isThemeId,
  normalizeCustomTheme,
  type CustomThemeConfig,
  type ThemeId,
} from "@/lib/themes";

export const BACKUP_TYPE = "rsshu-backup" as const;
export const BACKUP_VERSION = 1 as const;

export type BackupLocalData = {
  theme: ThemeId;
  customTheme: CustomThemeConfig;
};

export type BackupPayload = {
  type: typeof BACKUP_TYPE;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  hosts: unknown[];
  settings: SyncPayload["settings"];
  local: BackupLocalData;
};

export type ParsedBackup = ParsedSyncPayload & {
  local: Partial<BackupLocalData> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function buildBackupPayload(input: {
  hosts: unknown[];
  sftpHideDotfiles: boolean;
  sftpOpenEditMode: "auto" | "confirm";
  privacyRedactHosts: boolean;
  terminalHostInfoBar: boolean;
  terminalDragDropUpload: boolean;
  tcprawEnabled: boolean;
  autoInstallUpdates: boolean;
  quickNavKey: string;
  connectCounts: Record<string, { ssh: number; sftp: number }>;
  terminalKeywordSettings: TerminalKeywordSettings;
  proxyServers: SyncProxyServer[];
  proxyConfig: SyncProxyConfig;
  theme?: ThemeId;
  customTheme?: CustomThemeConfig;
}): BackupPayload {
  const sync = buildSyncPayload(input);
  return {
    type: BACKUP_TYPE,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    hosts: sync.hosts,
    settings: sync.settings,
    local: {
      theme: input.theme ?? getStoredThemeId(),
      customTheme: input.customTheme ?? getStoredCustomTheme(),
    },
  };
}

export function buildBackupJson(input: Parameters<typeof buildBackupPayload>[0]): string {
  return `${JSON.stringify(buildBackupPayload(input), null, 2)}\n`;
}

function parseLocal(raw: unknown): Partial<BackupLocalData> | null {
  if (!isRecord(raw)) return null;
  const result: Partial<BackupLocalData> = {};
  if (typeof raw.theme === "string" && isThemeId(raw.theme)) {
    result.theme = raw.theme;
  }
  if (isRecord(raw.customTheme)) {
    try {
      result.customTheme = normalizeCustomTheme(raw.customTheme as Partial<CustomThemeConfig>);
    } catch {
      // ignore invalid custom theme
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** Accepts rsshu-backup JSON, sync payload JSON, or legacy hosts-only array. */
export function parseBackupPayload(raw: string): ParsedBackup {
  const parsed: unknown = JSON.parse(raw || "{}");

  if (Array.isArray(parsed)) {
    return { hosts: parsed, settings: null, local: null };
  }

  if (!isRecord(parsed)) {
    return { hosts: [], settings: null, local: null };
  }

  const sync = parseSyncPayload(JSON.stringify(parsed));
  const local = "local" in parsed ? parseLocal(parsed.local) : null;

  // Bare sync payload without `type` still works via parseSyncPayload.
  if ("hosts" in parsed || parsed.type === BACKUP_TYPE) {
    return { ...sync, local };
  }

  return { hosts: [], settings: null, local };
}

export function defaultBackupFilename(date = new Date()): string {
  const stamp = date.toISOString().slice(0, 19).replace(/[:T]/g, (c) => (c === "T" ? "_" : "-"));
  return `rsshu-backup-${stamp}.json`;
}
