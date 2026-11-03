import { useRef, type RefObject } from "react";
import type { Checkpoint } from "@workspace/api-client-react";
import type { DraftFields } from "@/lib/thread";
import { fmtTime } from "@/lib/thread";
import { REPLACED_FIELDS } from "@/lib/checkpoint-replacement";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogCancel } from "@/components/ui/alert-dialog";

export function CheckpointReplacementDialog({ preview, busy, message, opener, onCancel, onConfirm }: {
  preview: { checkpoint: Checkpoint; before: DraftFields } | null;
  busy: boolean; message: string | null; opener: RefObject<HTMLElement | null>;
  onCancel: () => void; onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return <AlertDialog open={!!preview} onOpenChange={open => { if (!open && !busy) onCancel(); }}>
    <AlertDialogContent className="max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-y-auto"
      onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus({ preventScroll: true }); }}
      onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus(); }} data-testid="dialog-replace-checkpoint">
      <AlertDialogHeader>
        <AlertDialogTitle>Replace draft fields from this checkpoint?</AlertDialogTitle>
        <AlertDialogDescription>
          Checkpoint saved {preview ? fmtTime(preview.checkpoint.createdAt) : ""}. This replaces four working-draft fields, including empty values. Your working notes stay unchanged. We keep a prior-draft recovery copy before replacing anything.
        </AlertDialogDescription>
        {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
      </AlertDialogHeader>
      <div className="min-h-0 overflow-y-auto space-y-4 pr-2" tabIndex={0} aria-label="Preview of four replaced fields">
        {preview && REPLACED_FIELDS.map(field => <section key={field.key}>
          <h3 className="font-medium text-sm">{field.label}</h3>
          <div className="mt-2 grid sm:grid-cols-2 gap-2 text-sm">
            <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground mb-1">Current working draft</p>
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{preview.before[field.key] || "Empty"}</p></div>
            <div className="rounded-lg border border-primary/40 p-3"><p className="text-xs text-muted-foreground mb-1">Replacement from saved checkpoint</p>
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{preview.checkpoint[field.key] || "Empty — this will clear the current field"}</p></div>
          </div>
        </section>)}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <AlertDialogCancel ref={cancel} disabled={busy} data-testid="button-cancel-replacement" className="min-h-11 mt-0">Cancel</AlertDialogCancel>
        <button onClick={onConfirm} disabled={busy} className="min-h-11 px-4 rounded-full bg-primary text-primary-foreground text-sm disabled:opacity-50" data-testid="button-confirm-replacement">{busy ? "Replacing safely…" : "Replace draft fields"}</button>
      </div>
    </AlertDialogContent>
  </AlertDialog>;
}
