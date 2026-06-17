import { createInterface } from 'node:readline/promises';

import { writeStoredAuthCredentials } from './auth-credentials.js';
import { CliError } from './errors.js';

export type AuthLoginMethod = 'password' | 'user_token';

export type AuthLoginResult = {
  ok: true;
  authMethod: AuthLoginMethod;
  credentialType: 'session_bearer' | 'user_token';
  backendUrl: string;
  credentialsPath: string;
};

export function normalizeLocalUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function usernameToLocalEmail(username: string): string {
  return `${normalizeLocalUsername(username)}@overlord.local`;
}

export function validateLocalUsername(username: string): string | null {
  const normalized = normalizeLocalUsername(username);
  if (normalized.length < 3) return 'Username must be at least 3 characters.';
  if (normalized.length > 40) return 'Username must be 40 characters or fewer.';
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    return 'Use letters, numbers, dots, underscores, or dashes.';
  }
  return null;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

async function promptLine({
  message,
  defaultValue
}: {
  message: string;
  defaultValue?: string;
}): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError({
      message:
        'Interactive login requires a TTY. Set OVERLORD_USER_TOKEN / OVLD_USER_TOKEN / USER_TOKEN for non-interactive use.'
    });
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = await rl.question(`${message}${suffix}: `);
    return answer.trim() || defaultValue || '';
  } finally {
    rl.close();
  }
}

async function promptPassword({ message }: { message: string }): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError({
      message:
        'Interactive login requires a TTY. Set OVERLORD_USER_TOKEN / OVLD_USER_TOKEN / USER_TOKEN for non-interactive use.'
    });
  }

  process.stdout.write(`${message}: `);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let password = '';

    const cleanup = (): void => {
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };

    const onData = (chunk: string): void => {
      const char = chunk;

      if (char === '\u0003') {
        cleanup();
        process.stdout.write('\n');
        reject(new CliError({ message: 'Login cancelled.' }));
        return;
      }

      if (char === '\r' || char === '\n' || char === '\u0004') {
        cleanup();
        process.stdout.write('\n');
        resolve(password);
        return;
      }

      if (char === '\u007f' || char === '\b') {
        password = password.slice(0, -1);
        return;
      }

      password += char;
    };

    stdin.on('data', onData);
  });
}

async function promptAuthMethod(): Promise<AuthLoginMethod> {
  console.log('Choose how to authenticate:');
  console.log('  1. Username and password');
  console.log('  2. USER_TOKEN (generate one in Overlord Desktop: Settings > Tokens)');

  const answer = (await promptLine({ message: 'Selection', defaultValue: '1' })).toLowerCase();
  if (answer === '2' || answer === 'token' || answer === 'user_token') return 'user_token';
  if (answer === '1' || answer === 'password' || answer === 'username') return 'password';
  throw new CliError({ message: 'Selection must be 1 or 2.' });
}

function errorMessageFromJson(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return typeof record.error === 'string'
    ? record.error
    : typeof record.message === 'string'
      ? record.message
      : null;
}

async function readResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function formatUserTokenLoginCommand(token: string): string {
  return `ovld auth login --token ${token}`;
}

export async function loginWithUserToken({
  backendUrl,
  token
}: {
  backendUrl: string;
  token: string;
}): Promise<AuthLoginResult> {
  const normalizedBackendUrl = normalizeBaseUrl(backendUrl);
  const trimmedToken = token.trim();
  if (!trimmedToken) throw new CliError({ message: 'USER_TOKEN is required.' });
  if (!trimmedToken.startsWith('out_')) {
    throw new CliError({
      message:
        'USER_TOKEN must start with "out_". Generate one in Overlord Desktop: Settings > Tokens.'
    });
  }

  await validateBearerToken({ backendUrl: normalizedBackendUrl, token: trimmedToken });
  writeStoredAuthCredentials({
    type: 'user_token',
    token: trimmedToken,
    backendUrl: normalizedBackendUrl
  });

  const { authCredentialsPath } = await import('./auth-credentials.js');
  return {
    ok: true,
    authMethod: 'user_token',
    credentialType: 'user_token',
    backendUrl: normalizedBackendUrl,
    credentialsPath: authCredentialsPath()
  };
}

export async function validateBearerToken({
  backendUrl,
  token
}: {
  backendUrl: string;
  token: string;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(backendUrl);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/meta`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      }
    });
  } catch (error) {
    throw new CliError({
      message:
        `Could not reach Overlord backend at ${baseUrl}.\n` +
        (error instanceof Error ? error.message : String(error))
    });
  }

  if (response.ok) return;

  const payload = await readResponseJson(response);
  throw new CliError({
    message:
      errorMessageFromJson(payload) ??
      `Authentication failed (${response.status}). Check your credentials and try again.`
  });
}

export async function signInWithUsernamePassword({
  backendUrl,
  username,
  password
}: {
  backendUrl: string;
  username: string;
  password: string;
}): Promise<string> {
  const usernameError = validateLocalUsername(username);
  if (usernameError) throw new CliError({ message: usernameError });
  if (!password) throw new CliError({ message: 'Password is required.' });

  const baseUrl = normalizeBaseUrl(backendUrl);
  const email = usernameToLocalEmail(username);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // Better Auth enforces a CSRF/origin check on POST sign-in. Node's fetch
        // sends `Sec-Fetch-*` headers, which engages that check, so a missing
        // Origin is rejected with "Missing or null Origin". The backend trusts
        // its own loopback/base origin, so send it explicitly.
        Origin: baseUrl
      },
      body: JSON.stringify({ email, password })
    });
  } catch (error) {
    throw new CliError({
      message:
        `Could not reach Overlord backend at ${baseUrl}.\n` +
        (error instanceof Error ? error.message : String(error))
    });
  }

  const token = response.headers.get('set-auth-token')?.trim();
  if (response.ok && token) return token;

  const payload = await readResponseJson(response);
  throw new CliError({
    message:
      errorMessageFromJson(payload) ??
      `Sign-in failed (${response.status}). Check your username and password.`
  });
}

export async function runInteractiveAuthLogin({
  backendUrl
}: {
  backendUrl: string;
}): Promise<AuthLoginResult> {
  const method = await promptAuthMethod();
  const normalizedBackendUrl = normalizeBaseUrl(backendUrl);
  const { authCredentialsPath } = await import('./auth-credentials.js');

  if (method === 'user_token') {
    const token = await promptLine({ message: 'Paste your USER_TOKEN' });
    return loginWithUserToken({ backendUrl: normalizedBackendUrl, token });
  }

  const username = await promptLine({ message: 'Username' });
  const usernameError = validateLocalUsername(username);
  if (usernameError) throw new CliError({ message: usernameError });

  const password = await promptPassword({ message: 'Password' });
  const sessionToken = await signInWithUsernamePassword({
    backendUrl: normalizedBackendUrl,
    username,
    password
  });
  await validateBearerToken({ backendUrl: normalizedBackendUrl, token: sessionToken });
  writeStoredAuthCredentials({
    type: 'session_bearer',
    token: sessionToken,
    backendUrl: normalizedBackendUrl
  });

  return {
    ok: true,
    authMethod: 'password',
    credentialType: 'session_bearer',
    backendUrl: normalizedBackendUrl,
    credentialsPath: authCredentialsPath()
  };
}
