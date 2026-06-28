export const DEFAULT_TERMINAL_PROFILE = {
    launcher: 'Terminal',
    placement: 'window',
    chord: null
};
export const EMPTY_TERMINAL_PROFILE = DEFAULT_TERMINAL_PROFILE;
export function parseTerminalProfileJson(json) {
    if (!json?.trim())
        return { ...DEFAULT_TERMINAL_PROFILE };
    try {
        const parsed = JSON.parse(json);
        const hasLauncher = Object.prototype.hasOwnProperty.call(parsed, 'launcher');
        const placementRaw = typeof parsed.placement === 'string'
            ? parsed.placement.trim()
            : DEFAULT_TERMINAL_PROFILE.placement;
        const placement = placementRaw === 'tab' ? 'tab' : placementRaw === 'chord' ? 'chord' : 'window';
        return {
            launcher: typeof parsed.launcher === 'string' && parsed.launcher.trim()
                ? parsed.launcher.trim()
                : hasLauncher
                    ? null
                    : DEFAULT_TERMINAL_PROFILE.launcher,
            placement,
            chord: typeof parsed.chord === 'string' && parsed.chord.trim() ? parsed.chord.trim() : null
        };
    }
    catch {
        return { ...DEFAULT_TERMINAL_PROFILE };
    }
}
export function serializeTerminalProfile(profile) {
    return JSON.stringify({
        launcher: profile.launcher,
        placement: profile.placement,
        chord: profile.placement === 'chord' ? profile.chord : null
    });
}
//# sourceMappingURL=terminal-profile-types.js.map