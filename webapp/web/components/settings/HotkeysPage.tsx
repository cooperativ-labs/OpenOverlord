import { useEffect, useState } from 'react';

import { HotkeyCaptureButton } from '@/components/settings/HotkeyCaptureButton';
import { Button } from '@/components/ui/button';
import { getDesktopChrome } from '@/lib/desktop-chrome';

type HotkeyItem = {
  action: string;
  shortcut: string;
};

export function HotkeysPage() {
  const { isDesktop } = getDesktopChrome();
  const [items, setItems] = useState<HotkeyItem[]>([]);

  const [quickTaskAccelerator, setQuickTaskAccelerator] = useState<string | null>(null);
  const [defaultQuickTaskAccelerator, setDefaultQuickTaskAccelerator] = useState<string>('');
  const [isSavingHotkey, setIsSavingHotkey] = useState(false);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);

  useEffect(() => {
    const isMac =
      typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
    setItems([
      { action: 'Focus mission search', shortcut: isMac ? '⌘F' : 'Ctrl+F' },
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
                <HotkeyCaptureButton
                  value={quickTaskAccelerator}
                  onCapture={accel => void persistHotkey(accel)}
                  disabled={isSavingHotkey}
                />
                {quickTaskAccelerator !== defaultQuickTaskAccelerator ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void persistHotkey(defaultQuickTaskAccelerator)}
                    disabled={isSavingHotkey}
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
