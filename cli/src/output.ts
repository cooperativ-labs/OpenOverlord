export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printLine(line: string): void {
  process.stdout.write(`${line}\n`);
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
