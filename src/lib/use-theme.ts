import { useCallback, useSyncExternalStore } from "react";
import {
  applyTheme,
  CUSTOM_THEME_STORAGE_KEY,
  getStoredCustomTheme,
  getStoredThemeId,
  isThemeId,
  saveCustomTheme,
  setCustomTheme as persistCustomTheme,
  setTheme as persistTheme,
  type CustomThemeConfig,
  type ThemeId,
  THEME_STORAGE_KEY,
} from "@/lib/themes";

function subscribe(onStoreChange: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_STORAGE_KEY || e.key === CUSTOM_THEME_STORAGE_KEY) onStoreChange();
  };
  window.addEventListener("themechange", onStoreChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("themechange", onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

function getThemeSnapshot(): ThemeId {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr && isThemeId(attr)) return attr;
  return getStoredThemeId();
}

/** Stable revision counter — bumps on themechange (safe for useSyncExternalStore). */
let themeRevision = 0;

function getThemeRevision(): number {
  return themeRevision;
}

function subscribeWithRevision(onStoreChange: () => void) {
  const bump = () => {
    themeRevision += 1;
    onStoreChange();
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_STORAGE_KEY || e.key === CUSTOM_THEME_STORAGE_KEY) bump();
  };
  window.addEventListener("themechange", bump);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("themechange", bump);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTheme() {
  const themeId = useSyncExternalStore(subscribe, getThemeSnapshot, () => getStoredThemeId());
  // Revision changes only on themechange — avoids infinite loop from object snapshots.
  useSyncExternalStore(subscribeWithRevision, getThemeRevision, () => 0);

  const customTheme = getStoredCustomTheme();

  const setTheme = useCallback((id: ThemeId) => {
    persistTheme(id);
    window.dispatchEvent(new Event("themechange"));
  }, []);

  const setCustomTheme = useCallback((config: CustomThemeConfig) => {
    persistCustomTheme(config);
    window.dispatchEvent(new Event("themechange"));
  }, []);

  const updateCustomTheme = useCallback((config: CustomThemeConfig) => {
    saveCustomTheme(config);
    if (getStoredThemeId() === "custom") {
      applyTheme("custom");
    }
    window.dispatchEvent(new Event("themechange"));
  }, []);

  return { themeId, customTheme, setTheme, setCustomTheme, updateCustomTheme, applyTheme };
}
