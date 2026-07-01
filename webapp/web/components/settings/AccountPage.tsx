import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { Separator } from '@/components/ui/separator';
import { validateEmail } from '@/lib/auth-client';
import { useChangeEmail, useChangePassword, useDeleteAccount, useProfile } from '@/lib/queries';

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

      <div className="space-y-4 border-t pt-8">
        <div>
          <h2 className="text-base font-medium text-destructive">Danger zone</h2>
          <p className="text-sm text-muted-foreground">Permanently delete your account.</p>
        </div>
        <DeleteAccountSection />
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

function DeleteAccountSection() {
  const deleteAccount = useDeleteAccount();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [deleteState, setDeleteState] = useState<ButtonLoadingState>('default');
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    setPassword('');
    setError(null);
    setDeleteState('default');
    setConfirmOpen(true);
  }

  async function handleDelete() {
    if (!password) {
      setError('Enter your password to confirm.');
      setDeleteState('error');
      return;
    }

    setDeleteState('loading');
    setError(null);
    try {
      await deleteAccount.mutateAsync(password);
      // The session cookie is already cleared server-side; reload lands on
      // the signed-out state, mirroring the sign-out flow in nav-user.tsx.
      window.location.reload();
    } catch (err) {
      setDeleteState('error');
      setError(err instanceof Error ? err.message : 'Failed to delete account.');
    }
  }

  return (
    <>
      <div className="grid gap-2">
        <p className="text-sm text-muted-foreground">
          Deleting your account removes your profile, workspace memberships, tokens, and avatar
          images. This cannot be undone.
        </p>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="w-fit gap-1.5"
          onClick={openDialog}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete account
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
            <DialogDescription>
              This permanently removes your account and cannot be undone from the UI. Enter your
              password to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="delete-account-password">Password</Label>
            <Input
              id="delete-account-password"
              type="password"
              autoComplete="current-password"
              value={password}
              className="h-8"
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void handleDelete();
              }}
              disabled={deleteState === 'loading'}
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <LoadingButton
              buttonState={deleteState}
              setButtonState={setDeleteState}
              text="Delete account"
              loadingText="Deleting…"
              errorText="Retry"
              variant="destructive"
              onClick={() => void handleDelete()}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
