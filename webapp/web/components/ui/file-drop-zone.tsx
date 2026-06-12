import { Upload } from 'lucide-react';
import {
  type ComponentPropsWithoutRef,
  type DragEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState
} from 'react';

import { cn } from '@/lib/utils';

export type UseFileDropZoneOptions = {
  /** Called with the files the user dropped onto the target. */
  onDrop: (files: File[]) => void | Promise<void>;
  /** Ignore drag/drop while true (e.g. an upload is already in flight). */
  disabled?: boolean;
};

export type FileDropZoneRootProps = {
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
};

export type FileDropZoneDragState = {
  isDragOver: boolean;
  rootProps: FileDropZoneRootProps;
};

/**
 * Tracks file drag-and-drop over an element. A drag counter handles nested
 * children so moving the cursor across inner elements doesn't flicker the
 * `isDragOver` flag. Returns handlers to spread onto the drop target.
 */
export function useFileDropZone({
  onDrop,
  disabled = false
}: UseFileDropZoneOptions): FileDropZoneDragState {
  const dragCounterRef = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);

  const resetDragState = useCallback(() => {
    dragCounterRef.current = 0;
    setIsDragOver(false);
  }, []);

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;
      dragCounterRef.current += 1;
      setIsDragOver(true);
    },
    [disabled]
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;
      setIsDragOver(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      resetDragState();
      if (disabled) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) await onDrop(files);
    },
    [disabled, onDrop, resetDragState]
  );

  return {
    isDragOver: disabled ? false : isDragOver,
    rootProps: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop
    }
  };
}

export type FileDropZoneProps = Omit<ComponentPropsWithoutRef<'div'>, 'onDrop'> & {
  children: ReactNode;
  /** Called with the dropped files. */
  onDrop: (files: File[]) => void | Promise<void>;
  disabled?: boolean;
  /** Reuse drag state from {@link useFileDropZone} when a parent already owns drop handling. */
  dragState?: FileDropZoneDragState;
  /** Custom overlay; pass `null` to hide it. Omit for the default green overlay. */
  overlay?: ReactNode | null;
  /** Text shown in the default overlay. */
  label?: string;
  overlayClassName?: string;
};

/**
 * Wraps `children` in a drop target. While a file is dragged over it, a green
 * "drop to upload" overlay covers the element. Mirrors the Overlord dropzone:
 * the whole surface is droppable rather than a separate dashed box.
 */
export function FileDropZone({
  children,
  onDrop,
  disabled = false,
  dragState,
  className,
  overlay,
  label = 'Drop to upload',
  overlayClassName,
  ...rest
}: FileDropZoneProps) {
  const internalDragState = useFileDropZone({ onDrop, disabled });
  const { isDragOver, rootProps } = dragState ?? internalDragState;

  const defaultOverlay = (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-[inherit] bg-emerald-500/15 backdrop-blur-sm ring-2 ring-inset ring-emerald-500/35',
        overlayClassName
      )}
      aria-hidden
    >
      <Upload className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
      <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">{label}</span>
    </div>
  );

  return (
    <div className={cn('relative', className)} {...rootProps} {...rest}>
      {children}
      {isDragOver && overlay !== null ? (overlay === undefined ? defaultOverlay : overlay) : null}
    </div>
  );
}
