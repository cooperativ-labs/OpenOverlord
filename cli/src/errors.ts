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
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
