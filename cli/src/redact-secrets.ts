/**
 * Shared secret-redaction helper for CLI diagnostics.
 *
 * `USER_TOKEN` secrets are `out_`-prefixed, high-entropy strings (see
 * `auth/docs/07-user-token-authentication.md`). The security audit (2026-06-18)
 * recommended a single redaction utility so token-like values never leak into
 * error output, verbose logs, or crash reports as new code paths are added.
 *
 * The first 12 characters (`out_` + the 8-char non-secret display prefix) are
 * preserved for correlation/debugging; everything after the prefix — the actual
 * secret material — is masked.
 */

const TOKEN_PATTERN = /out_[A-Za-z0-9_-]{8,}/g;

/** Mask any `out_…` USER_TOKEN secrets found in `value`, keeping the display prefix. */
export function redactSecrets(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.replace(TOKEN_PATTERN, match => `${match.slice(0, 12)}…[redacted]`);
}
