import { useState } from 'react';

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { useCompleteSetup } from '@/lib/queries';

/** First three letters of the workspace name, as the suggested slug. */
function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 3);
}

/** Keep manually typed slugs in the same shape the server stores (`slugify`). */
function sanitizeSlugInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48);
}

/**
 * One-time initial instance setup: names the seeded first workspace and picks
 * the slug that prefixes every ticket identifier (`<slug>:<sequence>`).
 * Rendered full-screen instead of the app shell while `/api/meta` reports
 * `needsSetup`.
 */
export function InitialSetupScreen() {
  const completeSetupMutation = useCompleteSetup();
  const [name, setName] = useState('');
  // Until the operator edits the slug themselves, it follows the suggestion
  // derived from the name; clearing the field hands control back.
  const [slugOverride, setSlugOverride] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buttonState, setButtonState] = useState<ButtonLoadingState>('default');

  const suggestedSlug = suggestSlug(name);
  const slug = slugOverride ?? suggestedSlug;
  const exampleSlug = slug || 'abc';

  async function handleSubmit() {
    setButtonState('loading');
    setError(null);

    try {
      const trimmedName = name.trim();
      if (!trimmedName) {
        throw new Error('Workspace name is required.');
      }

      await completeSetupMutation.mutateAsync({ name: trimmedName, slug: slug || undefined });
      setButtonState('success');
      // `useCompleteSetup` invalidates the meta query; once `needsSetup` flips
      // to false the router renders the app shell in place of this screen.
    } catch (err) {
      setButtonState('error');
      setError(err instanceof Error ? err.message : 'Failed to complete setup.');
    }
  }

  return (
    <div className="flex h-dvh items-center justify-center overflow-y-auto bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Welcome to Overlord</CardTitle>
          <CardDescription>
            Name your first workspace. Workspaces keep their own projects, tickets, and members —
            you can rename it or add more later.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="setup-workspace-name">Workspace name</Label>
            <Input
              id="setup-workspace-name"
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Acme Engineering"
              onKeyDown={e => {
                if (e.key === 'Enter') void handleSubmit();
              }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="setup-workspace-slug">Workspace slug</Label>
            <Input
              id="setup-workspace-slug"
              value={slug}
              onChange={e => {
                const next = sanitizeSlugInput(e.target.value);
                setSlugOverride(next === '' ? null : next);
              }}
              placeholder="abc"
              className="font-mono"
              onKeyDown={e => {
                if (e.key === 'Enter') void handleSubmit();
              }}
            />
            <p className="text-xs text-muted-foreground">
              Suggested from the first three letters of the workspace name.
            </p>
          </div>

          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            <p className="text-muted-foreground">Tickets in this workspace will be identified as</p>
            <p className="mt-1 font-mono text-foreground">
              {exampleSlug}:1, {exampleSlug}:2, {exampleSlug}:3, …
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>

        <CardFooter className="justify-end">
          <LoadingButton
            buttonState={buttonState}
            setButtonState={setButtonState}
            text="Create workspace"
            loadingText="Saving…"
            successText="Done"
            onClick={handleSubmit}
          />
        </CardFooter>
      </Card>
    </div>
  );
}
