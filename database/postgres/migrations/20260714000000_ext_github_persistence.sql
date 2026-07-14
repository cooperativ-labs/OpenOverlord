-- GitHub extension persistence (coo:69). See SQLite migration for rationale.

CREATE TABLE IF NOT EXISTS ext_github_installations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  github_installation_id text NOT NULL CHECK (char_length(btrim(github_installation_id)) > 0),
  github_account_login text NOT NULL CHECK (char_length(btrim(github_account_login)) > 0),
  github_account_type text,
  permissions_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_github_installations_workspace_active ON ext_github_installations (workspace_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ext_github_project_links (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  github_repo_id text NOT NULL CHECK (char_length(btrim(github_repo_id)) > 0),
  full_name text NOT NULL CHECK (char_length(btrim(full_name)) > 0),
  default_branch text NOT NULL CHECK (char_length(btrim(default_branch)) > 0),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_github_project_links_active ON ext_github_project_links (workspace_id, project_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ext_github_mission_pull_requests (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  mission_id text NOT NULL REFERENCES missions(id) ON DELETE RESTRICT,
  github_pull_number integer NOT NULL CHECK (github_pull_number > 0),
  html_url text NOT NULL CHECK (char_length(btrim(html_url)) > 0),
  state text NOT NULL CHECK (state IN ('open', 'closed')),
  head_branch text NOT NULL CHECK (char_length(btrim(head_branch)) > 0),
  base_branch text NOT NULL CHECK (char_length(btrim(base_branch)) > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_github_mission_pr_active ON ext_github_mission_pull_requests (workspace_id, mission_id) WHERE deleted_at IS NULL;
