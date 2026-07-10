import { AlertTriangle, Check, Loader2, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchApi } from '@/lib/api-transport';

type OAuthRequestInfo = {
  clientName: string;
  redirectUri: string;
  redirectHost: string;
  resource: string;
  scopes: string[];
};

type OAuthDecisionResponse = {
  redirectTo: string;
};

function oauthParams(): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(window.location.search).entries());
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    error_description?: string;
    detail?: string;
  } | null;
  if (!response.ok) {
    throw new Error(
      payload?.error_description ??
        payload?.detail ??
        payload?.error ??
        `${response.status} ${response.statusText}`
    );
  }
  return payload as T;
}

async function postOAuth<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetchApi(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return parseJsonResponse<T>(response);
}

function scopeLabel(scope: string): string {
  switch (scope) {
    case 'overlord.workspace.read':
      return 'Read workspace';
    case 'overlord.mission.read':
      return 'Read missions';
    case 'overlord.mission.write':
      return 'Create and update missions';
    case 'overlord.session.write':
      return 'Attach, update, and deliver sessions';
    default:
      return scope;
  }
}

export function OAuthApprovePage() {
  const params = useMemo(oauthParams, []);
  const [requestInfo, setRequestInfo] = useState<OAuthRequestInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyDecision, setBusyDecision] = useState<'approve' | 'deny' | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    void postOAuth<OAuthRequestInfo>('/oauth/authorize/request', params)
      .then(info => {
        if (alive) setRequestInfo(info);
      })
      .catch(err => {
        if (alive) setError(err instanceof Error ? err.message : 'Could not load OAuth request.');
      });
    return () => {
      alive = false;
    };
  }, [params]);

  async function decide(decision: 'approve' | 'deny') {
    setBusyDecision(decision);
    setError(null);
    try {
      const result = await postOAuth<OAuthDecisionResponse>('/oauth/authorize/approve', {
        ...params,
        decision
      });
      window.location.assign(result.redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not finish OAuth request.');
      setBusyDecision(null);
    }
  }

  return (
    <main className="flex h-dvh items-center justify-center overflow-y-auto bg-muted/25 px-4 py-6">
      <Card className="my-auto w-full max-w-md rounded-xl border bg-background shadow-xl shadow-black/5">
        <CardHeader className="space-y-1 pb-4">
          <CardTitle className="text-lg">Approve MCP connection</CardTitle>
          <CardDescription>
            Allow this client to access your workspace with the permissions below.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {!requestInfo && !error ? (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading request…
            </div>
          ) : null}

          {error ? (
            <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {requestInfo ? (
            <>
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{requestInfo.clientName}</p>
                <p className="text-xs text-muted-foreground">
                  Redirects to {requestInfo.redirectHost}
                </p>
                <p className="text-xs text-muted-foreground">
                  Connects to {new URL(requestInfo.resource).host}
                </p>
              </div>

              <ul className="space-y-1.5 text-sm">
                {requestInfo.scopes.map(scope => (
                  <li key={scope} className="flex items-center gap-2">
                    <Check className="size-3.5 shrink-0 text-primary" />
                    {scopeLabel(scope)}
                  </li>
                ))}
              </ul>

              <p className="text-xs leading-relaxed text-muted-foreground">
                Approval creates a scoped token limited to these capabilities in workspaces you can
                access.
              </p>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busyDecision !== null}
                  onClick={() => void decide('deny')}
                >
                  {busyDecision === 'deny' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <X className="size-4" />
                  )}
                  Deny
                </Button>
                <Button
                  type="button"
                  disabled={busyDecision !== null}
                  onClick={() => void decide('approve')}
                >
                  {busyDecision === 'approve' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="size-4" />
                  )}
                  Approve
                </Button>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
