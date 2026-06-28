const MODIFIER_ALIASES = {
    cmd: 'command',
    command: 'command',
    meta: 'command',
    ctrl: 'control',
    control: 'control',
    alt: 'option',
    option: 'option',
    opt: 'option',
    shift: 'shift'
};
const SPECIAL_KEYS = {
    enter: '\r',
    return: '\r',
    tab: '\t',
    space: ' ',
    escape: '\u001b',
    esc: '\u001b',
    backspace: '\u0008',
    delete: '\u007f',
    up: '\u001b[A',
    down: '\u001b[B',
    left: '\u001b[D',
    right: '\u001b[C'
};
/** Parse a typed chord such as `cmd+d` or `ctrl+shift+\\`. */
export function parseTerminalLaunchChord(input) {
    const normalized = input.trim().toLowerCase();
    if (!normalized || /\+\+|^\+|\+$/.test(normalized))
        return null;
    const parts = normalized
        .split('+')
        .map(part => part.trim())
        .filter(Boolean);
    if (parts.length === 0)
        return null;
    const modifiers = [];
    const keyParts = [];
    for (const part of parts) {
        const modifier = MODIFIER_ALIASES[part];
        if (modifier) {
            if (!modifiers.includes(modifier))
                modifiers.push(modifier);
            continue;
        }
        keyParts.push(part);
    }
    if (keyParts.length !== 1)
        return null;
    const rawKey = keyParts[0] ?? '';
    const key = rawKey.length === 1
        ? rawKey
        : SPECIAL_KEYS[rawKey] !== undefined
            ? SPECIAL_KEYS[rawKey]
            : rawKey;
    if (!key)
        return null;
    return { modifiers, key };
}
/** Canonical display form for a parsed chord. */
export function formatTerminalLaunchChord(chord) {
    const modifierLabels = chord.modifiers.map(modifier => {
        switch (modifier) {
            case 'command':
                return 'cmd';
            case 'control':
                return 'ctrl';
            case 'option':
                return 'alt';
            case 'shift':
                return 'shift';
        }
    });
    const keyLabel = chord.key === '\r'
        ? 'enter'
        : chord.key === '\t'
            ? 'tab'
            : chord.key === ' '
                ? 'space'
                : chord.key.length === 1
                    ? chord.key
                    : 'key';
    return [...modifierLabels, keyLabel].join('+');
}
/** AppleScript `keystroke` modifier list for System Events. */
export function appleScriptKeystrokeClause(chord) {
    const modifierClause = chord.modifiers.length > 0
        ? ` using {${chord.modifiers.map(modifier => `${modifier} down`).join(', ')}}`
        : '';
    const keyLiteral = chord.key.length === 1 && chord.key !== '\\'
        ? JSON.stringify(chord.key)
        : JSON.stringify(chord.key);
    return `keystroke ${keyLiteral}${modifierClause}`;
}
export function normalizeTerminalLaunchPlacement(value) {
    switch (value?.trim().toLowerCase()) {
        case 'tab':
            return 'tab';
        case 'chord':
        case 'split':
        case 'shortcut':
            return 'chord';
        default:
            return 'window';
    }
}
//# sourceMappingURL=terminal-launch-chord.js.map