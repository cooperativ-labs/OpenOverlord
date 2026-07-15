import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Trash2, Unlink } from 'lucide-react';
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
import { authClient, socialSignInFetchOptions, validateEmail } from '@/lib/auth-client';
import {
  useChangeEmail,
  useChangePassword,
  useDeleteAccount,
  useMeta,
  useProfile
} from '@/lib/queries';

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

      <LinkedAccountsSection />

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

type LinkedAccount = {
  id: string;
  providerId: string;
  accountId: string;
  createdAt: Date;
};

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .5C5.73.5.5 5.73.5 12.01c0 5.02 3.26 9.28 7.78 10.79.57.1.78-.25.78-.55 0-.27-.01-.98-.02-1.92-3.17.69-3.84-1.53-3.84-1.53-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.75 1.18 1.75 1.18 1.02 1.75 2.68 1.24 3.33.95.1-.74.4-1.24.72-1.53-2.53-.29-5.19-1.27-5.19-5.64 0-1.25.44-2.27 1.18-3.07-.12-.29-.51-1.45.11-3.02 0 0 .96-.31 3.15 1.17.91-.25 1.89-.38 2.86-.38.97 0 1.95.13 2.86.38 2.19-1.48 3.15-1.17 3.15-1.17.62 1.57.23 2.73.11 3.02.74.8 1.18 1.82 1.18 3.07 0 4.38-2.67 5.35-5.21 5.63.41.35.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.2.66.79.55A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
    </svg>
  );
}

function providerLabel(providerId: string): string {
  if (providerId === 'credential') return 'Email and password';
  return providerId
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function LinkedAccountsSection() {
  const meta = useMeta();
  const queryClient = useQueryClient();
  const accounts = useQuery({
    queryKey: ['auth', 'linked-accounts'],
    queryFn: async (): Promise<LinkedAccount[]> => {
      const result = await authClient.listAccounts();
      if (result.error) throw new Error(result.error.message ?? 'Failed to load linked accounts.');
      return result.data ?? [];
    }
  });
  const [linking, setLinking] = useState(false);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const githubEnabled = meta.data?.authProviders.github ?? false;
  const githubLinked = accounts.data?.some(account => account.providerId === 'github') ?? false;

  async function handleLinkGitHub() {
    setError(null);
    setLinking(true);
    try {
      const result = await authClient.linkSocial({
        provider: 'github',
        callbackURL: window.location.href,
        errorCallbackURL: window.location.href,
        fetchOptions: socialSignInFetchOptions()
      });
      if (result.error) throw new Error(result.error.message ?? 'Failed to link GitHub.');
      // Better Auth redirects to the provider. If a provider completes without
      // navigation, refresh the list to show the new account.
      await queryClient.invalidateQueries({ queryKey: ['auth', 'linked-accounts'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to link GitHub.');
      setLinking(false);
    }
  }

  async function handleUnlink(account: LinkedAccount) {
    if (!window.confirm(`Unlink ${providerLabel(account.providerId)}?`)) return;
    setError(null);
    setUnlinkingId(account.id);
    try {
      const result = await authClient.unlinkAccount({
        providerId: account.providerId,
        accountId: account.accountId
      });
      if (result.error) throw new Error(result.error.message ?? 'Failed to unlink account.');
      await queryClient.invalidateQueries({ queryKey: ['auth', 'linked-accounts'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlink account.');
    } finally {
      setUnlinkingId(null);
    }
  }

  return (
    <div className="space-y-4 border-t pt-8">
      <div>
        <h2 className="text-base font-medium">Linked accounts</h2>
        <p className="text-sm text-muted-foreground">
          Sign in with any connected provider. You can remove a provider as long as another sign-in
          method remains.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border p-4">
        {accounts.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading linked accounts…</p>
        ) : accounts.isError ? (
          <p className="text-sm text-destructive">
            {(accounts.error as Error).message ?? 'Linked accounts are unavailable right now.'}
          </p>
        ) : accounts.data?.length ? (
          <ul className="divide-y">
            {accounts.data.map(account => (
              <li
                key={account.id}
                className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  {account.providerId === 'github' ? (
                    <GitHubIcon className="size-4 shrink-0" />
                  ) : (
                    <Link2 className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate font-medium">{providerLabel(account.providerId)}</span>
                </div>
                {account.providerId !== 'credential' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0 text-destructive hover:text-destructive"
                    disabled={unlinkingId === account.id}
                    onClick={() => void handleUnlink(account)}
                  >
                    <Unlink className="size-3.5" />
                    {unlinkingId === account.id ? 'Unlinking…' : 'Unlink'}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No sign-in methods are linked yet.</p>
        )}

        {githubEnabled && !githubLinked ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={linking}
            onClick={() => void handleLinkGitHub()}
          >
            <GitHubIcon className="size-3.5" />
            {linking ? 'Connecting…' : 'Connect GitHub'}
          </Button>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
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
