import { useEffect, useState } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { Separator } from '@/components/ui/separator';
import { validateEmail } from '@/lib/auth-client';
import { useChangeEmail, useChangePassword, useProfile } from '@/lib/queries';

type AccountPageProps = {
  open: boolean;
};

/**
 * Account & security settings: change the sign-in email and password. Email
 * is the authoritative identity — it is shown as your profile email wherever
 * you are attributed — so it is edited here through the Auth surface rather
 * than on the Profile page.
 */
export function AccountPage({ open }: AccountPageProps) {
  const profile = useProfile();

  if (!open) return null;

  if (profile.isLoading && !profile.data) {
    return <p className="text-sm text-muted-foreground">Loading account…</p>;
  }

  if (profile.isError || !profile.data) {
    return (
      <p className="text-sm text-destructive">
        {(profile.error as Error | undefined)?.message ??
          'Account settings are unavailable right now.'}
      </p>
    );
  }

  const currentEmail = profile.data.email ?? '';

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div>
          <h2 className="text-base font-medium">Account</h2>
          <p className="text-sm text-muted-foreground">
            Your sign-in credentials. Your email is also shown as your profile email wherever you
            are attributed.
          </p>
        </div>

        <div className="space-y-5 rounded-lg border p-4">
          <EmailForm currentEmail={currentEmail} />
          <Separator />
          <PasswordForm />
        </div>
      </div>
    </div>
  );
}

function EmailForm({ currentEmail }: { currentEmail: string }) {
  const changeEmail = useChangeEmail();
  const [draft, setDraft] = useState(currentEmail);
  const [saveState, setSaveState] = useState<ButtonLoadingState>('default');
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the underlying email changes (e.g. after a save/refetch).
  useEffect(() => {
    setDraft(currentEmail);
  }, [currentEmail]);

  async function handleSave() {
    const next = draft.trim();
    if (next.toLowerCase() === currentEmail.trim().toLowerCase()) return;
    const validationError = validateEmail(next);
    if (validationError) {
      setError(validationError);
      setSaveState('error');
      return;
    }

    setSaveState('loading');
    setError(null);
    try {
      await changeEmail.mutateAsync(next);
      setSaveState('success');
    } catch (err) {
      setSaveState('error');
      setError(err instanceof Error ? err.message : 'Failed to update email.');
    }
  }

  return (
    <div className="grid max-w-lg gap-2">
      <Label htmlFor="account-email">Email</Label>
      <div className="flex gap-2">
        <Input
          id="account-email"
          type="email"
          autoComplete="email"
          value={draft}
          placeholder="you@example.com"
          className="h-8"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') void handleSave();
          }}
          disabled={saveState === 'loading'}
        />
        <LoadingButton
          buttonState={saveState}
          setButtonState={setSaveState}
          text="Save"
          loadingText="Saving…"
          successText="Saved"
          errorText="Retry"
          reset
          size="sm"
          variant="outline"
          className="h-8 shrink-0"
          onClick={handleSave}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Used to sign in and shown as your profile email.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function PasswordForm() {
  const changePassword = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saveState, setSaveState] = useState<ButtonLoadingState>('default');
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!currentPassword) {
      setError('Enter your current password.');
      setSaveState('error');
      return;
    }
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      setSaveState('error');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      setSaveState('error');
      return;
    }

    setSaveState('loading');
    setError(null);
    try {
      await changePassword.mutateAsync({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSaveState('success');
    } catch (err) {
      setSaveState('error');
      setError(err instanceof Error ? err.message : 'Failed to update password.');
    }
  }

  return (
    <div className="grid max-w-lg gap-3">
      <Label>Password</Label>
      <Input
        id="account-current-password"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        placeholder="Current password"
        className="h-8"
        onChange={e => setCurrentPassword(e.target.value)}
        disabled={saveState === 'loading'}
      />
      <Input
        id="account-new-password"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        placeholder="New password"
        className="h-8"
        onChange={e => setNewPassword(e.target.value)}
        disabled={saveState === 'loading'}
      />
      <Input
        id="account-confirm-password"
        type="password"
        autoComplete="new-password"
        value={confirmPassword}
        placeholder="Confirm new password"
        className="h-8"
        onChange={e => setConfirmPassword(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') void handleSave();
        }}
        disabled={saveState === 'loading'}
      />
      <div className="flex items-center gap-3">
        <LoadingButton
          buttonState={saveState}
          setButtonState={setSaveState}
          text="Change password"
          loadingText="Saving…"
          successText="Changed"
          errorText="Retry"
          reset
          size="sm"
          variant="outline"
          className="h-8"
          onClick={handleSave}
        />
        <p className="text-xs text-muted-foreground">At least 8 characters.</p>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
