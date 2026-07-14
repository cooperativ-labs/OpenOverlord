import {
  authCredentialsPath,
  type AuthCredentialType,
  readStoredAuthCredentials,
  resolveAuthBearerToken
} from './auth-credentials.js';
import { validateBearerToken } from './auth-login.js';
import {
  type BackendMode,
  findEffectiveConfigPath,
  hasExplicitBackendConfig,
  loadConfig,
  resolveBackendUrl
} from './config.js';

export type AuthCredentialSource = 'environment' | 'stored' | 'stored_mismatch' | 'none';

export type AuthStatusResult = {
  backendUrl: string;
  backendMode: BackendMode | 'unset';
  configPath: string | null;
  loggedIn: boolean;
  credentialSource: AuthCredentialSource;
  credentialType: AuthCredentialType | null;
  credentialsPath: string | null;
  validationError: string | null;
  /** ISO expiry of the stored credential when known (minted user tokens); null otherwise. */
  expiresAt: string | null;
  /** Whole days until `expiresAt` (negative if already past); null when expiry is unknown. */
  expiresInDays: number | null;
  /** True when `expiresAt` is known and in the past. */
  expired: boolean;
};

function resolveExpiry(expiresAt: string | null | undefined): {
  expiresAt: string | null;
  expiresInDays: number | null;
  expired: boolean;
} {
  if (typeof expiresAt !== 'string' || !expiresAt.trim()) {
    return { expiresAt: null, expiresInDays: null, expired: false };
  }
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) {
    return { expiresAt: null, expiresInDays: null, expired: false };
  }
  const msRemaining = parsed.getTime() - Date.now();
  return {
    expiresAt: parsed.toISOString(),
    expiresInDays: Math.floor(msRemaining / (24 * 60 * 60 * 1000)),
    expired: msRemaining <= 0
  };
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function inferCredentialTypeFromToken(token: string): AuthCredentialType {
  return token.startsWith('out_') ? 'user_token' : 'session_bearer';
}

export function resolveAuthCredentialSource({
  backendUrl,
  env = process.env
}: {
  backendUrl: string;
  env?: NodeJS.ProcessEnv;
}): {
  source: AuthCredentialSource;
  type: AuthCredentialType | null;
  credentialsPath: string | null;
} {
  const fromEnv =
    env.OVERLORD_USER_TOKEN?.trim() || env.OVLD_USER_TOKEN?.trim() || env.USER_TOKEN?.trim();
  if (fromEnv) {
    return {
      source: 'environment',
      type: inferCredentialTypeFromToken(fromEnv),
      credentialsPath: null
    };
  }

  const stored = readStoredAuthCredentials();
  if (!stored) {
    return { source: 'none', type: null, credentialsPath: null };
  }

  const credentialsPath = authCredentialsPath();
  if (normalizeBaseUrl(stored.backendUrl) !== normalizeBaseUrl(backendUrl)) {
    return {
      source: 'stored_mismatch',
      type: stored.type,
      credentialsPath
    };
  }

  return {
    source: 'stored',
    type: stored.type,
    credentialsPath
  };
}

export async function resolveAuthStatus({
  env = process.env
}: {
  env?: NodeJS.ProcessEnv;
} = {}): Promise<AuthStatusResult> {
  const config = loadConfig();
  const backendUrl = resolveBackendUrl(config);
  const backendMode = hasExplicitBackendConfig(config) ? config.backendMode : 'unset';
  const configPath = findEffectiveConfigPath();
  const credential = resolveAuthCredentialSource({ backendUrl, env });
  const token = resolveAuthBearerToken({ backendUrl, env });

  // Expiry is only known for stored credentials (env-var and pasted tokens carry
  // no expiry metadata). Read it once and attach it to every return path.
  const expiry = resolveExpiry(
    credential.source === 'stored' || credential.source === 'stored_mismatch'
      ? readStoredAuthCredentials()?.expiresAt
      : null
  );

  if (!token) {
    return {
      backendUrl,
      backendMode,
      configPath,
      loggedIn: false,
      credentialSource: credential.source,
      credentialType: credential.type,
      credentialsPath: credential.credentialsPath,
      validationError:
        credential.source === 'stored_mismatch'
          ? `Stored credentials are for ${readStoredAuthCredentials()?.backendUrl ?? 'another backend'}.`
          : null,
      ...expiry
    };
  }

  try {
    await validateBearerToken({ backendUrl, token });
    return {
      backendUrl,
      backendMode,
      configPath,
      loggedIn: true,
      credentialSource: credential.source,
      credentialType: credential.type,
      credentialsPath: credential.credentialsPath,
      validationError: null,
      ...expiry
    };
  } catch (error) {
    return {
      backendUrl,
      backendMode,
      configPath,
      loggedIn: false,
      credentialSource: credential.source,
      credentialType: credential.type,
      credentialsPath: credential.credentialsPath,
      validationError: error instanceof Error ? error.message : String(error),
      ...expiry
    };
  }
}
