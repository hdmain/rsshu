import { useCallback, useEffect, useRef, useState } from "react";
import { getTerminalTheme } from "@/lib/themes";
import { useTheme } from "@/lib/use-theme";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { setTerminalClipboardBridge } from "@/lib/terminal-clipboard-bridge";
import { loadTerminalFonts, preferWebglRenderer, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE } from "@/lib/terminal-fonts";
import {
  getTerminalSessionBuffer,
  subscribeTerminalSessionOutput,
} from "@/lib/shell-session-poller";
import {
  LinkConfirmModal,
  UploadConflictModal,
  suggestRename,
} from "@/components/confirm-modals";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { ImageAddon, IImageAddonOptions } from "@xterm/addon-image";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

export type TerminalKeywordSettings = {
  enabled: boolean;
  colors: {
    error: string;
    warning: string;
    ok: string;
    info: string;
    debug: string;
    network: string;
  };
};

export type TerminalUploadHost = {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
};

type TerminalViewProps = {
  tabId: string;
  sessionId: string | null;
  onDisconnected: (tabId: string, sessionId: string) => void;
  keywordSettings: TerminalKeywordSettings;
  /** Changes when surrounding chrome (e.g. host info bar) resizes the terminal pane. */
  layoutKey?: boolean;
  dragDropUploadEnabled?: boolean;
  uploadHost?: TerminalUploadHost | null;
};

type DropTransfer =
  | { kind: "probing" }
  | { kind: "uploading"; current: number; total: number; name: string }
  | { kind: "done"; ok: number; failed: number }
  | { kind: "error"; message: string };

type UploadConflictDecision =
  | { action: "cancel" }
  | { action: "replace" }
  | { action: "rename"; name: string };

type UploadConflictState = {
  fileName: string;
  renameValue: string;
  resolve: (decision: UploadConflictDecision) => void;
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return null;
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return { r, g, b };
}

function colorizeToken(text: string, token: string, colorHex: string) {
  const rgb = hexToRgb(colorHex);
  if (!rgb) return text;
  const re = new RegExp(token, "gi");
  return text.replace(re, (m) => `\u001b[38;2;${rgb.r};${rgb.g};${rgb.b}m${m}\u001b[0m`);
}

function highlightChunk(chunk: string, settings: TerminalKeywordSettings) {
  if (!settings.enabled) return chunk;
  let out = chunk;
  out = colorizeToken(out, "\\b(error|failed|fatal|exception)\\b", settings.colors.error);
  out = colorizeToken(out, "\\b(warning|warn|deprecated)\\b", settings.colors.warning);
  out = colorizeToken(out, "\\b(ok|success|connected|ready)\\b", settings.colors.ok);
  out = colorizeToken(out, "\\b(info|notice)\\b", settings.colors.info);
  out = colorizeToken(out, "\\b(debug|trace|verbose)\\b", settings.colors.debug);
  out = colorizeToken(
    out,
    "(\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b|\\b[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}\\b)",
    settings.colors.network,
  );
  return out;
}

function fitTerminal(term: Terminal, fitAddon: FitAddon, host: HTMLElement): { cols: number; rows: number } | null {
  fitAddon.fit();
  const xtermEl = host.querySelector(".xterm") as HTMLElement | null;
  if (xtermEl) {
    let cols = term.cols;
    let rows = term.rows;
    while (rows > 1 && xtermEl.offsetHeight > host.clientHeight + 1) {
      rows -= 1;
      term.resize(cols, rows);
    }
  }
  term.scrollToBottom();
  term.refresh(0, term.rows - 1);
  if (term.cols > 0 && term.rows > 0) {
    return { cols: term.cols, rows: term.rows };
  }
  return null;
}

function relayoutTerminal(term: Terminal, fitAddon: FitAddon, host: HTMLElement): void {
  const family = term.options.fontFamily;
  term.options.fontFamily = "monospace";
  term.options.fontFamily = family;
  fitTerminal(term, fitAddon, host);
}

function localFilename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function joinRemotePath(base: string, name: string): string {
  const file = name.replace(/^\/+/, "");
  if (!file) return base || "/";
  const b = (base || "/").replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  if (b === "/") return `/${file}`;
  return `${b}/${file}`;
}

