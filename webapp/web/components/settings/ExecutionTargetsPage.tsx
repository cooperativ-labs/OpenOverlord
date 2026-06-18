import { useEffect, useState } from 'react';

import { AgentLaunchFooter } from '@/components/objectives/AgentLaunchFooter';
import { HotkeyCaptureButton } from '@/components/settings/HotkeyCaptureButton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { type ButtonLoadingState, LoadingButton } from '@/components/ui/loading-button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { acceleratorToTerminalChord, terminalChordToAccelerator } from '@/lib/accelerator';
import {
  useAgentCatalog,
  useLaunchSettings,
  useRefreshAgentCatalog,
  useUpdateAgentLaunchConfig,
  useUpdateTerminalProfile
} from '@/lib/queries';

import type { TerminalProfileDto } from '../../../shared/contract.ts';

const INLINE_LAUNCHER = '__inline__';
const CUSTOM_LAUNCHER = '__custom__';

const TERMINAL_OPTIONS = [
  { label: 'Inline in this terminal', launcher: INLINE_LAUNCHER },
  { label: 'iTerm2', launcher: 'iTerm2' },
  { label: 'Terminal', launcher: 'Terminal' },
  { label: 'Ghostty', launcher: "open -a 'Ghostty' --args" },
  { label: 'Warp', launcher: "open -a 'Warp' --args" },
  { label: 'WezTerm', launcher: "open -a 'WezTerm' --args" },
  { label: 'Alacritty', launcher: "open -a 'Alacritty' --args" },
  { label: 'Kitty', launcher: "open -a 'kitty' --args" },
  { label: 'Custom launcher command', launcher: CUSTOM_LAUNCHER }
] as const;

function profileToDraft(profile: TerminalProfileDto) {
  const preset = TERMINAL_OPTIONS.find(option => option.launcher === profile.launcher);
  return {
    launcherChoice: profile.launcher
      ? preset
        ? profile.launcher
        : CUSTOM_LAUNCHER
      : INLINE_LAUNCHER,
    customLauncher: profile.launcher && !preset ? profile.launcher : '',
    placement: profile.placement,
    chord: profile.chord ?? ''
  };
}

function normalizeProfile({
  launcherChoice,
  customLauncher,
  placement,
  chord
}: {
  launcherChoice: string;
  customLauncher: string;
  placement: TerminalProfileDto['placement'];
  chord: string;
}): TerminalProfileDto {
  const launcher =
    launcherChoice === INLINE_LAUNCHER
      ? null
      : launcherChoice === CUSTOM_LAUNCHER
        ? customLauncher.trim() || null
        : launcherChoice;
  return {
    launcher,
    placement: launcher ? placement : 'window',
    chord: launcher && placement === 'chord' ? chord.trim() || null : null
  };
}

