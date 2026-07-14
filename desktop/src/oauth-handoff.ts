const TICKET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/** Parse only the exact custom URL the desktop OAuth callback is allowed to open. */
export function parseDesktopOAuthHandoffUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'overlord:' ||
      url.hostname !== 'auth' ||
      url.pathname !== '/callback' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    ) {
      return null;
    }
    const ticket = url.searchParams.get('ticket');
    return ticket && TICKET_PATTERN.test(ticket) ? ticket : null;
  } catch {
    return null;
  }
}
