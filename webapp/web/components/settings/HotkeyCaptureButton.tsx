import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { eventToAccelerator, formatAcceleratorForDisplay } from '@/lib/accelerator';

type HotkeyCaptureButtonProps = {
  value: string;
  onCapture: (accelerator: string) => void;
  disabled?: boolean;
  placeholder?: string;
};

export function HotkeyCaptureButton({
  value,
  onCapture,
  disabled = false,
  placeholder = 'Click to set'
}: HotkeyCaptureButtonProps) {
  const [isCapturing, setIsCapturing] = useState(false);

  useEffect(() => {
    if (!isCapturing) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsCapturing(false);
        return;
      }
      const accel = eventToAccelerator(event);
      if (!accel) return;
      event.preventDefault();
      event.stopPropagation();
      setIsCapturing(false);
      onCapture(accel);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isCapturing, onCapture]);

  return (
    <button
      type="button"
      onClick={() => setIsCapturing(true)}
      disabled={disabled}
      className="min-w-[88px] rounded border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/70 disabled:opacity-60"
    >
      {isCapturing ? (
        <span className="inline-flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          Press keys…
        </span>
      ) : value ? (
        formatAcceleratorForDisplay(value)
      ) : (
        placeholder
      )}
    </button>
  );
}
