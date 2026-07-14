import type {
  CreateGitHubPullRequestBody,
  GitHubInstallUrlDto,
  GitHubIntegrationDto,
  GitHubPullRequestDto,
  GitHubRepoSummaryDto,
  LinkProjectGitHubBody,
  ProjectGitHubLinkDto
} from '@overlord/contract/ext/github';
import type { DatabaseClient } from '@overlord/database';
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

import { newId, nowIso, recordChange, requireDatabaseClient, WORKSPACE } from '../../db.ts';
import { ApiError } from '../../errors.ts';

const GITHUB_API = 'https://api.github.com';
const STATE_TTL_MS = 10 * 60 * 1000;

type InstallationRow = {
  id: string;
  github_installation_id: string;
  github_account_login: string;
  github_account_type: string | null;
  permissions_json: string;
  revision: number;
};
type ProjectLinkRow = {
  id: string;
  github_repo_id: string;
  full_name: string;
  default_branch: string;
  revision: number;
};
type PullRequestRow = {
  id: string;
  github_pull_number: number;
  html_url: string;
  state: 'open' | 'closed';
  head_branch: string;
  base_branch: string;
  revision: number;
};

function githubAppConfig(): { appId: string; privateKey: string; slug: string } | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  const slug = process.env.GITHUB_APP_SLUG?.trim();
  return appId && privateKey && slug ? { appId, privateKey, slug } : null;
}

function requireGitHubAppConfig(): { appId: string; privateKey: string; slug: string } {
  const config = githubAppConfig();
  if (!config) {
    throw new ApiError(
      400,
      'GitHub App is not configured. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_SLUG.'
    );
  }
  return config;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function appJwt(config: { appId: string; privateKey: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const encodedPayload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: config.appId })
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(config.privateKey, 'base64url')}`;
}

async function githubFetch<T>(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    });
  } catch (error) {
    throw new ApiError(502, `Could not reach GitHub: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const text = await response.text();
    let detail = text;
    try {
      detail = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      // GitHub occasionally returns non-JSON proxy errors.
    }
    const status = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw new ApiError(
      status,
      `GitHub API error (${response.status}): ${detail || response.statusText}`
    );
  }
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

function signedInstallState(workspaceId: string, privateKey: string): string {
  const payload = base64url(JSON.stringify({ workspaceId, expiresAt: Date.now() + STATE_TTL_MS }));
  const mac = createHmac('sha256', privateKey).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function verifyInstallState(
  value: string | undefined,
  workspaceId: string,
  privateKey: string
): void {
  const [payload, suppliedMac, ...extra] = value?.split('.') ?? [];
  if (!payload || !suppliedMac || extra.length)
    throw new ApiError(400, 'Invalid GitHub installation state.');
  const expectedMac = createHmac('sha256', privateKey).update(payload).digest('base64url');
  const sameLength = suppliedMac.length === expectedMac.length;
  if (!sameLength || !timingSafeEqual(Buffer.from(suppliedMac), Buffer.from(expectedMac))) {
    throw new ApiError(400, 'Invalid GitHub installation state.');
  }
  let decoded: { workspaceId?: unknown; expiresAt?: unknown };
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new ApiError(400, 'Invalid GitHub installation state.');
  }
  if (
    decoded.workspaceId !== workspaceId ||
    typeof decoded.expiresAt !== 'number' ||
    decoded.expiresAt < Date.now()
  ) {
    throw new ApiError(400, 'GitHub installation state has expired. Start installation again.');
  }
}

async function readInstallation(
  client: DatabaseClient = requireDatabaseClient()
): Promise<InstallationRow | null> {
  return (
    (await client.get<InstallationRow>(
      `SELECT id, github_installation_id, github_account_login, github_account_type, permissions_json, revision
         FROM ext_github_installations
        WHERE workspace_id = ? AND deleted_at IS NULL`,
      [WORKSPACE.id]
    )) ?? null
  );
}

