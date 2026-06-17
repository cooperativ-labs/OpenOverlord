import { Check, Copy, KeyRound, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { Separator } from '@/components/ui/separator';
import {
  useCreateUserToken,
  useRenameUserToken,
  useRevokeUserToken,
  useUserTokens
} from '@/lib/queries';

import type { UserTokenDto, UserTokenStatus } from '../../../shared/contract.ts';

type UserTokensPageProps = {
  open: boolean;
};

/** Human-readable date, or an em-dash when absent. */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const STATUS_VARIANT: Record<UserTokenStatus, 'secondary' | 'outline' | 'destructive'> = {
  active: 'secondary',
  revoked: 'destructive',
  expired: 'outline',
  rotated: 'outline'
};

/** Whether a token's expiry has passed, so we can present it as expired. */
function isExpired(token: UserTokenDto): boolean {
  return Boolean(token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now());
}

export function UserTokensPage({ open }: UserTokensPageProps) {
  const tokens = useUserTokens();

  if (!open) return null;

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h2 className="text-base font-medium">Access tokens</h2>
        <p className="text-sm text-muted-foreground">
          Long-lived tokens authenticate the CLI, agents, and runners as you for non-interactive
          use. A token carries your permissions; treat it like a password. The secret is shown only
          once when created.
        </p>
      </div>

      <CreateTokenForm />

      <Separator />

      <div className="space-y-3">
        <h3 className="text-sm font-medium">Your tokens</h3>
        {tokens.isLoading && !tokens.data ? (
          <p className="text-sm text-muted-foreground">Loading tokens…</p>
        ) : tokens.isError ? (
          <p className="text-sm text-destructive">
            {(tokens.error as Error | undefined)?.message ?? 'Tokens are unavailable right now.'}
          </p>
        ) : !tokens.data || tokens.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">You haven&apos;t created any tokens yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {tokens.data.map(token => (
              <TokenRow key={token.id} token={token} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CreateTokenForm() {
  const createToken = useCreateUserToken();
  const [label, setLabel] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [createState, setCreateState] = useState<ButtonLoadingState>('default');
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  async function handleCreate() {
    const trimmed = label.trim();
    if (!trimmed) {
      setError('Enter a label for the token.');
      setCreateState('error');
      return;
    }
    setCreateState('loading');
    setError(null);
    try {
      const result = await createToken.mutateAsync({
        label: trimmed,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null
      });
      setSecret(result.secret);
      setLabel('');
      setExpiresAt('');
      setCreateState('success');
    } catch (err) {
      setCreateState('error');
      setError(err instanceof Error ? err.message : 'Failed to create token.');
    }
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Create a token</h3>
      </div>

      {secret ? (
        <NewSecret secret={secret} onDismiss={() => setSecret(null)} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="grid gap-2">
            <Label htmlFor="token-label">Label</Label>
            <Input
              id="token-label"
              value={label}
              placeholder="e.g. macbook runner"
              className="h-8"
              onChange={e => setLabel(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void handleCreate();
              }}
              disabled={createState === 'loading'}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="token-expiry">Expires (optional)</Label>
            <Input
              id="token-expiry"
              type="date"
              value={expiresAt}
              className="h-8"
              onChange={e => setExpiresAt(e.target.value)}
              disabled={createState === 'loading'}
            />
          </div>
          <LoadingButton
            buttonState={createState}
            setButtonState={setCreateState}
            text="Create token"
            loadingText="Creating…"
            successText="Created"
            errorText="Retry"
            reset
            size="sm"
            className="h-8 sm:col-span-2 sm:justify-self-start"
            onClick={handleCreate}
          />
        </div>
      )}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** The one-time reveal of a freshly created token secret, with copy-to-clipboard. */
function NewSecret({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const cliLoginCommand = `ovld auth login --token ${secret}`;

  return (
    <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
      <p className="text-xs font-medium">Copy your token now — it won&apos;t be shown again.</p>

      <CopyField label="Token" value={secret} />
      <CopyField label="CLI login" value={cliLoginCommand} />

      <Button type="button" variant="ghost" size="sm" className="h-7" onClick={onDismiss}>
        Done
      </Button>
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be unavailable; the value stays visible to copy manually */
    }
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1.5 font-mono text-xs">
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0"
          onClick={handleCopy}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

function TokenRow({ token }: { token: UserTokenDto }) {
  const renameToken = useRenameUserToken();
  const revokeToken = useRevokeUserToken();
  const [draftLabel, setDraftLabel] = useState(token.label);
  const [editing, setEditing] = useState(false);
  const [revokeState, setRevokeState] = useState<ButtonLoadingState>('default');
  const [error, setError] = useState<string | null>(null);

  const expired = isExpired(token);
  const displayStatus: UserTokenStatus =
    token.status === 'active' && expired ? 'expired' : token.status;
  const isActive = token.status === 'active' && !expired;

  async function handleRename() {
    const trimmed = draftLabel.trim();
    if (!trimmed || trimmed === token.label) {
      setEditing(false);
      setDraftLabel(token.label);
      return;
    }
    setError(null);
    try {
      await renameToken.mutateAsync({ id: token.id, body: { label: trimmed } });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename token.');
    }
  }

  async function handleRevoke() {
    if (!window.confirm(`Revoke "${token.label}"? This cannot be undone.`)) return;
    setRevokeState('loading');
    setError(null);
    try {
      await revokeToken.mutateAsync(token.id);
      setRevokeState('default');
    } catch (err) {
      setRevokeState('error');
      setError(err instanceof Error ? err.message : 'Failed to revoke token.');
    }
  }

  return (
    <li className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          {editing ? (
            <Input
              value={draftLabel}
              className="h-7 max-w-56"
              autoFocus
              onChange={e => setDraftLabel(e.target.value)}
              onBlur={handleRename}
              onKeyDown={e => {
                if (e.key === 'Enter') void handleRename();
                if (e.key === 'Escape') {
                  setDraftLabel(token.label);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="truncate text-sm font-medium hover:underline disabled:no-underline disabled:hover:no-underline"
              onClick={() => isActive && setEditing(true)}
              disabled={!isActive}
              title={isActive ? 'Rename token' : undefined}
            >
              {token.label}
            </button>
          )}
          <Badge variant={STATUS_VARIANT[displayStatus]}>{displayStatus}</Badge>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">{token.tokenPrefix}…</p>
        <p className="text-xs text-muted-foreground">
          Created {formatDate(token.createdAt)} · Last used {formatDate(token.lastUsedAt)} ·{' '}
          {token.expiresAt ? `Expires ${formatDate(token.expiresAt)}` : 'No expiry'}
        </p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>

      {isActive ? (
        <LoadingButton
          buttonState={revokeState}
          setButtonState={setRevokeState}
          text={
            <>
              <Trash2 className="size-3.5" />
              Revoke
            </>
          }
          loadingText="Revoking…"
          errorText="Retry"
          reset
          size="sm"
          variant="ghost"
          className="h-8 shrink-0 text-destructive hover:text-destructive"
          onClick={handleRevoke}
        />
      ) : null}
    </li>
  );
}
