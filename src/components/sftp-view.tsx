import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { join, tempDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  ArrowUp,
  ChevronRight,
  Download,
  File as FileIcon,
  FolderPlus,
  Folder as FolderIcon,
  Home as HomeIcon,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export type SftpEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  mtime: number;
  perm: number;
};

export type SftpOpenEditMode = "auto" | "confirm";

type SftpViewProps = {
  sessionId: string;
  hostId: string;
  home: string;
  hostLabel: string;
  hideDotfiles: boolean;
  openEditMode: SftpOpenEditMode;
  onDisconnect: () => void;
};

type TransferInfo =
  | { kind: "upload"; name: string }
  | { kind: "download"; name: string }
  | { kind: "open"; name: string }
  | { kind: "rename"; name: string };

type TrackedOpenFile = {
  id: string;
  name: string;
  localPath: string;
  remotePath: string;
  baselineMtime: number;
  baselineSize: number;
  editState: "synced" | "modified" | "uploading";
};

type SftpViewState = {
  currentPath: string;
  trackedOpen: TrackedOpenFile[];
};

/** Module-level cache — survives React unmount/remount within the same app session. */
const _memCache = new Map<string, SftpViewState>();

/** Per-path directory listing cache — keyed by `${sessionId}:${normalizedPath}`. */
const _entriesCache = new Map<string, SftpEntry[]>();

function entriesCacheKey(sessionId: string, path: string) {
  return `${sessionId}:${path}`;
}

export function clearSftpSessionCache(sessionId: string, hostId: string) {
  // Entries cache is per-session (connection-specific).
  for (const key of Array.from(_entriesCache.keys())) {
    if (key.startsWith(`${sessionId}:`)) _entriesCache.delete(key);
  }
  // View-state cache (path, tracked files) is per-host — keep it so the
  // path is remembered when reconnecting, but allow the caller to wipe it
  // explicitly on vault-lock / host-delete by passing the hostId.
  _memCache.delete(hostId);
}

function saveViewState(hostId: string, state: SftpViewState) {
  _memCache.set(hostId, state);
  try {
    localStorage.setItem(`rsshu.sftp.viewState.${hostId}`, JSON.stringify(state));
  } catch {
    // storage quota exceeded — in-memory cache still works
  }
}

