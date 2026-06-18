import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { getDesktopChrome } from '@/lib/desktop-chrome';

type HotkeyItem = {
  action: string;
  shortcut: string;
};

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

/**
 * Translate a physical key code into a stable, layout-independent label so the
 * captured accelerator matches what Electron's `globalShortcut` expects.
 */
function keyFromPhysicalCode(event: globalThis.KeyboardEvent): string | null {
  const { code } = event;
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }
  if (/^Digit\d$/.test(code)) {
    return code.slice(5);
  }
  if (/^Numpad\d$/.test(code)) {
    return `num${code.slice(6)}`;
  }
  return null;
}

/**
 * Build an Electron accelerator string (e.g. `Command+Shift+O`) from a keydown
 * event, or null when the event is not a usable shortcut (modifier-only press,
 * Escape, or no modifier held).
 */
function eventToAccelerator(event: globalThis.KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) {
    return null;
  }

  const parts: string[] = [];
  if (event.metaKey) parts.push('Command');
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  let key = keyFromPhysicalCode(event) ?? event.key;
  if (key.length === 1) {
    key = key.toUpperCase();
  } else if (/^F\d{1,2}$/.test(key)) {
    // Function keys pass through unchanged.
  } else if (key === ' ') {
    key = 'Space';
  } else if (key === 'ArrowUp') {
    key = 'Up';
  } else if (key === 'ArrowDown') {
    key = 'Down';
  } else if (key === 'ArrowLeft') {
    key = 'Left';
  } else if (key === 'ArrowRight') {
    key = 'Right';
  } else if (key === 'Escape') {
    return null;
  }

  if (parts.length === 0) {
    return null;
  }

  parts.push(key);
  return parts.join('+');
}

/** Render an accelerator using the conventional glyphs shown elsewhere in the app. */
function formatAcceleratorForDisplay(accel: string): string {
  return accel
    .replace(/CommandOrControl/gi, '⌘')
    .replace(/Command/gi, '⌘')
    .replace(/Cmd/gi, '⌘')
    .replace(/Control/gi, 'Ctrl')
    .replace(/Alt/gi, '⌥')
    .replace(/Option/gi, '⌥')
    .replace(/Shift/gi, '⇧')
    .replace(/\+/g, ' ');
}

export function HotkeysPage() {
  const { isDesktop } = getDesktopChrome();
  const [items, setItems] = useState<HotkeyItem[]>([]);

  const [quickTaskAccelerator, setQuickTaskAccelerator] = useState<string | null>(null);
  const [defaultQuickTaskAccelerator, setDefaultQuickTaskAccelerator] = useState<string>('');
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSavingHotkey, setIsSavingHotkey] = useState(false);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);

  useEffect(() => {
    const isMac =
      typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
    setItems([
      { action: 'Focus ticket search', shortcut: isMac ? '⌘F' : 'Ctrl+F' },
      { action: 'Toggle sidebar', shortcut: isMac ? '⌘B' : 'Ctrl+B' },
      { action: 'Go back', shortcut: isMac ? '⌥←' : 'Alt+←' }
    ]);
  }, []);

  useEffect(() => {
    if (!isDesktop) return;
    const api = window.overlord?.quickTask;
    if (!api) return;
    api
      .getHotkey()
      .then(result => {
        setQuickTaskAccelerator(result.accelerator);
        setDefaultQuickTaskAccelerator(result.defaultAccelerator);
      })
      .catch(() => {
        // The desktop shell is present but the hotkey could not be read; leave
        // the editor hidden rather than surfacing a transient error.
      });
  }, [isDesktop]);

  async function persistHotkey(accelerator: string) {
    const api = window.overlord?.quickTask;
    if (!api) return;
    setIsSavingHotkey(true);
    setHotkeyError(null);
    try {
      const result = await api.setHotkey(accelerator);
      if (result.ok) {
        setQuickTaskAccelerator(result.accelerator);
      } else {
        setHotkeyError(result.error ?? 'Failed to register that shortcut.');
      }
    } catch (error) {
      setHotkeyError(error instanceof Error ? error.message : 'Failed to register that shortcut.');
    } finally {
      setIsSavingHotkey(false);
    }
  }

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
      void persistHotkey(accel);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isCapturing]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Hotkeys</h2>
        <p className="text-sm text-muted-foreground">
          Keyboard shortcuts to move faster across Overlord.
        </p>
      </div>

      {isDesktop && quickTaskAccelerator !== null ? (
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">Global hotkey</h3>
            <p className="text-xs text-muted-foreground">
              Works even when Overlord is not the active app. Saved to this machine.
            </p>
          </div>
          <div className="overflow-hidden rounded-lg border">
            <div className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="grid gap-0.5">
                <span className="text-sm text-foreground">Open quick task window</span>
                <span className="text-xs text-muted-foreground">
                  Open a small floating widget to send a new task from anywhere.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsCapturing(true)}
                  disabled={isSavingHotkey}
                  className="min-w-[88px] rounded border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/70 disabled:opacity-60"
                >
                  {isCapturing ? (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Press keys…
                    </span>
                  ) : (
                    formatAcceleratorForDisplay(quickTaskAccelerator)
                  )}
                </button>
                {quickTaskAccelerator !== defaultQuickTaskAccelerator ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void persistHotkey(defaultQuickTaskAccelerator)}
                    disabled={isSavingHotkey || isCapturing}
                  >
                    Reset
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
          {hotkeyError ? <p className="text-xs text-destructive">{hotkeyError}</p> : null}
        </div>
      ) : null}

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Keyboard shortcuts</h3>
          <p className="text-xs text-muted-foreground">
            Available anywhere in the app while Overlord is focused.
          </p>
        </div>
        <div className="overflow-hidden rounded-lg border">
          {items.map((item, index) => (
            <div
              key={item.action}
              className={`flex items-center justify-between px-3 py-2.5 ${
                index < items.length - 1 ? 'border-b' : ''
              }`}
            >
              <span className="text-sm text-foreground">{item.action}</span>
              <kbd className="rounded border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                {item.shortcut}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
