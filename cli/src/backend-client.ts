import { clearStoredAuthCredentials, readStoredAuthCredentials } from './auth-credentials.js';
import { loadConfig, resolveBackendUrl } from './config.js';
import { CliError } from './errors.js';

export type BackendClient = {
  baseUrl: string;
  health: () => Promise<{ ok: boolean; [key: string]: unknown }>;
  get: <T>(path: string) => Promise<T>;
  post: <T>({ path, body }: { path: string; body?: unknown }) => Promise<T>;
  patch: <T>({ path, body }: { path: string; body?: unknown }) => Promise<T>;
  delete: <T>(path: string) => Promise<T>;
};

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function resolveAuthHeaders({ baseUrl }: { baseUrl: string }): {
  headers: Record<string, string>;
  fromStored: boolean;
} {
  const fromEnv =
    process.env.OVERLORD_USER_TOKEN?.trim() ||
    process.env.OVLD_USER_TOKEN?.trim() ||
    process.env.USER_TOKEN?.trim();
  if (fromEnv) {
    return { headers: { Authorization: `Bearer ${fromEnv}` }, fromStored: false };
  }

  const stored = readStoredAuthCredentials();
  if (!stored) return { headers: {}, fromStored: false };
  if (normalizeBaseUrl(stored.backendUrl) !== normalizeBaseUrl(baseUrl)) {
    return { headers: {}, fromStored: false };
  }

  return {
    headers: { Authorization: `Bearer ${stored.token}` },
    fromStored: true
  };
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

function errorMessageFromJson(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const error =
    typeof record.error === 'string'
      ? record.error
      : typeof record.message === 'string'
        ? record.message
        : null;
  if (!error) return null;

  const parts = [error];
  const detail = typeof record.detail === 'string' ? record.detail.trim() : '';
  if (detail && detail !== error) parts.push(detail);
  const code = typeof record.code === 'string' ? record.code.trim() : '';
  if (code) parts.push(`(${code})`);
  return parts.join(' — ');
}

export function createBackendClient(): BackendClient {
  const baseUrl = normalizeBaseUrl(resolveBackendUrl(loadConfig()));

  async function request<T>({
    method,
    path,
    body
  }: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<T> {
    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const auth = resolveAuthHeaders({ baseUrl });
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...auth.headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw new CliError({
        message:
          `Could not reach Overlord backend at ${baseUrl}.\n` +
          'Start the Desktop/local backend or run `ovld config set cloud <url>`.\n' +
          (error instanceof Error ? error.message : String(error))
      });
    }

    const payload = await readResponseJson(response);
    if (!response.ok) {
      if (response.status === 401 && auth.headers.Authorization) {
        if (auth.fromStored) clearStoredAuthCredentials();
        const detail =
          errorMessageFromJson(payload) ??
          `Backend request failed: ${method} ${path} (${response.status})`;
        throw new CliError({
          message:
            `${detail}\n` +
            (auth.fromStored
              ? 'Saved credentials were cleared. Run `ovld auth login` to sign in again.'
              : 'Run `ovld auth login` or refresh your USER_TOKEN environment variable.')
        });
      }

      throw new CliError({
        message:
          errorMessageFromJson(payload) ??
          `Backend request failed: ${method} ${path} (${response.status})`
      });
    }
    return payload as T;
  }

  return {
    baseUrl,
    health: () => request({ method: 'GET', path: '/api/health' }),
    get: path => request({ method: 'GET', path }),
    post: ({ path, body }) => request({ method: 'POST', path, body }),
    patch: ({ path, body }) => request({ method: 'PATCH', path, body }),
    delete: path => request({ method: 'DELETE', path })
  };
}
