// ---- GitHub extension contract -------------------------------------------
//
// All GitHub endpoints are namespaced under `/ext/github`. Credentials remain
// server-side; DTOs expose only installation and repository metadata.

export interface GitHubIntegrationDto {
  configured: boolean;
  connected: boolean;
  accountLogin: string | null;
  accountType: string | null;
}

export interface GitHubInstallUrlDto {
  installUrl: string;
}

export interface GitHubRepoSummaryDto {
  id: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface ProjectGitHubLinkDto {
  projectId: string;
  repo: GitHubRepoSummaryDto | null;
}

export interface LinkProjectGitHubBody {
  repoFullName: string | null;
}

export interface GitHubPullRequestDto {
  number: number;
  url: string;
  state: 'open' | 'closed';
  headBranch: string;
  baseBranch: string;
}

export interface CreateGitHubPullRequestBody {
  title?: string;
  body?: string;
  draft?: boolean;
}
