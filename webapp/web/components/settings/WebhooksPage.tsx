import { AlertTriangle, Check, Copy, RotateCw, Trash2, Webhook } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import {
  useCreateWebhookSubscription,
  useDeleteWebhookSubscription,
  useProjects,
  useRedeliverWebhookDelivery,
  useRotateWebhookSecret,
  useTestWebhookSubscription,
  useUpdateWebhookSubscription,
  useWebhookDeliveries,
  useWebhookSubscriptions
} from '@/lib/queries';

import type {
  CreateWebhookSubscriptionBody,
  UpdateWebhookSubscriptionBody,
  WebhookDeliveryAttemptDto,
  WebhookEventType,
  WebhookSubscriptionDto
} from '../../../shared/contract.ts';

const EVENT_TYPE_OPTIONS: { value: WebhookEventType; label: string; description: string }[] = [
  {
    value: 'mission.delivered',
    label: 'Mission delivered',
    description: 'An agent delivers work for review (also fires on record-work).'
  },
  {
    value: 'mission.status_changed',
    label: 'Mission status changed',
    description: 'A mission moves between workspace statuses (board columns).'
  },
  {
    value: 'objective.completed',
    label: 'Objective completed',
    description: 'An objective reaches complete.'
  },
  {
    value: 'mission.blocked',
    label: 'Mission blocked',
    description: 'An agent posts a blocking question (ask).'
  }
];

/** `'auto'` omits `payloadMode` from the request so the server applies its internal-host-aware default. */
type PayloadModeSelection = 'auto' | 'thin' | 'full';

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function statusPill(subscription: WebhookSubscriptionDto): { label: string; className: string } {
  if (!subscription.enabled) {
    return { label: 'Disabled', className: 'text-muted-foreground' };
  }
  if (subscription.consecutiveFailures > 0) {
    return { label: 'Failing', className: 'text-amber-600 dark:text-amber-400' };
  }
  return { label: 'Active', className: 'text-emerald-600 dark:text-emerald-400' };
}

export function WebhooksPage({ open }: { open: boolean }) {
  const subscriptions = useWebhookSubscriptions();
  const [dialogTarget, setDialogTarget] = useState<'create' | WebhookSubscriptionDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WebhookSubscriptionDto | null>(null);
  const [logTarget, setLogTarget] = useState<WebhookSubscriptionDto | null>(null);
  const deleteSubscription = useDeleteWebhookSubscription();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (!open) return null;

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      await deleteSubscription.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete webhook.');
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-base font-medium">Webhooks</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Send a signed HTTP POST to an endpoint you control whenever a mission is delivered,
            changes status, or gets blocked — so independent software (a feed-post generator, a
            memory ingester, a test trigger) can react without living inside this repository. See{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">docs/webhooks.md</code> for the
            envelope schema and a worked example.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          className="h-8 shrink-0"
          onClick={() => setDialogTarget('create')}
        >
          <Webhook className="size-3.5" />
          New webhook
        </Button>
      </div>

      <Separator />

      <div className="space-y-3">
        {subscriptions.isLoading && !subscriptions.data ? (
          <p className="text-sm text-muted-foreground">Loading webhooks…</p>
        ) : subscriptions.isError ? (
          <p className="text-sm text-destructive">
            {(subscriptions.error as Error | undefined)?.message ??
              'Webhooks are unavailable right now.'}
          </p>
        ) : !subscriptions.data || subscriptions.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No webhooks yet. Create one to get a signed POST every time a mission is delivered.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {subscriptions.data.map(subscription => (
              <WebhookSubscriptionRow
                key={subscription.id}
                subscription={subscription}
                onEdit={() => setDialogTarget(subscription)}
                onDelete={() => setDeleteTarget(subscription)}
                onViewLog={() => setLogTarget(subscription)}
              />
            ))}
          </ul>
        )}
      </div>

      <WebhookDialog target={dialogTarget} onOpenChange={open => !open && setDialogTarget(null)} />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={open => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete webhook</DialogTitle>
            <DialogDescription>
              Delete &ldquo;{deleteTarget?.name}&rdquo;? This endpoint will stop receiving events
              immediately. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError ? <p className="text-sm text-destructive">{deleteError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteSubscription.isPending}
              onClick={() => void handleDelete()}
            >
              Delete webhook
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeliveryLogSheet
        subscription={logTarget}
        onOpenChange={open => !open && setLogTarget(null)}
      />
    </div>
  );
}

