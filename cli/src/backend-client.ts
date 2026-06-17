import { resolveAuthBearerToken } from './auth-credentials.js';
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

function authHeaders({ baseUrl }: { baseUrl: string }): Record<string, string> {
  const token = resolveAuthBearerToken({ backendUrl: baseUrl });
  return token ? { Authorization: `Bearer ${token}` } : {};
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
  return typeof record.error === 'string'
    ? record.error
    : typeof record.message === 'string'
      ? record.message
      : null;
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
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...authHeaders({ baseUrl })
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
