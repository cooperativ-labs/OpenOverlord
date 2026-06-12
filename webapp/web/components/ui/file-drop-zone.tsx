import { Upload } from 'lucide-react';
import { type DragEvent, type KeyboardEvent, type ReactNode, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

export type FileDropZoneProps = {
  /** Called with the accepted files the user dropped or picked. */
  onFiles: (files: File[]) => void;
  /** Disable interaction (e.g. while an upload is in flight). */
  disabled?: boolean;
  /** Allow selecting/dropping more than one file at once. Defaults to true. */
  multiple?: boolean;
  /** `accept` attribute forwarded to the file input (does not gate dropped files). */
  accept?: string;
  /** Reject files larger than this many bytes, reporting each via `onError`. */
  maxSizeBytes?: number;
  /** Called with a human-readable message when a file is rejected. */
  onError?: (message: string) => void;
  /** Replaces the default prompt rendered inside the drop target. */
  children?: ReactNode;
  className?: string;
  /** Accessible label for the drop target. */
  label?: string;
};

/**
 * A reusable file drop target. Users can drag files onto it or click it to open
 * the file browser; accepted files are handed to `onFiles`. Unlike the
 * image-only {@link import('./image-dropzone').ImageDropzone}, it accepts any
 * file type — pair it with an upload hook for attachment surfaces.
 */
export function FileDropZone({
  onFiles,
  disabled = false,
  multiple = true,
  accept,
  maxSizeBytes,
  onError,
  children,
  className,
  label = 'Upload files'
}: FileDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  function acceptFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const accepted: File[] = [];
    for (const file of Array.from(list)) {
      if (maxSizeBytes !== undefined && file.size > maxSizeBytes) {
        onError?.(`"${file.name}" is too large.`);
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length > 0) onFiles(multiple ? accepted : accepted.slice(0, 1));
  }

  function openBrowser() {
    if (!disabled) inputRef.current?.click();
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    if (disabled) return;
    acceptFiles(event.dataTransfer.files);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!disabled) setDragActive(true);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openBrowser();
    }
  }

  return (
    <>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-disabled={disabled}
        onClick={openBrowser}
        onKeyDown={handleKeyDown}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border bg-muted/20 px-4 py-5 text-center text-sm text-muted-foreground outline-none transition-colors',
          'hover:border-muted-foreground/40 hover:bg-muted/40',
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
          dragActive && 'border-primary/60 bg-primary/5 text-foreground',
          disabled && 'pointer-events-none opacity-60',
          className
        )}
      >
        {children ?? (
          <>
            <Upload className="h-5 w-5" />
            <span>
              <span className="font-medium text-foreground">Click to upload</span> or drag and drop
            </span>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        accept={accept}
        className="sr-only"
        disabled={disabled}
        onChange={event => {
          acceptFiles(event.target.files);
          // Reset so selecting the same file again still fires onChange.
          event.target.value = '';
        }}
      />
    </>
  );
}
