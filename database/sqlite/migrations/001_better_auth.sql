-- Better Auth implementation tables (migration 001).
-- These tables are owned by the Auth Layer (auth/src/auth/) and managed via Better Auth's
-- internal adapter. Column names follow Better Auth's camelCase conventions (intentionally
-- different from Overlord's snake_case domain tables).
-- No other component should read or write these tables directly.
-- See planning/feature-plans/09-database-schema-contract.md → Better Auth Implementation Tables.

PRAGMA foreign_keys = ON;

BEGIN;

-- Better Auth user identity. Linked to Overlord profiles via:
--   profiles.id = "user".id
CREATE TABLE "user" (
  "id"            TEXT    NOT NULL PRIMARY KEY,
  "name"          TEXT    NOT NULL,
  "email"         TEXT    NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,
  "image"         TEXT,
  "createdAt"     TEXT    NOT NULL,
  "updatedAt"     TEXT    NOT NULL
);

CREATE INDEX "idx_user_email" ON "user" ("email");

-- Active client sessions.
CREATE TABLE "session" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "expiresAt"   TEXT NOT NULL,
  "token"       TEXT NOT NULL UNIQUE,
  "createdAt"   TEXT NOT NULL,
  "updatedAt"   TEXT NOT NULL,
  "ipAddress"   TEXT,
  "userAgent"   TEXT,
  "userId"      TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE INDEX "idx_session_userId" ON "session" ("userId");
CREATE INDEX "idx_session_token"  ON "session" ("token");

-- OAuth2 / credential accounts linked to a Better Auth user.
CREATE TABLE "account" (
  "id"                     TEXT NOT NULL PRIMARY KEY,
  "accountId"              TEXT NOT NULL,
  "providerId"             TEXT NOT NULL,
  "userId"                 TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken"            TEXT,
  "refreshToken"           TEXT,
  "idToken"                TEXT,
  "accessTokenExpiresAt"   TEXT,
  "refreshTokenExpiresAt"  TEXT,
  "scope"                  TEXT,
  "password"               TEXT,
  "createdAt"              TEXT NOT NULL,
  "updatedAt"              TEXT NOT NULL
);

CREATE INDEX "idx_account_userId"                  ON "account" ("userId");
CREATE UNIQUE INDEX "idx_account_provider_accountId" ON "account" ("providerId", "accountId");

-- Email verification and magic-link tokens.
CREATE TABLE "verification" (
  "id"         TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value"      TEXT NOT NULL,
  "expiresAt"  TEXT NOT NULL,
  "createdAt"  TEXT,
  "updatedAt"  TEXT
);

CREATE INDEX "idx_verification_identifier" ON "verification" ("identifier");

COMMIT;
