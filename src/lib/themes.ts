import type { ITheme } from "@xterm/xterm";
import {
  buildAppCssVars,
  buildDarkTerminalTheme,
  buildHackerTerminalTheme,
  buildLightTerminalTheme,
  mixHex,
  parseHex,
} from "@/lib/theme-colors";

export const THEME_STORAGE_KEY = "rsshu.settings.theme";
export const CUSTOM_THEME_STORAGE_KEY = "rsshu.settings.customTheme";

export type BuiltinThemeId = "default" | "dark" | "light" | "hacker" | "midnight" | "ocean";
export type ThemeId = BuiltinThemeId | "custom";

export type CustomThemeConfig = {
  name: string;
  accent: string;
  surface: string;
  terminalBackground: string;
  terminalForeground: string;
  mode: "dark" | "light";
};

export const DEFAULT_CUSTOM_THEME: CustomThemeConfig = {
  name: "My theme",
  accent: "#38bdf8",
  surface: "#0b1326",
  terminalBackground: "#050912",
  terminalForeground: "#ffffff",
  mode: "dark",
};

export type ThemeDefinition = {
  id: ThemeId;
  label: string;
  description: string;
  preview: [string, string, string];
  cssVars: Record<string, string>;
  terminal: ITheme;
  isCustom?: boolean;
};

