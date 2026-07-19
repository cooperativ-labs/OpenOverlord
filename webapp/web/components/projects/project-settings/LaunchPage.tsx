import { useEffect, useRef, useState } from 'react';

import { LaunchVariableLibrary } from '@/components/projects/project-settings/LaunchVariableLibrary';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { Textarea } from '@/components/ui/textarea';
import { useProject, useUpdateProject } from '@/lib/queries';

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

function parsePreLaunchLines(value: string): string[] {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

type LaunchPageProps = {
  open: boolean;
  projectId: string;
};

export function LaunchPage({ open, projectId }: LaunchPageProps) {
  const projectQ = useProject(projectId);
  const updateProject = useUpdateProject(projectId);

  const savedPreLaunchText = (projectQ.data?.preLaunchCommands ?? []).join('\n');
  const savedEnvVarsText = envVarsToText(projectQ.data?.launchEnvVars);

  const [preLaunch, setPreLaunch] = useState(savedPreLaunchText);
  const [envVars, setEnvVars] = useState(savedEnvVarsText);
  const [preLaunchSaveState, setPreLaunchSaveState] = useState<ButtonLoadingState>('default');
  const [envVarsSaveState, setEnvVarsSaveState] = useState<ButtonLoadingState>('default');
  const [preLaunchError, setPreLaunchError] = useState<string | null>(null);
  const [envVarsError, setEnvVarsError] = useState<string | null>(null);
  const [insertTarget, setInsertTarget] = useState<'preLaunch' | 'envVars'>('envVars');
  const preLaunchRef = useRef<HTMLTextAreaElement | null>(null);
  const envVarsRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setPreLaunch(savedPreLaunchText);
    setEnvVars(savedEnvVarsText);
  }, [open, savedPreLaunchText, savedEnvVarsText]);

  useEffect(() => {
    if (!open) return;
    setPreLaunchSaveState('default');
    setEnvVarsSaveState('default');
    setPreLaunchError(null);
    setEnvVarsError(null);
  }, [open, projectId]);

  async function handleSavePreLaunch() {
    const nextLines = parsePreLaunchLines(preLaunch);
    if (nextLines.join('\n') === parsePreLaunchLines(savedPreLaunchText).join('\n')) return;

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

  async function handleSaveEnvVars() {
    const nextVars = parseEnvVarLines(envVars);
    if (envVarsToText(nextVars) === envVarsToText(parseEnvVarLines(savedEnvVarsText))) return;

    setEnvVarsSaveState('loading');
    setEnvVarsError(null);

    try {
      await updateProject.mutateAsync({ launchEnvVars: nextVars });
      setEnvVarsSaveState('success');
    } catch (error) {
      setEnvVarsSaveState('error');
      setEnvVarsError(
        error instanceof Error ? error.message : 'Failed to update launch environment variables.'
      );
    }
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
    </div>
  );
}
