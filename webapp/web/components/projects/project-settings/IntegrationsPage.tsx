import { useEffect, useState } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import {
  useEverhourIntegration,
  useLinkProjectEverhour,
  useProjectEverhourLink
} from '@/lib/queries';

import type { ProjectDto } from '../../../../shared/contract.ts';

type IntegrationsPageProps = {
  open: boolean;
  project: ProjectDto;
};

function EverhourProjectField({ open, project }: IntegrationsPageProps) {
  const integration = useEverhourIntegration();
  const projectLink = useProjectEverhourLink(project.id, { enabled: open });
  const link = useLinkProjectEverhour(project.id);
  const everhourProjectName = projectLink.data?.everhourProjectName ?? null;
  const defaultName = everhourProjectName ?? project.name;
  const [name, setName] = useState(defaultName);
  const [saved, setSaved] = useState(everhourProjectName);
  const [saveState, setSaveState] = useState<ButtonLoadingState>('default');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(everhourProjectName ?? project.name);
    setSaved(everhourProjectName);
    setSaveState('default');
    setError(null);
  }, [open, project, everhourProjectName]);

  async function handleSave() {
    const trimmed = name.trim();
    if (trimmed === (saved ?? '')) return;
    setSaveState('loading');
    setError(null);
    try {
      const updated = await link.mutateAsync({ everhourProjectName: trimmed || null });
      setSaved(updated.everhourProjectName);
      setSaveState('success');
    } catch (err) {
      setSaveState('error');
      setError(err instanceof Error ? err.message : 'Failed to link Everhour project.');
    }
  }

  return (
    <div className="max-w-lg space-y-3 rounded-lg border border-border p-4">
      <div>
        <h3 className="text-sm font-medium">Everhour</h3>
        <p className="text-xs text-muted-foreground">
          Link this project to an Everhour project. Missions create tasks here when you track time.
        </p>
      </div>

      {integration.data?.connected ? (
        <div className="grid gap-2">
          <Label htmlFor="project-settings-everhour">Everhour project name</Label>
          <div className="flex gap-2">
            <Input
              id="project-settings-everhour"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={project.name}
              className="h-8"
              onBlur={handleSave}
              onKeyDown={e => {
                if (e.key === 'Enter') void handleSave();
              }}
              disabled={saveState === 'loading'}
            />
            <LoadingButton
              buttonState={saveState}
              setButtonState={setSaveState}
              text="Link"
              loadingText="Linking…"
              successText="Linked"
              errorText="Retry"
              reset
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={handleSave}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {saved
              ? `Linked to Everhour project "${saved}".`
              : 'Find or create an Everhour project with this name. Defaults to the project name.'}
          </p>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No Everhour API key is configured for this workspace. Set one in{' '}
          <strong>Settings → Integrations</strong> to enable time tracking.
        </p>
      )}
    </div>
  );
}

export function IntegrationsPage({ open, project }: IntegrationsPageProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Integrations</h2>
        <p className="text-sm text-muted-foreground">Connect external services to this project.</p>
      </div>

      <EverhourProjectField open={open} project={project} />
    </div>
  );
}