async function requireInstallationToken(): Promise<string> {
  const installation = await readInstallation();
  if (!installation)
    throw new ApiError(400, 'Install the GitHub App in Settings → Integrations first.');
  const config = requireGitHubAppConfig();
  const result = await githubFetch<{ token: string }>(
    `/app/installations/${encodeURIComponent(installation.github_installation_id)}/access_tokens`,
    appJwt(config),
    { method: 'POST' }
  );
  if (!result.token) throw new ApiError(502, 'GitHub did not return an installation access token.');
  return result.token;
}

async function assertProject(
  projectId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<void> {
  const project = await client.get(
    `SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [projectId, WORKSPACE.id]
  );
  if (!project) throw new ApiError(404, 'Project not found.');
}

async function readProjectLink(
  projectId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<ProjectLinkRow | null> {
  return (
    (await client.get<ProjectLinkRow>(
      `SELECT id, github_repo_id, full_name, default_branch, revision
         FROM ext_github_project_links
        WHERE workspace_id = ? AND project_id = ? AND deleted_at IS NULL`,
      [WORKSPACE.id, projectId]
    )) ?? null
  );
}

function repoDto(row: ProjectLinkRow): GitHubRepoSummaryDto {
  return {
    id: row.github_repo_id,
    fullName: row.full_name,
    defaultBranch: row.default_branch,
    private: false
  };
}

export async function getGitHubIntegration(): Promise<GitHubIntegrationDto> {
  const installation = await readInstallation();
  return {
    configured: githubAppConfig() !== null,
    connected: installation !== null,
    accountLogin: installation?.github_account_login ?? null,
    accountType: installation?.github_account_type ?? null
  };
}

export function beginGitHubInstall(): GitHubInstallUrlDto {
  const config = requireGitHubAppConfig();
  const state = signedInstallState(WORKSPACE.id, config.privateKey);
  return {
    installUrl: `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`
  };
}

export async function completeGitHubInstall(input: {
  installationId: string;
  state?: string;
}): Promise<GitHubIntegrationDto> {
  const config = requireGitHubAppConfig();
  verifyInstallState(input.state, WORKSPACE.id, config.privateKey);
  if (!/^\d+$/.test(input.installationId))
    throw new ApiError(400, 'GitHub installation id is invalid.');
  const upstream = await githubFetch<{
    account?: { login?: string; type?: string };
    permissions?: Record<string, string>;
  }>(`/app/installations/${input.installationId}`, appJwt(config));
  const accountLogin = upstream.account?.login?.trim();
  if (!accountLogin) throw new ApiError(502, 'GitHub installation has no account login.');
  await requireDatabaseClient().transaction(async tx => {
    const existing = await readInstallation(tx);
    const now = nowIso();
    if (existing) {
      const revision = existing.revision + 1;
      await tx.run(
        `UPDATE ext_github_installations
            SET github_installation_id = ?, github_account_login = ?, github_account_type = ?, permissions_json = ?, updated_at = ?, revision = ?
          WHERE id = ? AND revision = ?`,
        [
          input.installationId,
          accountLogin,
          upstream.account?.type ?? null,
          JSON.stringify(upstream.permissions ?? {}),
          now,
          revision,
          existing.id,
          existing.revision
        ]
      );
      await recordChange(
        {
          entityType: 'github:installation',
          entityId: existing.id,
          operation: 'update',
          entityRevision: revision,
          changedFields: ['connected', 'accountLogin']
        },
        tx
      );
    } else {
      const id = newId();
      await tx.run(
        `INSERT INTO ext_github_installations (id, workspace_id, github_installation_id, github_account_login, github_account_type, permissions_json, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          id,
          WORKSPACE.id,
          input.installationId,
          accountLogin,
          upstream.account?.type ?? null,
          JSON.stringify(upstream.permissions ?? {}),
          now,
          now
        ]
      );
      await recordChange(
        {
          entityType: 'github:installation',
          entityId: id,
          operation: 'insert',
          entityRevision: 1,
          changedFields: ['connected', 'accountLogin']
        },
        tx
      );
    }
  });
  return getGitHubIntegration();
}