export function ExecutionTargetsPage() {
  const catalog = useAgentCatalog();
  const launchSettings = useLaunchSettings();
  const refreshCatalog = useRefreshAgentCatalog();
  const updateAgentLaunchConfig = useUpdateAgentLaunchConfig();
  const updateTerminalProfile = useUpdateTerminalProfile();

  const [launcherChoice, setLauncherChoice] = useState<string>(INLINE_LAUNCHER);
  const [customLauncher, setCustomLauncher] = useState('');
  const [placement, setPlacement] = useState<TerminalProfileDto['placement']>('window');
  const [chord, setChord] = useState('');
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [terminalButtonState, setTerminalButtonState] = useState<ButtonLoadingState>('default');

  useEffect(() => {
    const profile = launchSettings.data?.terminalProfile;
    if (!profile) return;
    const next = profileToDraft(profile);
    setLauncherChoice(next.launcherChoice);
    setCustomLauncher(next.customLauncher);
    setPlacement(next.placement);
    setChord(next.chord);
  }, [launchSettings.data?.terminalProfile]);

  if (launchSettings.isLoading && !launchSettings.data) {
    return <p className="text-sm text-muted-foreground">Loading execution-target settings…</p>;
  }

  if (launchSettings.isError || !launchSettings.data) {
    return (
      <p className="text-sm text-destructive">
        {(launchSettings.error as Error | undefined)?.message ??
          'Execution-target settings are unavailable right now.'}
      </p>
    );
  }

  const savedProfile = launchSettings.data.terminalProfile;
  const draftProfile = normalizeProfile({ launcherChoice, customLauncher, placement, chord });
  const terminalIsDirty =
    savedProfile.launcher !== draftProfile.launcher ||
    savedProfile.placement !== draftProfile.placement ||
    savedProfile.chord !== draftProfile.chord;
  const requiresCustomLauncher =
    launcherChoice === CUSTOM_LAUNCHER && draftProfile.launcher === null;
  const agents = [...(catalog.data?.agents ?? [])].sort((a, b) => a.label.localeCompare(b.label));

  async function saveTerminalProfile() {
    if (requiresCustomLauncher) {
      setTerminalButtonState('error');
      setTerminalError('Enter a launcher command or choose one of the built-in terminals.');
      return;
    }
    setTerminalButtonState('loading');
    setTerminalError(null);
    try {
      await updateTerminalProfile.mutateAsync(draftProfile);
      setTerminalButtonState('success');
      setTimeout(() => setTerminalButtonState('default'), 1600);
    } catch (error) {
      setTerminalButtonState('error');
      setTerminalError(
        error instanceof Error ? error.message : 'Failed to save the terminal profile.'
      );
    }
  }

  async function commitAgentConfig(
    agentKey: string,
    config: { preCommand: string; flags: string[] }
  ) {
    setAgentError(null);
    try {
      await updateAgentLaunchConfig.mutateAsync({ agentKey, body: config });
    } catch (error) {
      setAgentError(
        error instanceof Error ? error.message : 'Failed to save the agent launch defaults.'
      );
    }
  }

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div>
          <h2 className="text-base font-medium">Execution Targets</h2>
          <p className="text-sm text-muted-foreground">
            Per-user launch defaults for this machine. These values persist to your
            `user_execution_target_preferences` row for the local target fingerprint.
          </p>
        </div>

        <div className="rounded-lg border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">Local execution target</h3>
              <p className="text-sm text-muted-foreground">
                Launches queue against this device unless an objective overrides the target.
              </p>
            </div>
            <span className="rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground">
              local
            </span>
          </div>

          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <div className="space-y-1">
              <dt className="text-muted-foreground">Device label</dt>
              <dd className="font-medium">{launchSettings.data.deviceLabel}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">Execution target ID</dt>
              <dd className="break-all font-mono text-xs">
                {launchSettings.data.executionTargetId}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Terminal launch</h3>
          <p className="text-sm text-muted-foreground">
            Choose how agent runs open on this machine. These preferences are shared with the CLI
            and runner.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="execution-target-launcher">Terminal</Label>
            <Select
              value={launcherChoice}
              onValueChange={value => setLauncherChoice(value ?? INLINE_LAUNCHER)}
            >
              <SelectTrigger id="execution-target-launcher">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TERMINAL_OPTIONS.map(option => (
                  <SelectItem key={option.launcher} value={option.launcher}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="execution-target-placement">Placement</Label>
            <Select
              value={placement}
              disabled={draftProfile.launcher === null}
              onValueChange={value =>
                setPlacement((value as TerminalProfileDto['placement'] | null) ?? 'window')
              }
            >
              <SelectTrigger id="execution-target-placement">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="window">New window</SelectItem>
                <SelectItem value="tab">New tab</SelectItem>
                <SelectItem value="chord">Keyboard shortcut</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {launcherChoice === CUSTOM_LAUNCHER ? (
          <div className="space-y-2">
            <Label htmlFor="execution-target-custom-launcher">Custom launcher command</Label>
            <Input
              id="execution-target-custom-launcher"
              value={customLauncher}
              onChange={event => setCustomLauncher(event.target.value)}
              placeholder="open -a 'Ghostty' --args"
            />
            <p className="text-xs text-muted-foreground">
              Use the same prefix you would pass to `ovld --terminal`.
            </p>
          </div>
        ) : null}

        {draftProfile.launcher !== null && placement === 'chord' ? (
          <div className="space-y-2">
            <Label>Shortcut</Label>
            <div className="flex flex-wrap items-center gap-2">
              <HotkeyCaptureButton
                value={chord ? terminalChordToAccelerator(chord) : ''}
                onCapture={accel => setChord(acceleratorToTerminalChord(accel))}
                placeholder="Press to set"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Click the button and press the shortcut your terminal uses to split or open a new
              pane, for example ⌘ D in iTerm2.
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <LoadingButton
            buttonState={terminalButtonState}
            text="Save terminal profile"
            loadingText="Saving…"
            successText="Saved"
            errorText="Save failed"
            onClick={saveTerminalProfile}
            disabled={!terminalIsDirty && !requiresCustomLauncher}
          />
          <p className="text-xs text-muted-foreground">
            {draftProfile.launcher === null
              ? 'No launcher configured: runs stay inline in the current terminal.'
              : 'Saved changes apply to future launches from the web app and CLI.'}
          </p>
        </div>
        {terminalError ? <p className="text-sm text-destructive">{terminalError}</p> : null}
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Agent launch defaults</h3>
            <p className="text-sm text-muted-foreground">
              Store per-agent pre-commands and extra CLI flags for this execution target.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refreshCatalog.mutateAsync()}
            disabled={refreshCatalog.isPending}
          >
            {refreshCatalog.isPending ? 'Refreshing…' : 'Refresh catalog'}
          </Button>
        </div>

        {catalog.isLoading && !catalog.data ? (
          <p className="text-sm text-muted-foreground">Loading agent catalog…</p>
        ) : null}
        {catalog.isError ? (
          <p className="text-sm text-destructive">
            {(catalog.error as Error | undefined)?.message ?? 'Failed to load the agent catalog.'}
          </p>
        ) : null}
        {agentError ? <p className="text-sm text-destructive">{agentError}</p> : null}

        {agents.map((agent, index) => {
          const config = launchSettings.data?.agentConfigs[agent.key] ?? {
            preCommand: '',
            flags: []
          };
          return (
            <div key={agent.key} className="space-y-3">
              {index > 0 ? <Separator /> : null}
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-medium">{agent.label}</h4>
                  {!agent.availableByDefault ? (
                    <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      hidden by workspace default
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {agent.defaultModel ? `Default model: ${agent.defaultModel}. ` : ''}
                  These values are used when this agent is launched on this machine.
                </p>
              </div>
              <AgentLaunchFooter
                key={`${agent.key}:${config.preCommand}:${config.flags.join('\u0000')}`}
                agentKey={agent.key}
                preCommand={config.preCommand}
                flags={config.flags}
                onCommit={next => void commitAgentConfig(agent.key, next)}
                sourceHint="Saved to your per-target launch preferences."
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
