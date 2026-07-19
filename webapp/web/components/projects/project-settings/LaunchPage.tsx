import { useEffect, useRef, useState } from 'react';

import {
  LaunchEnvVarsEditor,
  type LaunchEnvVarsEditorHandle
} from '@/components/projects/project-settings/LaunchEnvVarsEditor';
import { parsePreLaunchLines } from '@/components/projects/project-settings/launch-settings-form';
import { LaunchVariableLibrary } from '@/components/projects/project-settings/LaunchVariableLibrary';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { Textarea } from '@/components/ui/textarea';
import { useProject, useUpdateProject } from '@/lib/queries';

type LaunchPageProps = {
  open: boolean;
  projectId: string;
};

export function LaunchPage({ open, projectId }: LaunchPageProps) {
  const projectQ = useProject(projectId);
  const updateProject = useUpdateProject(projectId);
  const envVarsEditorRef = useRef<LaunchEnvVarsEditorHandle | null>(null);

  const savedPreLaunchText = (projectQ.data?.preLaunchCommands ?? []).join('\n');
  const savedEnvVars = projectQ.data?.launchEnvVars ?? {};

  const [preLaunch, setPreLaunch] = useState(savedPreLaunchText);
  const [preLaunchSaveState, setPreLaunchSaveState] = useState<ButtonLoadingState>('default');
  const [envVarsSaveState, setEnvVarsSaveState] = useState<ButtonLoadingState>('default');
  const [preLaunchError, setPreLaunchError] = useState<string | null>(null);
  const [envVarsError, setEnvVarsError] = useState<string | null>(null);
  const [insertTarget, setInsertTarget] = useState<'preLaunch' | 'envVars'>('envVars');
  const preLaunchRef = useRef<HTMLTextAreaElement | null>(null);

  const preLaunchDirty =
    parsePreLaunchLines(preLaunch).join('\n') !== parsePreLaunchLines(savedPreLaunchText).join('\n');

  useEffect(() => {
    if (!open) return;
    setPreLaunch(savedPreLaunchText);
  }, [open, savedPreLaunchText]);

  useEffect(() => {
    if (!open) return;
    setPreLaunchSaveState('default');
    setEnvVarsSaveState('default');
    setPreLaunchError(null);
    setEnvVarsError(null);
  }, [open, projectId]);

  async function handleSavePreLaunch() {
    const nextLines = parsePreLaunchLines(preLaunch);
    if (!preLaunchDirty) return;

    setPreLaunchSaveState('loading');
    setPreLaunchError(null);

    try {
      await updateProject.mutateAsync({ preLaunchCommands: nextLines });
      setPreLaunchSaveState('success');
    } catch (error) {
      setPreLaunchSaveState('error');
      setPreLaunchError(
        error instanceof Error ? error.message : 'Failed to update launch commands.'
      );
    }
  }

  async function handleSaveEnvVars(vars: Record<string, string>) {
    await updateProject.mutateAsync({ launchEnvVars: vars });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Launch</h2>
        <p className="text-sm text-muted-foreground">
          Pre-launch commands, environment variables, and available placeholders.
        </p>
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
            disabled={!preLaunchDirty || preLaunchSaveState === 'loading'}
            onClick={handleSavePreLaunch}
          />
        </div>
        {preLaunchError ? <p className="text-xs text-destructive">{preLaunchError}</p> : null}
      </div>

      <div className="grid gap-2">
        <Label>Launch environment variables</Label>
        <LaunchEnvVarsEditor
          ref={envVarsEditorRef}
          savedEnvVars={savedEnvVars}
          disabled={!open}
          saveState={envVarsSaveState}
          setSaveState={setEnvVarsSaveState}
          error={envVarsError}
          setError={setEnvVarsError}
          onSave={handleSaveEnvVars}
        />
      </div>

      <LaunchVariableLibrary
        onInsert={token => {
          if (insertTarget === 'preLaunch') {
            setPreLaunch(prev =>
              prev.trim() ? `${prev}${prev.endsWith('\n') ? '' : ' '}${token}` : token
            );
            preLaunchRef.current?.focus();
          } else {
            envVarsEditorRef.current?.insertToken(token);
            envVarsEditorRef.current?.focus();
          }
        }}
      />
    </div>
  );
}
