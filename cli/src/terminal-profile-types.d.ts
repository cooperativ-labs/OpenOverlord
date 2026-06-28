import type { TerminalLaunchPlacement } from './terminal-launch-chord.js';
/** Per-user terminal launch settings stored on user_execution_target_preferences. */
export type TerminalProfile = {
    launcher: string | null;
    placement: TerminalLaunchPlacement;
    chord: string | null;
};
export declare const DEFAULT_TERMINAL_PROFILE: TerminalProfile;
export declare const EMPTY_TERMINAL_PROFILE: TerminalProfile;
export declare function parseTerminalProfileJson(json: string | null | undefined): TerminalProfile;
export declare function serializeTerminalProfile(profile: TerminalProfile): string;
//# sourceMappingURL=terminal-profile-types.d.ts.map