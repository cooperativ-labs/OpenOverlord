-- Better Auth implementation tables for PostgreSQL (migration 001).
-- These tables are owned by the Auth Layer (auth/src/auth/) and managed via Better Auth's
-- configured database adapter. Column names follow Better Auth's camelCase conventions
-- (intentionally different from Overlord's snake_case domain tables).
-- No other component should read or write these tables directly.
-- See database/docs/09-database-schema-contract.md -> Better Auth Implementation Tables.

BEGIN;

-- Better Auth user identity. Linked to Overlord profiles via:
--   profiles.id = "user".id
CREATE TABLE "user" (
  "id"            text        NOT NULL PRIMARY KEY,
  "name"          text        NOT NULL,
  "email"         text        NOT NULL UNIQUE,
  "emailVerified" boolean     NOT NULL DEFAULT false,
  "image"         text,
  "createdAt"     timestamptz NOT NULL,
  "updatedAt"     timestamptz NOT NULL
);

CREATE INDEX "idx_user_email" ON "user" ("email");

-- Active client sessions.
CREATE TABLE "session" (
  "id"          text        NOT NULL PRIMARY KEY,
  "expiresAt"   timestamptz NOT NULL,
  "token"       text        NOT NULL UNIQUE,
  "createdAt"   timestamptz NOT NULL,
  "updatedAt"   timestamptz NOT NULL,
  "ipAddress"   text,
  "userAgent"   text,
  "userId"      text        NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE INDEX "idx_session_userId" ON "session" ("userId");
CREATE INDEX "idx_session_token"  ON "session" ("token");

-- OAuth2 / credential accounts linked to a Better Auth user.
CREATE TABLE "account" (
  "id"                     text NOT NULL PRIMARY KEY,
  "accountId"              text NOT NULL,
  "providerId"             text NOT NULL,
  "userId"                 text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken"            text,
  "refreshToken"           text,
  "idToken"                text,
  "accessTokenExpiresAt"   timestamptz,
  "refreshTokenExpiresAt"  timestamptz,
  "scope"                  text,
  "password"               text,
  "createdAt"              timestamptz NOT NULL,
  "updatedAt"              timestamptz NOT NULL
);

CREATE INDEX "idx_account_userId" ON "account" ("userId");
CREATE UNIQUE INDEX "idx_account_provider_accountId" ON "account" ("providerId", "accountId");

-- Email verification and magic-link tokens.
CREATE TABLE "verification" (
  "id"         text        NOT NULL PRIMARY KEY,
  "identifier" text        NOT NULL,
  "value"      text        NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz,
  "updatedAt"  timestamptz
);

CREATE INDEX "idx_verification_identifier" ON "verification" ("identifier");

COMMIT;
