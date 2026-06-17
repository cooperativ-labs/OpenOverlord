import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { WorkspaceCreationFields } from '@/components/workspaces/WorkspaceCreationFields';
import { useWorkspaceCreationForm } from '@/lib/hooks/use-workspace-creation-form';
import { useCompleteSetup } from '@/lib/queries';

/**
 * One-time initial instance setup: names the seeded first workspace and picks
 * the slug that prefixes every ticket identifier (`<slug>:<sequence>`).
 * Rendered full-screen instead of the app shell while `/api/meta` reports
 * `needsSetup`.
 */
export function InitialSetupScreen() {
  const completeSetupMutation = useCompleteSetup();
  const { name, setName, slug, setSlugFromInput, exampleSlug, getSubmitBody } =
    useWorkspaceCreationForm();
  const [error, setError] = useState<string | null>(null);
  const [buttonState, setButtonState] = useState<ButtonLoadingState>('default');

  async function handleSubmit() {
    setButtonState('loading');
    setError(null);

    try {
      const body = getSubmitBody();
      if (!body.name) {
        throw new Error('Workspace name is required.');
      }

      await completeSetupMutation.mutateAsync(body);
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
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>
              Before continuing, install the Overlord CLI by running{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                npm install -g open-overlord
              </code>{' '}
              in your terminal.
            </p>
          </div>

          <WorkspaceCreationFields
            name={name}
            onNameChange={setName}
            slug={slug}
            onSlugChange={setSlugFromInput}
            exampleSlug={exampleSlug}
            nameInputId="setup-workspace-name"
            slugInputId="setup-workspace-slug"
            onEnter={() => void handleSubmit()}
          />

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
