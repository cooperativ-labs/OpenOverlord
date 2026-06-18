const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function printStepTitle(title: string): void {
  if (process.stdout.isTTY) {
    printLine(`${BLUE}${title}${RESET}`);
  } else {
    printLine(title);
  }
}

export function printLines(lines: string[]): void {
  for (const line of lines) {
    printLine(line);
  }
}

export function printKeyValue(stderrPairs: Record<string, string>): void {
  for (const [key, value] of Object.entries(stderrPairs)) {
    process.stderr.write(`${key}=${value}\n`);
  }
}
