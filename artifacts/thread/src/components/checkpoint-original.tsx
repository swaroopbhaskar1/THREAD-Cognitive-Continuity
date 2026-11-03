import type { Checkpoint } from "@workspace/api-client-react";
import { fmtTime } from "@/lib/thread";

export function CheckpointOriginal({ checkpoint }: { checkpoint: Checkpoint }) {
  return <details className="mt-3 text-sm" data-testid={`original-${checkpoint.id}`}>
    <summary className="cursor-pointer underline underline-offset-4">View saved checkpoint</summary>
    <p className="mt-3 text-xs text-muted-foreground">Immutable original · {fmtTime(checkpoint.createdAt)}. This is not your working draft.</p>
    <dl className="mt-3 space-y-3">
      {([["nextAction", "Next action"], ["understanding", "Understanding"], ["questions", "Questions / uncertainties"], ["reasoning", "Reasoning"], ["notes", "Working notes"]] as const).map(([key, label]) =>
        <div key={key}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{checkpoint[key] || <em>Empty at this checkpoint</em>}</dd></div>)}
    </dl>
  </details>;
}
