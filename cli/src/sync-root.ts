import path from 'node:path';

/**
 * Detects whether a credentials directory sits inside a continuously-synced
 * cloud folder (security audit 2026-06-18). Storing the `0600` `auth.json` token
 * there silently replicates the plaintext secret to cloud storage, bypassing the
 * local file-permission protection. `ovld doctor` warns when this is the case.
 */

export interface SyncRootMatch {
  /** Human-readable provider name, e.g. "iCloud Drive". */
  provider: string;
  /** The path segment (or joined segments) that matched, for the warning message. */
  matchedSegment: string;
}

interface SyncRootRule {
  provider: string;
  /** Matches a single path segment (case-insensitive). */
  segment?: RegExp;
  /** Matches a run of consecutive segments joined with '/'. */
  joined?: RegExp;
}

const RULES: SyncRootRule[] = [
  // iCloud Drive stores under ~/Library/Mobile Documents and, for third-party
  // app containers, ~/Library/CloudStorage.
  { provider: 'iCloud Drive', joined: /(^|\/)Library\/Mobile Documents(\/|$)/i },
  { provider: 'iCloud Drive', joined: /(^|\/)Library\/CloudStorage\/iCloud[^/]*(\/|$)/i },
  // Dropbox: a "Dropbox" or "Dropbox (Personal/Work)" folder.
  { provider: 'Dropbox', segment: /^Dropbox(\s|$|\s*\(.*\))/i },
  // OneDrive: "OneDrive" or "OneDrive - Company".
  { provider: 'OneDrive', segment: /^OneDrive(\s-\s.+)?$/i },
  // Google Drive desktop: "Google Drive", "My Drive", or the CloudStorage mount.
  { provider: 'Google Drive', segment: /^(Google Drive|My Drive)$/i },
  { provider: 'Google Drive', joined: /(^|\/)Library\/CloudStorage\/GoogleDrive[^/]*(\/|$)/i }
];

/**
 * Return the first cloud-sync root the given directory is nested inside, or
 * `null` when the path looks safe. The check is purely lexical (no filesystem
 * access) so it is cheap and testable.
 */
export function detectCloudSyncRoot(dir: string): SyncRootMatch | null {
  const normalized = path.resolve(dir).split(path.sep).join('/');
  const segments = normalized.split('/').filter(Boolean);

  for (const rule of RULES) {
    if (rule.joined && rule.joined.test(normalized)) {
      const match = normalized.match(rule.joined);
      return {
        provider: rule.provider,
        matchedSegment: (match?.[0] ?? '').replace(/^\/|\/$/g, '')
      };
    }
    if (rule.segment) {
      const hit = segments.find(seg => rule.segment!.test(seg));
      if (hit) return { provider: rule.provider, matchedSegment: hit };
    }
  }

  return null;
}
