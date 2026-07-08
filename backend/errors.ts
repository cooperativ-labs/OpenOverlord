/** A user-facing validation / not-found error that maps to a 4xx response. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: string,
    /** Optional machine-readable code so clients can branch without parsing the message. */
    public code?: string
  ) {
    super(message);
  }
}

type SqliteErrorLike = {
  code?: string;
  message?: string;
};

/** Map better-sqlite3 constraint failures to actionable API errors. */
export function apiErrorFromDatabaseError(error: unknown): ApiError | null {
  if (!error || typeof error !== 'object') return null;
  const { code, message = '' } = error as SqliteErrorLike;
  if (!code?.startsWith('SQLITE_CONSTRAINT')) return null;

  if (code === 'SQLITE_CONSTRAINT_UNIQUE' && message.includes('project_resources')) {
    if (message.includes('resource_key') || message.includes('target_key')) {
      return new ApiError(
        409,
        'This resource key is already linked to the project on this execution target.',
        message
      );
    }
    return new ApiError(
      409,
      'This directory is already linked to the project on this device.',
      message
    );
  }

  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return new ApiError(400, 'A related record is missing or invalid.', message);
  }

  return new ApiError(409, 'Database constraint violation.', message);
}
