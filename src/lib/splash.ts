import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";

let dismissed = false;

function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

export async function dismissSplashWhenReady(): Promise<void> {
  if (!isTauri() || dismissed) return;
  dismissed = true;

  const main = getCurrentWebviewWindow();

  try {
    await main.show();
    await main.setFocus();

    const splash = await WebviewWindow.getByLabel("splashscreen");
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
