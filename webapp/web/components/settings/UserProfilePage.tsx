import { useEffect, useState } from 'react';

import { AuthenticatedAvatarImage, Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ImageDropzone } from '@/components/ui/image-dropzone';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { Separator } from '@/components/ui/separator';
import { useMeta, useProfile, useUpdateProfile, useUploadAvatar } from '@/lib/queries';
import { cn } from '@/lib/utils';

import type { ProfileDto, UpdateProfileBody } from '../../../shared/contract.ts';

type UserProfilePageProps = {
  open: boolean;
};

/** Derive up-to-two-letter initials for the avatar fallback. */
function initialsFor(profile: ProfileDto): string {
  const source = profile.displayName || profile.handle || profile.email || '';
  const initials = source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part.charAt(0).toUpperCase())
    .join('');
  return initials || 'OL';
}

export function UserProfilePage({ open }: UserProfilePageProps) {
  const profile = useProfile();
  const meta = useMeta();

  if (!open) return null;

  if (profile.isLoading && !profile.data) {
    return <p className="text-sm text-muted-foreground">Loading profile…</p>;
  }

  if (profile.isError || !profile.data) {
    return (
      <p className="text-sm text-destructive">
        {(profile.error as Error | undefined)?.message ??
          'Profile settings are unavailable right now.'}
      </p>
    );
  }

  const data = profile.data;

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div>
          <h2 className="text-base font-medium">Profile</h2>
          <p className="text-sm text-muted-foreground">
            Your local operator identity. Changes are saved to the Overlord database and shown
            wherever you are attributed.
          </p>
        </div>

        <AvatarUploader profile={data} />

        <div className="space-y-5 rounded-lg border p-4">
          <ProfileField
            id="profile-display-name"
            label="Display name"
            value={data.displayName}
            placeholder="e.g. Ada Lovelace"
            required
            toBody={value => ({ displayName: value })}
            errorFallbackVerb="name"
          />
          <Separator />
          <ReadOnlyProfileField
            id="profile-handle"
            label="Username"
            value={data.handle ?? ''}
            emptyText="Set from your account username"
            description="Mirrors your account username. Change it under Account settings."
          />
          <Separator />
          <ProfileField
            id="profile-email"
            label="Email"
            type="email"
            value={data.email ?? ''}
            placeholder="you@example.com"
            toBody={value => ({ email: value || null })}
            errorFallbackVerb="email"
          />
          <Separator />
          <ProfileField
            id="profile-avatar-url"
            label="Avatar URL"
            type="url"
            value={data.avatarUrl ?? ''}
            placeholder="https://…/avatar.png"
            description="Link to an image used as your avatar."
            toBody={value => ({ avatarUrl: value || null })}
            errorFallbackVerb="avatar"
          />
        </div>
      </div>

      <Separator />

      <div className="space-y-3">
        <div>
          <h2 className="text-base font-medium">Workspace</h2>
          <p className="text-sm text-muted-foreground">
            The active workspace this Overlord instance is pointed at.
          </p>
        </div>
        {meta.data ? (
          <dl className="max-w-lg space-y-3 text-sm">
            <div className="space-y-1">
              <dt className="text-muted-foreground">Name</dt>
              <dd className="font-medium">{meta.data.workspace.name}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">Slug</dt>
              <dd className="font-mono text-xs">{meta.data.workspace.slug}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">Database</dt>
              <dd className="break-all font-mono text-xs">{meta.data.databasePath}</dd>
            </div>
          </dl>
        ) : null}
        <p className="max-w-lg text-xs text-muted-foreground">
          This build runs as a single trusted local operator. Password and passkeys appear here once
          multi-user authentication is enabled; access tokens are managed under Tokens.
        </p>
      </div>
    </div>
  );
}

/**
 * The avatar shown in the profile header, doubling as the drop target for the
 * core upload service. Dropping (or clicking to browse and selecting) an image
 * uploads it to the `user-images` bucket and sets it as the operator's avatar.
 */
function AvatarUploader({ profile }: { profile: ProfileDto }) {
  const uploadAvatar = useUploadAvatar();
  const [error, setError] = useState<string | null>(null);

  async function handleSelect(file: File) {
    setError(null);
    try {
      await uploadAvatar.mutateAsync(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload image.');
    }
  }

  return (
    <div className="flex items-center gap-4">
      <ImageDropzone
        onSelect={handleSelect}
        onError={setError}
        disabled={uploadAvatar.isPending}
        label="Upload a profile picture"
      >
        <Avatar size="lg" className="size-12">
          {profile.avatarUrl ? (
            <AuthenticatedAvatarImage src={profile.avatarUrl} alt={profile.displayName} />
          ) : null}
          <AvatarFallback className="rounded-full">{initialsFor(profile)}</AvatarFallback>
        </Avatar>
      </ImageDropzone>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{profile.displayName}</p>
        <p className={cn('truncate text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>
          {uploadAvatar.isPending
            ? 'Uploading…'
            : (error ?? 'Drag an image or click to upload a profile picture.')}
        </p>
      </div>
    </div>
  );
}

type ReadOnlyProfileFieldProps = {
  id: string;
  label: string;
  value: string;
  /** Shown muted in the field when the value is empty. */
  emptyText?: string;
  description?: string;
};

/**
 * A non-editable profile field, used for values that mirror an authoritative
 * source (e.g. the username, which mirrors the account username and is changed
 * under Account settings) and so must not be edited directly here.
 */
function ReadOnlyProfileField({
  id,
  label,
  value,
  emptyText,
  description
}: ReadOnlyProfileFieldProps) {
  return (
    <div className="grid max-w-lg gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} placeholder={emptyText} className="h-8" readOnly disabled />
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  );
}

type ProfileFieldProps = {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  description?: string;
  type?: string;
  required?: boolean;
  /** Build the patch body from the trimmed input value. */
  toBody: (value: string) => UpdateProfileBody;
  /** Noun used in the generic failure message, e.g. "name" → "Failed to update name." */
  errorFallbackVerb: string;
};

/**
 * One inline-editable profile field with its own save button and error slot,
 * mirroring the project General settings pattern. Saving is a no-op when the
 * value is unchanged.
 */
function ProfileField({
  id,
  label,
  value,
  placeholder,
  description,
  type = 'text',
  required = false,
  toBody,
  errorFallbackVerb
}: ProfileFieldProps) {
  const updateProfile = useUpdateProfile();
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(value);
  const [saveState, setSaveState] = useState<ButtonLoadingState>('default');
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the underlying profile changes (e.g. after a refetch) and the
  // field isn't mid-edit, so external updates aren't silently overwritten.
  useEffect(() => {
    setDraft(value);
    setSaved(value);
  }, [value]);

  async function handleSave() {
    const trimmed = draft.trim();
    if (trimmed === saved.trim()) return;
    if (required && !trimmed) {
      setError(`${label} cannot be empty.`);
      setSaveState('error');
      return;
    }

    setSaveState('loading');
    setError(null);
    try {
      await updateProfile.mutateAsync(toBody(trimmed));
      setSaved(trimmed);
      setDraft(trimmed);
      setSaveState('success');
    } catch (err) {
      setSaveState('error');
      setError(err instanceof Error ? err.message : `Failed to update ${errorFallbackVerb}.`);
    }
  }

  return (
    <div className="grid max-w-lg gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          type={type}
          value={draft}
          placeholder={placeholder}
          className="h-8"
          onChange={e => setDraft(e.target.value)}
          onBlur={handleSave}
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
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
