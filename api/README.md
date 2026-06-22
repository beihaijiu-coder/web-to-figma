# Web to Figma API

TypeScript API for Web to Figma identity, internal users, entitlements, weekly Free quota, device connection, token rotation, and short-lived conversion handoff.

## First local setup

`api/.env.local` is intentionally ignored by Git and has already been created as a blank local template. Fill in the three values you saved privately:

```text
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
DATABASE_URL=postgresql://...
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

### Conversion handoff

- `POST /v1/conversion-jobs` — Chrome-extension token creates a task with an `Idempotency-Key` and reserves Free quota when needed.
- `PUT /v1/conversion-jobs/:jobId/package` — Chrome-extension token uploads the encrypted scene package to the local development package store.
- `GET /v1/conversion-jobs/pending` — Figma-plugin token lists uploaded tasks assigned to that installation.
- `POST /v1/conversion-jobs/:jobId/claim` — Figma-plugin token claims a task and receives the package download URL.
- `GET /v1/conversion-jobs/:jobId/package` — Figma-plugin token downloads the encrypted package.
- `POST /v1/conversion-jobs/:jobId/imported` — Figma-plugin token marks success; Free reservation is settled into one usage event and the local package is deleted.
- `POST /v1/conversion-jobs/:jobId/failed` — Figma-plugin token marks failure; Free reservation is released and the local package is deleted.

The current package storage is a local development adapter under `.data/packages`, ignored by Git. It preserves the API contract while avoiding an object-storage account before production. Production should replace this adapter with short-lived object-storage upload/download authorizations.

## Production guardrails

- Production configuration requires HTTPS origins and an explicit `CLERK_AUDIENCE`.
- The API verifies `exp`, `iss`, token signature, `azp`/authorized party, and (when configured) `aud` through Clerk's backend verifier.
- The product week starts Monday 00:00 UTC. Free users have two completed conversions per product week; uncompleted reservations reduce remaining capacity but are not usage.
- Migrations are checksummed and run under a PostgreSQL advisory lock. A changed applied migration is rejected.
- Device and plugin tokens are opaque, stored only as SHA-256 hashes, and are scoped to one installation. Refresh Token reuse revokes the family and all active access for that installation.