function parseOsc7Path(data: string): string | null {
  const trimmed = data.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("file://")) {
    try {
      const url = new URL(trimmed);
      const path = decodeURIComponent(url.pathname || "");
      return path || "/";
    } catch {
      const withoutScheme = trimmed.slice("file://".length);
      const slash = withoutScheme.indexOf("/");
      if (slash < 0) return null;
      try {
        return decodeURIComponent(withoutScheme.slice(slash)) || "/";
      } catch {
        return withoutScheme.slice(slash) || "/";
      }
    }
  }
  if (trimmed.startsWith("/")) return trimmed;
  return null;
}

/** Pull OSC 7 paths out of raw PTY output (BEL or ST terminated). */
function consumeOsc7Paths(chunk: string): string[] {
  const paths: string[] = [];
  const re = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(chunk)) !== null) {
    const path = parseOsc7Path(match[1] ?? "");
    if (path) paths.push(path);
  }
  return paths;
}

function expandRemoteHomePath(path: string, home: string): string {
  const h = home.replace(/\/+$/, "") || "/";
  if (path === "~") return h || "/";
  if (path.startsWith("~/")) {
    const rest = path.slice(2).replace(/^\/+/, "");
    return rest ? `${h}/${rest}` : h;
  }
  return path;
}

/** Parse classic bash/zsh prompts like `root@debian:~/browser#` or `user@host:/var/www$`. */
function parseCwdFromPromptLine(line: string): string | null {
  const trimmed = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
  if (!trimmed) return null;
  const match = trimmed.match(/:((?:~\/|~|\/)[^#$\s]*)\s*[#$>]\s*$/);
  if (!match?.[1]) return null;
  return match[1];
}

function readCwdFromTerminal(term: Terminal): string | null {
  const buf = term.buffer.active;
  const end = buf.baseY + buf.cursorY;
  const start = Math.max(0, end - 10);
  for (let y = end; y >= start; y -= 1) {
    const line = buf.getLine(y)?.translateToString(true) ?? "";
    const cwd = parseCwdFromPromptLine(line);
    if (cwd) return cwd;
  }
  return null;
}

function pointInClientRect(x: number, y: number, r: DOMRect): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

export function TerminalView({
  tabId,
  sessionId,
  onDisconnected,
  keywordSettings,
  layoutKey,
  dragDropUploadEnabled = true,
  uploadHost = null,
}: TerminalViewProps) {
  const { themeId } = useTheme();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const suppressNextPasteEventRef = useRef(false);
  const suppressPasteResetTimerRef = useRef<number | null>(null);
  const lastClipboardPayloadRef = useRef<string>("");
  const lastClipboardAtRef = useRef(0);
  const remoteCwdRef = useRef<string | null>(null);
  const cwdWaitersRef = useRef<Array<(cwd: string | null) => void>>([]);
  const suppressProbeOutputRef = useRef(false);
  const uploadHostRef = useRef(uploadHost);
  const dragDropEnabledRef = useRef(dragDropUploadEnabled);
  const uploadingRef = useRef(false);
  const pendingLinkHandlerRef = useRef<(url: string) => void>(() => {});
  const [terminalReady, setTerminalReady] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [dropTransfer, setDropTransfer] = useState<DropTransfer | null>(null);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [uploadConflict, setUploadConflict] = useState<UploadConflictState | null>(null);

  uploadHostRef.current = uploadHost;
  dragDropEnabledRef.current = dragDropUploadEnabled;
  pendingLinkHandlerRef.current = (url: string) => setPendingLink(url);

  const askUploadConflict = useCallback((fileName: string) => {
    return new Promise<UploadConflictDecision>((resolve) => {
      setUploadConflict({
        fileName,
        renameValue: suggestRename(fileName),
        resolve,
      });
    });
  }, []);

  const resolveUploadConflict = useCallback((decision: UploadConflictDecision) => {
    setUploadConflict((prev) => {
      prev?.resolve(decision);
      return null;
    });
  }, []);

  const noteRemoteCwd = useCallback((cwd: string) => {
    remoteCwdRef.current = cwd;
    const waiters = cwdWaitersRef.current.splice(0);
    for (const resolve of waiters) resolve(cwd);
  }, []);

  const ingestOutputChunk = useCallback(
    (chunk: string) => {
      for (const path of consumeOsc7Paths(chunk)) {
        noteRemoteCwd(path);
      }
    },
    [noteRemoteCwd],
  );

  const probeRemoteCwd = useCallback(async (activeSessionId: string): Promise<string | null> => {
    const term = terminalRef.current;
    if (term) {
      const fromPrompt = readCwdFromTerminal(term);
      if (fromPrompt) {
        remoteCwdRef.current = fromPrompt;
        return fromPrompt;
      }
    }

    suppressProbeOutputRef.current = true;
    try {
      const probed = await new Promise<string | null>((resolve) => {
        const timer = window.setTimeout(() => {
          const idx = cwdWaitersRef.current.indexOf(onCwd);
          if (idx >= 0) cwdWaitersRef.current.splice(idx, 1);
          resolve(null);
        }, 1800);
        function onCwd(cwd: string | null) {
          window.clearTimeout(timer);
          resolve(cwd);
        }
        cwdWaitersRef.current.push(onCwd);
        // Space prefix avoids bash history when HISTCONTROL=ignorespace.
        // Output is suppressed locally so the command never appears in the terminal.
        const probe =
          "\u0015 printf '\\033]7;file://localhost%s\\033\\\\' \"$(pwd)\"\r";
        void invoke("ssh_send_input", { sessionId: activeSessionId, input: probe }).catch(() => {
          window.clearTimeout(timer);
          const idx = cwdWaitersRef.current.indexOf(onCwd);
          if (idx >= 0) cwdWaitersRef.current.splice(idx, 1);
          resolve(null);
        });
      });
      return probed ?? remoteCwdRef.current;
    } finally {
      // Let any late echo chunks settle, then show output again.
      window.setTimeout(() => {
        suppressProbeOutputRef.current = false;
      }, 120);
    }
  }, []);

  const resolveUploadDir = useCallback(
    async (activeSessionId: string, home: string): Promise<string> => {
      const raw = (await probeRemoteCwd(activeSessionId)) ?? remoteCwdRef.current;
      if (!raw) return home || "/";
      return expandRemoteHomePath(raw, home || "/");
    },
    [probeRemoteCwd],
  );

  const uploadDroppedFiles = useCallback(
    async (paths: string[]) => {
      if (uploadingRef.current) return;
      const host = uploadHostRef.current;
      const activeSessionId = activeSessionIdRef.current;
      if (!host || !activeSessionId || paths.length === 0) return;

      uploadingRef.current = true;
      setDropTransfer({ kind: "probing" });
      let sftpSessionId: string | null = null;
      let ok = 0;
      let failed = 0;
      try {
        const connected = await invoke<{ session_id: string; home: string }>("sftp_connect", {
          req: {
            host: host.host,
            port: host.port,
            username: host.username,
            password: host.password,
            privateKey: host.privateKey,
            passphrase: host.passphrase,
          },
        });
        sftpSessionId = connected.session_id;
        const targetDir = await resolveUploadDir(activeSessionId, connected.home || "/");

        for (let i = 0; i < paths.length; i += 1) {
          const localPath = paths[i]!;
          const name = localFilename(localPath);
          if (!name) {
            failed += 1;
            continue;
          }
          setDropTransfer({ kind: "uploading", current: i + 1, total: paths.length, name });
          let remoteName = name;
          let remotePath = joinRemotePath(targetDir, remoteName);
          try {
            const exists = await invoke<boolean>("sftp_exists", {
              sessionId: sftpSessionId,
              path: remotePath,
            });
            if (exists) {
              const decision = await askUploadConflict(remoteName);
              if (decision.action === "cancel") {
                continue;
              }
              if (decision.action === "rename") {
                remoteName = decision.name.trim() || suggestRename(name);
                remotePath = joinRemotePath(targetDir, remoteName);
              }
            }
            await invoke<number>("sftp_upload", {
              sessionId: sftpSessionId,
              localPath,
              remotePath,
            });
            ok += 1;
          } catch {
            failed += 1;
          }
          // Yield to the UI thread between files so the terminal stays interactive.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
        setDropTransfer({ kind: "done", ok, failed });
      } catch (err) {
        setDropTransfer({ kind: "error", message: String(err) });
      } finally {
        suppressProbeOutputRef.current = false;
        if (sftpSessionId) {
          try {
            await invoke("sftp_disconnect", { sessionId: sftpSessionId });
          } catch {
            // best-effort
          }
        }
        uploadingRef.current = false;
        window.setTimeout(() => setDropTransfer(null), 2800);
      }
    },
    [resolveUploadDir, askUploadConflict],
  );

  useEffect(() => {
    const term = terminalRef.current;
    const host = hostRef.current;
    if (!term) return;
    const apply = () => {
      const theme = getTerminalTheme(themeId);
      term.options.theme = theme;
      host?.style.setProperty("--xterm-bg", theme.background ?? "#050912");
    };
    apply();
    window.addEventListener("themechange", apply);
    return () => window.removeEventListener("themechange", apply);
  }, [themeId]);

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    let disposed = false;
    const cleanupRef = { current: null as (() => void) | null };

    void (async () => {
      await loadTerminalFonts();
      if (disposed || !hostRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        convertEol: true,
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: TERMINAL_FONT_SIZE,
        lineHeight: 1,
        letterSpacing: 0,
        scrollback: 10000,
        allowTransparency: false,
        minimumContrastRatio: 1,
        theme: getTerminalTheme(themeId),
      });
      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon((_event, uri) => {
        pendingLinkHandlerRef.current(uri);
      });
      const imageOptions: IImageAddonOptions = {
        enableSizeReports: true,
        pixelLimit: 16777216,
        storageLimit: 256,
        sixelSupport: true,
        sixelScrolling: true,
        sixelPaletteLimit: 256,
        iipSupport: true,
      };
      const imageAddon = new ImageAddon(imageOptions);
      const unicode11Addon = new Unicode11Addon();

      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.loadAddon(imageAddon);
      try {
        term.loadAddon(unicode11Addon);
        term.unicode.activeVersion = "11";
      } catch {
        // Unicode11 is optional — terminal still works without it.
      }
      term.open(host);

      try {
        term.parser.registerOscHandler(7, (data) => {
          const path = parseOsc7Path(data);
          if (path) noteRemoteCwd(path);
          return true;
        });
      } catch {
        // OSC handler optional
      }

      const sendClipboardToPty = (text: string) => {
        const activeSessionId = activeSessionIdRef.current;
        if (!activeSessionId || !text) return;
        const now = Date.now();
        if (text === lastClipboardPayloadRef.current && now - lastClipboardAtRef.current < 400) {
          return;
        }
        lastClipboardPayloadRef.current = text;
        lastClipboardAtRef.current = now;
        void invoke("ssh_send_input", { sessionId: activeSessionId, input: text });
      };

      term.attachCustomKeyEventHandler((e) => {
        const key = e.key.toLowerCase();
        const isCtrlPaste = e.ctrlKey && !e.shiftKey && !e.altKey && key === "v";
        const isShiftInsertPaste = e.shiftKey && !e.ctrlKey && !e.altKey && e.key === "Insert";
        if (!isCtrlPaste && !isShiftInsertPaste) return true;
        e.preventDefault();
        e.stopPropagation();
        suppressNextPasteEventRef.current = true;
        if (suppressPasteResetTimerRef.current) {
          window.clearTimeout(suppressPasteResetTimerRef.current);
        }
        suppressPasteResetTimerRef.current = window.setTimeout(() => {
          suppressNextPasteEventRef.current = false;
          suppressPasteResetTimerRef.current = null;
        }, 1000);
        void readText()
          .then((text) => sendClipboardToPty(text))
          .catch(() => {
            // ignore
          });
        return false;
      });

      const onPaste = (event: ClipboardEvent) => {
        const activeSessionId = activeSessionIdRef.current;
        if (!activeSessionId) return;
        event.preventDefault();
        event.stopPropagation();
        if (suppressNextPasteEventRef.current) {
          suppressNextPasteEventRef.current = false;
          if (suppressPasteResetTimerRef.current) {
            window.clearTimeout(suppressPasteResetTimerRef.current);
            suppressPasteResetTimerRef.current = null;
          }
          return;
        }
        const text = event.clipboardData?.getData("text");
        if (text) {
          sendClipboardToPty(text);
          return;
        }
        void readText()
          .then((fallbackText) => {
            if (fallbackText) sendClipboardToPty(fallbackText);
          })
          .catch(() => {
            // ignore
          });
      };
      host.addEventListener("paste", onPaste, { capture: true });

      let webglAddon: WebglAddon | null = null;

      const safeFit = () => {
        try {
          const dims = fitTerminal(term, fitAddon, host);
          if (!dims) return;
          const last = lastSizeRef.current;
          const activeSessionId = activeSessionIdRef.current;
          if (
            activeSessionId &&
            (!last || last.cols !== dims.cols || last.rows !== dims.rows)
          ) {
            lastSizeRef.current = dims;
            void invoke("ssh_resize_pty", {
              sessionId: activeSessionId,
              cols: dims.cols,
              rows: dims.rows,
            });
          }
        } catch {
          // Container may momentarily have 0 size during layout transitions.
        }
      };

      safeFit();

      if (preferWebglRenderer()) {
        try {
          webglAddon = new WebglAddon();
          webglAddon.onContextLoss(() => {
            webglAddon?.dispose();
            webglAddon = null;
          });
          term.loadAddon(webglAddon);
          relayoutTerminal(term, fitAddon, host);
          safeFit();
        } catch {
          // GPU unavailable — DOM renderer will be used automatically.
        }
      }

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;
      setTerminalReady(true);

      setTerminalClipboardBridge({
        term,
        hasSession: () => activeSessionIdRef.current != null,
        sendToPty: (data) => {
          const id = activeSessionIdRef.current;
          if (!id) return;
          void invoke("ssh_send_input", { sessionId: id, input: data });
        },
      });

      let resizeRaf = 0;
      const scheduleFit = () => {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          safeFit();
          requestAnimationFrame(() => safeFit());
        });
      };

      const onResize = () => scheduleFit();
      window.addEventListener("resize", onResize);

      let observer: ResizeObserver | null = null;
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => scheduleFit());
        observer.observe(host);
        if (wrapperRef.current) {
          observer.observe(wrapperRef.current);
        }
      }

      cleanupRef.current = () => {
        host.removeEventListener("paste", onPaste, { capture: true });
        if (suppressPasteResetTimerRef.current) {
          window.clearTimeout(suppressPasteResetTimerRef.current);
          suppressPasteResetTimerRef.current = null;
        }
        setTerminalClipboardBridge(null);
        cancelAnimationFrame(resizeRaf);
        window.removeEventListener("resize", onResize);
        observer?.disconnect();
        unicode11Addon.dispose();
        webglAddon?.dispose();
        term.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        setTerminalReady(false);
      };
    })();

    return () => {
      disposed = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [noteRemoteCwd]);

  useEffect(() => {
    if (!terminalReady) return;
    const term = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const host = hostRef.current;
    if (!term || !fitAddon || !host) return;
    try {
      const dims = fitTerminal(term, fitAddon, host);
      const activeSessionId = activeSessionIdRef.current;
      const last = lastSizeRef.current;
      if (
        activeSessionId &&
        dims &&
        (!last || last.cols !== dims.cols || last.rows !== dims.rows)
      ) {
        lastSizeRef.current = dims;
        void invoke("ssh_resize_pty", {
          sessionId: activeSessionId,
          cols: dims.cols,
          rows: dims.rows,
        });
      }
    } catch {
      // ignore transient sizing race
    }
  }, [terminalReady, layoutKey]);

  useEffect(() => {
    if (!terminalReady) return;
    const term = terminalRef.current;
    if (!term) return;
    activeSessionIdRef.current = sessionId;
    remoteCwdRef.current = null;
    if (!sessionId) {
      lastSizeRef.current = null;
      term.clear();
      term.write("\x1b[90mNo active session.\x1b[0m\r\n");
      return;
    }

    const fitAddon = fitAddonRef.current;
    const host = hostRef.current;
    if (fitAddon && host) {
      try {
        const dims = fitTerminal(term, fitAddon, host);
        if (dims) {
          lastSizeRef.current = dims;
          void invoke("ssh_resize_pty", { sessionId, cols: dims.cols, rows: dims.rows });
        }
      } catch {
        // ignore transient sizing race
      }
    }

    term.clear();
    const cached = getTerminalSessionBuffer(sessionId);
    if (cached) {
      ingestOutputChunk(cached);
      term.write(highlightChunk(cached, keywordSettings));
    }
    term.scrollToBottom();

    const disposeInput = term.onData((data) => {
      void invoke("ssh_send_input", { sessionId, input: data }).catch(() => {
        onDisconnected(tabId, sessionId);
      });
    });

    const unsubscribeOutput = subscribeTerminalSessionOutput(sessionId, (chunk) => {
      ingestOutputChunk(chunk);
      if (suppressProbeOutputRef.current) {
        return;
      }
      term.write(highlightChunk(chunk, keywordSettings));
      const buffer = term.buffer.active;
      if (buffer.baseY + term.rows >= buffer.length) {
        term.scrollToBottom();
      }
    });

    return () => {
      disposeInput.dispose();
      unsubscribeOutput();
    };
  }, [terminalReady, sessionId, tabId, onDisconnected, keywordSettings, ingestOutputChunk]);

  useEffect(() => {
    if (!isTauri() || !dragDropUploadEnabled || !uploadHost || !sessionId) {
      setDragOver(false);
      return;
    }
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const webview = getCurrentWebview();
      const w = getCurrentWindow();
      const scaleFactor = await w.scaleFactor();
      unlisten = await webview.onDragDropEvent((event) => {
        if (cancelled || !dragDropEnabledRef.current) return;
        const root = wrapperRef.current;
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
          if (!inside || paths.length === 0) return;
          void uploadDroppedFiles(paths);
        }
      });
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [dragDropUploadEnabled, uploadHost, sessionId, uploadDroppedFiles]);

  return (
    <div
      ref={wrapperRef}
      className={`app-surface relative flex h-full min-h-0 w-full flex-1 px-3 py-2 ${
        dragOver ? "ring-2 ring-inset ring-[rgb(var(--app-accent)/0.55)]" : ""
      }`}
    >
      <div ref={hostRef} className="h-full min-h-0 w-full overflow-hidden" />
      {dragOver ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[rgb(var(--app-accent)/0.08)]">
          <div className="app-panel rounded-md border px-4 py-3 text-sm shadow-lg">
            Drop files to upload into the current remote folder
          </div>
        </div>
      ) : null}
      {dropTransfer ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
          <div className="app-panel rounded-md border px-3 py-2 text-xs shadow-lg">
            {dropTransfer.kind === "probing" ? "Detecting remote folder…" : null}
            {dropTransfer.kind === "uploading"
              ? `Uploading ${dropTransfer.current}/${dropTransfer.total}: ${dropTransfer.name}`
              : null}
            {dropTransfer.kind === "done"
              ? dropTransfer.failed > 0
                ? `Uploaded ${dropTransfer.ok}, failed ${dropTransfer.failed}`
                : `Uploaded ${dropTransfer.ok} file${dropTransfer.ok === 1 ? "" : "s"}`
              : null}
            {dropTransfer.kind === "error" ? (
              <span className="text-destructive">{dropTransfer.message}</span>
            ) : null}
          </div>
        </div>
      ) : null}
      {pendingLink ? (
        <LinkConfirmModal
          url={pendingLink}
          onCancel={() => setPendingLink(null)}
          onOpen={() => {
            const url = pendingLink;
            setPendingLink(null);
            void openUrl(url).catch(() => {
              // ignore
            });
          }}
        />
      ) : null}
      {uploadConflict ? (
        <UploadConflictModal
          fileName={uploadConflict.fileName}
          renameValue={uploadConflict.renameValue}
          onRenameValueChange={(value) =>
            setUploadConflict((prev) => (prev ? { ...prev, renameValue: value } : prev))
          }
          onCancel={() => resolveUploadConflict({ action: "cancel" })}
          onReplace={() => resolveUploadConflict({ action: "replace" })}
          onRename={() =>
            resolveUploadConflict({
              action: "rename",
              name: uploadConflict.renameValue.trim(),
            })
          }
        />
      ) : null}
    </div>
  );
}
