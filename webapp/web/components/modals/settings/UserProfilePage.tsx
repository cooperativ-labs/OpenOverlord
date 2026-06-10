import { useMeta } from '@/lib/queries';

type UserProfilePageProps = {
  open: boolean;
};

export function UserProfilePage({ open }: UserProfilePageProps) {
  const meta = useMeta();

  if (!open) return null;

  if (meta.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading profile…</p>;
  }

  if (meta.isError || !meta.data) {
    return (
      <p className="text-sm text-destructive">
        {(meta.error as Error | undefined)?.message ?? 'Profile settings are unavailable right now.'}
      </p>
    );
  }

  const { workspace, databasePath } = meta.data;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Profile</h2>
        <p className="text-sm text-muted-foreground">
          Your local workspace identity for this Overlord instance.
        </p>
      </div>

      <dl className="max-w-lg space-y-4 text-sm">
        <div className="space-y-1">
          <dt className="text-muted-foreground">Display name</dt>
          <dd className="font-medium">{workspace.name}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground">Workspace slug</dt>
          <dd className="font-mono text-xs">{workspace.slug}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground">Workspace ID</dt>
          <dd className="break-all font-mono text-xs">{workspace.id}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-muted-foreground">Database</dt>
          <dd className="break-all font-mono text-xs">{databasePath}</dd>
        </div>
      </dl>

      <p className="max-w-lg text-xs text-muted-foreground">
        This build runs as a single trusted local user. Full account profile editing, passkeys,
        and API tokens will appear here when multi-user auth is enabled.
      </p>
    </div>
  );
}
