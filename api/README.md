# Web to Figma API

TypeScript API for Web to Figma identity, internal users, entitlements, weekly Free quota, device connection, token rotation, and short-lived conversion handoff.

## First local setup

`api/.env.local` is intentionally ignored by Git and has already been created as a blank local template. Fill in the Clerk, Neon, and private Cloudflare R2 values you saved privately:

```text
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
DATABASE_URL=postgresql://...
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=web-to-figma-dev
R2_ENDPOINT=https://....r2.cloudflarestorage.com
R2_REGION=auto
```

Do not paste these values into chat, source files, screenshots, or Git commits. `CLERK_AUTHORIZED_PARTIES` and `CORS_ALLOWED_ORIGINS` default to the local marketing-site origin, `http://localhost:4173`.

## Commands

From the repository root:

```bash
npm run check:api
npm run test:api
npm run migrate:api
npm run dev:api
```

`migrate:api` is the only command that changes Neon. Run it only after `DATABASE_URL` points to the **development** branch. `dev:api` starts the API at `http://127.0.0.1:8787`.

## First verification

After starting the server, this must return a JSON health response:

```bash
curl http://127.0.0.1:8787/health
```

`GET /v1/me` requires a real Clerk Session JWT in the `Authorization: Bearer` header. The API verifies the Clerk signature and allowed origin before atomically creating or reading the internal user and entitlement record. It never accepts a client-provided user ID, plan, or quota.

## Implemented endpoints

### Website identity

- `GET /health` — unauthenticated liveness check.
- `GET /v1/me` — Clerk-authenticated current user, entitlement, and weekly quota.

### Chrome/Figma account connection

- `POST /v1/device-connections` — create a one-time connection request for `chrome_extension` or `figma_plugin`.
- `POST /v1/device-connections/approve` — Clerk-authenticated website approval.
- `POST /v1/device-connections/deny` — Clerk-authenticated website denial.
- `POST /v1/device-connections/token` — extension/plugin polling endpoint; returns an opaque Access Token and rotating Refresh Token once approved.
- `POST /v1/tokens/refresh` — rotate a Refresh Token; reuse detection revokes the token family and active installation access.
- `GET /v1/device/me` — extension/plugin token reads its own installation identity.
- `DELETE /v1/device/me` — revoke the calling extension/plugin installation and all of its tokens.
- `GET /v1/installations?clientType=figma_plugin` — extension/plugin token lists active installations for the same internal user. Chrome may use this for optional direct targeting, but the default handoff uses the account task queue.
- `GET /v1/me/installations` and `DELETE /v1/me/installations/:installationId` — website session lists and revokes the user’s client installations.

### Conversion handoff

- `POST /v1/conversion-jobs` — Chrome-extension token creates an account-queue task with an `Idempotency-Key` and reserves Free quota when needed. `targetInstallationId` is optional for direct targeting; `preview` may include the captured page title, URL, and thumbnail for the Figma task grid. Thumbnail bytes are stored in the private R2 bucket; Neon stores only the object key.
- `PUT /v1/conversion-jobs/:jobId/package` — Chrome-extension token uploads the encrypted scene package to the local development package store.
- `POST /v1/conversion-jobs/:jobId/capture-failed` — Chrome-extension token releases a reservation when encryption or upload cannot complete.
- `GET /v1/conversion-jobs/pending` — Figma-plugin token lists the same account's stored cloud captures, including unimported tasks and imported captures that remain available for repeat import. The API reads private thumbnails from R2 and returns them only to the authenticated Figma installation. The default retention limit is 10 stored captures per user.
- `POST /v1/conversion-jobs/:jobId/claim` — Figma-plugin token claims a task, atomically binds unclaimed account-queue tasks to that installation, and receives both encrypted-binary and API-decoded package download URLs.
- `GET /v1/conversion-jobs/:jobId/package` — Figma-plugin token downloads the encrypted package when the plugin UI can use WebCrypto locally.
- `GET /v1/conversion-jobs/:jobId/package-json` — Figma-plugin token downloads the decrypted capture payload through the API compatibility path for Figma UI environments without WebCrypto.
- `POST /v1/conversion-jobs/:jobId/imported` — Figma-plugin token marks success; Free reservation is settled into one usage event and the package remains in cloud storage until it ages out of the user's retained capture limit.
- `POST /v1/conversion-jobs/:jobId/failed` — Figma-plugin token marks failure; Free reservation is released and the local package is deleted.
- `POST /v1/conversion-jobs/:jobId/cancelled` — Figma-plugin token records cancellation after partial Figma nodes have been removed.

Chrome removes credentials, browser-session fields, and URL query parameters from the cloud scene package, then encrypts the scene JSON with AES-256-GCM before upload. The temporary object contains only ciphertext; the API stores the task key separately and returns it only after a Figma installation for the same account atomically claims that task. This is server-orchestrated encrypted storage, not a claim that the API itself can never decrypt the scene. Package SHA-256 is checked before decryption. Successful object deletion is recorded so the cleanup worker retries only packages whose deletion has not yet succeeded; deletion failure never reverses an already-settled task.

The current encrypted scene-package storage is a local development adapter under `.data/packages`, ignored by Git. Capture thumbnails use the private R2 bucket and are removed alongside their task when it fails, expires, or falls beyond the user's newest ten captures. The R2 bucket does not need public access or browser CORS because only the API talks to it. A minute-based maintenance job expires abandoned tasks, releases reservations, and removes terminal package and preview objects. Production should also replace the local scene-package adapter with short-lived object-storage upload/download authorizations plus a storage lifecycle TTL.

## Production guardrails

- Production configuration requires HTTPS origins and an explicit `CLERK_AUDIENCE`.
- Local CORS explicitly permits the Figma UI `null` origin and a development Chrome-extension wildcard. Production rejects that wildcard and requires the published extension origin.
- The API verifies `exp`, `iss`, token signature, `azp`/authorized party, and (when configured) `aud` through Clerk's backend verifier.
- The product week starts Monday 00:00 UTC. Free users have two completed conversions per product week; uncompleted reservations reduce remaining capacity but are not usage.
- Migrations are checksummed and run under a PostgreSQL advisory lock. A changed applied migration is rejected.
- Device and plugin tokens are opaque, stored only as SHA-256 hashes, and are scoped to one installation. Refresh Token reuse revokes the family and all active access for that installation.
- Only an active, unexpired Pro subscription receives unlimited quota. Past-due, cancelled, inactive, or expired Pro records use Free quota until billing synchronization restores an active period.
