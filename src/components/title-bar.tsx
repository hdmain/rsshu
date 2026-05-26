import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minus, Square, Terminal, X } from "lucide-react";

type TitleBarProps = {
  title?: string;
};

export function TitleBar({ title = "RSSHU" }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    let mounted = true;

    (async () => {
      try {
        const current = await win.isMaximized();
        if (mounted) setMaximized(current);
      } catch {
        // Ignore: web preview.
      }
      try {
        unlisten = await win.onResized(async () => {
          try {
            const current = await win.isMaximized();
            if (mounted) setMaximized(current);
          } catch {
            // Ignore.
          }
        });
      } catch {
        // Ignore.
      }
    })();

    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, []);

  const onMinimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch {
      // noop
    }
  };

  const onToggleMaximize = async () => {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch {
      // noop
    }
  };

  const onClose = async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      // noop
    }
  };

  return (
    <div
      data-tauri-drag-region
      className="app-title-bar flex h-8 shrink-0 select-none items-center justify-between pl-3 text-[12px]"
    >
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2">
        <Terminal className="app-accent-text h-3.5 w-3.5 shrink-0" />
        <span data-tauri-drag-region className="truncate font-medium tracking-wide app-chrome-text">
          {title}
        </span>
      </div>
      <div className="flex h-full items-center">
        <button
          type="button"
          aria-label="Minimize"
          className="app-chrome-muted flex h-full w-11 items-center justify-center transition app-chrome-hover"
          onClick={onMinimize}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={maximized ? "Restore" : "Maximize"}
          className="app-chrome-muted flex h-full w-11 items-center justify-center transition app-chrome-hover"
          onClick={onToggleMaximize}
        >
          {maximized ? (
            <Square className="h-3 w-3" />
          ) : (
            <Maximize2 className="h-3 w-3" />
          )}
        </button>
        <button
          type="button"
          aria-label="Close"
          className="app-chrome-muted flex h-full w-11 items-center justify-center transition hover:bg-rose-500/80 hover:text-white"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
