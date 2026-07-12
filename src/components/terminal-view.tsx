import { useEffect, useRef, useState } from "react";
import { getTerminalTheme } from "@/lib/themes";
import { useTheme } from "@/lib/use-theme";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { setTerminalClipboardBridge } from "@/lib/terminal-clipboard-bridge";
import { loadTerminalFonts, preferWebglRenderer, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE } from "@/lib/terminal-fonts";
import {
  getTerminalSessionBuffer,
  subscribeTerminalSessionOutput,
} from "@/lib/shell-session-poller";
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

type TerminalViewProps = {
  tabId: string;
  sessionId: string | null;
  onDisconnected: (tabId: string, sessionId: string) => void;
  keywordSettings: TerminalKeywordSettings;
  /** Changes when surrounding chrome (e.g. host info bar) resizes the terminal pane. */
  layoutKey?: boolean;
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
    // FitAddon uses clientHeight which includes padding on the host; trim rows until
    // the canvas fits so the live prompt row is not clipped under chrome below.
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

export function TerminalView({
  tabId,
  sessionId,
  onDisconnected,
  keywordSettings,
  layoutKey,
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
  const [terminalReady, setTerminalReady] = useState(false);

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
        void openUrl(uri);
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
  }, []);

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
      term.write(highlightChunk(cached, keywordSettings));
    }
    term.scrollToBottom();

    const disposeInput = term.onData((data) => {
      void invoke("ssh_send_input", { sessionId, input: data }).catch(() => {
        onDisconnected(tabId, sessionId);
      });
    });

    const unsubscribeOutput = subscribeTerminalSessionOutput(sessionId, (chunk) => {
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
  }, [terminalReady, sessionId, tabId, onDisconnected, keywordSettings]);

  return (
    <div
      ref={wrapperRef}
      className="app-surface relative flex h-full min-h-0 w-full flex-1 px-3 py-2"
    >
      <div ref={hostRef} className="h-full min-h-0 w-full overflow-hidden" />
    </div>
  );
}
