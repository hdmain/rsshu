import type { Terminal } from "@xterm/xterm";

export type TerminalClipboardBridge = {
  term: Terminal;
  sendToPty: (data: string) => void;
  hasSession: () => boolean;
};

let bridge: TerminalClipboardBridge | null = null;

export function setTerminalClipboardBridge(b: TerminalClipboardBridge | null) {
  bridge = b;
}

export function getTerminalClipboardBridge() {
  return bridge;
}
