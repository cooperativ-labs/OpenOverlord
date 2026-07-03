export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
    /** Structured, machine-readable payload for self-servicing error recovery. */
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export function assertFound<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new ServiceError(message, 'not_found', 404);
  }
  return value;
}
