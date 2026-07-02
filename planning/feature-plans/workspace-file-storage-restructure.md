# Workspace File Storage Restructure Plan

Status: draft
Origin: Overlord mission `coo:111` - "Restructure file storage and access control"
Owner: jake@cooperativ.io

## Summary

Restructure durable file bytes so Overlord uses one physical object-store
bucket/container with stable top-level prefixes. In the current Railway setup,
`overlord-storage` is the physical bucket. The former "buckets" in this plan are
application-level prefixes or storage locations inside that bucket:

```text
overlord-storage/
  user-images/
    <user-id>/
      <image-id>.<ext>
  workspace-files/
    <workspace-id>/
      attachments/
        <attachment-id>.<ext>
      images/
        <image-id>.<ext>
```

Keep the top-level `user-images` area, but organize it by user id. Avatar/profile
images are profile-owned rather than workspace-owned, so they should not move
under `workspace-files`.

The migration can be destructive for existing files. We do not need to copy old
objects into the new layout. Implementation can tombstone or purge existing
`user_images`, `workspace_images`, and `attachments` metadata where needed,
delete old byte directories or objects where practical, and start writing new
uploads to the new prefixes.

## Current Storage And Access-Control Review

### Storage model

Overlord already separates byte storage from metadata, but the naming is
confusing:

- `storage_buckets` currently stores application storage-location/backend
  configuration, not necessarily one physical object-store bucket per row.
- `workspace_images`, `user_images`, and `attachments` store provider-neutral
  metadata and backend keys.
- `backend/storage.ts` owns byte I/O for REST uploads and downloads.
- `packages/core/service/storage.ts` owns metadata service operations and RBAC
  checks for storage records.
- `backend/storage-backends.ts` dispatches `local_fs`, `s3`, and
  `railway_volume` reads/writes from a `storage_buckets` row.

In hosted Railway, there should be one physical object-store bucket:
`overlord-storage`. Application rows should point at prefixes inside it, for
example `user-images/<user-id>` or
`workspace-files/<workspace-id>/attachments`.

Current seeded local paths:

```text
database/.local/storage/workspace-images
database/.local/storage/user-images
database/.local/storage/attachments
```

Newly created workspaces already get a more isolated `workspace-images`
storage-location row at:

```text
database/.local/storage/workspace-images/<workspace-id>/images
```

Hosted S3 configuration supports per-location `settings_json.pathPrefix`, but
attachments currently use a flat logical prefix such as `prod/attachments`.

### Access control

Write access is already RBAC-gated:

- `POST /api/uploads/user-images` requires `user_image:self:create`.
- `POST /api/uploads/workspace-images` requires `workspace_image:create`.
- `GET/POST/DELETE /api/objectives/:id/attachments` require
  `attachment:read/create/delete`.
- Default `ADMIN` has `*`.
- Default `MEMBER` has `workspace_image:read`, `user_image:read`,
  `user_image:self:*`, and `attachment:*`.

Read access for raw bytes is coarser than the storage permission model:

- `GET /api/storage/:bucketKey/:storageKey` currently requires
  `project:read` for every bucket.
- `resolveStoredObject()` then confirms the exact `(storage_bucket_id,
  storage_key)` exists in the relevant metadata table and is not deleted before
  streaming or presigning bytes.
- This prevents path traversal and arbitrary object reads, but it does not use
  the bucket-specific read permissions already defined by RBAC.

The target design should keep the exact metadata lookup as the read trust anchor,
but replace the read-route gate with bucket-specific permissions:

```text
workspace-images -> workspace_image:read
user-images      -> user_image:read
attachments      -> attachment:read
```

## Contract Impact

This target structure changes the schema contract's documented storage layout.
Before implementation, update `database/docs/09-database-schema-contract.md` and
any matching machine-readable contract files if they are introduced for storage.

Required contract edits:

1. Clarify terminology: hosted deployments use one physical object-store bucket
   such as `overlord-storage`; `storage_buckets.bucket_key` values are Overlord
   application storage locations/prefixes unless the backend truly maps them to
   separate provider buckets.
2. Define the canonical object-key layout:
   `user-images/<user-id>/<image-id>.<ext>`,
   `workspace-files/<workspace-id>/attachments/<attachment-id>.<ext>`, and
   `workspace-files/<workspace-id>/images/<image-id>.<ext>`.
3. State that workspace-owned attachments and images are provisioned per
   workspace beneath `workspace-files/<workspace-id>`.
4. State that user images are profile/user owned and live beneath
   `user-images/<user-id>`, not beneath a workspace folder.
5. Clarify that raw byte reads must be gated by the storage location's permission,
   then resolved through exact metadata lookup before any backend read or
   presigned redirect.

Impact by module:

