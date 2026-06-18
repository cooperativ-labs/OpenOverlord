import { redactSecrets } from './redact-secrets.js';

export class CliError extends Error {
  readonly exitCode: number;

  constructor({ message, exitCode = 1 }: { message: string; exitCode?: number }) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function formatCliError(error: unknown): string {
  if (error instanceof CliError) {
    return redactSecrets(error.message);
  }

  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}
