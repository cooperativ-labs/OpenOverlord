import { Cloud, Loader2, Plus, Server } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { DEFAULT_CLOUD_BACKEND_URL } from '@/lib/backend-defaults';
import { cn } from '@/lib/utils';

type BackendProfileRow = {
  id: string;
  label: string;
  mode: 'local' | 'remote';
  backendUrl: string;
};

type BackendLoginPanelProps = {
  /**
   * When true, the panel renders as a bare section without its own card chrome,
   * so it can sit inside a larger surface (e.g. the auth card) alongside the
   * credentials form instead of floating as a separate card.
   */
  embedded?: boolean;
};

export function BackendLoginPanel({ embedded = false }: BackendLoginPanelProps) {
  const bridge = typeof window === 'undefined' ? undefined : window.overlord;
  const [profiles, setProfiles] = useState<BackendProfileRow[]>([]);
  const [activeId, setActiveId] = useState<string>('local');
  const [activeUrl, setActiveUrl] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [label, setLabel] = useState('Overlord Cloud');
  const [backendUrl, setBackendUrl] = useState(DEFAULT_CLOUD_BACKEND_URL);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge?.listBackends || !bridge.getActiveBackend) return;
    const [listed, active] = await Promise.all([bridge.listBackends(), bridge.getActiveBackend()]);
    setProfiles(listed);
    setActiveId(active.id);
    setActiveUrl(active.backendUrl);
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!bridge?.switchBackend) {
    return null;
  }

  const activeProfile = profiles.find(profile => profile.id === activeId);
  const isBusy = busy || Boolean(switchingId);

  async function handleSwitch(nextId: string | null) {
    if (!bridge?.switchBackend || !nextId || nextId === activeId) return;
    setError(null);
    setSwitchingId(nextId);
    try {
      await bridge.switchBackend(nextId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch backend.');
      setSwitchingId(null);
    }
  }

  async function handleAddBackend() {
    if (!bridge?.addBackend) return;
    setError(null);
    setBusy(true);
    try {
      const created = await bridge.addBackend({ label, backendUrl });
      setBackendUrl(DEFAULT_CLOUD_BACKEND_URL);
      setShowAddForm(false);
      await bridge.switchBackend?.(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add backend.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn('space-y-3', embedded ? '' : 'mb-5 rounded-lg border bg-card p-4')}>
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Backend</p>
        <p className="text-sm text-muted-foreground">Sign in to this Overlord instance.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="auth-backend-select">Instance</Label>
        <Select
          value={activeId}
          disabled={isBusy}
          onValueChange={value => void handleSwitch(value)}
        >
          <SelectTrigger id="auth-backend-select" className="w-full">
            <SelectValue>
              <span className="flex items-center gap-2">
                {activeProfile?.mode === 'remote' ? (
                  <Cloud className="size-4 shrink-0" />
                ) : (
                  <Server className="size-4 shrink-0" />
                )}
                {activeProfile?.label ?? 'Backend'}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {profiles.map(profile => (
              <SelectItem key={profile.id} value={profile.id}>
                <span className="flex items-center gap-2">
                  {profile.mode === 'remote' ? (
                    <Cloud className="size-4 shrink-0" />
                  ) : (
                    <Server className="size-4 shrink-0" />
                  )}
                  {profile.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="truncate text-xs text-muted-foreground" title={activeUrl}>
          {switchingId ? 'Switching backend…' : activeUrl}
        </p>
      </div>

      {showAddForm ? (
        <div className="space-y-3 border-t pt-3">
          <div className="space-y-2">
            <Label htmlFor="auth-backend-label">Label</Label>
            <Input
              id="auth-backend-label"
              value={label}
              onChange={event => setLabel(event.target.value)}
              disabled={isBusy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="auth-backend-url">Backend URL</Label>
            <Input
              id="auth-backend-url"
              placeholder={DEFAULT_CLOUD_BACKEND_URL}
              value={backendUrl}
              onChange={event => setBackendUrl(event.target.value)}
              disabled={isBusy}
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={isBusy || backendUrl.trim().length === 0}
              onClick={() => void handleAddBackend()}
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              Add and switch
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={isBusy}
              onClick={() => {
                setShowAddForm(false);
                setBackendUrl(DEFAULT_CLOUD_BACKEND_URL);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="w-full"
          disabled={isBusy}
          onClick={() => {
            setBackendUrl(DEFAULT_CLOUD_BACKEND_URL);
            setShowAddForm(true);
          }}
        >
          <Plus className="size-4" />
          Add backend
        </Button>
      )}

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}