| Module | Impact |
| --- | --- |
| Database | Migrations and seed constants must set new `local_path` / `settings_json.pathPrefix` values for `user-images`, `workspace-images`, and `attachments`. Existing file metadata may be purged. |
| Backend REST | Uploads must use the new bucket roots/prefixes. The storage read route should require bucket-specific read permission. |
| Core service | Metadata CRUD should keep existing permissions, but tests and bucket path summaries must expect the new workspace file layout. |
| Auth/RBAC | No new permission names are required. Existing `workspace_image:*`, `user_image:*`, and `attachment:*` permissions are sufficient. |
| Webapp | DTOs and client URLs can stay as `/api/storage/<bucket>/<key>`; no client-visible path change is required. |
| Deployment | Hosted S3/Railway configuration changes from flat prefixes to one physical `overlord-storage` bucket with user/workspace-scoped prefixes. Existing objects can be deleted. |

## Target Model

Keep API-facing logical keys stable for now so URLs and metadata tables do not
churn, but document them as application storage locations rather than physical
provider buckets:

```text
bucket_key = user-images        -> user-images/<user-id>
bucket_key = workspace-images   -> workspace-files/<workspace-id>/images
bucket_key = attachments        -> workspace-files/<workspace-id>/attachments
```

Use object keys or storage-location configuration to express the provider layout,
but keep provider paths out of client-facing URLs:

- For `local_fs`, set `storage_buckets.local_path` to the shared local storage
  root for the location, or to the workspace/user-specific directory when that
  keeps the code simpler.
- For S3-compatible backends, set `settings_json.bucketName` to the one physical
  bucket (`overlord-storage`) and use either `settings_json.pathPrefix` plus a
  short key, or a full `storage_key` containing the canonical prefix.
- Generate opaque object ids for stored object names, such as
  `<image-id>.png` or `<attachment-id>.txt`; never rely on original filenames for
  provider keys.
- Continue returning `/api/storage/<bucketKey>/<storageKey>` so callers never
  depend on provider paths.

Recommended implementation: store the canonical provider object key in
`storage_key`:

```text
user-images/<user-id>/<image-id>.<ext>
workspace-files/<workspace-id>/attachments/<attachment-id>.<ext>
workspace-files/<workspace-id>/images/<image-id>.<ext>
```

That makes the same metadata row work for both `local_fs` and S3 with minimal
special cases. It is acceptable for `storage_key` to include the workspace/user
folder because every read still goes through Overlord RBAC plus exact metadata
lookup. The id portion remains opaque, and original filenames stay in metadata.

## Migration Plan

### Phase 0 - Contract And Test Baseline

1. Update the database schema contract with the new `workspace-files` layout and
   storage-location-specific read-gate rule.
2. Add or update tests that assert current intended behavior before changing the
   implementation:
   - user image object keys include `user-images/<user-id>`.
   - workspace image object keys include `workspace-files/<workspace-id>/images`.
   - attachment object keys include `workspace-files/<workspace-id>/attachments`.
   - The byte read route checks `attachment:read` for attachments and
     `workspace_image:read` for workspace images.
3. Fix the existing inconsistency where the contract and workspace creation code
   already describe per-workspace workspace-image paths, but the initial
   `004_storage.sql` seed still uses `database/.local/storage/workspace-images`.

Exit criteria: tests fail only because implementation still uses the old layout
or read gate.

### Phase 1 - Introduce Canonical Object-Key Helpers

1. Introduce shared helpers/constants for object keys:

```text
userImageObjectKey(userId, imageId, ext) =
  user-images/<user-id>/<image-id>.<ext>

workspaceImageObjectKey(workspaceId, imageId, ext) =
  workspace-files/<workspace-id>/images/<image-id>.<ext>

attachmentObjectKey(workspaceId, attachmentId, ext) =
  workspace-files/<workspace-id>/attachments/<attachment-id>.<ext>
```

2. Use these helpers in `backend/storage.ts` when creating new `storage_key`
   values for user images, workspace images, and objective attachments.
3. Preserve original/display filenames only in metadata columns such as
   `attachments.filename`; do not put original filenames in object-store keys.
4. Decide whether existing workspaces lacking an `attachments` row should be
   backfilled by migration or by an idempotent runtime seeder. Prefer migration
   for deterministic schema state.

Exit criteria: every new object key follows the canonical prefix layout and is
opaque after the user/workspace path segment.

### Phase 2 - Storage Location Configuration

1. Update SQLite and Postgres storage seeds so `storage_buckets` rows describe
   application locations, not separate provider buckets:
   - `settings_json.bucketName` for hosted S3 rows should be
     `overlord-storage`.
   - `local_path` for local rows can point at the shared local storage root, with
     `storage_key` carrying the canonical subpath.
   - If keeping per-location local roots, ensure they still produce the same
     final relative paths shown below.
2. Update `database/src/storage-seed.ts` so hosted S3 writes resolve to one
   physical bucket with these object keys:

