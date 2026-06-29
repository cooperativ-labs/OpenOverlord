# Railway S3 Storage — Implementation Plan

Mission: `coo:45` — *Implement Secure Cloud Storage*

## TL;DR

1. **Add an `s3` storage backend alongside the existing `local_fs` one.** The
   metadata schema, RBAC, routes, and DTOs already exist and stay unchanged; only
   the byte-I/O layer in `webapp/server/storage.ts` gains a second backend.
2. **Keep the bucket private and keep Overlord auth/RBAC as the only access gate.**
   Bytes are never world-readable. Every read still flows through
   `GET /api/storage/:bucketKey/:storageKey`, which already calls
   `requirePermission` before resolving an object — so the S3 backend inherits the
   exact same authorization the local backend has today.
3. **Serve bytes one of two ways, both gated:** either stream the object through the
   existing authenticated route (server proxies S3 → client), or, for large/hot
   objects, mint a **short-lived presigned GET URL** *after* the RBAC check passes
   and redirect to it. Phase 1 ships the proxy path (smallest change, no public URL
   surface); presigned URLs are an opt-in optimization in Phase 3.
4. **Credentials come from deployment secrets, never the database.** The
   `storage_buckets` row holds only non-secret provider metadata (`storage_backend
   = 's3'`, `base_url`, `settings_json` with region/bucket/endpoint/prefix). The
   access key/secret are read from environment variables, matching the schema
   contract's explicit instruction.
5. **"Railway S3" = an S3-compatible service running on Railway.** Railway has no
   first-party S3 API; the standard pattern is a MinIO (S3-compatible) service on
   Railway backed by a Railway Volume, addressed through a custom `endpoint`. The
   code targets the AWS S3 SDK against that endpoint, so the same backend also works
   against AWS S3, Cloudflare R2, Backblaze B2, or Supabase Storage with only config
   changes — no lock-in.

The result: cloud-durable storage for images and attachments, with **zero change to
the auth model** — RBAC remains the boundary, the bucket stays private, and the only
new trust surface is short-lived, single-object signed URLs issued behind a passed
permission check.

---

## How storage works today (the local backend)

The byte path and the metadata/authorization path are already cleanly separated,
which is what makes adding a cloud backend a contained change.

| Layer | File | Responsibility |
| --- | --- | --- |
| Bucket config | `storage_buckets` table (seeded in `database/{sqlite,postgres}/migrations/004_storage.sql`) | One row per logical bucket: `bucket_key`, `storage_backend`, `base_url`, `local_path`, `settings_json`. |
| Byte I/O + metadata write (REST) | `webapp/server/storage.ts` | Resolves the bucket, validates bytes, **writes to the backend**, records provider-neutral metadata, returns a server-relative `url`. |
| Byte I/O is backend-specific | `localRootFor()` in `webapp/server/storage.ts` | **The only place that assumes `local_fs`.** Rejects any other backend with HTTP 501. |
| HTTP surface | `webapp/server/index.ts` | `POST /api/uploads/:bucketKey` (upload), `GET /api/storage/:bucketKey/:storageKey` (serve). Both gated by `requirePermission(...)`. |
| Object metadata service (CLI/protocol) | `packages/core/service/storage.ts` | Provider-neutral CRUD over `workspace_images` / `user_images` / `attachments`, each guarded by `PERMISSIONS.*`. Never touches bytes. |
| DTOs | `webapp/server/shared/contract.ts` (`StoredImageDto`, `ObjectiveAttachmentDto`) | Provider-neutral; carry a `url`, not a provider path. |

Key properties to preserve:

- **`storage_key` is the trust anchor for reads.** `resolveStoredObject()` looks the
  object up by *exact* `storage_bucket_id + storage_key` against a non-deleted
  metadata row before serving. This is what makes path traversal impossible and is
  why the route can serve arbitrary keys safely. The S3 backend must keep this
  lookup as the gate — never serve an S3 key the client supplies without first
  matching it to a recorded row.
- **The read route is already authorized.** `GET /api/storage/...` calls
  `await requirePermission(PERMISSIONS.PROJECT_READ)` before resolving. Attachments
  are forced to `Content-Disposition: attachment` + `nosniff`; `Cache-Control` is
  `private`. All of this stays.
