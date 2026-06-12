import { type DragEvent, type ReactNode, useId, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/** Image media types the dropzone accepts, mirroring the upload service. */
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const ACCEPT_ATTR = ACCEPTED_TYPES.join(',');

export type ImageDropzoneProps = {
  /**
   * Called with a validated image File when the user drops one or picks one
   * through the file browser. The caller performs the actual upload; the
   * dropzone only owns the drag/drop + click-to-browse interaction.
   */
  onSelect: (file: File) => void | Promise<void>;
  /** Visible content (e.g. an avatar preview). Rendered inside the drop target. */
  children: ReactNode;
  /** Disables interaction (e.g. while an upload is in flight). */
  disabled?: boolean;
  /** Shown when the dropped file is not an accepted image type. */
  onError?: (message: string) => void;
  className?: string;
  /** Accessible label for the click-to-browse control. */
  label?: string;
};

/**
 * A reusable image drop target. Users can drag an image onto it or click it to
 * open the file browser; the selected File is handed to `onSelect`. This is the
 * shared front-end half of the core upload service — pair it with
 * `api.uploadImage` (or a hook around it) for any image-upload surface.
 */
export function ImageDropzone({
  onSelect,
  children,
  disabled = false,
  onError,
  className,
  label = 'Upload an image'
}: ImageDropzoneProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      onError?.('Unsupported image type. Use a PNG, JPEG, GIF, or WebP image.');
      return;
    }
    void onSelect(file);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragActive(false);
    if (disabled) return;
    handleFiles(event.dataTransfer.files);
  }

  function handleDragOver(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (!disabled) setDragActive(true);
  }

  return (
    <>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={cn(
          'group relative inline-flex items-center justify-center overflow-hidden rounded-full outline-none transition',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'disabled:cursor-not-allowed disabled:opacity-60',
          dragActive && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
          className
        )}
      >
        {children}
        <span
          className={cn(
            'pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-black/55 text-[10px] font-medium text-white opacity-0 transition-opacity',
            'group-hover:opacity-100 group-focus-visible:opacity-100',
            dragActive && 'opacity-100'
          )}
        >
          {dragActive ? 'Drop' : 'Change'}
        </span>
      </button>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={ACCEPT_ATTR}
        className="sr-only"
        disabled={disabled}
        onChange={event => {
          handleFiles(event.target.files);
          // Reset so selecting the same file again still fires onChange.
          event.target.value = '';
        }}
      />
    </>
  );
}
