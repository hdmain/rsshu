import { invoke } from "@tauri-apps/api/core";

type SessionRef = { tabId: string; sessionId: string };
type OutputListener = (text: string) => void;

const sessionBufferCache = new Map<string, string>();
const outputListeners = new Map<string, Set<OutputListener>>();

let pollTimer: ReturnType<typeof setInterval> | null = null;
let trackedSessions: SessionRef[] = [];
let onSessionLost: ((tabId: string, sessionId: string) => void) | null = null;

export function setShellSessionLostHandler(
  handler: ((tabId: string, sessionId: string) => void) | null,
): void {
  onSessionLost = handler;
}

export function syncShellSessionPoller(sessions: SessionRef[]): void {
  trackedSessions = sessions;
  if (sessions.length === 0) {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    return;
  }
  if (pollTimer !== null) return;

  pollTimer = setInterval(() => {
    for (const { tabId, sessionId } of trackedSessions) {
      void invoke<string[]>("ssh_read_output", { sessionId })
        .then((chunks) => {
          if (chunks.length === 0) return;
          const text = chunks.join("");
          const previous = sessionBufferCache.get(sessionId) ?? "";
          sessionBufferCache.set(sessionId, previous + text);
          outputListeners.get(sessionId)?.forEach((listener) => listener(text));
        })
        .catch(() => {
          onSessionLost?.(tabId, sessionId);
        });
    }
  }, 50);
}

export function getTerminalSessionBuffer(sessionId: string): string {
  return sessionBufferCache.get(sessionId) ?? "";
}

export function clearTerminalSessionCache(sessionId: string): void {
  sessionBufferCache.delete(sessionId);
  outputListeners.delete(sessionId);
}

export function subscribeTerminalSessionOutput(
  sessionId: string,
  listener: OutputListener,
): () => void {
  let listeners = outputListeners.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    outputListeners.set(sessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      outputListeners.delete(sessionId);
    }
  };
}
