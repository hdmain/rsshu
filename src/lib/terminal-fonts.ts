import "../terminal-fonts.css";

/** Single patched Nerd Font — text + icons in one face (required for WebGL atlas). */
export const TERMINAL_FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "Noto Color Emoji", "Segoe UI Emoji", monospace';

export const TERMINAL_FONT_SIZE = 14;

export function preferWebglRenderer(): boolean {
  if (typeof navigator === "undefined") return true;
  // WebGL glyph atlas is unreliable on many Linux GPU stacks (gray blocks / transparency).
  return !/linux/i.test(navigator.userAgent);
}

export async function loadTerminalFonts(fontSize = TERMINAL_FONT_SIZE): Promise<void> {
  try {
    await Promise.race([
      document.fonts.load(`${fontSize}px "JetBrainsMono Nerd Font Mono"`),
      new Promise<void>((resolve) => window.setTimeout(resolve, 5000)),
    ]);
    await document.fonts.ready;
  } catch {
    // Fall back to system monospace.
  }
}
