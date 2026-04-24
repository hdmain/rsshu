import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { setTerminalClipboardBridge } from "@/lib/terminal-clipboard-bridge";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
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
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 10000,
      allowTransparency: true,
      theme: {
        background: "#050912",
        foreground: "#e2e8f0",
        cursor: "#38bdf8",
        cursorAccent: "#050912",
        selectionBackground: "#1e3a5f",
        black: "#0b1120",
        red: "#f87171",
        green: "#34d399",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e2e8f0",
        brightBlack: "#475569",
        brightRed: "#fca5a5",
        brightGreen: "#6ee7b7",
        brightYellow: "#fcd34d",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#f8fafc",
      },
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      // Open URLs emitted by terminal output in the system browser.
      void openUrl(uri);
    });
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(hostRef.current);

    term.attachCustomKeyEventHandler(async (e) => {
      if (e.ctrlKey && e.key === 'v') {
        e.preventDefault();
        try {
          const text = await readText();
          term.paste(text);
        } catch {
          // ignore
        }
        return false;
      }
      return true;
    });

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
      setTerminalClipboardBridge(null);
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
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

    const disposeInput = term.onData(async (data) => {
      try {
        await invoke("ssh_send_input", { sessionId, input: data });
      } catch {
        onDisconnected(tabId);
      }
    });

    const timer = window.setInterval(async () => {
      try {
        const chunks = await invoke<string[]>("ssh_read_output", { sessionId });
        for (const chunk of chunks) {
          const highlighted = highlightChunk(chunk, keywordSettings);
          const previous = sessionBufferCache.get(sessionId) ?? "";
          sessionBufferCache.set(sessionId, previous + highlighted);
          term.write(highlighted);
        }
      } catch {
        onDisconnected(tabId);
      }
    }, 50);

    return () => {
      disposeInput.dispose();
      window.clearInterval(timer);
    };
  }, [sessionId, tabId, onDisconnected, keywordSettings]);

  return (
    <div
      ref={wrapperRef}
      className="relative flex h-full w-full flex-1 bg-[#050912]"
    >
      <div ref={hostRef} className="h-full w-full px-3 py-2" />
    </div>
  );
}
