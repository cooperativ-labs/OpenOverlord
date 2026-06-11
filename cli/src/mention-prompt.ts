import { createInterface } from 'node:readline';

import {
  type ActiveMention,
  findActiveMention,
  fuzzyMatchFiles,
  getCollapsedFileMentionLabel,
  insertMention
} from './mentions.js';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CLEAR_DOWN = '\x1b[0J';
const MENU_LIMIT = 8;

export interface MentionPromptOptions {
  /** Candidate file paths offered when the user types `@`. */
  files: string[];
  /** Label shown before the input (kept plain so cursor math stays exact). */
  prompt: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/**
 * Prompt for a line of text with a live `@`-mention file picker. As the user
 * types `@`, a fuzzy-matched menu of repository files appears; Up/Down moves the
 * selection, Tab/Enter inserts it, Esc dismisses the menu, and Enter on a closed
 * menu submits. Falls back to a plain readline prompt when stdin is not a TTY.
 *
 * Resolves to the entered text, or `null` if the user cancelled (Ctrl-C).
 */
export function promptWithMentions({
  files,
  prompt,
  input = process.stdin,
  output = process.stdout
}: MentionPromptOptions): Promise<string | null> {
  if (!input.isTTY || files.length === 0) {
    return plainPrompt(prompt, input, output);
  }
  return new Promise(resolve => {
    let buffer = '';
    let selected = 0;
    let menuDismissed = false;
    let renderedMenuRows = 0;

    const visibleMatches = (mention: ActiveMention | null): string[] =>
      mention ? fuzzyMatchFiles(files, mention.query, MENU_LIMIT) : [];

    const render = () => {
      const mention = findActiveMention(buffer, buffer.length);
      const matches = menuDismissed ? [] : visibleMatches(mention);
      if (selected >= matches.length) selected = Math.max(0, matches.length - 1);

      // Cursor sits at the end of the input line from the previous render.
      output.write(`\r${CLEAR_DOWN}${prompt}${buffer}`);

      matches.forEach((filePath, index) => {
        const marker = index === selected ? '❯' : ' ';
        const label = getCollapsedFileMentionLabel(filePath);
        const detail = label === filePath ? '' : `  ${DIM}${filePath}${RESET}`;
        output.write(`\n  ${marker} @${label}${detail}`);
      });

      // Park the cursor back at the end of the input line for the next render.
      if (matches.length > 0) {
        output.write(`\x1b[${matches.length}A\r\x1b[${prompt.length + buffer.length}C`);
      }
      renderedMenuRows = matches.length;
    };

    const finish = (result: string | null) => {
      input.removeListener('data', onData);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      // Move below the menu so subsequent output starts on a clean line.
      if (renderedMenuRows > 0) output.write(`\x1b[${renderedMenuRows}B`);
      output.write('\n');
      resolve(result);
    };

    const acceptMention = (): boolean => {
      const mention = findActiveMention(buffer, buffer.length);
      const matches = menuDismissed ? [] : visibleMatches(mention);
      if (!mention || matches.length === 0) return false;
      const choice = matches[selected] ?? matches[0];
      if (choice === undefined) return false;
      const next = insertMention(buffer, mention, choice, buffer.length);
      buffer = next.text;
      selected = 0;
      menuDismissed = false;
      return true;
    };

    const menuOpen = (): boolean =>
      !menuDismissed && visibleMatches(findActiveMention(buffer, buffer.length)).length > 0;

    const onChar = (char: string) => {
      if (char === '\r' || char === '\n') {
        if (menuOpen()) {
          acceptMention();
          render();
        } else {
          finish(buffer.trim());
        }
        return;
      }
      if (char === '\t') {
        if (acceptMention()) render();
        return;
      }
      if (char === '\x03') {
        finish(null);
        return;
      }
      if (char === '\x7f' || char === '\b') {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          selected = 0;
          menuDismissed = false;
          render();
        }
        return;
      }
      if (char >= ' ') {
        buffer += char;
        selected = 0;
        menuDismissed = false;
        render();
      }
    };

    const onData = (chunk: string) => {
      if (chunk === '\x1b[A') {
        if (menuOpen()) {
          const count = visibleMatches(findActiveMention(buffer, buffer.length)).length;
          selected = (selected - 1 + count) % count;
          render();
        }
        return;
      }
      if (chunk === '\x1b[B') {
        if (menuOpen()) {
          const count = visibleMatches(findActiveMention(buffer, buffer.length)).length;
          selected = (selected + 1) % count;
          render();
        }
        return;
      }
      if (chunk === '\x1b') {
        if (menuOpen()) {
          menuDismissed = true;
          render();
        }
        return;
      }
      for (const char of chunk) onChar(char);
    };

    output.write(`${prompt}`);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    input.on('data', onData);
  });
}

function plainPrompt(
  prompt: string,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream
): Promise<string | null> {
  return new Promise(resolve => {
    const rl = createInterface({ input, output });
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