function WebhookSubscriptionRow({
  subscription,
  onEdit,
  onDelete,
  onViewLog
}: {
  subscription: WebhookSubscriptionDto;
  onEdit: () => void;
  onDelete: () => void;
  onViewLog: () => void;
}) {
  const updateSubscription = useUpdateWebhookSubscription();
  const testSubscription = useTestWebhookSubscription();
  const [testState, setTestState] = useState<ButtonLoadingState>('default');
  const [testError, setTestError] = useState<string | null>(null);
  const pill = statusPill(subscription);

  async function handleToggle(enabled: boolean) {
    await updateSubscription.mutateAsync({ id: subscription.id, body: { enabled } });
  }

  async function handleTest() {
    setTestState('loading');
    setTestError(null);
    try {
      await testSubscription.mutateAsync(subscription.id);
      setTestState('success');
    } catch (err) {
      setTestState('error');
      setTestError(err instanceof Error ? err.message : 'Test delivery failed.');
    }
  }

  return (
    <li className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="truncate text-sm font-medium hover:underline"
            onClick={onEdit}
          >
            {subscription.name}
          </button>
          <span className={`text-xs font-medium ${pill.className}`}>{pill.label}</span>
          {subscription.isInternal ? (
            <Badge variant="outline" className="text-xs">
              Internal
            </Badge>
          ) : null}
          <Badge variant="outline" className="text-xs">
            {subscription.payloadMode}
          </Badge>
          {!subscription.projectId ? (
            <Badge variant="outline" className="text-xs">
              All projects
            </Badge>
          ) : null}
        </div>
        <p
          className="truncate font-mono text-xs text-muted-foreground"
          title={subscription.endpointUrl}
        >
          {hostFromUrl(subscription.endpointUrl)}
        </p>
        <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
          {subscription.eventTypes.join(', ')}
        </p>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:underline"
          onClick={onViewLog}
        >
          Last success {formatDate(subscription.lastSuccessAt)} · Last failure{' '}
          {formatDate(subscription.lastFailureAt)} · View delivery log
        </button>
        {testError ? <p className="text-xs text-destructive">{testError}</p> : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <LoadingButton
          buttonState={testState}
          setButtonState={setTestState}
          text="Send test"
          loadingText="Sending…"
          successText="Sent"
          errorText="Retry"
          reset
          size="sm"
          variant="outline"
          className="h-8"
          onClick={handleTest}
        />
        <Switch
          checked={subscription.enabled}
          onCheckedChange={next => void handleToggle(next)}
          aria-label={subscription.enabled ? 'Disable webhook' : 'Enable webhook'}
        />
        <Button type="button" variant="ghost" size="sm" className="h-8" onClick={onEdit}>
          Edit
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

function WebhookDialog({
  target,
  onOpenChange
}: {
  target: 'create' | WebhookSubscriptionDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const isEdit = target !== null && target !== 'create';
  const existing = isEdit ? (target as WebhookSubscriptionDto) : null;

  const projectsQ = useProjects();
  const createSubscription = useCreateWebhookSubscription();
  const updateSubscription = useUpdateWebhookSubscription();
  const rotateSecret = useRotateWebhookSecret();
  const testSubscription = useTestWebhookSubscription();

  const [name, setName] = useState(existing?.name ?? '');
  const [endpointUrl, setEndpointUrl] = useState(existing?.endpointUrl ?? '');
  const [projectId, setProjectId] = useState<string>(existing?.projectId ?? 'all');
  const [eventTypes, setEventTypes] = useState<WebhookEventType[]>(existing?.eventTypes ?? []);
  const [payloadMode, setPayloadMode] = useState<PayloadModeSelection>(
    existing?.payloadMode ?? 'auto'
  );
  const [saveState, setSaveState] = useState<ButtonLoadingState>('default');
  const [error, setError] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  function resetForm(nextTarget: 'create' | WebhookSubscriptionDto | null) {
    const next = nextTarget !== null && nextTarget !== 'create' ? nextTarget : null;
    setName(next?.name ?? '');
    setEndpointUrl(next?.endpointUrl ?? '');
    setProjectId(next?.projectId ?? 'all');
    setEventTypes(next?.eventTypes ?? []);
    setPayloadMode(next?.payloadMode ?? 'auto');
    setSaveState('default');
    setError(null);
    setRevealedSecret(null);
    setTestResult(null);
  }

  function toggleEventType(value: WebhookEventType) {
    setEventTypes(current =>
      current.includes(value) ? current.filter(v => v !== value) : [...current, value]
    );
  }

  async function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name is required.');
      setSaveState('error');
      return;
    }
    if (eventTypes.length === 0) {
      setError('Select at least one event type.');
      setSaveState('error');
      return;
    }
    setSaveState('loading');
    setError(null);
    try {
      const resolvedProjectId = projectId === 'all' ? null : projectId;
      if (isEdit && existing) {
        const body: UpdateWebhookSubscriptionBody = {
          name: trimmedName,
          endpointUrl,
          projectId: resolvedProjectId,
          eventTypes,
          ...(payloadMode !== 'auto' ? { payloadMode } : {})
        };
        await updateSubscription.mutateAsync({ id: existing.id, body });
        setSaveState('success');
      } else {
        const body: CreateWebhookSubscriptionBody = {
          name: trimmedName,
          endpointUrl,
          projectId: resolvedProjectId,
          eventTypes,
          ...(payloadMode !== 'auto' ? { payloadMode } : {})
        };
        const result = await createSubscription.mutateAsync(body);
        setRevealedSecret(result.secret);
        setSaveState('success');
      }
    } catch (err) {
      setSaveState('error');
      setError(err instanceof Error ? err.message : 'Failed to save webhook.');
    }
  }

  async function handleRotateSecret() {
    if (!existing) return;
    try {
      const result = await rotateSecret.mutateAsync(existing.id);
      setRevealedSecret(result.secret);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rotate secret.');
    }
  }

  async function handleSendTest() {
    const id = existing?.id;
    if (!id) return;
    setTestResult(null);
    try {
      await testSubscription.mutateAsync(id);
      setTestResult('Test delivery sent successfully.');
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : 'Test delivery failed.');
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={open => {
        if (!open) resetForm(null);
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit webhook' : 'New webhook'}</DialogTitle>
          <DialogDescription>
            Deliveries are HMAC-signed and retried with backoff. See{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">docs/webhooks.md</code> for
            signature verification.
          </DialogDescription>
        </DialogHeader>

        {revealedSecret ? (
          <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
            <p className="text-xs font-medium">
              Copy your signing secret now — it won&apos;t be shown again.
            </p>
            <CopyField label="Signing secret" value={revealedSecret} />
            {isEdit ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => void handleSendTest()}
                >
                  Send test delivery
                </Button>
                {testResult ? <p className="text-xs text-muted-foreground">{testResult}</p> : null}
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => setRevealedSecret(null)}
              >
                Done
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="webhook-name">Name</Label>
              <Input
                id="webhook-name"
                value={name}
                placeholder="e.g. Feed post generator"
                onChange={e => setName(e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="webhook-url">Endpoint URL</Label>
              <Input
                id="webhook-url"
                value={endpointUrl}
                placeholder="https://example.com/webhooks/overlord"
                onChange={e => setEndpointUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Must be <code className="text-xs">https://</code> unless the host matches your
                instance&apos;s <code className="text-xs">OVERLORD_WEBHOOK_INTERNAL_HOSTS</code>{' '}
                allowlist.
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="webhook-project">Project</Label>
              <Select value={projectId} onValueChange={value => setProjectId(value ?? 'all')}>
                <SelectTrigger id="webhook-project">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All projects</SelectItem>
                  {(projectsQ.data ?? [])
                    .filter(project => project.status === 'active')
                    .map(project => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label>Events</Label>
              {EVENT_TYPE_OPTIONS.map(option => (
                <label key={option.value} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4"
                    checked={eventTypes.includes(option.value)}
                    onChange={() => toggleEventType(option.value)}
                  />
                  <span>
                    <span className="font-medium">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            <div className="grid gap-2">
              <Label>Payload mode</Label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="webhook-payload-mode"
                  className="mt-0.5 size-4"
                  checked={payloadMode === 'auto'}
                  onChange={() => setPayloadMode('auto')}
                />
                <span>
                  <span className="font-medium">Auto (recommended)</span>
                  <span className="block text-xs text-muted-foreground">
                    Full for internal endpoints (matching OVERLORD_WEBHOOK_INTERNAL_HOSTS), thin
                    otherwise.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="webhook-payload-mode"
                  className="mt-0.5 size-4"
                  checked={payloadMode === 'thin'}
                  onChange={() => setPayloadMode('thin')}
                />
                <span>
                  <span className="font-medium">Thin</span>
                  <span className="block text-xs text-muted-foreground">
                    Ids and hydration links only — no mission content rests on the endpoint.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="webhook-payload-mode"
                  className="mt-0.5 size-4"
                  checked={payloadMode === 'full'}
                  onChange={() => setPayloadMode('full')}
                />
                <span>
                  <span className="font-medium">Full</span>
                  <span className="block text-xs text-muted-foreground">
                    Includes mission/objective/delivery/rationale content in the payload.
                    {!existing?.isInternal ? ' Only choose this for an endpoint you trust.' : ''}
                  </span>
                </span>
              </label>
            </div>

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        )}

        {!revealedSecret ? (
          <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            {isEdit ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                disabled={rotateSecret.isPending}
                onClick={() => void handleRotateSecret()}
              >
                <RotateCw className="size-3.5" />
                Rotate secret
              </Button>
            ) : (
              <span />
            )}
            <LoadingButton
              buttonState={saveState}
              setButtonState={setSaveState}
              text={isEdit ? 'Save changes' : 'Create webhook'}
              loadingText="Saving…"
              successText="Saved"
              errorText="Retry"
              reset
              size="sm"
              className="h-8"
              onClick={handleSave}
            />
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
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

function DeliveryLogSheet({
  subscription,
  onOpenChange
}: {
  subscription: WebhookSubscriptionDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const deliveries = useWebhookDeliveries(subscription?.id ?? '', subscription !== null);
  const redeliver = useRedeliverWebhookDelivery();
  const [redeliveringId, setRedeliveringId] = useState<string | null>(null);

  async function handleRedeliver(attempt: WebhookDeliveryAttemptDto) {
    if (!subscription) return;
    setRedeliveringId(attempt.id);
    try {
      await redeliver.mutateAsync({ id: subscription.id, outboxId: attempt.outboxMessageId });
    } finally {
      setRedeliveringId(null);
    }
  }

  return (
    <Sheet open={subscription !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{subscription?.name ?? 'Delivery log'}</SheetTitle>
          <SheetDescription>
            Reverse-chronological delivery attempts for this webhook.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-4">
          {deliveries.isLoading && !deliveries.data ? (
            <p className="text-sm text-muted-foreground">Loading deliveries…</p>
          ) : !deliveries.data || deliveries.data.attempts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No deliveries recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {deliveries.data.attempts.map(attempt => (
                <li key={attempt.id} className="space-y-1 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-medium">{attempt.eventType}</span>
                    {attempt.error ? (
                      <span className="flex items-center gap-1 text-xs text-destructive">
                        <AlertTriangle className="size-3" />
                        {attempt.responseStatus ?? 'error'}
                      </span>
                    ) : (
                      <span className="text-xs text-emerald-600 dark:text-emerald-400">
                        {attempt.responseStatus}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Attempt {attempt.attemptNumber} · {formatDate(attempt.attemptedAt)} ·{' '}
                    {attempt.durationMs !== null && attempt.durationMs !== undefined
                      ? `${attempt.durationMs}ms`
                      : '—'}
                  </p>
                  {attempt.error ? (
                    <p className="text-xs text-destructive">{attempt.error}</p>
                  ) : null}
                  {attempt.responseSnippet ? (
                    <pre className="max-h-32 overflow-y-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
                      {attempt.responseSnippet}
                    </pre>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7"
                    disabled={redeliveringId === attempt.id}
                    onClick={() => void handleRedeliver(attempt)}
                  >
                    Redeliver
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
