import { useEffect, useState } from 'react';

import { AuthenticatedAvatarImage, Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ImageDropzone } from '@/components/ui/image-dropzone';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { useUpdateOrganization, useUploadOrganizationLogo } from '@/lib/queries';
import { cn } from '@/lib/utils';

import type { OrganizationDto } from '../../../../shared/contract.ts';

type GeneralPageProps = {
  open: boolean;
  organization: OrganizationDto;
  isOrgAdmin: boolean;
  partialAdmin: boolean;
};

function initialsFor(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part.charAt(0).toUpperCase())
    .join('');
  return initials || 'OL';
}

export function GeneralPage({ open, organization, isOrgAdmin, partialAdmin }: GeneralPageProps) {
  const updateOrganization = useUpdateOrganization();
  const uploadLogo = useUploadOrganizationLogo();
  const [name, setName] = useState(organization.name);
  const [savedName, setSavedName] = useState(organization.name);
  const [nameSaveState, setNameSaveState] = useState<ButtonLoadingState>('default');
  const [nameError, setNameError] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(organization.name);
    setSavedName(organization.name);
    setNameSaveState('default');
    setNameError(null);
    setLogoError(null);
  }, [open, organization]);

  async function handleSaveName() {
    const trimmed = name.trim();
    if (trimmed === savedName || !trimmed) return;

    setNameSaveState('loading');
    setNameError(null);

    try {
      await updateOrganization.mutateAsync({ id: organization.id, body: { name: trimmed } });
      setSavedName(trimmed);
      setName(trimmed);
      setNameSaveState('success');
    } catch (error) {
      setNameSaveState('error');
      setNameError(error instanceof Error ? error.message : 'Failed to update name.');
    }
  }

  async function handleSelectLogo(file: File) {
    if (!isOrgAdmin) return;
    setLogoError(null);
    try {
      await uploadLogo.mutateAsync({ organizationId: organization.id, file });
    } catch (error) {
      setLogoError(error instanceof Error ? error.message : 'Failed to upload image.');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">General</h2>
        <p className="text-sm text-muted-foreground">Organization name and logo.</p>
      </div>

      {partialAdmin ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
          You are an admin in some workspaces but not all. Visit the Admins tab to repair this
          before renaming the organization or changing its logo.
        </p>
      ) : null}

      {isOrgAdmin ? (
        <div className="flex items-center gap-4">
          <ImageDropzone
            onSelect={handleSelectLogo}
            onError={setLogoError}
            disabled={uploadLogo.isPending}
            label="Upload an organization logo"
          >
            <Avatar size="lg" className="size-12">
              {organization.logoUrl ? (
                <AuthenticatedAvatarImage src={organization.logoUrl} alt={organization.name} />
              ) : null}
              <AvatarFallback className="rounded-full">
                {initialsFor(organization.name)}
              </AvatarFallback>
            </Avatar>
          </ImageDropzone>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{organization.name}</p>
            <p
              className={cn(
                'truncate text-xs',
                logoError ? 'text-destructive' : 'text-muted-foreground'
              )}
            >
              {uploadLogo.isPending
                ? 'Uploading…'
                : (logoError ?? 'Drag an image or click to upload an organization logo.')}
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid max-w-lg gap-2">
        <Label htmlFor="organization-settings-name">Name</Label>
        <div className="flex gap-2">
          <Input
            id="organization-settings-name"
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="Organization name"
            className="h-8"
            onBlur={handleSaveName}
            onKeyDown={event => {
              if (event.key === 'Enter') void handleSaveName();
            }}
            disabled={!isOrgAdmin || nameSaveState === 'loading'}
          />
          {isOrgAdmin ? (
            <LoadingButton
              buttonState={nameSaveState}
              setButtonState={setNameSaveState}
              text="Save"
              loadingText="Saving…"
              successText="Saved"
              errorText="Retry"
              reset
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={handleSaveName}
            />
          ) : null}
        </div>
        {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
        {!isOrgAdmin ? (
          <p className="text-xs text-muted-foreground">
            Only organization admins can rename the organization.
          </p>
        ) : null}
      </div>
    </div>
  );
}
