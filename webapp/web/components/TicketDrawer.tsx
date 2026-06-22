import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'ticket-drawer-width';
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 320;
const MAX_WIDTH = 640;

export function TicketDrawer({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const isDragging = useRef(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    const parsed = Number(stored);
    if (parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) setWidth(parsed);
  }, []);

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      isDragging.current = true;
      const startX = e.clientX;
      const startWidth = width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onPointerMove = (ev: PointerEvent) => {
        if (!isDragging.current) return;
        const delta = ev.clientX - startX;
        const nextWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth - delta));
        setWidth(nextWidth);
      };

      const onPointerUp = () => {
        isDragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        setWidth(current => {
          localStorage.setItem(STORAGE_KEY, String(current));
          return current;
        });
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
      };

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    },
    [width]
  );

  return (
    <aside
      className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-(--color-border)"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize ticket panel"
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-accent/20"
        onPointerDown={onResizePointerDown}
      />
      <div className="min-h-0 flex-1 overflow-hidden bg-(--color-surface-0)">{children}</div>
    </aside>
  );
}