- **Only `webapp/server/storage.ts` is backend-aware.** Everything above it
  (routes, DTOs, the core service, RBAC) is already provider-neutral. The schema
  contract (`09-database-schema-contract.md` §`storage_buckets`) already lists `s3`
  / `railway_volume` as valid `storage_backend` values and already says
  **credentials must not live in this table**. So this plan needs **no contract
  change** — it implements behavior the contract already anticipates.

---

## Target architecture

```
 Browser / CLI
     │  (1) POST /api/uploads/:bucket   ── requirePermission(USER_IMAGE_SELF_CREATE)
     ▼
 webapp/server/index.ts ──► webapp/server/storage.ts
     │                          │
     │                 resolveBucket(bucketKey)  ── reads storage_buckets row
     │                          │
     │            ┌─────────────┴─────────────┐
     │     backend==='local_fs'        backend==='s3'
     │      write to disk          PutObject → private S3 bucket (Railway MinIO)
     │                          (creds from env, NOT the DB row)
     ▼
 records metadata row (storage_key, checksum, size, content_type)

 Browser / CLI
     │  (2) GET /api/storage/:bucket/:key  ── requirePermission(PROJECT_READ)
     ▼
 resolveStoredObject(bucket, key)  ── matches an EXACT recorded, non-deleted row
     │
     ├── local_fs → res.sendFile(absolutePath)
     └── s3       → Phase 1: stream GetObject through the response (proxy)
                   Phase 3: 302 → short-lived presigned GET URL (opt-in)
```

The dotted invariant: **no byte ever leaves storage without a passed Overlord
permission check first.** The bucket has no public ACL; the only way to read is
through Overlord's authorized route.

---

## Implementation phases

### Phase 1 — `s3` backend in the byte layer (core of the work)

Make `webapp/server/storage.ts` backend-aware instead of `local_fs`-only.

1. **Add an S3 client dependency.** Use `@aws-sdk/client-s3` (and
   `@aws-sdk/s3-request-presigner` for Phase 3). It speaks to any S3-compatible
   endpoint via a configurable `endpoint` + `forcePathStyle: true` (required for
   MinIO/Railway).
2. **Introduce a small backend interface** so the bucket's `storage_backend` selects
   the implementation. Refactor the three inline `writeFileSync`/`existsSync`
   call sites (`writeImageObject`, `uploadObjectiveAttachment`, `resolveStoredObject`)
   to call through it:
   ```ts
   interface StorageBackend {
     put(key: string, bytes: Buffer, contentType: string): Promise<void>;
     // Phase 1 read: stream bytes through our authorized route.
     getStream(key: string): Promise<Readable>;
     // Phase 3 read: presigned GET, minted only after RBAC passes.
     presignGet?(key: string, ttlSeconds: number): Promise<string>;
   }
   ```
   `local_fs` keeps today's disk behavior; `s3` implements `put`/`getStream` against
   the bucket. `localRootFor()`'s 501 path is replaced by backend dispatch.
3. **Resolve S3 config from env + the bucket row, never secrets from the DB.**
   - Non-secret, from `storage_buckets.settings_json`: `bucketName`, `region`,
     `endpoint`, `pathPrefix`.
   - Secret, from environment (Railway service variables): `S3_ACCESS_KEY_ID`,
     `S3_SECRET_ACCESS_KEY` (optionally `S3_ENDPOINT`/`S3_REGION` as fallback).
   - The `storage_key` written stays the same shape as today (`<id><ext>` for images,
     `<id><ext>` for attachments), optionally prefixed with `settings_json.pathPrefix`.
4. **Keep `resolveStoredObject()` as the read gate.** It still matches an exact
   recorded row first; only the final "produce bytes" step branches on backend.
5. **Keep upload validation identical** — size ceilings (`MAX_IMAGE_BYTES`,
   `MAX_ATTACHMENT_BYTES`), the raster-only image allowlist (SVG still excluded),
   content-type normalization, and SHA-256 checksum all run *before* the object is
   put to S3, exactly as they do before `writeFileSync` today.

**No change** to `index.ts` routes, RBAC, DTOs, the core service, or the metadata
schema in Phase 1.

### Phase 2 — Provision the bucket on Railway and seed config

1. **Run an S3-compatible service on Railway** (MinIO image) backed by a Railway
   Volume for durability, on Railway's private network. Create the private bucket(s);
   set no public read policy.
2. **Set deployment secrets** on the Overlord service: `S3_ACCESS_KEY_ID`,
   `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION` (Railway service variables /
   referenced from the MinIO service).
