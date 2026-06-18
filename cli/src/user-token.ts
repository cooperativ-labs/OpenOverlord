import { flagBoolean, flagValue, parseArgs } from './args.js';
import { createBackendClient } from './backend-client.js';
import { CliError } from './errors.js';
import { printJson } from './output.js';

// Light local mirrors of the relevant shared DTOs (the CLI package does not
// depend on the webapp shared contract). Only the fields the CLI reads/sends.
type TokenScope = 'full' | 'ticket_lifecycle';

interface UserTokenDto {
  id: string;
  label: string;
  tokenPrefix: string;
  status: string;
  scope: TokenScope;
  scopeGrants: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface CreateUserTokenResultDto {
  token: UserTokenDto;
  secret: string;
}

const DURATION_PATTERN = /^(\d+)\s*(h|d|w|mo|m|y)$/i;

/**
 * Parse a human duration (`90d`, `12w`, `3mo`, `6h`, `1y`) into an ISO-8601
 * timestamp that many units from now. `m` is treated as months for ergonomics
 * (`mo` also accepted); use `h` for hours.
 */
export function durationToIso(value: string, now: number = Date.now()): string {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new CliError({
      message: `Invalid --expires-in '${value}'. Use forms like 90d, 12w, 3mo, 6h, or 1y.`
    });
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const date = new Date(now);
  switch (unit) {
    case 'h':
      date.setHours(date.getHours() + amount);
      break;
    case 'd':
      date.setDate(date.getDate() + amount);
      break;
    case 'w':
      date.setDate(date.getDate() + amount * 7);
      break;
    case 'mo':
    case 'm':
      date.setMonth(date.getMonth() + amount);
      break;
    case 'y':
      date.setFullYear(date.getFullYear() + amount);
      break;
    default:
      throw new CliError({ message: `Unsupported duration unit in '${value}'.` });
  }
  return date.toISOString();
}

function normalizeScope(raw: string | undefined): TokenScope | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'full') return 'full';
  if (value === 'ticket-lifecycle' || value === 'ticket_lifecycle') return 'ticket_lifecycle';
  throw new CliError({
    message: `Unknown --scope '${raw}'. Use 'full' or 'ticket-lifecycle'.`
  });
}

function formatDate(iso: string | null): string {
  return iso ?? '—';
}

function printTokenTable(tokens: UserTokenDto[]): void {
  if (tokens.length === 0) {
    console.log('No tokens. Create one with `ovld user-token create --label "<label>"`.');
    return;
  }
  for (const token of tokens) {
    const expiry = token.expiresAt ? `expires ${formatDate(token.expiresAt)}` : 'no expiry';
    console.log(
      `${token.tokenPrefix}…  ${token.status.padEnd(8)}  ${token.scope.padEnd(16)}  ${expiry}  ${token.label}`
    );
    console.log(`    id: ${token.id}`);
  }
}

/**
 * `ovld user-token <create|list|revoke|rename>` — manage user-owned
 * non-interactive credentials. Subcommands call the existing REST endpoints
 * through the backend client; secrets are printed exactly once at creation.
 */
export async function runUserTokenCommand({ rest }: { rest: string[] }): Promise<void> {
  const [subcommand, ...subArgs] = rest;
  const parsed = parseArgs(subArgs);
  const json = flagBoolean(parsed.flags, '--json');
  const backend = createBackendClient();

  switch (subcommand) {
    case 'create': {
      const label = flagValue(parsed.flags, '--label') ?? parsed.positional[0];
      if (!label || !label.trim()) {
        throw new CliError({ message: 'A label is required: --label "macbook runner".' });
      }
      const scope = normalizeScope(flagValue(parsed.flags, '--scope'));

      // Expiry: --no-expiry sends null (never expires); --expires-in sets it;
      // omitting both lets the backend apply its 90-day default (send undefined).
      let expiresAt: string | null | undefined;
      if (flagBoolean(parsed.flags, '--no-expiry')) {
        expiresAt = null;
      } else {
        const expiresIn = flagValue(parsed.flags, '--expires-in');
        expiresAt = expiresIn ? durationToIso(expiresIn) : undefined;
      }

      const body: Record<string, unknown> = { label: label.trim() };
      if (expiresAt !== undefined) body.expiresAt = expiresAt;
      if (scope !== undefined) body.scope = scope;

      const result = await backend.post<CreateUserTokenResultDto>({
        path: '/api/user-tokens',
        body
      });

      if (json) {
        printJson(result);
        return;
      }
      console.log('Token created. Copy the secret now — it will not be shown again:\n');
      console.log(`  ${result.secret}\n`);
      console.log(`  label:  ${result.token.label}`);
      console.log(`  scope:  ${result.token.scope}`);
      console.log(
        `  expiry: ${result.token.expiresAt ? formatDate(result.token.expiresAt) : 'no expiry'}`
      );
      console.log('\nAuthenticate with:  ovld auth login --token <secret>');
      return;
    }

    case 'list': {
      const tokens = await backend.get<UserTokenDto[]>('/api/user-tokens');
      if (json) {
        printJson(tokens);
        return;
      }
      printTokenTable(tokens);
      return;
    }

    case 'revoke': {
      const id = flagValue(parsed.flags, '--id') ?? parsed.positional[0];
      if (!id) throw new CliError({ message: 'Usage: ovld user-token revoke <token-id>' });
      const token = await backend.post<UserTokenDto>({ path: `/api/user-tokens/${id}/revoke` });
      if (json) {
        printJson(token);
        return;
      }
      console.log(`Revoked token ${token.tokenPrefix}… (${token.label}).`);
      return;
    }

    case 'rename': {
      const id = flagValue(parsed.flags, '--id') ?? parsed.positional[0];
      const label = flagValue(parsed.flags, '--label') ?? parsed.positional[1];
      if (!id || !label) {
        throw new CliError({ message: 'Usage: ovld user-token rename <token-id> "<new label>"' });
      }
      const token = await backend.patch<UserTokenDto>({
        path: `/api/user-tokens/${id}`,
        body: { label }
      });
      if (json) {
        printJson(token);
        return;
      }
      console.log(`Renamed token ${token.tokenPrefix}… to "${token.label}".`);
      return;
    }

    default:
      throw new CliError({
        message:
          `Unknown user-token subcommand: ${subcommand ?? '(none)'}\n` +
          'Usage: ovld user-token <create|list|revoke|rename>'
      });
  }
}