```text
<S3_PATH_PREFIX>/user-images/<user-id>/<image-id>.<ext>
<S3_PATH_PREFIX>/workspace-files/<workspace-id>/images/<image-id>.<ext>
<S3_PATH_PREFIX>/workspace-files/<workspace-id>/attachments/<attachment-id>.<ext>
```

3. Keep S3 credentials in environment variables only. Store only non-secret
   provider metadata in `settings_json`, matching the current contract.
4. Update `backend/storage-backends.test.ts`, `backend/storage.test.ts`, and
   `packages/core/service/storage.test.ts` expected prefixes.

Exit criteria: local and hosted storage both produce the same canonical relative
object keys, with provider-specific bucket/container details hidden behind
backend config.

### Phase 3 - Destructive Cleanup Of Existing Storage

Because existing saved files can be deleted, avoid object-by-object migration:

1. In both dialect migrations, tombstone or hard-delete existing active rows from
   `user_images`, `workspace_images`, and `attachments` if object-key migration
   would be extra work.
2. Remove old local byte directories where the migration environment can safely
   reach them, or document a one-time manual cleanup:

```text
database/.local/storage/workspace-images
database/.local/storage/user-images
database/.local/storage/attachments
```

3. For hosted S3/Railway, delete old prefixes manually or with an ops script:

```text
<S3_PATH_PREFIX>/workspace-images
<S3_PATH_PREFIX>/user-images
<S3_PATH_PREFIX>/attachments
```

4. After cleanup, only new uploads should populate:

```text
<S3_PATH_PREFIX>/user-images/<user-id>/
<S3_PATH_PREFIX>/workspace-files/<workspace-id>/images/
<S3_PATH_PREFIX>/workspace-files/<workspace-id>/attachments/
```

Exit criteria: no active metadata points at the old workspace-image or
attachment locations; new uploads create fresh metadata under the new layout.

### Phase 4 - Bucket-Specific Read Authorization

1. Replace the raw byte route's blanket `project:read` gate with a lookup table:

```text
user-images      -> user_image:read
workspace-images -> workspace_image:read
attachments      -> attachment:read
```

2. Keep `resolveStoredObject()` as the second gate. It must still:
   - resolve the active workspace bucket by `(workspace_id, bucket_key)`;
   - match an exact active metadata row by `(storage_bucket_id, storage_key)`;
   - reject missing or tombstoned rows before touching the backend;
   - force attachments to download with `nosniff`.
3. Preserve presigned-read behavior only after both gates pass.

Exit criteria: a token with only `attachment:read` can fetch an attachment but
not project data; a token with only `workspace_image:read` can fetch workspace
images; a token without the relevant storage permission receives `403`.

### Phase 5 - UI And Regression Verification

No URL shape change should be visible to the SPA, but verify:

1. Workspace settings can upload and render a workspace image as an Admin.
2. A Member cannot set a workspace image.
3. Objective attachment upload, list, download, and delete still work.
4. User profile image upload and rendering are unchanged.
5. Cross-origin desktop/remote mode still uses authenticated fetches for
   `/api/storage/*` URLs.

## Implementation Notes

- Keep logical API keys stable (`workspace-images`, `user-images`,
  `attachments`) to avoid client/API churn, but stop describing them as physical
  provider buckets in docs.
- If `storage_key` contains slashes, continue URL-encoding it when constructing
  `/api/storage/<bucketKey>/<storageKey>` URLs. `publicUrlFor()` already uses
  `encodeURIComponent(storageKey)`, so full object keys remain one route segment.
- For local filesystem writes, `createLocalFsBackend()` already writes relative
  to the configured root plus key; if `storage_key` carries the canonical
  subpath, the local root can be the shared storage directory.
- For S3 writes, `objectKeyFor()` already prepends `settings_json.pathPrefix`;
  use either an environment-level deployment prefix plus full canonical
  `storage_key`, or a per-location prefix plus short key. Prefer full canonical
  `storage_key` to keep local and S3 behavior aligned.
- If implementation chooses one shared physical `workspace-files` bucket row
  instead of keeping logical `workspace-images` and `attachments` bucket rows,
  that is a larger contract change because current URLs and metadata assume
  logical bucket keys. Prefer stable logical bucket rows for this migration.

## Open Questions

1. Should old image and attachment metadata be hard-deleted or
   tombstoned? Tombstoning preserves audit/change-feed semantics; hard delete
   is simpler if no historical references matter.
2. Should local migrations delete old byte directories automatically, or should
   cleanup stay an explicit developer/ops command?
3. Should `attachments` remain MEMBER-manageable by default? The current RBAC
   default grants `attachment:*` to MEMBER, which matches the objective's
   "members of the workspace having access based on their RBAC" statement.
4. Should `storage_buckets` be renamed in a future schema version to
   `storage_locations` or `storage_namespaces`? The current name is misleading
   when hosted deployments use one physical object-store bucket.
