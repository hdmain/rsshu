import type { ITheme } from "@xterm/xterm";

export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace(/^#/, "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

export function toHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s: s * 100, l: l * 100 };
}

export function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

export function mixHex(a: string, b: string, weight: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const w = Math.max(0, Math.min(1, weight));
  return toHex(
    ca.r * (1 - w) + cb.r * w,
    ca.g * (1 - w) + cb.g * w,
    ca.b * (1 - w) + cb.b * w,
  );
}

export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

export function isDark(hex: string): boolean {
  return relativeLuminance(hex) < 0.35;
}

/** Readable default text on a given background. */
export function readableTextOn(bg: string, preferBright = true): string {
  if (isDark(bg)) return preferBright ? "#f8fafc" : "#e2e8f0";
  return "#0f172a";
}

/** High-contrast xterm palette: white default text on dark backgrounds. */
export function buildDarkTerminalTheme(background: string, accent: string, foreground?: string): ITheme {
  const fg = foreground ?? "#ffffff";
  const bg = background;
  const selection = mixHex(accent, "#ffffff", 0.35);
  const dim = mixHex(bg, "#000000", 0.25);
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: selection,
    selectionForeground: fg,
    black: dim,
    red: "#f87171",
    green: "#4ade80",
    yellow: "#facc15",
    blue: "#60a5fa",
    magenta: "#e879f9",
    cyan: "#22d3ee",
    white: fg,
    brightBlack: "#94a3b8",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde047",
    brightBlue: "#93c5fd",
    brightMagenta: "#f0abfc",
    brightCyan: "#67e8f9",
    brightWhite: "#ffffff",
  };
}

export function buildLightTerminalTheme(background: string, accent: string): ITheme {
  const fg = "#0f172a";
  return {
    background,
    foreground: fg,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: mixHex(accent, "#ffffff", 0.65),
    selectionForeground: fg,
    black: "#1e293b",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#ca8a04",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    white: "#f1f5f9",
    brightBlack: "#64748b",
    brightRed: "#ef4444",
    brightGreen: "#22c55e",
    brightYellow: "#eab308",
    brightBlue: "#3b82f6",
    brightMagenta: "#a855f7",
    brightCyan: "#06b6d4",
    brightWhite: "#ffffff",
  };
}

export function buildHackerTerminalTheme(background = "#000000"): ITheme {
  return {
    background,
    foreground: "#39ff14",
    cursor: "#22c55e",
    cursorAccent: background,
    selectionBackground: "#14532d",
    black: "#0a0a0a",
    red: "#ff5555",
    green: "#39ff14",
    yellow: "#f1fa8c",
    blue: "#50fa7b",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8fff8",
    brightBlack: "#44475a",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  };
}

export function accentToRgbTriplet(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return "56 189 248";
  return `${rgb.r} ${rgb.g} ${rgb.b}`;
}

export function buildAppCssVars(
  surface: string,
  accent: string,
  mode: "dark" | "light",
): Record<string, string> {
  const dark = mode === "dark";
  const hsl = hexToHsl(surface) ?? { h: 220, s: 40, l: dark ? 8 : 98 };
  const accentHsl = hexToHsl(accent) ?? { h: 199, s: 89, l: 48 };
  const fg = dark ? "210 40% 98%" : "222 47% 11%";
  const mutedFg = dark ? "215 20% 65%" : "215 16% 47%";
  const cardL = dark ? Math.max(hsl.l, 6) + 3 : 100;
  const borderL = dark ? hsl.l + 14 : 91;
  const surface2 = hslToHex(hsl.h, Math.min(hsl.s, 45), dark ? hsl.l + 6 : hsl.l - 4);
  const surface3 = hslToHex(hsl.h, Math.min(hsl.s, 50), dark ? hsl.l + 12 : hsl.l - 8);
  const panel = mixHex(surface, dark ? "#ffffff" : "#000000", dark ? 0.08 : 0.04);

  return {
    "--background": `${Math.round(hsl.h)} ${Math.round(hsl.s)}% ${Math.round(hsl.l)}%`,
    "--foreground": fg,
    "--card": `${Math.round(hsl.h)} ${Math.round(Math.min(hsl.s, 40))}% ${cardL}%`,
    "--card-foreground": fg,
    "--primary": `${Math.round(accentHsl.h)} ${Math.round(accentHsl.s)}% ${Math.round(accentHsl.l)}%`,
    "--primary-foreground": dark ? `${Math.round(hsl.h)} ${Math.round(hsl.s)}% ${Math.round(hsl.l)}%` : "0 0% 100%",
    "--secondary": `${Math.round(hsl.h)} ${Math.round(Math.min(hsl.s, 35))}% ${dark ? hsl.l + 10 : 96}%`,
    "--secondary-foreground": fg,
    "--muted": `${Math.round(hsl.h)} ${Math.round(Math.min(hsl.s, 30))}% ${dark ? hsl.l + 10 : 96}%`,
    "--muted-foreground": mutedFg,
    "--accent": `${Math.round(hsl.h)} ${Math.round(Math.min(hsl.s, 35))}% ${dark ? hsl.l + 14 : 94}%`,
    "--accent-foreground": fg,
    "--destructive": "0 72% 51%",
    "--destructive-foreground": dark ? "210 40% 98%" : "0 0% 100%",
    "--border": `${Math.round(hsl.h)} ${Math.round(Math.min(hsl.s, 30))}% ${borderL}%`,
    "--input": `${Math.round(hsl.h)} ${Math.round(Math.min(hsl.s, 30))}% ${borderL}%`,
    "--ring": `${Math.round(accentHsl.h)} ${Math.round(accentHsl.s)}% ${Math.round(accentHsl.l)}%`,
    "--radius": "0.65rem",
    "--app-shell": dark
      ? `radial-gradient(circle at top, ${surface3} 0%, ${surface} 55%, ${mixHex(surface, "#000000", 0.35)} 100%)`
      : `linear-gradient(180deg, ${surface} 0%, ${mixHex(surface, "#e2e8f0", 0.5)} 100%)`,
    "--app-vault-bg": dark
      ? `radial-gradient(ellipse at center, ${surface3} 0%, ${surface} 65%, ${mixHex(surface, "#000000", 0.4)} 100%)`
      : `radial-gradient(ellipse at center, ${surface} 0%, ${mixHex(surface, "#cbd5e1", 0.4)} 100%)`,
    "--app-header": `linear-gradient(to right, ${surface}, ${surface2}, ${surface})`,
    "--app-title-bar": `rgb(${parseHex(surface)?.r ?? 7} ${parseHex(surface)?.g ?? 12} ${parseHex(surface)?.b ?? 24} / 0.92)`,
    "--app-sidebar": `rgb(${parseHex(surface)?.r ?? 7} ${parseHex(surface)?.g ?? 12} ${parseHex(surface)?.b ?? 24} / 0.88)`,
    "--app-surface": surface,
    "--app-panel": panel.includes("rgb") ? panel : `color-mix(in srgb, ${panel} 88%, transparent)`,
    "--app-modal": surface2,
    "--app-accent": accentToRgbTriplet(accent),
    "--app-accent-soft": `rgb(${accentToRgbTriplet(accent)} / 0.2)`,
    "--app-chrome-fg": dark ? "226 232 240" : "51 65 85",
    "--app-chrome-border": dark ? "255 255 255 / 0.12" : "15 23 42 / 0.1",
  };
}
