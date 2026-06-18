import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { GlobalContextMenu } from "@/components/global-context-menu";
import { initTheme } from "@/lib/themes";
import { dismissSplashWhenReady } from "@/lib/splash";
import "./index.css";

initTheme();

function SplashDismiss() {
  useEffect(() => {
    void dismissSplashWhenReady();
  }, []);
  return null;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SplashDismiss />
    <App />
    <GlobalContextMenu />
  </React.StrictMode>,
);
