import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  DEFAULT_PROJECT_COLOR,
  ProjectColorSetter
} from '@/components/projects/ProjectColorSetter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { Textarea } from '@/components/ui/textarea';
import { useEverhourIntegration, useLinkProjectEverhour, useUpdateProject } from '@/lib/queries';

import type { ProjectDto } from '../../../../shared/contract.ts';

type GeneralPageProps = {
  open: boolean;
  project: ProjectDto;
  onOpenChange: (open: boolean) => void;
};

/**
 * Links the Overlord project to an Everhour project by name. Only shown when the
 * workspace has an Everhour API key configured. Defaults the input to the linked
 * name, falling back to the Overlord project name so a first save reuses it.
 */
function EverhourProjectField({ open, project }: { open: boolean; project: ProjectDto }) {
  const integration = useEverhourIntegration();
  const link = useLinkProjectEverhour(project.id);
  const defaultName = project.everhourProjectName ?? project.name;
  const [name, setName] = useState(defaultName);
  const [saved, setSaved] = useState(project.everhourProjectName);
  const [saveState, setSaveState] = useState<ButtonLoadingState>('default');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(project.everhourProjectName ?? project.name);
    setSaved(project.everhourProjectName);
    setSaveState('default');
    setError(null);
  }, [open, project]);

  if (!integration.data?.connected) return null;

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
    <div className="grid max-w-lg gap-2">
      <Label htmlFor="project-settings-everhour">Everhour project</Label>
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
          ? `Linked to Everhour project "${saved}". Missions create tasks here when you track time.`
          : 'Find or create an Everhour project with this name. Defaults to the project name.'}
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function GeneralPage({ open, project }: GeneralPageProps) {
  const updateProject = useUpdateProject(project.id);
  const [name, setName] = useState(project.name);
  const [savedName, setSavedName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [savedDescription, setSavedDescription] = useState(project.description ?? '');
  const [savedColor, setSavedColor] = useState(project.color ?? DEFAULT_PROJECT_COLOR);
  const [nameSaveState, setNameSaveState] = useState<ButtonLoadingState>('default');
  const [descriptionSaveState, setDescriptionSaveState] = useState<ButtonLoadingState>('default');
  const [nameError, setNameError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [colorError, setColorError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(project.name);
    setSavedName(project.name);
    setDescription(project.description ?? '');
    setSavedDescription(project.description ?? '');
    setSavedColor(project.color ?? DEFAULT_PROJECT_COLOR);
    setNameSaveState('default');
    setDescriptionSaveState('default');
    setNameError(null);
    setDescriptionError(null);
    setColorError(null);
    setCopied(false);
  }, [open, project]);

  async function handleSaveName() {
    const trimmed = name.trim();
    if (trimmed === savedName) return;

    setNameSaveState('loading');
    setNameError(null);

    try {
      await updateProject.mutateAsync({ name: trimmed });
      setSavedName(trimmed);
      setNameSaveState('success');
    } catch (error) {
      setNameSaveState('error');
      setNameError(error instanceof Error ? error.message : 'Failed to update name.');
    }
  }

  async function handleSaveDescription() {
    const trimmed = description.trim();
    const nextDescription = trimmed.length > 0 ? trimmed : null;
    const saved = savedDescription.trim().length > 0 ? savedDescription.trim() : null;
    if (nextDescription === saved) return;

    setDescriptionSaveState('loading');
    setDescriptionError(null);

    try {
      await updateProject.mutateAsync({ description: nextDescription });
      setSavedDescription(trimmed);
      setDescriptionSaveState('success');
    } catch (error) {
      setDescriptionSaveState('error');
      setDescriptionError(error instanceof Error ? error.message : 'Failed to update description.');
    }
  }

  async function handleSelectColor(color: string) {
    if (color.toLowerCase() === savedColor.toLowerCase()) return;

    setColorError(null);

    try {
      await updateProject.mutateAsync({ color: color.toLowerCase() });
      setSavedColor(color.toLowerCase());
    } catch (error) {
      setColorError(error instanceof Error ? error.message : 'Failed to update color.');
    }
  }

  async function handleCopyProjectId() {
    try {
      await navigator.clipboard.writeText(project.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">General</h2>
        <p className="text-sm text-muted-foreground">Name, description, and display color.</p>
      </div>

      <div className="grid max-w-lg gap-2">
        <Label htmlFor="project-settings-name">Name</Label>
        <div className="flex gap-2">
          <Input
            id="project-settings-name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Mobile App"
            className="h-8"
            onBlur={handleSaveName}
            onKeyDown={e => {
              if (e.key === 'Enter') void handleSaveName();
            }}
            disabled={nameSaveState === 'loading'}
          />
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
        </div>
        {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
      </div>

      <div className="grid max-w-lg gap-2">
        <Label htmlFor="project-settings-description">Description</Label>
        <Textarea
          id="project-settings-description"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="What is this project for?"
          rows={3}
          onBlur={handleSaveDescription}
          disabled={descriptionSaveState === 'loading'}
        />
        <div className="flex items-center gap-2">
          <LoadingButton
            buttonState={descriptionSaveState}
            setButtonState={setDescriptionSaveState}
            text="Save description"
            loadingText="Saving…"
            successText="Saved"
            errorText="Retry"
            reset
            size="sm"
            variant="outline"
            onClick={handleSaveDescription}
          />
        </div>
        {descriptionError ? <p className="text-xs text-destructive">{descriptionError}</p> : null}
      </div>

      <div className="grid max-w-lg gap-2">
        <Label>Color</Label>
        <ProjectColorSetter value={savedColor} onSelect={handleSelectColor} />
        {colorError ? <p className="text-xs text-destructive">{colorError}</p> : null}
      </div>

      <EverhourProjectField open={open} project={project} />

      <div className="grid max-w-lg gap-2">
        <Label>Project ID</Label>
        <div className="flex items-center gap-2">
          <Input value={project.id} readOnly className="h-8 font-mono text-xs" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1.5"
            onClick={handleCopyProjectId}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Stable identifier used by the CLI and protocol surfaces.
        </p>
      </div>
    </div>
  );
}
