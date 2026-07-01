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
import { useCreateWorkspace } from '@/lib/queries';

export function CreateWorkspaceOnboardingScreen() {
  const createWorkspace = useCreateWorkspace();
  const {
    name,
    setName,
    workspaceId,
    setWorkspaceIdFromInput,
    slug,
    setSlugFromInput,
    exampleSlug,
    getSubmitBody
  } = useWorkspaceCreationForm();
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

      await createWorkspace.mutateAsync(body);
      setButtonState('success');
    } catch (err) {
      setButtonState('error');
      setError(err instanceof Error ? err.message : 'Failed to create workspace.');
    }
  }

  return (
    <div className="flex h-dvh items-center justify-center overflow-y-auto bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create your workspace</CardTitle>
          <CardDescription>
            Start with a private workspace. You can invite other members from settings later.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <WorkspaceCreationFields
            name={name}
            onNameChange={setName}
            workspaceId={workspaceId}
            onWorkspaceIdChange={setWorkspaceIdFromInput}
            slug={slug}
            onSlugChange={setSlugFromInput}
            exampleSlug={exampleSlug}
            nameInputId="onboarding-workspace-name"
            workspaceIdInputId="onboarding-workspace-id"
            slugInputId="onboarding-workspace-slug"
            onEnter={() => void handleSubmit()}
          />

          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>

        <CardFooter className="justify-end">
          <LoadingButton
            buttonState={buttonState}
            setButtonState={setButtonState}
            text="Create workspace"
            loadingText="Creating..."
            successText="Created"
            onClick={handleSubmit}
          />
        </CardFooter>
      </Card>
    </div>
  );
}
