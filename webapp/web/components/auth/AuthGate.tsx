import { type ReactNode, useEffect } from 'react';

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

  useEffect(() => {
    if (!session.data) return;
    void ensureRemoteDesktopBearerToken().catch(() => {
      /* bearer minting is best-effort; session cookies may still work for REST */
    });
  }, [session.data]);

  if (session.isPending) {
    return <div className="min-h-dvh bg-background" />;
  }

  if (!session.data) {
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
