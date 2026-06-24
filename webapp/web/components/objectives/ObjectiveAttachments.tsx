import { FileText, ImageIcon, Loader2, Plus, Trash2 } from 'lucide-react';
import {
  type ChangeEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useRef,
  useState
} from 'react';

import type { ObjectiveAttachmentDto } from '../../../shared/contract.ts';
import {
  useDeleteObjectiveAttachment,
  useObjectiveAttachments,
  useUploadObjectiveAttachment
} from '../../lib/queries.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { type FileDropZoneDragState, useFileDropZone } from '../ui/file-drop-zone.tsx';

/** Client-side mirror of the server's per-attachment ceiling. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_LABEL = '25 MB';

function formatFileSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * Owns the attachment data + upload/remove flow for one objective, plus the
 * drag-and-drop state so a parent can wrap its whole surface in a
 * {@link import('../ui/file-drop-zone').FileDropZone}. File picking is exposed
 * via `inputRef` + `handleInputChange` for a trigger button.
 */
export function useObjectiveAttachmentState(
  objectiveId: string,
  { dropDisabled = false }: { dropDisabled?: boolean } = {}
) {
  const { data: attachments = [], isLoading } = useObjectiveAttachments(objectiveId);
  const upload = useUploadObjectiveAttachment(objectiveId);
  const remove = useDeleteObjectiveAttachment(objectiveId);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: File[]) => {
      setError(null);
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          setError(`File too large. Attachments can be no longer than ${MAX_ATTACHMENT_LABEL}.`);
          continue;
        }
        try {
          await upload.mutateAsync(file);
        } catch (err) {
          setError(err instanceof Error ? err.message : `Failed to upload "${file.name}".`);
          break;
        }
      }
    },
    [upload]
  );

  const dragState = useFileDropZone({
    onDrop: handleFiles,
    disabled: dropDisabled || upload.isPending
  });

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (event.target.files && event.target.files.length > 0) {
        void handleFiles(Array.from(event.target.files));
        // Reset so picking the same file again still fires onChange.
        event.target.value = '';
      }
    },
    [handleFiles]
  );

  const handleRemove = useCallback(
    (id: string) => {
      setError(null);
      setRemovingId(id);
      remove.mutate(id, {
        onError: err =>
          setError(err instanceof Error ? err.message : 'Failed to remove attachment.'),
        onSettled: () => setRemovingId(null)
      });
    },
    [remove]
  );

  return {
    attachments,
    isLoading,
    error,
    removingId,
    isUploading: upload.isPending,
    inputRef,
    handleFiles,
    handleInputChange,
    handleRemove,
    dragState
  };
}

export type ObjectiveAttachmentState = ReturnType<typeof useObjectiveAttachmentState>;
export type { FileDropZoneDragState };

function AttachmentIcon({ contentType }: { contentType: string | null }) {
  if (contentType?.startsWith('image/')) {
    return <ImageIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
  return <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

type ObjectiveAttachmentListProps = {
  attachments: ObjectiveAttachmentDto[];
  removingId: string | null;
  onRemove: (id: string) => void;
  className?: string;
  /** Match Overlord toolbar padding when rendered above the upload trigger row. */
  toolbar?: boolean;
};

/**
 * Compact attachment rows: type icon, downloadable filename, size, and a
 * hover-revealed remove button — matching Overlord's attachment list look.
 */
export function ObjectiveAttachmentList({
  attachments,
  removingId,
  onRemove,
  className,
  toolbar = false
}: ObjectiveAttachmentListProps) {
  if (attachments.length === 0) return null;

  return (
    <div className={cn('space-y-0.5', toolbar ? 'px-2 pb-0 pt-1' : undefined, className)}>
      {attachments.map(attachment => (
        <div
          key={attachment.id}
          className="group flex min-h-8 items-center gap-2 rounded px-2 py-1 hover:bg-muted/40"
        >
          <AttachmentIcon contentType={attachment.contentType} />
          <a
            href={attachment.url}
            download={attachment.filename}
            className="min-w-0 flex-1 truncate text-left text-xs hover:underline"
            title={attachment.filename}
          >
            {attachment.filename}
          </a>
          {attachment.sizeBytes !== null ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {formatFileSize(attachment.sizeBytes)}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            disabled={removingId === attachment.id}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-50"
            aria-label={`Remove ${attachment.filename}`}
            title="Remove"
          >
            {removingId === attachment.id ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
          </button>
        </div>
      ))}
    </div>
  );
}

type ObjectiveAttachmentUploadTriggerProps = {
  attachmentsCount: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  children?: ReactNode;
};

/**
 * Footer row with a + button that opens the file picker. Drop handling is owned
 * by a parent {@link import('../ui/file-drop-zone').FileDropZone}.
 */
export function ObjectiveAttachmentUploadTrigger({
  attachmentsCount,
  inputRef,
  onInputChange,
  disabled = false,
  children
}: ObjectiveAttachmentUploadTriggerProps) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        aria-label="Upload objective attachment"
        title="Upload attachment"
      >
        <Plus size={18} />
      </Button>
      <div className="min-w-0 flex-1" />
      {attachmentsCount > 0 ? (
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums leading-none">
          {attachmentsCount}
        </span>
      ) : null}
      <input ref={inputRef} type="file" multiple className="hidden" onChange={onInputChange} />
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}
