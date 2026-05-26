import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { GlobalContextMenu } from "@/components/global-context-menu";
import { initTheme } from "@/lib/themes";
import "./index.css";

initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <GlobalContextMenu />
  </React.StrictMode>,
);
