/**
 * Minimal HTML escaping helpers for interpolating dynamic values (URLs, tokens)
 * into the transactional email templates. Templates are plain string builders,
 * so any interpolated value must be escaped for its context to avoid breaking
 * out of an attribute or injecting markup.
 */

/** Escape text destined for HTML element content. */
export function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape a value destined for a double-quoted HTML attribute. */
export function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, '&quot;');
}
