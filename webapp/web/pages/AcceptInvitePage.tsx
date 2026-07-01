import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAcceptWorkspaceInvitation } from '@/lib/queries';

/** Reads `?token=` from the current URL without a router-level search schema. */
function tokenFromLocation(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('token');
}

/**
 * Lands here from the invite email's "Accept Invite" link
 * (`backend/email-templates/invite-user.ts` → `inviteAcceptUrl`). The browser
 * router mounts this page outside the normal workspace-gated shell (see
 * `router.tsx`) since an invitee may have zero workspace memberships until
 * this page's accept call succeeds.
 */
export function AcceptInvitePage() {
  const navigate = useNavigate();
  const { mutate: acceptInvitation } = useAcceptWorkspaceInvitation();
  const [status, setStatus] = useState<'pending' | 'success' | 'error'>('pending');
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    const token = tokenFromLocation();
    if (!token) {
      setStatus('error');
      setError('This invite link is missing its token.');
      return;
    }

    acceptInvitation(
      { token },
      {
        onSuccess: () => setStatus('success'),
        onError: err => {
          setStatus('error');
          setError(err instanceof Error ? err.message : 'Failed to accept the invitation.');
        }
      }
    );
  }, [acceptInvitation]);

  return (
    <div className="flex h-dvh items-center justify-center overflow-y-auto bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{status === 'success' ? "You're in." : 'Joining workspace…'}</CardTitle>
          <CardDescription>
            {status === 'pending' && 'Accepting your invitation…'}
            {status === 'success' && 'Your invitation has been accepted.'}
            {status === 'error' && (error ?? 'This invitation could not be accepted.')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status === 'success' ? (
            <Button className="w-full" onClick={() => void navigate({ to: '/workspace' })}>
              Go to workspace
            </Button>
          ) : null}
          {status === 'error' ? (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => void navigate({ to: '/workspace' })}
            >
              Back to Overlord
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