function loadViewState(hostId: string, home: string): SftpViewState {
  const mem = _memCache.get(hostId);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(`rsshu.sftp.viewState.${hostId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SftpViewState>;
      const trackedOpen = Array.isArray(parsed.trackedOpen)
        ? (parsed.trackedOpen as Array<unknown>)
            .filter((x): x is TrackedOpenFile => {
              if (!x || typeof x !== "object") return false;
              const item = x as Partial<TrackedOpenFile>;
              return (
                typeof item.id === "string" &&
                typeof item.name === "string" &&
                typeof item.localPath === "string" &&
                typeof item.remotePath === "string" &&
                typeof item.baselineMtime === "number" &&
                typeof item.baselineSize === "number" &&
                (item.editState === "synced" ||
                  item.editState === "modified" ||
                  item.editState === "uploading")
              );
            })
            .map((item) => ({
              ...item,
              editState: item.editState === "uploading" ? ("modified" as const) : item.editState,
            }))
        : [];
      return {
        currentPath: typeof parsed.currentPath === "string"
          ? normalizeFsPath(parsed.currentPath)
          : normalizeFsPath(home),
        trackedOpen,
      };
    }
  } catch {
    // ignore
  }
  return { currentPath: normalizeFsPath(home), trackedOpen: [] };
}

function formatSize(size: number, isDir: boolean): string {
  if (isDir) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatMtime(ts: number): string {
  if (!ts) return "—";
  try {
    const d = new Date(ts * 1000);
    return d.toLocaleString();
  } catch {
    return "—";
  }
}

function joinPath(base: string, segment: string): string {
  if (!segment) return normalizeFsPath(base);
  const seg = segment.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!seg) return normalizeFsPath(base);
  if (segment.startsWith("/")) return normalizeFsPath(segment);
  const b = normalizeFsPath(base);
  if (b === "/") return `/${seg}`;
  return normalizeFsPath(`${b.replace(/\/+$/, "")}/${seg}`);
}

/** POSIX-style path for SFTP: backslashes and duplicate slashes are normalized. */
function normalizeFsPath(path: string): string {
  let p = path.trim().replace(/\\/g, "/");
  if (!p) return "/";
  p = p.replace(/\/+/g, "/");
  if (p[0] !== "/") p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

function parentPath(path: string): string {
  const p = normalizeFsPath(path);
  if (!p || p === "/") return "/";
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return "/";
  return p.slice(0, idx) || "/";
}

function segmentsOf(path: string): string[] {
  const p = normalizeFsPath(path);
  if (p === "/") return [];
  return p.slice(1).split("/").filter(Boolean);
}

function localFilename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function pointInClientRect(x: number, y: number, r: DOMRect): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

const AUTO_UPLOAD_DEBOUNCE_MS = 1200;

export function SftpView({
  sessionId,
  hostId,
  home,
  hostLabel,
  hideDotfiles,
  openEditMode,
  onDisconnect,
}: SftpViewProps) {
  const initialPath = normalizeFsPath(loadViewState(hostId, home).currentPath);
  const [currentPath, setCurrentPath] = useState<string>(initialPath);
  const [entries, setEntries] = useState<SftpEntry[]>(
    () => _entriesCache.get(entriesCacheKey(sessionId, initialPath)) ?? [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<TransferInfo | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [trackedOpen, setTrackedOpen] = useState<TrackedOpenFile[]>(
    () => loadViewState(hostId, home).trackedOpen,
  );
  const trackedRef = useRef<TrackedOpenFile[]>([]);
  const dropZoneRef = useRef<HTMLDivElement | null>(null);
  const currentPathRef = useRef(currentPath);
  const debouncersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    trackedRef.current = trackedOpen;
  }, [trackedOpen]);

  useEffect(
    () => () => {
      for (const h of debouncersRef.current.values()) clearTimeout(h);
      debouncersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  useEffect(() => {
    saveViewState(hostId, { currentPath, trackedOpen });
  }, [sessionId, hostId, currentPath, trackedOpen]);

  const load = useCallback(
    async (path: string) => {
      const pathNorm = normalizeFsPath(path);
      const cacheKey = entriesCacheKey(sessionId, pathNorm);
      const cached = _entriesCache.get(cacheKey);

      // Show cached entries immediately so the UI never blanks out.
      if (cached) {
        setEntries(cached);
        setCurrentPath(pathNorm);
      } else {
        // First time loading this path — show spinner.
        setLoading(true);
      }
      setError("");

      try {
        const list = await invoke<SftpEntry[]>("sftp_list", { sessionId, path: pathNorm });
        _entriesCache.set(cacheKey, list);
        setEntries(list);
        setCurrentPath(pathNorm);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    void load(currentPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const breadcrumbs = useMemo(() => segmentsOf(currentPath), [currentPath]);

  const visibleEntries = useMemo(() => {
    if (!hideDotfiles) return entries;
    return entries.filter((e) => !e.name.startsWith("."));
  }, [entries, hideDotfiles]);

  const uploadLocalToRemote = useCallback(
    async (localPath: string, remotePath: string, options?: { skipReload?: boolean }) => {
      setTransfer({ kind: "upload", name: localFilename(localPath) });
      setBusyPath(remotePath);
      try {
        await invoke<number>("sftp_upload", {
          sessionId,
          localPath,
          remotePath,
        });
        if (!options?.skipReload) {
          await load(currentPathRef.current);
        }
      } catch (e) {
        setError(String(e));
        throw e;
      } finally {
        setTransfer(null);
        setBusyPath(null);
      }
    },
    [sessionId, load],
  );

  const uploadLocalFile = useCallback(
    async (localPath: string, options?: { skipReload?: boolean }) => {
      const remotePath = joinPath(currentPathRef.current, localFilename(localPath));
      await uploadLocalToRemote(localPath, remotePath, options);
    },
    [uploadLocalToRemote],
  );

  const syncUploadAndRefreshBaseline = useCallback(
    async (t: TrackedOpenFile) => {
      await uploadLocalToRemote(t.localPath, t.remotePath, { skipReload: false });
      const meta = await invoke<{ mtime: number; size: number }>("file_metadata", { path: t.localPath });
      setTrackedOpen((prev) =>
        prev.map((x) =>
          x.id === t.id
            ? { ...x, editState: "synced" as const, baselineMtime: meta.mtime, baselineSize: meta.size }
            : x,
        ),
      );
    },
    [uploadLocalToRemote],
  );

  const dismissTracked = useCallback((id: string) => {
    const d = debouncersRef.current.get(id);
    if (d) {
      clearTimeout(d);
      debouncersRef.current.delete(id);
    }
    setTrackedOpen((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const applyAutoUploadDebounced = useCallback(
    (t: TrackedOpenFile) => {
      const existing = debouncersRef.current.get(t.id);
      if (existing) clearTimeout(existing);
      const handle = window.setTimeout(() => {
        debouncersRef.current.delete(t.id);
        void (async () => {
          const cur = trackedRef.current.find((x) => x.id === t.id);
          if (!cur || cur.editState === "uploading") return;
          setTrackedOpen((prev) => prev.map((x) => (x.id === t.id ? { ...x, editState: "uploading" } : x)));
          try {
            await syncUploadAndRefreshBaseline(cur);
          } catch {
            setTrackedOpen((prev) =>
              prev.map((x) => (x.id === t.id ? { ...x, editState: "modified" as const } : x)),
            );
          }
        })();
      }, AUTO_UPLOAD_DEBOUNCE_MS);
      debouncersRef.current.set(t.id, handle);
    },
    [syncUploadAndRefreshBaseline],
  );

  useEffect(() => {
    if (!isTauri() || trackedOpen.length === 0) return;
    const poll = window.setInterval(() => {
      const list = trackedRef.current;
      for (const t of list) {
        if (t.editState === "uploading") continue;
        void (async () => {
          const cur = trackedRef.current.find((x) => x.id === t.id);
          if (!cur || cur.editState === "uploading") return;
          try {
            const meta = await invoke<{ mtime: number; size: number }>("file_metadata", { path: cur.localPath });
            const changed = meta.mtime !== cur.baselineMtime || meta.size !== cur.baselineSize;
            if (!changed) return;

            if (openEditMode === "confirm") {
              setTrackedOpen((prev) =>
                prev.map((x) => (x.id === cur.id && x.editState === "synced" ? { ...x, editState: "modified" } : x)),
              );
              return;
            }
            if (cur.editState === "synced" && changed) {
              setTrackedOpen((prev) =>
                prev.map((x) => (x.id === cur.id ? { ...x, editState: "modified" } : x)),
              );
              applyAutoUploadDebounced({ ...cur, editState: "modified" });
              return;
            }
            if (cur.editState === "modified" && changed && !debouncersRef.current.has(cur.id)) {
              applyAutoUploadDebounced(cur);
            }
          } catch {
            setError("A watched file was removed or is no longer readable. It was removed from the list.");
            dismissTracked(t.id);
          }
        })();
      }
    }, 1500);
    return () => clearInterval(poll);
  }, [trackedOpen.length, openEditMode, applyAutoUploadDebounced, dismissTracked]);

  async function onSaveTracked(id: string) {
    const t = trackedRef.current.find((x) => x.id === id);
    if (!t) return;
    setTrackedOpen((prev) => prev.map((x) => (x.id === id ? { ...x, editState: "uploading" } : x)));
    try {
      await syncUploadAndRefreshBaseline(t);
    } catch {
      setTrackedOpen((prev) => prev.map((x) => (x.id === id ? { ...x, editState: "modified" as const } : x)));
    }
  }

  async function goUp() {
    await load(parentPath(currentPath));
  }

  async function goHome() {
    await load(home || "/");
  }

  async function onOpenEntry(entry: SftpEntry) {
    if (entry.is_dir) {
      await load(entry.path);
    }
  }

  async function onOpenFile(entry: SftpEntry) {
    if (entry.is_dir) {
      await load(entry.path);
      return;
    }
    if (!isTauri()) {
      setError("Opening files requires the desktop app.");
      return;
    }
    setError("");
    setTransfer({ kind: "open", name: entry.name });
    setBusyPath(entry.path);
    try {
      const tmp = await tempDir();
      const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const localPath = await join(tmp, `rsshu-sftp-open-${id}-${localFilename(entry.name)}`);
      await invoke<number>("sftp_download", {
        sessionId,
        remotePath: entry.path,
        localPath,
      });
      const meta = await invoke<{ mtime: number; size: number }>("file_metadata", { path: localPath });
      const trackId = id;
      setTrackedOpen((prev) => [
        ...prev,
        {
          id: trackId,
          name: entry.name,
          localPath,
          remotePath: entry.path,
          baselineMtime: meta.mtime,
          baselineSize: meta.size,
          editState: "synced",
        },
      ]);
      await openPath(localPath);
    } catch (e) {
      setError(String(e));
    } finally {
      setTransfer(null);
      setBusyPath(null);
    }
  }

  async function onDownload(entry: SftpEntry) {
    if (entry.is_dir) return;
    const destination = await saveDialog({
      title: `Download ${entry.name}`,
      defaultPath: entry.name,
    });
    if (!destination) return;
    setTransfer({ kind: "download", name: entry.name });
    setBusyPath(entry.path);
    try {
      await invoke<number>("sftp_download", {
        sessionId,
        remotePath: entry.path,
        localPath: destination,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setTransfer(null);
      setBusyPath(null);
    }
  }

  async function onUpload() {
    const selected = await openDialog({
      title: "Pick file to upload",
      multiple: false,
      directory: false,
    });
    if (!selected || Array.isArray(selected)) {
      if (!selected) return;
    }
    const localPath = Array.isArray(selected) ? selected[0] : selected;
    if (!localPath) return;
    try {
      await uploadLocalFile(localPath);
    } catch {
      // handled in uploadLocalFile
    }
  }

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const webview = getCurrentWebview();
      const w = getCurrentWindow();
      const scaleFactor = await w.scaleFactor();
      unlisten = await webview.onDragDropEvent((event) => {
        if (cancelled) return;
        const root = dropZoneRef.current;
        if (event.payload.type === "leave") {
          setDragOver(false);
          return;
        }
        if (event.payload.type === "enter" || event.payload.type === "over") {
          if (!root) {
            setDragOver(false);
            return;
          }
          const r = root.getBoundingClientRect();
          const lp = event.payload.position.toLogical(scaleFactor);
          setDragOver(pointInClientRect(lp.x, lp.y, r));
          return;
        }
        if (event.payload.type === "drop") {
          if (!root) {
            setDragOver(false);
            return;
          }
          const { paths } = event.payload;
          const r = root.getBoundingClientRect();
          const lp = event.payload.position.toLogical(scaleFactor);
          const inside = pointInClientRect(lp.x, lp.y, r);
          setDragOver(false);
          if (!inside) return;
          setError("");
          (async () => {
            for (const localPath of paths) {
              try {
                await uploadLocalFile(localPath, { skipReload: true });
              } catch {
                break;
              }
            }
            await load(currentPathRef.current);
          })();
        }
      });
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [uploadLocalFile, load]);

  async function onNewFolder() {
    const name = window.prompt("New folder name");
    if (!name) return;
    const path = joinPath(currentPath, name);
    try {
      await invoke("sftp_mkdir", { sessionId, path });
      await load(currentPath);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onRename(entry: SftpEntry) {
    const newName = window.prompt("New name", entry.name);
    if (newName == null || newName === "" || newName === entry.name) return;
    const to = joinPath(parentPath(entry.path), newName);
    setTransfer({ kind: "rename", name: entry.name });
    setBusyPath(entry.path);
    try {
      await invoke("sftp_rename", { sessionId, from: entry.path, to });
      await load(currentPath);
    } catch (e) {
      setError(String(e));
    } finally {
      setTransfer(null);
      setBusyPath(null);
    }
  }

  async function onDelete(entry: SftpEntry) {
    const confirmed = window.confirm(`Delete ${entry.name}?`);
    if (!confirmed) return;
    setBusyPath(entry.path);
    try {
      if (entry.is_dir) {
        await invoke("sftp_remove_dir", { sessionId, path: entry.path });
      } else {
        await invoke("sftp_remove_file", { sessionId, path: entry.path });
      }
      await load(currentPath);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyPath(null);
    }
  }

  async function navigateToSegment(idx: number) {
    const target = normalizeFsPath(`/${breadcrumbs.slice(0, idx + 1).join("/")}`);
    await load(target);
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-row">
      <div
        ref={dropZoneRef}
        className={`app-surface relative flex min-h-0 min-w-0 flex-1 flex-col ${
          dragOver ? "ring-2 ring-inset ring-[rgb(var(--app-accent)/0.5)]" : ""
        }`}
      >
        {dragOver ? (
          <div
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[rgb(var(--app-accent)/0.07)]"
            aria-hidden
          >
            <p className="app-banner-info rounded-md border bg-card/95 px-4 py-2 text-sm font-medium shadow-lg">
              Drop files to upload to this folder
            </p>
          </div>
        ) : null}
        <div className="app-sidebar flex items-center gap-2 border-b px-3 py-2">
          <Button size="sm" variant="ghost" onClick={() => void goHome()} title="Home">
            <HomeIcon className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void goUp()} title="Up">
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void load(currentPath)}
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <div className="app-chrome-border mx-1 h-5 w-px bg-[currentColor]" />
          <div className="app-text-muted flex min-w-0 flex-1 items-center overflow-x-auto text-xs">
            <button
              className="app-soft-hover rounded px-1.5 py-0.5"
              onClick={() => void load("/")}
            >
              /
            </button>
            {breadcrumbs.map((seg, idx) => (
              <span key={`${seg}-${idx}`} className="flex items-center">
                <ChevronRight className="app-icon-muted mx-0.5 h-3 w-3" />
                <button
                  className="app-soft-hover rounded px-1.5 py-0.5"
                  onClick={() => void navigateToSegment(idx)}
                >
                  {seg}
                </button>
              </span>
            ))}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="app-text-muted hidden text-xs md:inline">{hostLabel}</span>
            <Button size="sm" variant="outline" onClick={() => void onUpload()}>
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Upload
            </Button>
            <Button size="sm" variant="outline" onClick={() => void onNewFolder()}>
              <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
              New Folder
            </Button>
            <Button size="sm" variant="ghost" onClick={onDisconnect}>
              Disconnect
            </Button>
          </div>
        </div>

        {error ? (
          <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}

        {transfer ? (
          <div
            className="app-banner-info flex items-center gap-2 border-b px-3 py-1.5 text-xs"
            role="status"
          >
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            <span>
              {transfer.kind === "upload"
                ? "Uploading"
                : transfer.kind === "download"
                  ? "Downloading"
                  : transfer.kind === "open"
                    ? "Opening (downloading to temp file)"
                    : "Renaming"}
              : {transfer.name}
            </span>
          </div>
        ) : null}

        <div className="app-card app-soft app-text-muted grid grid-cols-[1fr_120px_200px_100px_120px] gap-x-2 border-b px-3 py-1.5 text-[10px] uppercase tracking-wider">
          <span>Name</span>
          <span className="text-right">Size</span>
          <span>Modified</span>
          <span>Perms</span>
          <span>Actions</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && entries.length === 0 ? (
            <div className="app-text-muted flex h-full items-center justify-center">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : null}

          {!loading && entries.length === 0 && !error ? (
            <div className="app-text-muted flex h-full items-center justify-center text-sm">
              Empty directory
            </div>
          ) : null}
          {!loading && entries.length > 0 && visibleEntries.length === 0 && !error ? (
            <div className="app-text-muted flex h-full items-center justify-center px-4 text-center text-sm">
              All items are hidden (names start with “.”). Change this in Settings.
            </div>
          ) : null}

          {visibleEntries.map((entry) => {
            const busy = busyPath === entry.path;
            return (
              <div
                key={entry.path}
                className="grid cursor-default grid-cols-[1fr_120px_200px_100px_120px] items-center gap-x-2 border-b border-border/40 px-3 py-1.5 text-xs transition app-soft-hover"
                onDoubleClick={() => void onOpenFile(entry)}
              >
                <div className="flex min-w-0 items-center gap-2 truncate">
                  {entry.is_dir ? (
                    <FolderIcon className="app-icon-accent h-4 w-4 shrink-0" />
                  ) : (
                    <FileIcon className="app-icon-muted h-4 w-4 shrink-0" />
                  )}
                  <button
                    type="button"
                    className="app-text-strong truncate text-left hover:app-accent-text"
                    onClick={() => void onOpenEntry(entry)}
                    title={entry.path}
                  >
                    {entry.name}
                    {entry.is_symlink ? <span className="app-text-muted ml-1">→</span> : null}
                  </button>
                </div>
                <span className="app-text-muted text-right">
                  {formatSize(entry.size, entry.is_dir)}
                </span>
                <span className="app-text-muted truncate">{formatMtime(entry.mtime)}</span>
                <span className="app-text-muted font-mono text-[11px]">
                  {(entry.perm & 0o777).toString(8).padStart(3, "0")}
                </span>
                <div
                  className="flex items-center justify-end gap-0.5"
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="app-icon-muted app-soft-hover rounded p-1 hover:text-amber-300"
                    onClick={() => void onRename(entry)}
                    disabled={busy}
                    title="Rename"
                  >
                    {busy && transfer?.kind === "rename" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Pencil className="h-3.5 w-3.5" />
                    )}
                  </button>
                  {!entry.is_dir ? (
                    <button
                      type="button"
                      className="app-icon-muted app-soft-hover rounded p-1 hover:text-foreground disabled:opacity-50"
                      onClick={() => void onDownload(entry)}
                      disabled={busy}
                      title="Download"
                    >
                      {busy && (transfer?.kind === "download" || transfer?.kind === "open") ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="app-icon-muted app-soft-hover rounded p-1 hover:text-rose-300"
                    onClick={() => void onDelete(entry)}
                    disabled={busy}
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {trackedOpen.length > 0 ? (
        <aside className="app-sidebar flex w-64 shrink-0 flex-col border-l">
          <div className="border-b border-border px-2 py-2">
            <p className="app-text-strong text-xs font-medium">External editor</p>
            <p className="app-text-muted mt-0.5 text-[10px] leading-snug">
              {openEditMode === "auto"
                ? "Saves to the server shortly after the file on disk changes."
                : "Click Save in this list to upload your edits to the server."}
            </p>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {trackedOpen.map((t) => (
              <li
                key={t.id}
                className="app-card app-soft app-text-muted mb-1.5 rounded-md p-1.5 text-[11px]"
              >
                <div className="flex items-start justify-between gap-1">
                  <span className="app-text-strong min-w-0 flex-1 truncate font-medium" title={t.name}>
                    {t.name}
                  </span>
                  <button
                    type="button"
                    className="app-icon-muted app-soft-hover shrink-0 rounded p-0.5"
                    onClick={() => dismissTracked(t.id)}
                    title="Remove from list"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <p className="app-text-muted mt-0.5 text-[10px]">
                  {t.editState === "uploading"
                    ? "Uploading…"
                    : t.editState === "modified"
                      ? "Modified (not on server yet)"
                      : "Synced with server"}
                </p>
                {openEditMode === "confirm" && t.editState === "modified" ? (
                  <Button
                    type="button"
                    size="sm"
                    className="mt-1.5 h-7 w-full text-[10px]"
                    onClick={() => void onSaveTracked(t.id)}
                  >
                    <Save className="mr-1 h-3 w-3" />
                    Save to server
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </aside>
      ) : null}
    </div>
  );
}
