import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';

import type { BackendClient } from './backend-client.js';
import { findEffectiveConfigPath } from './config.js';
import { normalizeTerminalLaunchPlacement } from './terminal-launch-chord.js';
import {
  EMPTY_TERMINAL_PROFILE,
  parseTerminalProfileJson,
  type TerminalProfile
} from './terminal-profile-types.js';

type LaunchSettingsResponse = {
  executionTargetId: string;
  deviceLabel: string;
  terminalProfile?: TerminalProfile;
  terminal_profile?: TerminalProfile;
};

function terminalProfileFromResponse(body: LaunchSettingsResponse): TerminalProfile {
  const profile = body.terminalProfile ?? body.terminal_profile;
  if (!profile) return { ...EMPTY_TERMINAL_PROFILE };
  return {
    launcher: profile.launcher ?? null,
    placement: profile.placement ?? 'window',
    chord: profile.chord ?? null,
    background: profile.background ?? false
  };
}

/** Read deprecated terminal keys from overlord.toml for one-time migration during setup. */
export function readLegacyTerminalProfileFromToml(): TerminalProfile | null {
  const configPath = findEffectiveConfigPath();
  if (!configPath || !existsSync(configPath)) return null;

  const toml = parse(readFileSync(configPath, 'utf8')) as {
    terminal_launcher?: string;
    terminal_launch_placement?: string;
    terminal_launch_chord?: string;
  };

  const launcher = toml.terminal_launcher?.trim();
  if (!launcher) return null;

  return {
    launcher,
    placement: normalizeTerminalLaunchPlacement(toml.terminal_launch_placement),
    chord: toml.terminal_launch_chord?.trim() ? toml.terminal_launch_chord.trim() : null
  };
}

export async function fetchTerminalProfile({
  backend
}: {
  backend: BackendClient;
}): Promise<TerminalProfile & { executionTargetId: string; deviceLabel: string }> {
  const response = await backend.get<LaunchSettingsResponse>('/api/launch-settings');
  const profile = terminalProfileFromResponse(response);
  return {
    ...profile,
    executionTargetId: response.executionTargetId,
    deviceLabel: response.deviceLabel
  };
}

export async function saveTerminalProfile({
  backend,
  profile
}: {
  backend: BackendClient;
  profile: TerminalProfile;
}): Promise<TerminalProfile & { executionTargetId: string; deviceLabel: string }> {
  const response = await backend.patch<LaunchSettingsResponse>({
    path: '/api/launch-settings/terminal-profile',
    body: profile
  });
  const saved = terminalProfileFromResponse(response);
  return {
    ...saved,
    executionTargetId: response.executionTargetId,
    deviceLabel: response.deviceLabel
  };
}

export function terminalProfileToLaunchSettings(profile: TerminalProfile): {
  terminalLauncher: string | null;
  terminalLaunchPlacement: TerminalProfile['placement'];
  terminalLaunchChord: string | null;
  terminalLaunchBackground: boolean;
} {
  return {
    terminalLauncher: profile.launcher,
    terminalLaunchPlacement: profile.placement,
    terminalLaunchChord: profile.chord,
    terminalLaunchBackground: profile.background ?? false
  };
}

export { EMPTY_TERMINAL_PROFILE, parseTerminalProfileJson, type TerminalProfile };
