import { Download, FileText, Loader2, Paperclip, Upload, X } from 'lucide-react';
import { useState } from 'react';

import {
  useDeleteObjectiveAttachment,
  useObjectiveAttachments,
  useUploadObjectiveAttachment
} from '../../lib/queries.ts';
import { cn } from '../../lib/utils.ts';
import { FileDropZone } from '../ui/file-drop-zone.tsx';

/** Client-side mirror of the server's per-attachment ceiling. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

type ObjectiveAttachmentsProps = {
  objectiveId: string;
  className?: string;
};

/**
 * Drag-and-drop attachment surface for a single objective: lists existing
 * attachments (download / remove) and accepts new uploads via {@link FileDropZone}.
 */
export function ObjectiveAttachments({ objectiveId, className }: ObjectiveAttachmentsProps) {
  const { data: attachments = [], isLoading } = useObjectiveAttachments(objectiveId);
  const upload = useUploadObjectiveAttachment(objectiveId);
  const remove = useDeleteObjectiveAttachment(objectiveId);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function handleFiles(files: File[]) {
    setError(null);
    for (const file of files) {
      try {
        await upload.mutateAsync(file);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to upload "${file.name}".`);
        break;
      }
    }
  }

  function handleRemove(id: string) {
    setError(null);
    setRemovingId(id);
    remove.mutate(id, {
      onError: err =>
        setError(err instanceof Error ? err.message : 'Failed to remove attachment.'),
      onSettled: () => setRemovingId(null)
    });
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Paperclip className="h-3.5 w-3.5" />
        <span>Attachments{attachments.length > 0 ? ` (${attachments.length})` : ''}</span>
      </div>

      {attachments.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {attachments.map(attachment => (
            <li
              key={attachment.id}
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5"
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground" title={attachment.filename}>
                  {attachment.filename}
                </p>
                {attachment.sizeBytes != null ? (
                  <p className="text-[11px] text-muted-foreground">
                    {formatFileSize(attachment.sizeBytes)}
                  </p>
                ) : null}
              </div>
              <a
                href={attachment.url}
                download={attachment.filename}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label={`Download ${attachment.filename}`}
                title="Download"
              >
                <Download className="h-3.5 w-3.5" />
              </a>
              <button
                type="button"
                onClick={() => handleRemove(attachment.id)}
                disabled={removingId === attachment.id}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                aria-label={`Remove ${attachment.filename}`}
                title="Remove"
              >
                {removingId === attachment.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <FileDropZone
        onFiles={handleFiles}
        disabled={upload.isPending}
        maxSizeBytes={MAX_ATTACHMENT_BYTES}
        onError={setError}
        label="Upload objective attachments"
      >
        {upload.isPending ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Uploading…</span>
          </>
        ) : (
          <>
            <Upload className="h-5 w-5" />
            <span>
              <span className="font-medium text-foreground">Click to upload</span> or drag and drop
            </span>
            <span className="text-[11px]">Up to 25 MB each</span>
          </>
        )}
      </FileDropZone>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {isLoading ? <p className="text-xs text-muted-foreground">Loading attachments…</p> : null}
    </div>
  );
}
