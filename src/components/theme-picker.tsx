import { useEffect, useMemo, useState } from "react";
import { Check, Download, Palette, RotateCcw, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ITheme } from "@xterm/xterm";
import {
  BUILTIN_THEME_IDS,
  BUILTIN_THEMES,
  buildCustomThemeDefinition,
  DEFAULT_CUSTOM_THEME,
  exportCustomThemeJson,
  getStoredCustomTheme,
  importCustomThemeJson,
  resolveTheme,
  type BuiltinThemeId,
  type CustomThemeConfig,
} from "@/lib/themes";
import { parseHex } from "@/lib/theme-colors";
import { useTheme } from "@/lib/use-theme";

function TerminalPreview({ terminal }: { terminal: ITheme }) {
  const t = terminal;
  const bg = t.background ?? "#050912";
  const fg = t.foreground ?? "#ffffff";
  return (
    <div
      className="mt-2 overflow-hidden rounded-md border font-mono text-[10px] leading-relaxed app-chrome-border"
      style={{ background: bg, color: fg }}
    >
      <div className="px-2 py-1.5">
        <span style={{ color: t.green }}>user@host</span>
        <span style={{ color: fg }}>:~$ </span>
        <span style={{ color: t.cyan }}>ls -la</span>
      </div>
      <div className="border-t px-2 py-1 opacity-90" style={{ borderColor: `${fg}22` }}>
        <span style={{ color: t.brightBlue }}>drwx</span>
        <span style={{ color: fg }}>  config  </span>
        <span style={{ color: t.yellow }}>README.md</span>
      </div>
    </div>
  );
}

function SwatchStrip({ colors }: { colors: [string, string, string] }) {
  return (
    <div className="flex h-10 overflow-hidden rounded-lg border app-chrome-border shadow-inner">
      {colors.map((color) => (
        <span key={color} className="h-full flex-1" style={{ backgroundColor: color }} title={color} />
      ))}
    </div>
  );
}

type ColorFieldProps = {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
};

function ColorField({ label, hint, value, onChange }: ColorFieldProps) {
  const valid = parseHex(value);
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={valid ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-12 shrink-0 cursor-pointer rounded-md border app-chrome-border bg-transparent p-0.5"
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 font-mono text-xs"
          placeholder="#000000"
        />
      </div>
    </label>
  );
}