export async function disconnectGitHub(): Promise<GitHubIntegrationDto> {
  await requireDatabaseClient().transaction(async tx => {
    const installation = await readInstallation(tx);
    if (!installation) return;
    const now = nowIso();
    const revision = installation.revision + 1;
    await tx.run(
      `UPDATE ext_github_installations SET deleted_at = ?, updated_at = ?, revision = ? WHERE id = ? AND revision = ?`,
      [now, now, revision, installation.id, installation.revision]
    );
    await tx.run(
      `UPDATE ext_github_project_links SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE workspace_id = ? AND deleted_at IS NULL`,
      [now, now, WORKSPACE.id]
    );
    await recordChange(
      {
        entityType: 'github:installation',
        entityId: installation.id,
        operation: 'delete',
        entityRevision: revision,
        changedFields: ['connected']
      },
      tx
    );
  });
  return getGitHubIntegration();
}

export async function listGitHubRepos(query: string | null): Promise<GitHubRepoSummaryDto[]> {
  const token = await requireInstallationToken();
  const data = await githubFetch<{
    repositories?: Array<{
      id: number;
      full_name: string;
      default_branch?: string;
      private?: boolean;
    }>;
  }>('/installation/repositories?per_page=100', token);
  const needle = query?.trim().toLowerCase();
  return (data.repositories ?? [])
    .filter(repo => !needle || repo.full_name.toLowerCase().includes(needle))
    .map(repo => ({
      id: String(repo.id),
      fullName: repo.full_name,
      defaultBranch: repo.default_branch ?? 'main',
      private: Boolean(repo.private)
    }));
}

export async function getProjectGitHubLink(projectId: string): Promise<ProjectGitHubLinkDto> {
  await assertProject(projectId);
  const link = await readProjectLink(projectId);
  return { projectId, repo: link ? repoDto(link) : null };
}

