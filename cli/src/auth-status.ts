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
};

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
          : null
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
      validationError: null
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
      validationError: error instanceof Error ? error.message : String(error)
    };
  }
}
