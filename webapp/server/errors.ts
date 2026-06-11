/** A user-facing validation / not-found error that maps to a 4xx response. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: string
  ) {
    super(message);
  }
}
