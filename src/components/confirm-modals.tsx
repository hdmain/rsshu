import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type LinkConfirmModalProps = {
  url: string;
  onOpen: () => void;
  onCancel: () => void;
};

export function LinkConfirmModal({ url, onOpen, onCancel }: LinkConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <Card className="app-modal w-full max-w-lg border">
        <CardHeader>
          <CardTitle>Open link?</CardTitle>
          <CardDescription>This will open the URL in your default browser.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="app-text-strong break-all rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs">
            {url}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={onOpen}>Open</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export type UploadConflictAction = "rename" | "replace" | "cancel";

type UploadConflictModalProps = {
  fileName: string;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onRename: () => void;
  onReplace: () => void;
  onCancel: () => void;
};

export function UploadConflictModal({
  fileName,
  renameValue,
  onRenameValueChange,
  onRename,
  onReplace,
  onCancel,
}: UploadConflictModalProps) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <Card className="app-modal w-full max-w-lg border">
        <CardHeader>
          <CardTitle>File already exists</CardTitle>
          <CardDescription>
            <span className="app-text-strong font-mono">{fileName}</span> is already on the remote host.
            Choose what to do.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <p className="app-text-muted text-xs font-medium uppercase tracking-wide">Rename to</p>
            <Input
              value={renameValue}
              onChange={(e) => onRenameValueChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && renameValue.trim()) onRename();
              }}
              autoFocus
            />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="outline" onClick={onReplace}>
              Replace
            </Button>
            <Button disabled={!renameValue.trim() || renameValue.trim() === fileName} onClick={onRename}>
              Rename
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Suggest `name (1).ext`, `name (2).ext`, … */
export function suggestRename(fileName: string, taken?: (name: string) => boolean): string {
  const dot = fileName.lastIndexOf(".");
  const hasExt = dot > 0 && dot < fileName.length - 1;
  const stem = hasExt ? fileName.slice(0, dot) : fileName;
  const ext = hasExt ? fileName.slice(dot) : "";
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken || !taken(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}
