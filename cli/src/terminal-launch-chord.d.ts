export type TerminalLaunchPlacement = 'window' | 'tab' | 'chord';
export type ParsedTerminalChord = {
    modifiers: Array<'command' | 'control' | 'option' | 'shift'>;
    key: string;
};
/** Parse a typed chord such as `cmd+d` or `ctrl+shift+\\`. */
export declare function parseTerminalLaunchChord(input: string): ParsedTerminalChord | null;
/** Canonical display form for a parsed chord. */
export declare function formatTerminalLaunchChord(chord: ParsedTerminalChord): string;
/** AppleScript `keystroke` modifier list for System Events. */
export declare function appleScriptKeystrokeClause(chord: ParsedTerminalChord): string;
export declare function normalizeTerminalLaunchPlacement(value: string | undefined | null): TerminalLaunchPlacement;
//# sourceMappingURL=terminal-launch-chord.d.ts.map