export function ThemePicker() {
  const { themeId, customTheme, setTheme, setCustomTheme } = useTheme();
  const [draft, setDraft] = useState<CustomThemeConfig>(() => customTheme);
  const [showCustom, setShowCustom] = useState(themeId === "custom");
  const [ioError, setIoError] = useState("");

  useEffect(() => {
    const sync = () => setDraft(getStoredCustomTheme());
    window.addEventListener("themechange", sync);
    return () => window.removeEventListener("themechange", sync);
  }, []);

  const customPreview = useMemo(
    () => (showCustom ? buildCustomThemeDefinition(draft) : resolveTheme("custom")),
    [showCustom, draft],
  );

  const draftValid =
    parseHex(draft.accent) &&
    parseHex(draft.surface) &&
    parseHex(draft.terminalBackground) &&
    parseHex(draft.terminalForeground);

  function applyCustom() {
    if (!draftValid) return;
    setCustomTheme(draft);
    setShowCustom(true);
  }

  function resetCustom() {
    setDraft({ ...DEFAULT_CUSTOM_THEME });
  }

  function exportCustom() {
    try {
      const data = exportCustomThemeJson(draft);
      const blob = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safe = (draft.name || "custom-theme").replace(/[^a-z0-9-_.]+/gi, "-");
      a.href = url;
      a.download = `${safe}.rsshu-theme.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setIoError("");
    } catch {
      setIoError("Could not export theme.");
    }
  }

  async function importCustom(file: File | null) {
    if (!file) return;
    try {
      const raw = await file.text();
      const parsed = importCustomThemeJson(raw);
      setDraft(parsed);
      setCustomTheme(parsed);
      setShowCustom(true);
      setIoError("");
    } catch {
      setIoError("Invalid theme file.");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 flex items-center gap-2">
          <Palette className="h-4 w-4 app-accent-text" />
          <h3 className="text-sm font-semibold text-foreground">Built-in themes</h3>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {BUILTIN_THEME_IDS.map((id) => {
            const theme = BUILTIN_THEMES[id];
            const selected = themeId === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTheme(id as BuiltinThemeId)}
                className={`group relative rounded-xl border p-3 text-left transition-all ${
                  selected
                    ? "app-nav-active scale-[1.01] shadow-lg"
                    : "border-border bg-card/50 hover:border-[rgb(var(--app-accent)/0.4)] hover:bg-muted/30"
                }`}
              >
                <SwatchStrip colors={theme.preview} />
                <div className="mt-2.5 flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{theme.label}</p>
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                      {theme.description}
                    </p>
                  </div>
                  {selected ? (
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full app-accent-bg">
                      <Check className="h-3.5 w-3.5" />
                    </span>
                  ) : null}
                </div>
                <TerminalPreview terminal={theme.terminal} />
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-dashed app-chrome-border bg-muted/20 p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 app-accent-text" />
            <h3 className="text-sm font-semibold text-foreground">Custom theme</h3>
          </div>
          <Button
            type="button"
            size="sm"
            variant={themeId === "custom" ? "default" : "outline"}
            onClick={() => setShowCustom((v) => !v)}
          >
            {showCustom ? "Hide editor" : "Create / edit"}
          </Button>
        </div>

        <button
          type="button"
          onClick={() => {
            if (themeId !== "custom") setCustomTheme(draft);
            else setTheme("custom");
          }}
          className={`mb-3 w-full rounded-xl border p-3 text-left transition ${
            themeId === "custom"
              ? "app-nav-active shadow-md"
              : "border-border bg-card/40 hover:bg-muted/30"
          }`}
        >
          <SwatchStrip colors={customPreview.preview} />
          <p className="mt-2 text-sm font-semibold text-foreground">{customPreview.label}</p>
          <p className="text-[11px] text-muted-foreground">Accent, UI shell, and terminal colors</p>
          {themeId === "custom" ? <TerminalPreview terminal={customPreview.terminal} /> : null}
        </button>

        {showCustom ? (
          <div className="space-y-4 rounded-lg border app-chrome-border bg-card/60 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 sm:col-span-2">
                <span className="text-xs font-medium text-foreground">Theme name</span>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                  placeholder="My theme"
                  className="h-9"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-foreground">UI mode</span>
                <div className="flex gap-2">
                  {(["dark", "light"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setDraft((p) => ({ ...p, mode }))}
                      className={`flex-1 rounded-md border px-3 py-2 text-xs capitalize transition ${
                        draft.mode === mode ? "app-nav-active" : "border-border hover:bg-muted/50"
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </label>
              <ColorField
                label="Accent"
                hint="Buttons, links, highlights"
                value={draft.accent}
                onChange={(accent) => setDraft((p) => ({ ...p, accent }))}
              />
              <ColorField
                label="App background"
                hint="Shell, sidebar, panels"
                value={draft.surface}
                onChange={(surface) => setDraft((p) => ({ ...p, surface }))}
              />
              <ColorField
                label="Terminal background"
                value={draft.terminalBackground}
                onChange={(terminalBackground) => setDraft((p) => ({ ...p, terminalBackground }))}
              />
              <ColorField
                label="Terminal text"
                hint="Use #ffffff for max readability"
                value={draft.terminalForeground}
                onChange={(terminalForeground) => setDraft((p) => ({ ...p, terminalForeground }))}
              />
            </div>

            <div className="rounded-lg border app-chrome-border p-2">
              <p className="mb-1 px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Live preview
              </p>
              <TerminalPreview terminal={buildCustomThemeDefinition(draft).terminal} />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={!draftValid} onClick={applyCustom}>
                Save & apply
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={resetCustom}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Reset
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={exportCustom}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Export JSON
              </Button>
              <label className="inline-flex cursor-pointer items-center">
                <input
                  type="file"
                  accept=".json,.rsshu-theme.json,application/json"
                  className="hidden"
                  onChange={(e) => {
                    void importCustom(e.target.files?.[0] ?? null);
                    e.currentTarget.value = "";
                  }}
                />
                <span className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium transition-colors hover:bg-muted">
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  Import JSON
                </span>
              </label>
            </div>
            {!draftValid ? (
              <p className="text-xs text-amber-500">Use valid 6-digit hex colors (e.g. #ffffff).</p>
            ) : null}
            {ioError ? <p className="text-xs text-destructive">{ioError}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
