-- GitHub extension persistence (coo:69).
--
-- Workspace GitHub App installations, project repository links, and mission
-- pull-request records are extension-owned. No GitHub credential is persisted:
-- installation tokens are minted on demand from environment-held App keys.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ext_github_installations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  github_installation_id TEXT NOT NULL CHECK (length(trim(github_installation_id)) > 0),
  github_account_login TEXT NOT NULL CHECK (length(trim(github_account_login)) > 0),
  github_account_type TEXT,
  permissions_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_github_installations_workspace_active
  ON ext_github_installations (workspace_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ext_github_project_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  github_repo_id TEXT NOT NULL CHECK (length(trim(github_repo_id)) > 0),
  full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
  default_branch TEXT NOT NULL CHECK (length(trim(default_branch)) > 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_github_project_links_active
  ON ext_github_project_links (workspace_id, project_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ext_github_mission_pull_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  github_pull_number INTEGER NOT NULL CHECK (github_pull_number > 0),
  html_url TEXT NOT NULL CHECK (length(trim(html_url)) > 0),
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  head_branch TEXT NOT NULL CHECK (length(trim(head_branch)) > 0),
  base_branch TEXT NOT NULL CHECK (length(trim(base_branch)) > 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_github_mission_pr_active
  ON ext_github_mission_pull_requests (workspace_id, mission_id) WHERE deleted_at IS NULL;