export async function linkProjectGitHub(
  projectId: string,
  body: LinkProjectGitHubBody
): Promise<ProjectGitHubLinkDto> {
  await assertProject(projectId);
  const fullName = body.repoFullName?.trim() ?? '';
  if (!fullName) {
    const existing = await readProjectLink(projectId);
    if (existing) {
      const now = nowIso();
      await requireDatabaseClient().run(
        `UPDATE ext_github_project_links SET deleted_at = ?, updated_at = ?, revision = ? WHERE id = ? AND revision = ?`,
        [now, now, existing.revision + 1, existing.id, existing.revision]
      );
    }
    return { projectId, repo: null };
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(fullName))
    throw new ApiError(400, 'Repository must be written as owner/name.');
  const token = await requireInstallationToken();
  const repo = await githubFetch<{
    id: number;
    full_name: string;
    default_branch?: string;
    private?: boolean;
  }>(`/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`, token);
  const next = {
    id: String(repo.id),
    fullName: repo.full_name,
    defaultBranch: repo.default_branch ?? 'main',
    private: Boolean(repo.private)
  };
  await requireDatabaseClient().transaction(async tx => {
    const existing = await readProjectLink(projectId, tx);
    const now = nowIso();
    if (existing) {
      await tx.run(
        `UPDATE ext_github_project_links SET github_repo_id = ?, full_name = ?, default_branch = ?, metadata_json = ?, deleted_at = NULL, updated_at = ?, revision = ? WHERE id = ? AND revision = ?`,
        [
          next.id,
          next.fullName,
          next.defaultBranch,
          JSON.stringify({ private: next.private }),
          now,
          existing.revision + 1,
          existing.id,
          existing.revision
        ]
      );
      await recordChange(
        {
          entityType: 'github:project_link',
          entityId: existing.id,
          operation: 'update',
          entityRevision: existing.revision + 1,
          projectId,
          changedFields: ['repo']
        },
        tx
      );
    } else {
      const id = newId();
      await tx.run(
        `INSERT INTO ext_github_project_links (id, workspace_id, project_id, github_repo_id, full_name, default_branch, metadata_json, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          id,
          WORKSPACE.id,
          projectId,
          next.id,
          next.fullName,
          next.defaultBranch,
          JSON.stringify({ private: next.private }),
          now,
          now
        ]
      );
      await recordChange(
        {
          entityType: 'github:project_link',
          entityId: id,
          operation: 'insert',
          entityRevision: 1,
          projectId,
          changedFields: ['repo']
        },
        tx
      );
    }
  });
  return { projectId, repo: next };
}

async function readPullRequest(
  missionId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<PullRequestRow | null> {
  return (
    (await client.get<PullRequestRow>(
      `SELECT id, github_pull_number, html_url, state, head_branch, base_branch, revision FROM ext_github_mission_pull_requests WHERE workspace_id = ? AND mission_id = ? AND deleted_at IS NULL`,
      [WORKSPACE.id, missionId]
    )) ?? null
  );
}

function pullRequestDto(row: PullRequestRow): GitHubPullRequestDto {
  return {
    number: row.github_pull_number,
    url: row.html_url,
    state: row.state,
    headBranch: row.head_branch,
    baseBranch: row.base_branch
  };
}

export async function getMissionGitHubPullRequest(
  missionId: string
): Promise<GitHubPullRequestDto | null> {
  const row = await readPullRequest(missionId);
  return row ? pullRequestDto(row) : null;
}

export async function createMissionGitHubPullRequest(
  missionId: string,
  body: CreateGitHubPullRequestBody
): Promise<GitHubPullRequestDto> {
  const existing = await readPullRequest(missionId);
  if (existing) return pullRequestDto(existing);
  const mission = await requireDatabaseClient().get<{
    id: string;
    project_id: string;
    title: string;
    active_branch: string | null;
  }>(
    `SELECT id, project_id, title, active_branch FROM missions WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [missionId, WORKSPACE.id]
  );
  if (!mission) throw new ApiError(404, 'Mission not found.');
  if (!mission.active_branch?.trim())
    throw new ApiError(409, 'Publish the mission branch before opening a pull request.');
  const link = await readProjectLink(mission.project_id);
  if (!link)
    throw new ApiError(400, 'Link this project to a GitHub repository in project settings first.');
  const token = await requireInstallationToken();
  const pr = await githubFetch<{ number: number; html_url: string; state: 'open' | 'closed' }>(
    `/repos/${link.full_name.split('/').map(encodeURIComponent).join('/')}/pulls`,
    token,
    {
      method: 'POST',
      body: {
        title: body.title?.trim() || mission.title,
        body: body.body?.trim() || undefined,
        draft: Boolean(body.draft),
        head: mission.active_branch,
        base: link.default_branch
      }
    }
  );
  const now = nowIso();
  const id = newId();
  await requireDatabaseClient().transaction(async tx => {
    const concurrent = await readPullRequest(missionId, tx);
    if (concurrent) return;
    await tx.run(
      `INSERT INTO ext_github_mission_pull_requests (id, workspace_id, project_id, mission_id, github_pull_number, html_url, state, head_branch, base_branch, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        WORKSPACE.id,
        mission.project_id,
        missionId,
        pr.number,
        pr.html_url,
        pr.state,
        mission.active_branch,
        link.default_branch,
        now,
        now
      ]
    );
    await recordChange(
      {
        entityType: 'github:mission_pull_request',
        entityId: id,
        operation: 'insert',
        entityRevision: 1,
        projectId: mission.project_id,
        missionId,
        changedFields: ['pullRequest']
      },
      tx
    );
  });
  return {
    number: pr.number,
    url: pr.html_url,
    state: pr.state,
    headBranch: mission.active_branch,
    baseBranch: link.default_branch
  };
}
