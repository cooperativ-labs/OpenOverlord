-- Mission data webhooks/API (coo:115): implements the previously-contracted
-- outbox_messages durable effect queue and its first consumer, a workspace-
-- scoped webhook subscription system.
-- See planning/feature-plans/mission-data-webhooks-api.md and
-- database/docs/09-database-schema-contract.md -> outbox_messages /
-- webhook_subscriptions / webhook_delivery_attempts.

PRAGMA foreign_keys = ON;

BEGIN;

-- outbox_messages: durable side-effect queue for notifications, webhooks,
-- index updates, or future hosted integrations. Separate from entity_changes
-- (state sync); this table is for effects.
CREATE TABLE outbox_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  topic TEXT NOT NULL CHECK (length(trim(topic)) > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  available_at TEXT NOT NULL CHECK (available_at GLOB '????-??-??T??:??:??.???Z'),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX idx_outbox_messages_workspace_status_available ON outbox_messages
  (workspace_id, status, available_at);
CREATE INDEX idx_outbox_messages_topic_created ON outbox_messages (topic, created_at);

-- webhook_subscriptions: which events an external endpoint receives, with what
-- payload mode, signed with a per-subscription secret. The secret is stored
-- raw (HMAC signing needs it back) -- same posture as the Everhour API key.
CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  endpoint_url TEXT NOT NULL CHECK (length(trim(endpoint_url)) > 0),
  secret TEXT NOT NULL CHECK (length(trim(secret)) > 0),
  event_types_json TEXT NOT NULL CHECK (json_valid(event_types_json)),
  payload_mode TEXT NOT NULL DEFAULT 'thin' CHECK (payload_mode IN ('thin', 'full')),
  created_by_workspace_user_id TEXT NOT NULL REFERENCES workspace_users (id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  disabled_reason TEXT CHECK (disabled_reason IS NULL OR disabled_reason IN ('manual', 'failures', 'owner_revoked')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at TEXT CHECK (last_success_at IS NULL OR last_success_at GLOB '????-??-??T??:??:??.???Z'),
  last_failure_at TEXT CHECK (last_failure_at IS NULL OR last_failure_at GLOB '????-??-??T??:??:??.???Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??.???Z'),
  deleted_at TEXT CHECK (deleted_at IS NULL OR deleted_at GLOB '????-??-??T??:??:??.???Z'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE SET NULL
);

CREATE INDEX idx_webhook_subscriptions_workspace_enabled ON webhook_subscriptions (workspace_id, enabled)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_webhook_subscriptions_workspace_project ON webhook_subscriptions (workspace_id, project_id)
  WHERE deleted_at IS NULL;

-- webhook_delivery_attempts: append-only per-attempt delivery log for the
-- management UI's delivery-log drawer.
CREATE TABLE webhook_delivery_attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE RESTRICT,
  outbox_message_id TEXT NOT NULL REFERENCES outbox_messages (id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  response_status INTEGER,
  response_snippet TEXT,
  error TEXT,
  duration_ms INTEGER,
  attempted_at TEXT NOT NULL CHECK (attempted_at GLOB '????-??-??T??:??:??.???Z')
);

CREATE INDEX idx_webhook_delivery_attempts_subscription_attempted ON webhook_delivery_attempts
  (subscription_id, attempted_at);
CREATE INDEX idx_webhook_delivery_attempts_outbox_message ON webhook_delivery_attempts (outbox_message_id);

COMMIT;
