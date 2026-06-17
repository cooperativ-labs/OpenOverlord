import type { TerminalLaunchPlacement } from './terminal-launch-chord.js';

/** Per-user terminal launch settings stored on user_execution_target_preferences. */
export type TerminalProfile = {
  launcher: string | null;
  placement: TerminalLaunchPlacement;
  chord: string | null;
};

export const EMPTY_TERMINAL_PROFILE: TerminalProfile = {
  launcher: null,
  placement: 'window',
  chord: null
};

export function parseTerminalProfileJson(json: string | null | undefined): TerminalProfile {
  if (!json?.trim()) return { ...EMPTY_TERMINAL_PROFILE };
  try {
    const parsed = JSON.parse(json) as {
      launcher?: unknown;
      placement?: unknown;
      chord?: unknown;
    };
    const placementRaw = typeof parsed.placement === 'string' ? parsed.placement.trim() : 'window';
    const placement: TerminalLaunchPlacement =
      placementRaw === 'tab' ? 'tab' : placementRaw === 'chord' ? 'chord' : 'window';
    return {
      launcher:
        typeof parsed.launcher === 'string' && parsed.launcher.trim()
          ? parsed.launcher.trim()
          : null,
      placement,
      chord: typeof parsed.chord === 'string' && parsed.chord.trim() ? parsed.chord.trim() : null
    };
  } catch {
    return { ...EMPTY_TERMINAL_PROFILE };
  }
}

export function serializeTerminalProfile(profile: TerminalProfile): string {
  return JSON.stringify({
    launcher: profile.launcher,
    placement: profile.placement,
    chord: profile.placement === 'chord' ? profile.chord : null
  });
}
