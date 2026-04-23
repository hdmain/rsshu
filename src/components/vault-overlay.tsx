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
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[radial-gradient(ellipse_at_center,_#0e1a33_0%,_#050912_65%,_#02040a_100%)] px-4 py-8">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0a1120]/90 p-6 shadow-[0_20px_60px_rgba(2,6,23,0.65)] backdrop-blur"
      >
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-500 shadow-[0_0_18px_rgba(56,189,248,0.45)]">
            {isNew ? (
              <ShieldCheck className="h-6 w-6 text-white" />
            ) : (
              <Lock className="h-6 w-6 text-white" />
            )}
          </div>
          <h2 className="mt-3 text-lg font-semibold text-slate-100">
            {isNew ? "Create Master Password" : "Unlock Vault"}
          </h2>
          <p className="mt-1 max-w-xs text-xs text-slate-400">
            {isNew
              ? "Your hosts are encrypted with AES-256. Choose a strong master password — it cannot be recovered."
              : "Enter your master password to decrypt your saved hosts."}
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wider text-slate-400">
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
              <label className="mb-1 block text-[11px] uppercase tracking-wider text-slate-400">
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
          <p className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {shownError}
          </p>
        ) : null}

        <Button type="submit" className="mt-5 w-full" disabled={submitting}>
          {submitting ? "Working…" : isNew ? "Create vault" : "Unlock"}
        </Button>

        <div className="mt-5 flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-slate-500">
          <Terminal className="h-3 w-3" />
          <span>RSSHU secure storage</span>
        </div>
      </form>
    </div>
  );
}
