import "@azurity/pure-nerd-font/pure-nerd-font.css";

/** Monospace stack with Nerd Font icons + system emoji fallbacks. */
export const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, "Pure Nerd Font", "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", monospace';

export async function loadTerminalFonts(fontSize = 13): Promise<void> {
  const load = document.fonts.load(`${fontSize}px "Pure Nerd Font"`);
  try {
    await Promise.race([
      load,
      new Promise<void>((resolve) => window.setTimeout(resolve, 3000)),
    ]);
    await document.fonts.ready;
  } catch {
    // Fall back to system monospace / emoji fonts.
  }
}
