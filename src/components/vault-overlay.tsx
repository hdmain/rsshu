import { type FormEvent, useState } from "react";
import { Lock, ShieldCheck, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type VaultMode = "new" | "locked";

type VaultOverlayProps = {
  mode: VaultMode;
  submitting?: boolean;
  error?: string;
  onSubmit: (password: string) => void | Promise<void>;
};

export function VaultOverlay({ mode, submitting, error, onSubmit }: VaultOverlayProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string>("");

  const isNew = mode === "new";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLocalError("");
    if (!password) {
      setLocalError("Password is required");
      return;
    }
    if (isNew) {
      if (password.length < 8) {
        setLocalError("Master password must be at least 8 characters");
        return;
      }
      if (password !== confirm) {
        setLocalError("Passwords do not match");
        return;
      }
    }
    await onSubmit(password);
  }

  const shownError = localError || error;

  return (
    <div className="app-vault-screen relative flex min-h-0 flex-1 items-center justify-center overflow-auto px-4 py-8">
      <form
        onSubmit={handleSubmit}
        className="app-modal w-full max-w-sm rounded-2xl border p-6 shadow-[0_20px_60px_rgba(2,6,23,0.65)] backdrop-blur"
      >
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-500 shadow-[0_0_18px_rgba(56,189,248,0.45)]">
            {isNew ? (
              <ShieldCheck className="h-6 w-6 text-white" />
            ) : (
              <Lock className="h-6 w-6 text-white" />
            )}
          </div>
          <h2 className="app-text-strong mt-3 text-lg font-semibold">
            {isNew ? "Create Master Password" : "Unlock Vault"}
          </h2>
          <p className="app-text-muted mt-1 max-w-xs text-xs">
            {isNew
              ? "Your hosts are encrypted with AES-256. Choose a strong master password — it cannot be recovered."
              : "Enter your master password to decrypt your saved hosts."}
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="app-text-muted mb-1 block text-[11px] uppercase tracking-wider">
              Master password
            </label>
            <Input
              type="password"
              autoFocus
              autoComplete={isNew ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isNew ? "At least 8 characters" : "••••••••"}
            />
          </div>
          {isNew ? (
            <div>
              <label className="app-text-muted mb-1 block text-[11px] uppercase tracking-wider">
                Confirm password
              </label>
              <Input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat master password"
              />
            </div>
          ) : null}
        </div>

        {shownError ? (
          <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {shownError}
          </p>
        ) : null}

        <Button type="submit" className="mt-5 w-full" disabled={submitting}>
          {submitting ? "Working…" : isNew ? "Create vault" : "Unlock"}
        </Button>

        <div className="app-text-muted mt-5 flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-[0.18em]">
          <Terminal className="h-3 w-3" />
          <span>RSSHU secure storage</span>
        </div>
      </form>
    </div>
  );
}
