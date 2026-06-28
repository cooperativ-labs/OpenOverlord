import { Cloud, Loader2, Plus, Server, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type BackendProfileRow = {
  id: string;
  label: string;
  mode: 'local' | 'remote';
  backendUrl: string;
};

export function BackendPage() {
  const bridge = typeof window === 'undefined' ? undefined : window.overlord;
  const [profiles, setProfiles] = useState<BackendProfileRow[]>([]);
  const [activeId, setActiveId] = useState<string>('local');
  const [label, setLabel] = useState('Overlord Cloud');
  const [backendUrl, setBackendUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge?.listBackends || !bridge.getActiveBackend) return;
    const [listed, active] = await Promise.all([bridge.listBackends(), bridge.getActiveBackend()]);
    setProfiles(listed);
    setActiveId(active.id);
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!bridge?.switchBackend) {
    return (
      <div className="space-y-2 text-sm text-muted-foreground">
        Backend switching is available in the Overlord desktop app.
      </div>
    );
  }

  async function handleAddBackend() {
    if (!bridge?.addBackend) return;
    setError(null);
    setBusy(true);
    try {
      await bridge.addBackend({ label, backendUrl });
      setBackendUrl('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add backend.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSwitch(id: string) {
    if (!bridge?.switchBackend || id === activeId) return;
    setError(null);
    setSwitchingId(id);
    try {
      await bridge.switchBackend(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch backend.');
      setSwitchingId(null);
    }
  }

  async function handleRemove(id: string) {
    if (!bridge?.removeBackend) return;
    setError(null);
    setBusy(true);
    try {
      await bridge.removeBackend(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove backend.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Backend</h2>
        <p className="text-sm text-muted-foreground">
          Choose whether this desktop app uses your local SQLite database or a hosted Postgres
          backend. Switching reloads the app and requires signing in again for that backend.
          The CLI backend URL in <code className="text-xs">~/.ovld/overlord.toml</code> updates
          with this switch, but CLI auth does not — run <code className="text-xs">ovld auth status</code>{' '}
          after changing backends.
        </p>
      </div>

      <div className="space-y-3">
        {profiles.map(profile => {
          const isActive = profile.id === activeId;
          const switching = switchingId === profile.id;
          return (
            <div
              key={profile.id}
              className="flex items-start justify-between gap-3 rounded-lg border bg-card p-4"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  {profile.mode === 'local' ? (
                    <Server className="size-4 shrink-0" />
                  ) : (
                    <Cloud className="size-4 shrink-0" />
                  )}
                  <p className="font-medium">{profile.label}</p>
                  {isActive ? (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                      Active
                    </span>
                  ) : null}
                </div>
                <p className="truncate text-xs text-muted-foreground" title={profile.backendUrl}>
                  {profile.backendUrl}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!isActive ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={Boolean(switchingId) || busy}
                    onClick={() => void handleSwitch(profile.id)}
                  >
                    {switching ? <Loader2 className="animate-spin" /> : null}
                    Switch
                  </Button>
                ) : null}
                {profile.mode === 'remote' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={Boolean(switchingId) || busy}
                    onClick={() => void handleRemove(profile.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <Plus className="size-4" />
          <h3 className="font-medium">Add cloud backend</h3>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="backend-label">Label</Label>
            <Input
              id="backend-label"
              value={label}
              onChange={event => setLabel(event.target.value)}
              disabled={busy || Boolean(switchingId)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="backend-url">Backend URL</Label>
            <Input
              id="backend-url"
              placeholder="https://overlord-backend-production.up.railway.app"
              value={backendUrl}
              onChange={event => setBackendUrl(event.target.value)}
              disabled={busy || Boolean(switchingId)}
            />
          </div>
        </div>
        <Button
          disabled={busy || Boolean(switchingId) || backendUrl.trim().length === 0}
          onClick={() => void handleAddBackend()}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          Add backend
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}
