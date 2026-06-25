import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import {
  useClearEverhourApiKey,
  useEverhourIntegration,
  useSetEverhourApiKey
} from '@/lib/queries';

export function IntegrationsPage() {
  const integration = useEverhourIntegration();
  const setKey = useSetEverhourApiKey();
  const clearKey = useClearEverhourApiKey();
  const [apiKey, setApiKey] = useState('');
  const [saveState, setSaveState] = useState<ButtonLoadingState>('default');
  const [error, setError] = useState<string | null>(null);

  const connected = integration.data?.connected ?? false;
  const accountName = integration.data?.accountName ?? null;

  async function handleConnect() {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError('Enter an Everhour API key.');
      return;
    }
    setSaveState('loading');
    setError(null);
    try {
      await setKey.mutateAsync(trimmed);
      setApiKey('');
      setSaveState('success');
    } catch (err) {
      setSaveState('error');
      setError(err instanceof Error ? err.message : 'Failed to validate the API key.');
    }
  }

  async function handleDisconnect() {
    setError(null);
    try {
      await clearKey.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect.');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Connect external services. Credentials are stored on this workspace and never sent to the
          browser.
        </p>
      </div>

      <div className="max-w-lg space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium">Everhour</h3>
            <p className="text-xs text-muted-foreground">
              Track time on missions. Each project links to an Everhour project and each mission to
              a task.
            </p>
          </div>
          {connected ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Connected
            </span>
          ) : null}
        </div>

        {connected ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {accountName ? (
                <>
                  Connected as <strong className="text-foreground">{accountName}</strong>.
                </>
              ) : (
                'An Everhour API key is configured for this workspace.'
              )}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={clearKey.isPending}
              onClick={handleDisconnect}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="everhour-api-key">API key</Label>
            <div className="flex gap-2">
              <Input
                id="everhour-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="abcd-efgh-1234567-7890ab-cdefgh12"
                className="h-8 font-mono text-xs"
                onKeyDown={e => {
                  if (e.key === 'Enter') void handleConnect();
                }}
              />
              <LoadingButton
                buttonState={saveState}
                setButtonState={setSaveState}
                text="Connect"
                loadingText="Validating…"
                successText="Connected"
                errorText="Retry"
                reset
                size="sm"
                className="h-8 shrink-0"
                onClick={handleConnect}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Find your key in your Everhour profile (Account → Profile, at the bottom).
            </p>
          </div>
        )}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}
