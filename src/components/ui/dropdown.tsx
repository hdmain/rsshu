import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type DropdownOption = {
  value: string;
  label: string;
  description?: string;
};

type DropdownProps = {
  value: string | null;
  onValueChange: (value: string | null) => void;
  options: DropdownOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  allowEmpty?: boolean;
  emptyLabel?: string;
};

export function Dropdown({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  disabled = false,
  className,
  allowEmpty = false,
  emptyLabel = "None",
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = options.find((opt) => opt.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function pick(next: string | null) {
    onValueChange(next);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "app-card app-chrome-border app-text-strong flex h-9 w-full items-center justify-between gap-2 rounded-md border px-3 text-left text-sm transition",
          "hover:app-soft-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <span className={cn("min-w-0 truncate", !selected && "app-text-muted")}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown
          className={cn("app-text-muted h-4 w-4 shrink-0 transition", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div
          id={listId}
          role="listbox"
          className="app-panel absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border shadow-xl"
        >
          {allowEmpty ? (
            <button
              type="button"
              role="option"
              aria-selected={value === null || value === ""}
              onClick={() => pick(null)}
              className={cn(
                "app-soft-hover flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition",
                (value === null || value === "") && "app-accent-bg",
              )}
            >
              <Check
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  value === null || value === "" ? "opacity-100" : "opacity-0",
                )}
              />
              <span className="app-text-muted">{emptyLabel}</span>
            </button>
          ) : null}
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => pick(opt.value)}
                className={cn(
                  "app-soft-hover flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition",
                  isSelected && "app-accent-bg",
                )}
              >
                <Check
                  className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", isSelected ? "opacity-100" : "opacity-0")}
                />
                <span className="min-w-0">
                  <span className="app-text-strong block truncate">{opt.label}</span>
                  {opt.description ? (
                    <span className="app-text-muted block truncate text-xs">{opt.description}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
