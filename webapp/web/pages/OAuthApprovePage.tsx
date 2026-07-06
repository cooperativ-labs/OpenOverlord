import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Cable, Check, ExternalLink, Loader2, ShieldCheck, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchApi } from '@/lib/api-transport';

type OAuthRequestInfo = {
  clientName: string;
  redirectUri: string;
  redirectHost: string;
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
    detail?: string;
  } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `${response.status} ${response.statusText}`);
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
    <main className="grid min-h-dvh place-items-center bg-muted/25 px-4 py-10">
      <Card className="w-full max-w-xl rounded-xl border bg-background shadow-xl shadow-black/5">
        <CardHeader className="gap-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="rounded-xl border bg-primary/10 p-2.5 text-primary">
                <Cable className="size-5" />
              </div>
              <div>
                <CardTitle>Connect Overlord MCP</CardTitle>
                <CardDescription>
                  Approve a cloud agent connection to this workspace.
                </CardDescription>
              </div>
            </div>
            <Badge variant="secondary" className="gap-1">
              <ShieldCheck className="size-3" />
              OAuth
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
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
              <div className="rounded-lg border bg-muted/25 p-4">
                <p className="text-xs font-medium uppercase text-muted-foreground">Client</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <p className="text-base font-medium">{requestInfo.clientName}</p>
                  <Badge variant="outline" className="gap-1">
                    <ExternalLink className="size-3" />
                    {requestInfo.redirectHost}
                  </Badge>
                </div>
                <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                  {requestInfo.redirectUri}
                </p>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Requested access</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {requestInfo.scopes.map(scope => (
                    <div key={scope} className="rounded-lg border bg-background px-3 py-2 text-sm">
                      <Check className="mr-2 inline size-3.5 text-primary" />
                      {scopeLabel(scope)}
                    </div>
                  ))}
                </div>
              </div>

              <p className="text-sm leading-relaxed text-muted-foreground">
                Approval creates a scoped Overlord token for this MCP client. It can only use the
                mission lifecycle capabilities listed here and only within workspaces your account
                can already access.
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
