-- Mission data webhooks/API (coo:115): implements the previously-contracted
-- outbox_messages durable effect queue and its first consumer, a workspace-
-- scoped webhook subscription system.
-- See planning/feature-plans/mission-data-webhooks-api.md and
-- database/docs/09-database-schema-contract.md -> outbox_messages /
-- webhook_subscriptions / webhook_delivery_attempts.

BEGIN;

-- outbox_messages: durable side-effect queue for notifications, webhooks,
-- index updates, or future hosted integrations. Separate from entity_changes
-- (state sync); this table is for effects.
CREATE TABLE outbox_messages (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  topic text NOT NULL CHECK (char_length(btrim(topic)) > 0),
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  available_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX idx_outbox_messages_workspace_status_available ON outbox_messages
  (workspace_id, status, available_at);
CREATE INDEX idx_outbox_messages_topic_created ON outbox_messages (topic, created_at);

-- webhook_subscriptions: which events an external endpoint receives, with what
-- payload mode, signed with a per-subscription secret. The secret is stored
-- raw (HMAC signing needs it back) -- same posture as the Everhour API key.
CREATE TABLE webhook_subscriptions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  project_id text REFERENCES projects (id) ON DELETE SET NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) > 0),
  endpoint_url text NOT NULL CHECK (char_length(btrim(endpoint_url)) > 0),
  secret text NOT NULL CHECK (char_length(btrim(secret)) > 0),
  event_types_json jsonb NOT NULL,
  payload_mode text NOT NULL DEFAULT 'thin' CHECK (payload_mode IN ('thin', 'full')),
  created_by_workspace_user_id text NOT NULL REFERENCES workspace_users (id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT true,
  disabled_reason text CHECK (disabled_reason IS NULL OR disabled_reason IN ('manual', 'failures', 'owner_revoked')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE SET NULL
);

CREATE INDEX idx_webhook_subscriptions_workspace_enabled ON webhook_subscriptions (workspace_id, enabled)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_webhook_subscriptions_workspace_project ON webhook_subscriptions (workspace_id, project_id)
  WHERE deleted_at IS NULL;

-- webhook_delivery_attempts: append-only per-attempt delivery log for the
-- management UI's delivery-log drawer.
CREATE TABLE webhook_delivery_attempts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  subscription_id text NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE RESTRICT,
  outbox_message_id text NOT NULL REFERENCES outbox_messages (id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (char_length(btrim(event_type)) > 0),
  attempt_number integer NOT NULL CHECK (attempt_number >= 1),
  response_status integer,
  response_snippet text,
  error text,
  duration_ms integer,
  attempted_at timestamptz NOT NULL
);

CREATE INDEX idx_webhook_delivery_attempts_subscription_attempted ON webhook_delivery_attempts
  (subscription_id, attempted_at);
CREATE INDEX idx_webhook_delivery_attempts_outbox_message ON webhook_delivery_attempts (outbox_message_id);

COMMIT;
