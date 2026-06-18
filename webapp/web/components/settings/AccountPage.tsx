import { useEffect, useState } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { Separator } from '@/components/ui/separator';
import { localEmailToUsername, validateLocalUsername } from '@/lib/auth-client';
import { useChangePassword, useChangeUsername, useProfile } from '@/lib/queries';

type AccountPageProps = {
  open: boolean;
};

/**
 * Account & security settings: change the sign-in username and password. The
 * username is the authoritative identity — the profile handle and (at sign-up)
 * display name mirror it — so it is edited here through the Auth surface rather
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

  const currentUsername = profile.data.handle ?? localEmailToUsername(profile.data.email);

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div>
          <h2 className="text-base font-medium">Account</h2>
          <p className="text-sm text-muted-foreground">
            Your sign-in credentials. Your username is also shown as your profile username wherever
            you are attributed.
          </p>
        </div>

        <div className="space-y-5 rounded-lg border p-4">
          <UsernameForm currentUsername={currentUsername} />
          <Separator />
          <PasswordForm />
        </div>
      </div>
    </div>
  );
}

function UsernameForm({ currentUsername }: { currentUsername: string }) {
  const changeUsername = useChangeUsername();
  const [draft, setDraft] = useState(currentUsername);
  const [saveState, setSaveState] = useState<ButtonLoadingState>('default');
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the underlying username changes (e.g. after a save/refetch).
  useEffect(() => {
    setDraft(currentUsername);
  }, [currentUsername]);

  async function handleSave() {
    const next = draft.trim();
    if (next.toLowerCase() === currentUsername.trim().toLowerCase()) return;
    const validationError = validateLocalUsername(next);
    if (validationError) {
      setError(validationError);
      setSaveState('error');
      return;
    }

    setSaveState('loading');
    setError(null);
    try {
      await changeUsername.mutateAsync(next);
      setSaveState('success');
    } catch (err) {
      setSaveState('error');
      setError(err instanceof Error ? err.message : 'Failed to update username.');
    }
  }

  return (
    <div className="grid max-w-lg gap-2">
      <Label htmlFor="account-username">Username</Label>
      <div className="flex gap-2">
        <Input
          id="account-username"
          autoComplete="username"
          value={draft}
          placeholder="e.g. ada"
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
        Used to sign in and shown as your profile username. Letters, numbers, dots, underscores, or
        dashes.
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
