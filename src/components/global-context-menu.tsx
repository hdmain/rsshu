import { useCallback, useEffect, useState } from "react";
import { getTerminalClipboardBridge } from "@/lib/terminal-clipboard-bridge";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

type FieldTarget = HTMLInputElement | HTMLTextAreaElement;

type MenuState = { x: number; y: number; kind: "xterm" } | { x: number; y: number; kind: "field"; el: FieldTarget } | null;

function isTextLikeInput(field: FieldTarget) {
  if (field instanceof HTMLTextAreaElement) return true;
  if (!(field instanceof HTMLInputElement)) return false;
  const t = field.type;
  return t === "text" || t === "search" || t === "url" || t === "tel" || t === "email" || t === "password" || t === "number" || t === "";
}

function replaceRange(el: FieldTarget, start: number, end: number, insert: string) {
  const val = el.value;
  const next = val.slice(0, start) + insert + val.slice(end);
  el.value = next;
  const pos = start + insert.length;
  el.setSelectionRange(pos, pos);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function GlobalContextMenu() {
  const [menu, setMenu] = useState<MenuState>(null);

  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const n = e.target;
      if (!(n instanceof Node)) return;
      const el = (n as HTMLElement).closest?.(".xterm");
      if (el) {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, kind: "xterm" });
        return;
      }
      const field = (n as HTMLElement).closest?.("input, textarea") as FieldTarget | null;
      if (field && isTextLikeInput(field)) {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, kind: "field", el: field });
        return;
      }
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu, { capture: true });
    return () => document.removeEventListener("contextmenu", onContextMenu, { capture: true });
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Node && (t as HTMLElement).closest?.("[data-app-context-menu]")) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menu, close]);

  const doCopy = async () => {
    if (!menu) return;
    try {
      if (menu.kind === "xterm") {
        const b = getTerminalClipboardBridge();
        if (!b) return;
        const s = b.term.getSelection();
        if (!s) return;
        await writeText(s);
        return;
      }
      const el = menu.el;
      el.focus();
      const a = el.selectionStart ?? 0;
      const b = el.selectionEnd ?? 0;
      const { value } = el;
      if (a === b) return;
      await writeText(value.slice(a, b));
    } catch {
      // ignore
    } finally {
      close();
    }
  };

  const doPaste = async () => {
    if (!menu) return;
    try {
      const text = await readText();
      if (menu.kind === "xterm") {
        const br = getTerminalClipboardBridge();
        if (!br || !br.hasSession()) return;
        br.term.paste(text);
        return;
      }
      const el = menu.el;
      if (el.readOnly) return;
      el.focus();
      const a = el.selectionStart ?? 0;
      const b = el.selectionEnd ?? 0;
      replaceRange(el, a, b, text);
    } catch {
      // ignore
    } finally {
      close();
    }
  };

  const doDelete = () => {
    if (!menu) return;
    try {
      if (menu.kind === "xterm") {
        const br = getTerminalClipboardBridge();
        if (!br) return;
        if (br.term.getSelection()) {
          br.term.clearSelection();
        } else if (br.hasSession()) {
          br.sendToPty("\x1b[3~");
        }
        return;
      }
      const el = menu.el;
      if (el.readOnly) return;
      el.focus();
      const a = el.selectionStart ?? 0;
      const b = el.selectionEnd ?? 0;
      if (a !== b) {
        replaceRange(el, a, b, "");
      } else if (a < el.value.length) {
        replaceRange(el, a, a + 1, "");
      }
    } catch {
      // ignore
    } finally {
      close();
    }
  };

  if (!menu) return null;

  const inX = menu.kind === "xterm";
  const br = inX ? getTerminalClipboardBridge() : null;
  const copyEmpty = inX ? !br?.term.getSelection() : (() => {
    const el = (menu as { kind: "field"; el: FieldTarget }).el;
    return (el.selectionStart ?? 0) === (el.selectionEnd ?? 0);
  })();
  const pasteDisabled = inX && (!br || !br.hasSession());
  const fieldReadonly = !inX && (menu as { el: FieldTarget }).el.readOnly;
  const deleteXtermDisabled = inX && br && !br.hasSession() && !br.term.getSelection();
  const showShortcuts = !inX;

  const mw = 200;
  const mh = 108;
  let left = menu.x;
  let top = menu.y;
  if (typeof window !== "undefined") {
    left = Math.max(4, Math.min(left, window.innerWidth - mw - 4));
    top = Math.max(4, Math.min(top, window.innerHeight - mh - 4));
  }

  return (
    <div
      data-app-context-menu
      className="fixed z-[10000] min-w-[12rem] overflow-hidden rounded-md border border-white/10 bg-[#0a1120] py-1 text-sm shadow-lg shadow-black/50"
      style={{ left, top }}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        disabled={copyEmpty || (inX && !br)}
        onClick={() => void doCopy()}
        className="flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-slate-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="flex-1">Kopiuj</span>
        {showShortcuts ? <span className="text-[10px] text-slate-500">Ctrl+C</span> : null}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={inX ? pasteDisabled : fieldReadonly}
        onClick={() => void doPaste()}
        className="flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-slate-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="flex-1">Wklej</span>
        {showShortcuts ? <span className="text-[10px] text-slate-500">Ctrl+V</span> : null}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={fieldReadonly || deleteXtermDisabled || (inX && !br)}
        onClick={doDelete}
        className="flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-slate-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="flex-1">Usuń</span>
        {showShortcuts ? <span className="text-[10px] text-slate-500">Del</span> : null}
      </button>
    </div>
  );
}
