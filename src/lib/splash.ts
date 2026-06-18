import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";

let dismissed = false;

function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function waitForSplashShown(timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await invoke<boolean>("splash_is_shown")) return;
    } catch {
      // splash window may not be ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

export async function dismissSplashWhenReady(): Promise<void> {
  if (!isTauri() || dismissed) return;
  dismissed = true;

  const main = getCurrentWebviewWindow();
  if (main.label !== "main") return;

  try {
    await waitForSplashShown();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const splash = await WebviewWindow.getByLabel("splashscreen");
    await main.show();
    await main.setFocus();
    if (splash) {
      await splash.close();
    }
  } catch (err) {
    dismissed = false;
    console.warn("[splash] failed to dismiss splash screen", err);
    try {
      await main.show();
    } catch {
      // ignore
    }
  }
}
