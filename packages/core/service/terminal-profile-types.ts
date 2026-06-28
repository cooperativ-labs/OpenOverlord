export type TerminalLaunchPlacement = 'window' | 'tab' | 'chord';

/** Per-user terminal launch settings stored on user_execution_target_preferences. */
export type TerminalProfile = {
  launcher: string | null;
  placement: TerminalLaunchPlacement;
  chord: string | null;
};

export const DEFAULT_TERMINAL_PROFILE: TerminalProfile = {
  launcher: 'Terminal',
  placement: 'window',
  chord: null
};

export const EMPTY_TERMINAL_PROFILE = DEFAULT_TERMINAL_PROFILE;

export function parseTerminalProfileJson(json: string | null | undefined): TerminalProfile {
  if (!json?.trim()) return { ...DEFAULT_TERMINAL_PROFILE };
  try {
    const parsed = JSON.parse(json) as {
      launcher?: unknown;
      placement?: unknown;
      chord?: unknown;
    };
    const hasLauncher = Object.prototype.hasOwnProperty.call(parsed, 'launcher');
    const placementRaw =
      typeof parsed.placement === 'string'
        ? parsed.placement.trim()
        : DEFAULT_TERMINAL_PROFILE.placement;
    const placement: TerminalLaunchPlacement =
      placementRaw === 'tab' ? 'tab' : placementRaw === 'chord' ? 'chord' : 'window';
    return {
      launcher:
        typeof parsed.launcher === 'string' && parsed.launcher.trim()
          ? parsed.launcher.trim()
          : hasLauncher
            ? null
            : DEFAULT_TERMINAL_PROFILE.launcher,
      placement,
      chord: typeof parsed.chord === 'string' && parsed.chord.trim() ? parsed.chord.trim() : null
    };
  } catch {
    return { ...DEFAULT_TERMINAL_PROFILE };
  }
}

export function serializeTerminalProfile(profile: TerminalProfile): string {
  return JSON.stringify({
    launcher: profile.launcher,
    placement: profile.placement,
    chord: profile.placement === 'chord' ? profile.chord : null
  });
}