3. **Point the buckets at S3 via data, not code.** For hosted deployments, the
   `storage_buckets` rows for `workspace-images` / `user-images` / `attachments`
   carry `storage_backend = 's3'` and a `settings_json` describing the bucket
   name/prefix. Local/SQLite installs keep `local_fs`. Provide this as a small,
   idempotent seed/migration that only flips backend when the S3 env vars are
   present (so local dev is unaffected). Selection is per-bucket, by data — the same
   pattern the Railway Postgres plan uses for `DATABASE_URL`.

### Phase 3 — Short-lived presigned URLs (opt-in optimization)

The proxy path in Phase 1 is correct and fully gated but routes every byte through
the app server. For large attachments / hot images, add presigned reads:

1. In the `GET /api/storage/...` handler, **after** `requirePermission` passes and
   the row is resolved, if the backend supports `presignGet`, mint a URL with a short
   TTL (e.g. 60–300s) and `302` redirect to it instead of streaming.
2. The URL is single-object, time-boxed, and only issued post-authorization — it
   never widens access beyond what the RBAC check already granted. The bucket stays
   private; presigning is the *only* way to read, and only Overlord can presign.
3. Make proxy-vs-presign a per-bucket `settings_json` flag so it can be enabled
   incrementally and disabled instantly if needed.

### Phase 4 — Lifecycle, parity, and hardening

1. **Deletion currently tombstones metadata and leaves bytes** (documented in
   `deleteObjectiveAttachment`). Decide cloud cleanup: either a `DeleteObject` on
   soft-delete or a sweep job over tombstoned rows. Keep it provider-neutral behind
   the backend interface.
2. **CLI/protocol parity.** `packages/core/service/storage.ts` already records
   provider-neutral metadata and needs no byte changes; confirm any CLI upload path
   funnels bytes through the same backend interface rather than assuming a local path.
3. **Tests.** Extend `webapp/server/storage.test.ts` and
   `packages/core/service/storage.test.ts` with an `s3` backend using a mocked S3
   client (or a local MinIO in CI): upload → metadata recorded → read gated → wrong
   permission rejected → presigned URL only minted post-auth.

---

## Why this respects auth and RBAC

- **The bucket is private; Overlord is the only door.** No public-read ACL. Reads
  require `PROJECT_READ`; uploads require the same `PERMISSIONS.*` they do today
  (`USER_IMAGE_SELF_CREATE`, `ATTACHMENT_CREATE`, …). The cloud backend changes
  *where bytes live*, not *who may touch them*.
- **`storage_key` stays the trust anchor.** A client can never name an arbitrary S3
  object; the server only ever acts on keys it matched to a recorded, non-deleted,
  workspace-scoped metadata row.
- **Signed URLs are issued only after a permission check passes**, are short-lived,
  and are scoped to one object — so they cannot escalate beyond the RBAC decision
  that produced them.
- **Credentials live in deployment secrets**, satisfying the schema contract's
  explicit "credentials must not be stored in this table" rule.
- **No contract change required.** `storage_backend = 's3'` and non-secret
  `settings_json` provider metadata are already specified in
  `database/docs/09-database-schema-contract.md` §`storage_buckets`.

## Module / contract impact

| Module | Change | Contract impact |
| --- | --- | --- |
| `webapp/` (`rest`) | Add `s3` backend behind a `StorageBackend` interface in `storage.ts`; optional presign branch in the serve route. Routes/RBAC unchanged. | None — behavior already allowed by the schema contract. |
| `database/` | Idempotent seed/migration to set `storage_backend='s3'` + `settings_json` for hosted deployments; local stays `local_fs`. | None — uses existing columns/values. |
| `packages/core` (`service`) | Confirm CLI byte path uses the shared backend; metadata service unchanged. | None. |
| Deployment | New env secrets (`S3_*`) + a MinIO-on-Railway service with a Volume. | New ops surface; documented, not in the DB. |

## Open questions

1. **Proxy vs. presign as the default read path** — Phase 1 ships proxy (simplest,
   no public URL surface). Confirm whether presigned redirects should be the default
   for attachments from the start.
2. **MinIO-on-Railway vs. external S3** (R2 / Backblaze / AWS) reached *from* Railway.
   The code is identical (endpoint + creds); the only difference is who runs the
   bucket. MinIO keeps everything inside Railway's private network; an external
   provider trades that for managed durability.
3. **Cloud deletion policy** for tombstoned objects (immediate `DeleteObject` vs.
   sweep) — Phase 4.
