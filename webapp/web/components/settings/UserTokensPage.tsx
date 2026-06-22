import { Check, Copy, KeyRound, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  useCreateUserToken,
  useRenameUserToken,
  useRevokeUserToken,
  useUserTokens
} from '@/lib/queries';

import type { TokenScope, UserTokenDto, UserTokenStatus } from '../../../shared/contract.ts';

const SCOPE_LABELS: Record<TokenScope, string> = {
  full: 'Full user privileges',
  ticket_lifecycle: 'Ticket lifecycle + runner'
};

type TokenExpiryPreset =
  | 'one_week'
  | 'one_month'
  | 'three_months'
  | 'six_months'
  | 'one_year'
  | 'no_expiration';

const TOKEN_EXPIRY_PRESETS: { value: TokenExpiryPreset; label: string }[] = [
  { value: 'one_week', label: 'One Week' },
  { value: 'one_month', label: 'One Month' },
  { value: 'three_months', label: 'Three Months' },
  { value: 'six_months', label: 'Six Months' },
  { value: 'one_year', label: 'One Year' },
  { value: 'no_expiration', label: 'No Expiration' }
];

function getTokenExpiryPresetLabel(preset: TokenExpiryPreset): string {
  return TOKEN_EXPIRY_PRESETS.find(p => p.value === preset)?.label ?? preset;
}

const DEFAULT_TOKEN_EXPIRY_PRESET: TokenExpiryPreset = 'three_months';

/** Map a UI preset to the API `expiresAt` field (omit for the 90-day backend default). */
function tokenExpiryPresetToExpiresAt(preset: TokenExpiryPreset): string | null | undefined {
  if (preset === 'no_expiration') return null;
  if (preset === 'three_months') return undefined;

  const date = new Date();
  switch (preset) {
    case 'one_week':
      date.setDate(date.getDate() + 7);
      break;
    case 'one_month':
      date.setMonth(date.getMonth() + 1);
      break;
    case 'six_months':
      date.setMonth(date.getMonth() + 6);
      break;
    case 'one_year':
      date.setFullYear(date.getFullYear() + 1);
      break;
  }
  return date.toISOString();
}

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
  const [expiryPreset, setExpiryPreset] = useState<TokenExpiryPreset>(DEFAULT_TOKEN_EXPIRY_PRESET);
  const [scope, setScope] = useState<TokenScope>('full');
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
      const expiresAt = tokenExpiryPresetToExpiresAt(expiryPreset);
      const result = await createToken.mutateAsync({
        label: trimmed,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        scope
      });
      setSecret(result.secret);
      setLabel('');
      setExpiryPreset(DEFAULT_TOKEN_EXPIRY_PRESET);
      setScope('full');
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
            <Label htmlFor="token-expiry">Expires</Label>
            <Select
              value={expiryPreset}
              onValueChange={value => setExpiryPreset(value as TokenExpiryPreset)}
              disabled={createState === 'loading'}
            >
              <SelectTrigger id="token-expiry" className="h-8">
                <SelectValue>{getTokenExpiryPresetLabel(expiryPreset)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {TOKEN_EXPIRY_PRESETS.map(preset => (
                  <SelectItem key={preset.value} value={preset.value}>
                    {preset.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2 sm:col-span-2">
            <Label>Scope</Label>
            <p className="text-xs text-muted-foreground">
              Limit what this token can do. Scopes can only narrow your own permissions, never
              exceed them.
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={scope === 'full'}
                disabled={createState === 'loading'}
                onChange={e => setScope(e.target.checked ? 'full' : 'ticket_lifecycle')}
              />
              <span>
                <span className="font-medium">{SCOPE_LABELS.full}</span>
                <span className="block text-xs text-muted-foreground">
                  Everything you can do, including creating/deleting projects and changing settings.
                  Disables the options below.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={scope === 'ticket_lifecycle'}
                disabled={scope === 'full' || createState === 'loading'}
                onChange={e => setScope(e.target.checked ? 'ticket_lifecycle' : 'full')}
              />
              <span>
                <span className="font-medium">{SCOPE_LABELS.ticket_lifecycle}</span>
                <span className="block text-xs text-muted-foreground">
                  Select, create, update, and delete tickets and objectives, plus everything a
                  runner needs. No project, user, or admin changes.
                </span>
              </span>
            </label>
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
          {token.scope !== 'full' ? (
            <Badge variant="outline">{SCOPE_LABELS[token.scope]}</Badge>
          ) : null}
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
