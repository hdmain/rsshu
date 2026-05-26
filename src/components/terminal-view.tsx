import { useEffect, useRef } from "react";
import { getTerminalTheme } from "@/lib/themes";
import { useTheme } from "@/lib/use-theme";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { setTerminalClipboardBridge } from "@/lib/terminal-clipboard-bridge";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { ImageAddon, IImageAddonOptions } from "@xterm/addon-image";
import "@xterm/xterm/css/xterm.css";

const sessionBufferCache = new Map<string, string>();

export function clearTerminalSessionCache(sessionId: string) {
  sessionBufferCache.delete(sessionId);
}

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
  onDisconnected: (tabId: string) => void;
  keywordSettings: TerminalKeywordSettings;
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

export function TerminalView({ tabId, sessionId, onDisconnected, keywordSettings }: TerminalViewProps) {
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

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    const apply = () => {
      term.options.theme = getTerminalTheme(themeId);
    };
    apply();
    window.addEventListener("themechange", apply);
    return () => window.removeEventListener("themechange", apply);
  }, [themeId]);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      convertEol: true,
      fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      scrollback: 10000,
      allowTransparency: false, // must be false for WebGL renderer
      // Ensure the internal canvas matches the physical pixel grid — this is
      // what makes Terminus look sharper. xterm reads window.devicePixelRatio
      // automatically when the WebGL renderer is active, but we also help the
      // DOM fallback by not artificially squashing the canvas.
      // Disable minimum contrast ratio enforcement so colors render exactly
      // as the application sends them (matches Terminus default behaviour).
      minimumContrastRatio: 1,
      theme: getTerminalTheme(themeId),
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      // Open URLs emitted by terminal output in the system browser.
      void openUrl(uri);
    });

    // Image protocol support (sixel + iTerm2 inline images).
    const imageOptions: IImageAddonOptions = {
      enableSizeReports: true,
      pixelLimit: 16777216, // 16 MiB — allows large sixel/kitty images
      storageLimit: 256,    // 256 MB image cache
      sixelSupport: true,
      sixelScrolling: true,
      sixelPaletteLimit: 256,
      iipSupport: true,     // iTerm2 inline image protocol
    };
    const imageAddon = new ImageAddon(imageOptions);

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(imageAddon);
    term.open(hostRef.current);

    const sendClipboardToPty = (text: string) => {
      const activeSessionId = activeSessionIdRef.current;
      if (!activeSessionId || !text) return;
      const now = Date.now();
      // Guard against duplicate browser/terminal paste paths firing together.
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
    hostRef.current.addEventListener("paste", onPaste, { capture: true });

    // WebGL renderer — GPU-accelerated, sharpest text + graphics.
    // Falls back silently if WebGL is unavailable (e.g. in software rendering).
    let webglAddon: WebglAddon | null = null;
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        // Context lost (e.g. GPU driver reset). Dispose and fall back to DOM.
        webglAddon?.dispose();
        webglAddon = null;
      });
      term.loadAddon(webglAddon);
    } catch {
      // GPU unavailable — DOM renderer will be used automatically.
    }

    const safeFit = () => {
      try {
        fitAddon.fit();
        const cols = term.cols;
        const rows = term.rows;
        const last = lastSizeRef.current;
        const activeSessionId = activeSessionIdRef.current;
        if (activeSessionId && cols > 0 && rows > 0 && (!last || last.cols !== cols || last.rows !== rows)) {
          lastSizeRef.current = { cols, rows };
          void invoke("ssh_resize_pty", { sessionId: activeSessionId, cols, rows });
        }
      } catch {
        // Container may momentarily have 0 size during layout transitions.
      }
    };

    safeFit();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    setTerminalClipboardBridge({
      term,
      hasSession: () => activeSessionIdRef.current != null,
      sendToPty: (data) => {
        const id = activeSessionIdRef.current;
        if (!id) return;
        void invoke("ssh_send_input", { sessionId: id, input: data });
      },
    });

    const onResize = () => safeFit();
    window.addEventListener("resize", onResize);

    let observer: ResizeObserver | null = null;
    if (wrapperRef.current && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => safeFit());
      observer.observe(wrapperRef.current);
    }

    return () => {
      hostRef.current?.removeEventListener("paste", onPaste, { capture: true });
      if (suppressPasteResetTimerRef.current) {
        window.clearTimeout(suppressPasteResetTimerRef.current);
        suppressPasteResetTimerRef.current = null;
      }
      setTerminalClipboardBridge(null);
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      webglAddon?.dispose();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
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
    if (fitAddon) {
      try {
        fitAddon.fit();
        if (term.cols > 0 && term.rows > 0) {
          lastSizeRef.current = { cols: term.cols, rows: term.rows };
          void invoke("ssh_resize_pty", { sessionId, cols: term.cols, rows: term.rows });
        }
      } catch {
        // ignore transient sizing race
      }
    }

    term.clear();
    const cached = sessionBufferCache.get(sessionId);
    if (cached) {
      term.write(cached);
    }

    const disposeInput = term.onData((data) => {
      void invoke("ssh_send_input", { sessionId, input: data }).catch(() => {
        onDisconnected(tabId);
      });
    });

    let outputRaf = 0;
    let pendingOutput = "";
    const flushOutput = () => {
      outputRaf = 0;
      if (!pendingOutput) return;
      const highlighted = highlightChunk(pendingOutput, keywordSettings);
      pendingOutput = "";
      const previous = sessionBufferCache.get(sessionId) ?? "";
      sessionBufferCache.set(sessionId, previous + highlighted);
      term.write(highlighted);
    };

    const timer = window.setInterval(() => {
      void invoke<string[]>("ssh_read_output", { sessionId })
        .then((chunks) => {
          if (chunks.length === 0) return;
          for (const chunk of chunks) {
            pendingOutput += chunk;
          }
          if (!outputRaf) {
            outputRaf = window.requestAnimationFrame(flushOutput);
          }
        })
        .catch(() => {
          onDisconnected(tabId);
        });
    }, 50);

    return () => {
      disposeInput.dispose();
      window.clearInterval(timer);
      if (outputRaf) {
        window.cancelAnimationFrame(outputRaf);
      }
    };
  }, [sessionId, tabId, onDisconnected, keywordSettings]);

  return (
    <div
      ref={wrapperRef}
      className="app-surface relative flex h-full w-full flex-1"
    >
      <div ref={hostRef} className="h-full w-full px-3 py-2" />
    </div>
  );
}
