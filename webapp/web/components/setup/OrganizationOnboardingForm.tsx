import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ImageDropzone } from '@/components/ui/image-dropzone';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { useCreateOrganizationOnboarding, useUploadOrganizationLogo } from '@/lib/queries';
import { sanitizeWorkspaceSlugInput, suggestWorkspaceSlug } from '@/lib/workspace-slug';

type OrganizationOnboardingFormProps = {
  onSuccess?: () => void;
};

export function OrganizationOnboardingForm({ onSuccess }: OrganizationOnboardingFormProps) {
  const createOnboarding = useCreateOrganizationOnboarding();
  const uploadLogo = useUploadOrganizationLogo();
  const [organizationName, setOrganizationName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('general');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buttonState, setButtonState] = useState<ButtonLoadingState>('default');

  const suggestedSlug = suggestWorkspaceSlug(workspaceName || 'general');
  const resolvedSlug = slugTouched ? slug : suggestedSlug;

  async function handleSubmit() {
    setButtonState('loading');
    setError(null);
    setLogoError(null);

    try {
      const trimmedOrgName = organizationName.trim();
      const trimmedWorkspaceName = workspaceName.trim() || 'general';
      if (!trimmedOrgName) throw new Error('Organization name is required.');
      if (!trimmedWorkspaceName) throw new Error('Workspace name is required.');

      const meta = await createOnboarding.mutateAsync({
        organizationName: trimmedOrgName,
        workspaceName: trimmedWorkspaceName,
        workspaceSlug: resolvedSlug.trim() || undefined
      });

      if (logoFile && meta.organization) {
        try {
          await uploadLogo.mutateAsync({
            organizationId: meta.organization.id,
            file: logoFile
          });
        } catch (uploadErr) {
          setLogoError(
            uploadErr instanceof Error
              ? uploadErr.message
              : 'Organization created, but the logo upload failed.'
          );
        }
      }

      setButtonState('success');
      onSuccess?.();
    } catch (err) {
      setButtonState('error');
      setError(err instanceof Error ? err.message : 'Failed to complete onboarding.');
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-4">
        <ImageDropzone
          onSelect={file => {
            setLogoFile(file);
            setLogoError(null);
          }}
          onError={setLogoError}
          disabled={createOnboarding.isPending || uploadLogo.isPending}
          label="Upload an organization logo"
        >
          <div className="flex size-12 items-center justify-center rounded-lg border bg-muted text-xs text-muted-foreground">
            Logo
          </div>
        </ImageDropzone>
        <p className="text-xs text-muted-foreground">
          Optional. Uploaded after your organization is created.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="onboarding-organization-name">Organization name</Label>
        <Input
          id="onboarding-organization-name"
          autoFocus
          value={organizationName}
          onChange={event => setOrganizationName(event.target.value)}
          placeholder="e.g. Cooperativ"
          onKeyDown={event => {
            if (event.key === 'Enter') void handleSubmit();
          }}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="onboarding-workspace-name">Workspace name</Label>
        <Input
          id="onboarding-workspace-name"
          value={workspaceName}
          onChange={event => setWorkspaceName(event.target.value)}
          placeholder="general"
          onKeyDown={event => {
            if (event.key === 'Enter') void handleSubmit();
          }}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="onboarding-workspace-slug">Workspace slug</Label>
        <Input
          id="onboarding-workspace-slug"
          value={slugTouched ? slug : suggestedSlug}
          onChange={event => {
            setSlugTouched(true);
            setSlug(sanitizeWorkspaceSlugInput(event.target.value));
          }}
          placeholder={suggestedSlug}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          Mission identifiers use this slug, for example {resolvedSlug || 'gen'}:1.
        </p>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {logoError ? <p className="text-sm text-amber-600 dark:text-amber-400">{logoError}</p> : null}

      <div className="flex justify-end">
        <LoadingButton
          buttonState={buttonState}
          setButtonState={setButtonState}
          text="Create organization"
          loadingText="Creating…"
          successText="Created"
          onClick={handleSubmit}
        />
      </div>
    </div>
  );
}
