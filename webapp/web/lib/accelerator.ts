const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

/**
 * Translate a physical key code into a stable, layout-independent label so the
 * captured accelerator matches what Electron's `globalShortcut` expects.
 */
export function keyFromPhysicalCode(event: globalThis.KeyboardEvent): string | null {
  const { code } = event;
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }
  if (/^Digit\d$/.test(code)) {
    return code.slice(5);
  }
  if (/^Numpad\d$/.test(code)) {
    return `num${code.slice(6)}`;
  }
  return null;
}

/**
 * Build an Electron accelerator string (e.g. `Command+Shift+O`) from a keydown
 * event, or null when the event is not a usable shortcut (modifier-only press,
 * Escape, or no modifier held).
 */
export function eventToAccelerator(event: globalThis.KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) {
    return null;
  }

  const parts: string[] = [];
  if (event.metaKey) parts.push('Command');
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  let key = keyFromPhysicalCode(event) ?? event.key;
  if (key.length === 1) {
    key = key.toUpperCase();
  } else if (/^F\d{1,2}$/.test(key)) {
    // Function keys pass through unchanged.
  } else if (key === ' ') {
    key = 'Space';
  } else if (key === 'ArrowUp') {
    key = 'Up';
  } else if (key === 'ArrowDown') {
    key = 'Down';
  } else if (key === 'ArrowLeft') {
    key = 'Left';
  } else if (key === 'ArrowRight') {
    key = 'Right';
  } else if (key === 'Escape') {
    return null;
  }

  if (parts.length === 0) {
    return null;
  }

  parts.push(key);
  return parts.join('+');
}

/** Render an accelerator using the conventional glyphs shown elsewhere in the app. */
export function formatAcceleratorForDisplay(accel: string): string {
  return accel
    .replace(/CommandOrControl/gi, '⌘')
    .replace(/Command/gi, '⌘')
    .replace(/Cmd/gi, '⌘')
    .replace(/Control/gi, 'Ctrl')
    .replace(/Alt/gi, '⌥')
    .replace(/Option/gi, '⌥')
    .replace(/Shift/gi, '⇧')
    .replace(/\+/g, ' ');
}

/** Convert an Electron accelerator into a terminal launch chord such as `cmd+d`. */
export function acceleratorToTerminalChord(accelerator: string): string {
  const parts = accelerator.split('+');
  if (parts.length === 0) return '';

  const keyPart = parts[parts.length - 1] ?? '';
  const modifierParts = parts.slice(0, -1);

  const modifiers = modifierParts.map(part => {
    switch (part.toLowerCase()) {
      case 'command':
      case 'cmd':
        return 'cmd';
      case 'control':
      case 'ctrl':
        return 'ctrl';
      case 'alt':
      case 'option':
        return 'alt';
      case 'shift':
        return 'shift';
      default:
        return part.toLowerCase();
    }
  });

  let key = keyPart;
  if (key.length === 1) {
    key = key.toLowerCase();
  } else if (key === 'Space') {
    key = 'space';
  } else {
    key = key.toLowerCase();
  }

  return [...modifiers, key].join('+');
}

/** Convert a stored terminal launch chord into an Electron accelerator for display. */
export function terminalChordToAccelerator(chord: string): string {
  const parts = chord
    .split('+')
    .map(part => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';

  const keyPart = parts[parts.length - 1] ?? '';
  const modifierParts = parts.slice(0, -1);

  const modifiers = modifierParts.map(part => {
    switch (part.toLowerCase()) {
      case 'cmd':
      case 'command':
      case 'meta':
        return 'Command';
      case 'ctrl':
      case 'control':
        return 'Control';
      case 'alt':
      case 'option':
      case 'opt':
        return 'Alt';
      case 'shift':
        return 'Shift';
      default:
        return part;
    }
  });

  let key = keyPart;
  if (key.length === 1) {
    key = key.toUpperCase();
  } else if (key === 'space') {
    key = 'Space';
  } else if (/^f\d{1,2}$/i.test(key)) {
    key = key.toUpperCase();
  } else if (['up', 'down', 'left', 'right'].includes(key.toLowerCase())) {
    key = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
  }

  return [...modifiers, key].join('+');
}
