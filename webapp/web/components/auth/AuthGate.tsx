import { type ReactNode } from 'react';

import { AuthScreen } from '@/components/auth/AuthScreen';
import { authClient } from '@/lib/auth-client';

type AuthGateProps = {
  children: ReactNode;
};

export function AuthGate({ children }: AuthGateProps) {
  const session = authClient.useSession();

  if (session.isPending) {
    return <div className="min-h-dvh bg-background" />;
  }

  if (!session.data) {
    return <AuthScreen onAuthenticated={() => session.refetch()} />;
  }

  return children;
}