function panelRgba(surface: string, alpha: number): string {
  const rgb = parseHex(surface);
  if (!rgb) return `rgb(31 39 64 / ${alpha})`;
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${alpha})`;
}

function makeBuiltin(
  id: BuiltinThemeId,
  label: string,
  description: string,
  preview: [string, string, string],
  surface: string,
  accent: string,
  terminal: ITheme,
  extraCss: Record<string, string> = {},
): ThemeDefinition {
  const mode = id === "light" ? "light" : "dark";
  return {
    id,
    label,
    description,
    preview,
    cssVars: {
      ...buildAppCssVars(surface, accent, mode),
      "--app-panel": panelRgba(surface, mode === "light" ? 0.95 : 0.82),
      ...extraCss,
    },
    terminal,
  };
}

export const BUILTIN_THEMES: Record<BuiltinThemeId, ThemeDefinition> = {
  default: makeBuiltin(
    "default",
    "Default",
    "Original RSSHU blue-dark",
    ["#0ea5e9", "#0b1326", "#050912"],
    "#0b1326",
    "#38bdf8",
    buildDarkTerminalTheme("#050912", "#38bdf8", "#e2e8f0"),
    {
      "--background": "222 47% 5%",
      "--foreground": "210 40% 98%",
      "--card": "222 47% 8%",
      "--card-foreground": "210 40% 98%",
      "--primary": "199 89% 48%",
      "--primary-foreground": "222 47% 5%",
      "--secondary": "217 32% 15%",
      "--secondary-foreground": "210 40% 96%",
      "--muted": "217 32% 15%",
      "--muted-foreground": "215 20% 65%",
      "--accent": "217 32% 19%",
      "--accent-foreground": "210 40% 98%",
      "--destructive": "0 72% 51%",
      "--destructive-foreground": "210 40% 98%",
      "--border": "217 32% 20%",
      "--input": "217 32% 20%",
      "--ring": "199 89% 48%",
      "--radius": "0.65rem",
      "--app-shell": "radial-gradient(circle at top, #0e1a33 0%, #050912 55%, #03060d 100%)",
      "--app-vault-bg": "radial-gradient(ellipse at center, #0e1a33 0%, #050912 65%, #02040a 100%)",
      "--app-header": "linear-gradient(to right, #0a1120, #0b1326, #0a1120)",
      "--app-title-bar": "rgb(7 12 24 / 0.9)",
      "--app-sidebar": "rgb(7 12 24 / 0.8)",
      "--app-surface": "#050912",
      "--app-panel": "rgb(31 39 64 / 0.8)",
      "--app-modal": "#0a1120",
      "--app-accent": "56 189 248",
      "--app-accent-soft": "rgb(14 165 233 / 0.16)",
      "--app-chrome-fg": "203 213 225",
      "--app-chrome-border": "255 255 255 / 0.1",
    },
  ),
  dark: makeBuiltin(
    "dark",
    "Dark",
    "Neutral charcoal, crisp terminal",
    ["#e4e4e7", "#18181b", "#09090b"],
    "#18181b",
    "#e4e4e7",
    buildDarkTerminalTheme("#18181b", "#fafafa", "#ffffff"),
  ),
  light: makeBuiltin(
    "light",
    "Light",
    "Bright UI with dark terminal text",
    ["#0284c7", "#f8fafc", "#ffffff"],
    "#f8fafc",
    "#0284c7",
    buildLightTerminalTheme("#f8fafc", "#0284c7"),
  ),
  hacker: makeBuiltin(
    "hacker",
    "Hacker",
    "Matrix green on black (terminal stays green)",
    ["#39ff14", "#052e16", "#000000"],
    "#001a00",
    "#22c55e",
    buildHackerTerminalTheme("#001a00"),
    {
      "--radius": "0.35rem",
      "--app-chrome-fg": "134 239 172",
      "--app-chrome-border": "34 197 94 / 0.25",
    },
  ),
  midnight: makeBuiltin(
    "midnight",
    "Midnight",
    "Purple night — white terminal text",
    ["#a78bfa", "#1e1b4b", "#0f0a1a"],
    "#1e1b4b",
    "#a78bfa",
    buildDarkTerminalTheme("#1e1b4b", "#a78bfa", "#ffffff"),
  ),
  ocean: makeBuiltin(
    "ocean",
    "Ocean",
    "Deep teal shell, bright white terminal",
    ["#2dd4bf", "#134e4a", "#042f2e"],
    "#042f2e",
    "#2dd4bf",
    buildDarkTerminalTheme("#021c1a", "#2dd4bf", "#ffffff"),
    {
      "--app-shell": "radial-gradient(circle at top, #134e4a 0%, #042f2e 55%, #021a18 100%)",
      "--app-surface": "#021c1a",
    },
  ),
};

export const BUILTIN_THEME_IDS = Object.keys(BUILTIN_THEMES) as BuiltinThemeId[];

export function isBuiltinThemeId(value: string): value is BuiltinThemeId {
  return value in BUILTIN_THEMES;
}

export function isThemeId(value: string): value is ThemeId {
  return isBuiltinThemeId(value) || value === "custom";
}

export function getStoredCustomTheme(): CustomThemeConfig {
  try {
    const raw = localStorage.getItem(CUSTOM_THEME_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CUSTOM_THEME };
    const parsed = JSON.parse(raw) as Partial<CustomThemeConfig>;
    return {
      name: parsed.name ?? DEFAULT_CUSTOM_THEME.name,
      accent: parseHex(parsed.accent ?? "") ? parsed.accent! : DEFAULT_CUSTOM_THEME.accent,
      surface: parseHex(parsed.surface ?? "") ? parsed.surface! : DEFAULT_CUSTOM_THEME.surface,
      terminalBackground: parseHex(parsed.terminalBackground ?? "")
        ? parsed.terminalBackground!
        : DEFAULT_CUSTOM_THEME.terminalBackground,
      terminalForeground: parseHex(parsed.terminalForeground ?? "")
        ? parsed.terminalForeground!
        : DEFAULT_CUSTOM_THEME.terminalForeground,
      mode: parsed.mode === "light" ? "light" : "dark",
    };
  } catch {
    return { ...DEFAULT_CUSTOM_THEME };
  }
}

export function saveCustomTheme(config: CustomThemeConfig): void {
  try {
    localStorage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore
  }
}

function normalizeCustomTheme(input: Partial<CustomThemeConfig> | null | undefined): CustomThemeConfig {
  const parsed = input ?? {};
  return {
    name: (parsed.name ?? DEFAULT_CUSTOM_THEME.name).trim() || DEFAULT_CUSTOM_THEME.name,
    accent: parseHex(parsed.accent ?? "") ? parsed.accent! : DEFAULT_CUSTOM_THEME.accent,
    surface: parseHex(parsed.surface ?? "") ? parsed.surface! : DEFAULT_CUSTOM_THEME.surface,
    terminalBackground: parseHex(parsed.terminalBackground ?? "")
      ? parsed.terminalBackground!
      : DEFAULT_CUSTOM_THEME.terminalBackground,
    terminalForeground: parseHex(parsed.terminalForeground ?? "")
      ? parsed.terminalForeground!
      : DEFAULT_CUSTOM_THEME.terminalForeground,
    mode: parsed.mode === "light" ? "light" : "dark",
  };
}

export function exportCustomThemeJson(config: CustomThemeConfig): string {
  return JSON.stringify(
    {
      type: "rsshu-custom-theme",
      version: 1,
      theme: normalizeCustomTheme(config),
    },
    null,
    2,
  );
}

export function importCustomThemeJson(raw: string): CustomThemeConfig {
  const data = JSON.parse(raw) as unknown;
  if (typeof data === "object" && data !== null && "theme" in data) {
    const wrapped = data as { theme?: Partial<CustomThemeConfig> };
    if (wrapped.theme) return normalizeCustomTheme(wrapped.theme);
  }
  return normalizeCustomTheme(data as Partial<CustomThemeConfig>);
}

export function buildCustomThemeDefinition(config: CustomThemeConfig): ThemeDefinition {
  const terminal =
    config.mode === "light"
      ? buildLightTerminalTheme(config.terminalBackground, config.accent)
      : buildDarkTerminalTheme(
          config.terminalBackground,
          config.accent,
          config.terminalForeground,
        );

  const preview: [string, string, string] = [
    config.accent,
    mixHex(config.surface, config.accent, 0.35),
    config.terminalBackground,
  ];

  return {
    id: "custom",
    label: config.name.trim() || "Custom",
    description: "Your personalized colors",
    preview,
    cssVars: {
      ...buildAppCssVars(config.surface, config.accent, config.mode),
      "--app-panel": panelRgba(config.surface, config.mode === "light" ? 0.95 : 0.82),
      "--app-surface": config.terminalBackground,
    },
    terminal,
    isCustom: true,
  };
}

export function resolveTheme(id: ThemeId): ThemeDefinition {
  if (id === "custom") return buildCustomThemeDefinition(getStoredCustomTheme());
  return BUILTIN_THEMES[id] ?? BUILTIN_THEMES.default;
}

export function getStoredThemeId(): ThemeId {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw && isThemeId(raw)) return raw;
  } catch {
    // ignore
  }
  return "default";
}

export function applyTheme(id: ThemeId): void {
  const theme = resolveTheme(id);
  const root = document.documentElement;
  root.setAttribute("data-theme", id);
  root.classList.toggle("theme-light", theme.id === "light" || (id === "custom" && getStoredCustomTheme().mode === "light"));
  for (const [key, value] of Object.entries(theme.cssVars)) {
    root.style.setProperty(key, value);
  }
}

export function initTheme(): ThemeId {
  const id = getStoredThemeId();
  applyTheme(id);
  return id;
}

export function setTheme(id: ThemeId): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // ignore
  }
  applyTheme(id);
}

export function setCustomTheme(config: CustomThemeConfig): void {
  saveCustomTheme(normalizeCustomTheme(config));
  setTheme("custom");
}

export function getTerminalTheme(id: ThemeId): ITheme {
  return resolveTheme(id).terminal;
}

/** @deprecated use BUILTIN_THEMES */
export const THEMES = BUILTIN_THEMES;
/** @deprecated use BUILTIN_THEME_IDS */
export const THEME_IDS = BUILTIN_THEME_IDS;
