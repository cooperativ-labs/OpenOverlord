# 14 — Private-Network S3 Storage Deployment (Railway MinIO)

**Status:** Runbook (Phase 2 of mission `coo:45`)
**Companion plan:** [`planning/feature-plans/railway-s3-storage-implementation-plan.md`](../../planning/feature-plans/railway-s3-storage-implementation-plan.md)
**Sibling:** [12 — Private-Network PostgreSQL Deployment](12-private-network-postgresql-deployment-plan.md)

## What this covers

Phase 1 made `webapp/server/storage.ts` backend-aware (an `s3` backend behind a
`StorageBackend` interface in `webapp/server/storage-backends.ts`). Phase 2 is the
**operational** half: stand up a private S3-compatible object store on Railway,
keep its buckets private, hand the Overlord service the credentials as deployment
secrets, and let the application flip its storage buckets to the `s3` backend
**by data** the moment those secrets are present.

The flip itself is code — an idempotent seed (`applyHostedS3StorageBackend`,
`database/src/storage-seed.ts`) that runs on every boot of a **Postgres**
deployment. It is a no-op until the S3 env vars exist, so local/SQLite installs
are never touched and keep `local_fs`. This document is the infra checklist that
makes those env vars real.

## Why MinIO on Railway

Railway has no first-party S3 API. The standard pattern is a **MinIO**
(S3-compatible) service running inside the Railway project, backed by a **Railway
Volume** for durability, reachable only on Railway's **private network**. The
Overlord service talks to it with the AWS S3 SDK pointed at a custom `endpoint`
and `forcePathStyle: true` — identical code also works against AWS S3,
Cloudflare R2, or Backblaze B2 if you later prefer a managed provider (see the
plan's Open Questions). Nothing here is MinIO-specific beyond the endpoint.

## Provisioning steps (Railway)

1. **Add a MinIO service** to the same Railway project as the Overlord service.
   Use the official `minio/minio` image with the command `server /data
   --console-address ":9001"`.
2. **Attach a Railway Volume** mounted at `/data` so objects survive restarts and
   redeploys. Size it for expected images + attachments; it can be grown later.
3. **Set MinIO's root credentials** as variables on the MinIO service:
   `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` (strong, generated). These are the
   credentials the Overlord service will reuse as `S3_ACCESS_KEY_ID` /
   `S3_SECRET_ACCESS_KEY` (or mint a scoped MinIO access key — preferred for least
   privilege).
4. **Keep MinIO private.** Do **not** assign it a public Railway domain. The
   Overlord service reaches it over the private network at
   `http://<minio-service>.railway.internal:9000`. The S3 API port (`9000`) and
   the console (`9001`) stay off the public internet.
5. **Create the bucket(s) with no public read policy.** Using `mc` (the MinIO
   client) against the private endpoint, or the console on a temporary port:
   ```sh
   mc alias set ovld http://<minio-host>:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
   mc mb ovld/overlord-storage          # single shared bucket (default)
   mc anonymous set none ovld/overlord-storage   # explicitly private — no public read
   ```
   The seed defaults to **one shared bucket** with a per-logical-bucket path
   prefix (`workspace-images/`, `user-images/`, `attachments/`), so a single
   private bucket is sufficient. The bucket must have **no anonymous/public read
   policy** — Overlord's authorized route is the only door.

## Deployment secrets (Overlord service)

Set these as variables on the **Overlord** service (reference the MinIO service's
private host). The seed reads them at boot; the byte layer reads the secrets at
request time. **Secrets are never written to the database.**

| Variable | Required | Purpose |
| --- | --- | --- |
| `S3_ACCESS_KEY_ID` | yes | MinIO access key. Read only by `storage-backends.ts`; gates the seed. |
| `S3_SECRET_ACCESS_KEY` | yes | MinIO secret key. Same. |
| `S3_ENDPOINT` | yes | e.g. `http://<minio-service>.railway.internal:9000`. Stored (non-secret) in `settings_json`. |
| `S3_BUCKET` (or `S3_BUCKET_NAME`) | yes | Bucket name, e.g. `overlord-storage`. Stored in `settings_json`. |
| `S3_REGION` | no | SDK requires a region string; MinIO ignores it. Defaults to `us-east-1`. |
| `S3_PATH_PREFIX` | no | Optional base prefix applied under each logical bucket. |

When all **required** vars are present, the next boot updates the
`workspace-images`, `user-images`, and `attachments` bucket rows to
`storage_backend = 's3'` with `settings_json = { bucketName, region, endpoint,
pathPrefix }`. Remove the vars (or never set them) and the buckets stay
`local_fs`. The update only touches rows whose backend/settings differ, so it is
safe to run on every deploy.

## What stays unchanged

- **Auth/RBAC is still the only access boundary.** Reads go through
  `GET /api/storage/:bucketKey/:storageKey`, gated by `requirePermission`, and
  only ever serve a key matched to a recorded, non-deleted metadata row
  (`storage_key` remains the trust anchor). The cloud backend changes *where
  bytes live*, not *who may touch them*.
- **No schema/contract change.** `storage_backend = 's3'` and non-secret
  `settings_json` provider metadata are already specified in
  [09 — Database Schema Contract](09-database-schema-contract.md) §`storage_buckets`,
  which also mandates that credentials live in deployment secrets, not the table.

## Verification

1. Deploy with the S3 vars set. On boot, confirm the seed ran (the three bucket
   rows now read `storage_backend = 's3'`):
   ```sql
   SELECT bucket_key, storage_backend, settings_json FROM storage_buckets
   WHERE bucket_key IN ('workspace-images', 'user-images', 'attachments');
   ```
2. Upload an image/attachment through the app; confirm an object appears under
   the expected prefix in MinIO (`mc ls ovld/overlord-storage/user-images/`).
3. Fetch it back through `GET /api/storage/...` as an authorized user (proxy
   path streams it). Confirm an unauthorized request is rejected by
   `requirePermission` before any byte is read.
4. Confirm the bucket has **no** public policy — a direct unauthenticated
   request to the MinIO object URL must fail.

Presigned-URL reads (a redirect instead of a proxy stream) are **Phase 3** and
stay disabled until enabled per-bucket; the bucket remains private either way.
