import { type ReactNode } from 'react';

import { AuthScreen } from '@/components/auth/AuthScreen';
import { authClient } from '@/lib/auth-client';

type AuthGateProps = {
  children: ReactNode;
};

export function AuthGate({ children }: AuthGateProps) {
  const session = authClient.useSession();

  if (session.isPending) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background px-4 text-sm text-muted-foreground">
        Loading account…
      </main>
    );
  }

  if (!session.data) {
    return (
      <AuthScreen
        onAuthenticated={async () => {
          await session.refetch();
        }}
      />
    );
  }

  return children;
}
