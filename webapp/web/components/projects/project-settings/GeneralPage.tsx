import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { LaunchVariableLibrary } from '@/components/projects/project-settings/LaunchVariableLibrary';
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
import { useUpdateProject } from '@/lib/queries';

import type { ProjectDto } from '../../../../shared/contract.ts';

/** Serialize a launch env-var map to editable `KEY=VALUE` lines (sorted by name). */
function envVarsToText(vars: Record<string, string> | undefined): string {
  return Object.entries(vars ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/**
 * Parse `KEY=VALUE` lines into a launch env-var map. The name is everything
 * before the first `=` (trimmed); the value is the remainder (trimmed, verbatim
 * otherwise so `{PLACEHOLDER}` tokens survive). Blank lines, lines without `=`,
 * and lines with an empty name are dropped. Later duplicates win.
 */
function parseEnvVarLines(value: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    vars[key] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

type GeneralPageProps = {
  open: boolean;
  project: ProjectDto;
  onOpenChange: (open: boolean) => void;
  onNavigateToIntegrations: () => void;
};

export function GeneralPage({ open, project, onNavigateToIntegrations }: GeneralPageProps) {
  const updateProject = useUpdateProject(project.id);
  const [name, setName] = useState(project.name);
  const [savedName, setSavedName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [savedDescription, setSavedDescription] = useState(project.description ?? '');
  const [savedColor, setSavedColor] = useState(project.color ?? DEFAULT_PROJECT_COLOR);
  const [preLaunch, setPreLaunch] = useState((project.preLaunchCommands ?? []).join('\n'));
  const [savedPreLaunch, setSavedPreLaunch] = useState(
    (project.preLaunchCommands ?? []).join('\n')
  );
  const [envVars, setEnvVars] = useState(envVarsToText(project.launchEnvVars));
  const [savedEnvVars, setSavedEnvVars] = useState(envVarsToText(project.launchEnvVars));
  const [nameSaveState, setNameSaveState] = useState<ButtonLoadingState>('default');
  const [descriptionSaveState, setDescriptionSaveState] = useState<ButtonLoadingState>('default');
  const [preLaunchSaveState, setPreLaunchSaveState] = useState<ButtonLoadingState>('default');
  const [envVarsSaveState, setEnvVarsSaveState] = useState<ButtonLoadingState>('default');
  const [nameError, setNameError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [colorError, setColorError] = useState<string | null>(null);
  const [preLaunchError, setPreLaunchError] = useState<string | null>(null);
  const [envVarsError, setEnvVarsError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [insertTarget, setInsertTarget] = useState<'preLaunch' | 'envVars'>('envVars');
  const preLaunchRef = useRef<HTMLTextAreaElement | null>(null);
  const envVarsRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(project.name);
    setSavedName(project.name);
    setDescription(project.description ?? '');
    setSavedDescription(project.description ?? '');
    setSavedColor(project.color ?? DEFAULT_PROJECT_COLOR);
    setPreLaunch((project.preLaunchCommands ?? []).join('\n'));
    setSavedPreLaunch((project.preLaunchCommands ?? []).join('\n'));
    setEnvVars(envVarsToText(project.launchEnvVars));
    setSavedEnvVars(envVarsToText(project.launchEnvVars));
    setNameSaveState('default');
    setDescriptionSaveState('default');
    setPreLaunchSaveState('default');
    setEnvVarsSaveState('default');
    setNameError(null);
    setDescriptionError(null);
    setColorError(null);
    setPreLaunchError(null);
    setEnvVarsError(null);
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

  function parsePreLaunchLines(value: string): string[] {
    return value
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }

  async function handleSavePreLaunch() {
    const nextLines = parsePreLaunchLines(preLaunch);
    if (nextLines.join('\n') === parsePreLaunchLines(savedPreLaunch).join('\n')) return;

    setPreLaunchSaveState('loading');
    setPreLaunchError(null);

    try {
      await updateProject.mutateAsync({ preLaunchCommands: nextLines });
      setSavedPreLaunch(nextLines.join('\n'));
      setPreLaunch(nextLines.join('\n'));
      setPreLaunchSaveState('success');
    } catch (error) {
      setPreLaunchSaveState('error');
      setPreLaunchError(
        error instanceof Error ? error.message : 'Failed to update launch commands.'
      );
    }
  }

  async function handleSaveEnvVars() {
    const nextVars = parseEnvVarLines(envVars);
    if (envVarsToText(nextVars) === envVarsToText(parseEnvVarLines(savedEnvVars))) return;

    setEnvVarsSaveState('loading');
    setEnvVarsError(null);

    try {
      await updateProject.mutateAsync({ launchEnvVars: nextVars });
      setSavedEnvVars(envVarsToText(nextVars));
      setEnvVars(envVarsToText(nextVars));
      setEnvVarsSaveState('success');
    } catch (error) {
      setEnvVarsSaveState('error');
      setEnvVarsError(
        error instanceof Error ? error.message : 'Failed to update launch environment variables.'
      );
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

      <div className="grid max-w-lg gap-2">
        <Label htmlFor="project-settings-pre-launch">Launch preparation commands</Label>
        <p className="text-xs text-muted-foreground">
          Shell commands run in the agent&apos;s launch environment after entering the working
          directory but before the agent starts — one per line. Insert{' '}
          <code className="font-mono">{'{VARIABLE}'}</code> placeholders from the library below.
        </p>
        <Textarea
          id="project-settings-pre-launch"
          ref={preLaunchRef}
          value={preLaunch}
          onChange={e => setPreLaunch(e.target.value)}
          onFocus={() => setInsertTarget('preLaunch')}
          placeholder="agent-pod file-access set {OVERLORD_PROJECT_RESOURCES_PATHS}"
          rows={3}
          className="font-mono text-xs"
          onBlur={handleSavePreLaunch}
          disabled={preLaunchSaveState === 'loading'}
        />
        <div className="flex items-center gap-2">
          <LoadingButton
            buttonState={preLaunchSaveState}
            setButtonState={setPreLaunchSaveState}
            text="Save commands"
            loadingText="Saving…"
            successText="Saved"
            errorText="Retry"
            reset
            size="sm"
            variant="outline"
            onClick={handleSavePreLaunch}
          />
        </div>
        {preLaunchError ? <p className="text-xs text-destructive">{preLaunchError}</p> : null}
      </div>

      <div className="grid max-w-lg gap-2">
        <Label htmlFor="project-settings-env-vars">Launch environment variables</Label>
        <p className="text-xs text-muted-foreground">
          Environment variables exported into the agent&apos;s launch environment before the
          pre-launch commands and the agent run — one <code className="font-mono">NAME=value</code>{' '}
          per line. Values may include <code className="font-mono">{'{VARIABLE}'}</code>{' '}
          placeholders from the library below.
        </p>
        <Textarea
          id="project-settings-env-vars"
          ref={envVarsRef}
          value={envVars}
          onChange={e => setEnvVars(e.target.value)}
          onFocus={() => setInsertTarget('envVars')}
          placeholder="AGENT_POD_EXTRA_ALLOWED_PATHS={OVERLORD_PROJECT_RESOURCES_PATHS_CSV}"
          rows={3}
          className="font-mono text-xs"
          onBlur={handleSaveEnvVars}
          disabled={envVarsSaveState === 'loading'}
        />
        <div className="flex items-center gap-2">
          <LoadingButton
            buttonState={envVarsSaveState}
            setButtonState={setEnvVarsSaveState}
            text="Save variables"
            loadingText="Saving…"
            successText="Saved"
            errorText="Retry"
            reset
            size="sm"
            variant="outline"
            onClick={handleSaveEnvVars}
          />
        </div>
        {envVarsError ? <p className="text-xs text-destructive">{envVarsError}</p> : null}
      </div>

      <LaunchVariableLibrary
        onInsert={token => {
          if (insertTarget === 'preLaunch') {
            setPreLaunch(prev =>
              prev.trim() ? `${prev}${prev.endsWith('\n') ? '' : ' '}${token}` : token
            );
            preLaunchRef.current?.focus();
          } else {
            setEnvVars(prev => {
              const lines = prev.split('\n');
              const last = lines[lines.length - 1] ?? '';
              if (!last.trim()) {
                lines[lines.length - 1] = last.includes('=') ? `${last}${token}` : token;
                return lines.join('\n');
              }
              if (last.includes('=')) {
                lines[lines.length - 1] = `${last}${token}`;
                return lines.join('\n');
              }
              return `${prev}${prev.endsWith('\n') ? '' : '\n'}${token}`;
            });
            envVarsRef.current?.focus();
          }
        }}
      />

      <div className="max-w-lg rounded-lg border border-border p-4">
        <p className="text-sm text-muted-foreground">
          To configure Everhour time tracking for this project, visit the{' '}
          <button
            type="button"
            className="font-medium text-foreground underline-offset-4 hover:underline"
            onClick={onNavigateToIntegrations}
          >
            Integrations
          </button>{' '}
          page. Set your Everhour API key in <strong>Settings → Integrations</strong> to get
          started.
        </p>
      </div>

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
