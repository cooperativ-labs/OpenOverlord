import { type ReactNode, useEffect, useState } from 'react';

import { AuthScreen } from '@/components/auth/AuthScreen';
import { api } from '@/lib/api';
import { isRemoteBackend, persistDesktopBearerToken } from '@/lib/api-base';
import { authClient } from '@/lib/auth-client';

type AuthGateProps = {
  children: ReactNode;
};

async function ensureRemoteDesktopBearerToken(): Promise<void> {
  if (!isRemoteBackend()) return;
  const bridge = window.overlord;
  if (!bridge?.getActiveBackend || !bridge.getBearerToken) return;

  const active = await bridge.getActiveBackend();
  const existing = await bridge.getBearerToken(active.id);
  if (existing) {
    await persistDesktopBearerToken(existing);
    return;
  }

  const created = await api.createUserToken({ label: 'Desktop shell', scope: 'full' });
  await persistDesktopBearerToken(created.secret);
}

export function AuthGate({ children }: AuthGateProps) {
  const session = authClient.useSession();
  const [authPendingTimedOut, setAuthPendingTimedOut] = useState(false);

  useEffect(() => {
    if (!session.data) return;
    void ensureRemoteDesktopBearerToken().catch(() => {
      /* USER_TOKEN minting is best-effort once the session bearer is active */
    });
  }, [session.data]);

  useEffect(() => {
    if (!session.isPending) {
      setAuthPendingTimedOut(false);
      return;
    }

    const timeout = window.setTimeout(() => setAuthPendingTimedOut(true), 2500);
    return () => window.clearTimeout(timeout);
  }, [session.isPending]);

  if (session.isPending && !authPendingTimedOut) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background px-4 text-sm text-muted-foreground">
        Loading account…
      </main>
    );
  }

  if (!session.data || authPendingTimedOut) {
    return (
      <AuthScreen
        onAuthenticated={async () => {
          await session.refetch();
          await ensureRemoteDesktopBearerToken();
        }}
      />
    );
  }

  return children;
}
