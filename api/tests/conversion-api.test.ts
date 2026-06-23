import { mkdtemp } from "node:fs/promises";
import { createCipheriv } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { createApi } from "../src/app.js";
import type { Authenticator } from "../src/auth/authenticator.js";
import { PostgresConversionJobRepository } from "../src/db/conversion-jobs.js";
import { PostgresDeviceConnectionRepository } from "../src/db/device-connections.js";
import { PostgresCurrentUserRepository } from "../src/db/postgres.js";
import { DeviceConnectionService } from "../src/device/device-connection.js";
import type { PreviewContentType, PreviewStorage } from "../src/conversions/conversion-jobs.js";
import { LocalPackageStorage } from "../src/storage/local-package-storage.js";
import { migratedPglite, pglitePool, testConfig } from "./helpers.js";

const authenticator: Authenticator = {
  async authenticate(header) {
    if (!header) return null;
    return { clerkUserId: "user_conversion", sessionId: "sess_conversion", email: "conversion@example.com" };
  },
};

const packageEncryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const preview = {
  sourceUrl: "https://example.com/private-page",
  sourceTitle: "Private dashboard",
  previewImageDataUrl: "data:image/jpeg;base64,AAAA",
};
const packagePayload = {
  version: 1,
  source: { url: preview.sourceUrl, title: preview.sourceTitle },
  root: {
    type: "frame",
    name: "Captured page",
    children: [{ type: "text", text: "Hello from encrypted cloud package" }],
  },
};

class MemoryPreviewStorage implements PreviewStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: PreviewContentType }>();
  writeCount = 0;

  async write(objectKey: string, body: Buffer, contentType: PreviewContentType): Promise<void> {
    this.writeCount += 1;
    this.objects.set(objectKey, { body: Buffer.from(body), contentType });
  }

  async read(objectKey: string): Promise<{ body: Buffer; contentType: PreviewContentType }> {
    const object = this.objects.get(objectKey);
    if (!object) throw new Error("Preview object not found");
    return { body: Buffer.from(object.body), contentType: object.contentType };
  }

  async remove(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }
}

function createEncryptedScenePackage(payload: unknown, keyValue = packageEncryptionKey): Buffer {
  const magic = Buffer.from([0x57, 0x32, 0x46, 0x31]);
  const iv = Buffer.alloc(12, 7);
  const key = Buffer.from(keyValue, "base64url");
  const plaintext = Buffer.from(JSON.stringify({ source: "web-to-figma", type: "capture-scene", payload }), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(magic);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([magic, iv, ciphertext, cipher.getAuthTag()]);
}

async function connectInstallation(
  api: Awaited<ReturnType<typeof createApi>>,
  clientType: "chrome_extension" | "figma_plugin"
) {
  const createResponse = await api.inject({
    method: "POST",
    url: "/v1/device-connections",
    payload: { clientType },
  });
  assert.equal(createResponse.statusCode, 201);
  const created = createResponse.json();

  const approveResponse = await api.inject({
    method: "POST",
    url: "/v1/device-connections/approve",
    headers: { authorization: "Bearer clerk-session" },
    payload: { userCode: created.userCode },
  });
  assert.equal(approveResponse.statusCode, 200);

  const tokenResponse = await api.inject({
    method: "POST",
    url: "/v1/device-connections/token",
    payload: { deviceCode: created.deviceCode },
  });
  assert.equal(tokenResponse.statusCode, 200);
  return { installationId: approveResponse.json().installationId as string, tokens: tokenResponse.json() };
}

test("Chrome uploads an account queue task that a later Figma connection can claim and settle", async () => {
  const database = await migratedPglite();
  const pool = pglitePool(database);
  const config = {
    ...testConfig(),
    conversions: {
      ...testConfig().conversions,
      packageStorageDir: await mkdtemp(join(tmpdir(), "web-to-figma-packages-")),
    },
  };
  const previewStorage = new MemoryPreviewStorage();
  const api = await createApi({
    config,
    authenticator,
    currentUsers: new PostgresCurrentUserRepository(pool),
    deviceConnections: new DeviceConnectionService(new PostgresDeviceConnectionRepository(pool), config),
    conversionJobs: new PostgresConversionJobRepository(pool),
    packageStorage: new LocalPackageStorage(config.conversions.packageStorageDir),
    previewStorage,
  });

  const chrome = await connectInstallation(api, "chrome_extension");

  const createJob = await api.inject({
    method: "POST",
    url: "/v1/conversion-jobs",
    headers: {
      authorization: `Bearer ${chrome.tokens.accessToken}`,
      "idempotency-key": "conversion-job-1",
    },
    payload: { scenePackageVersion: 1, packageEncryptionKey, preview },
  });
  assert.equal(createJob.statusCode, 201);
  const taskId = createJob.json().taskId as string;

  const storedPreviewMetadata = await pool.query<{
    preview_image_data_url: string | null;
    preview_object_key: string | null;
  }>(
    "select preview_image_data_url, preview_object_key from conversion_jobs where id = $1",
    [taskId]
  );
  assert.equal(
    storedPreviewMetadata.rows[0]?.preview_image_data_url,
    null,
    "thumbnail bytes must not be stored in Neon"
  );
  const previewObjectKey = storedPreviewMetadata.rows[0]?.preview_object_key;
  assert.equal(previewObjectKey, `conversion-jobs/${taskId}/preview.jpg`);
  assert.deepEqual(previewStorage.objects.get(previewObjectKey!)?.body, Buffer.from("AAAA", "base64"));
  assert.equal(previewStorage.writeCount, 1);

  const duplicateCreate = await api.inject({
    method: "POST",
    url: "/v1/conversion-jobs",
    headers: {
      authorization: `Bearer ${chrome.tokens.accessToken}`,
      "idempotency-key": "conversion-job-1",
    },
    payload: { scenePackageVersion: 1, packageEncryptionKey, preview },
  });
  assert.equal(duplicateCreate.statusCode, 201);
  assert.equal(duplicateCreate.json().taskId, taskId);
  assert.equal(previewStorage.writeCount, 1);

  const encryptedPackage = createEncryptedScenePackage(packagePayload);
  const upload = await api.inject({
    method: "PUT",
    url: `/v1/conversion-jobs/${taskId}/package`,
    headers: {
      authorization: `Bearer ${chrome.tokens.accessToken}`,
      "content-type": "application/octet-stream",
    },
    payload: encryptedPackage,
  });
  assert.equal(upload.statusCode, 200);
  assert.equal(upload.json().status, "uploaded");

  const figma = await connectInstallation(api, "figma_plugin");
  const pending = await api.inject({
    method: "GET",
    url: "/v1/conversion-jobs/pending",
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.json().jobs[0].id, taskId);
  assert.equal(pending.json().jobs[0].sourceUrl, preview.sourceUrl);
  assert.equal(pending.json().jobs[0].sourceTitle, preview.sourceTitle);
  assert.equal(pending.json().jobs[0].previewImageDataUrl, preview.previewImageDataUrl);
  assert.equal(pending.json().jobs[0].packageEncryptionKey, undefined);

  const secondFigma = await connectInstallation(api, "figma_plugin");
  const secondFigmaPendingBeforeClaim = await api.inject({
    method: "GET",
    url: "/v1/conversion-jobs/pending",
    headers: { authorization: `Bearer ${secondFigma.tokens.accessToken}` },
  });
  assert.equal(secondFigmaPendingBeforeClaim.statusCode, 200);
  assert.equal(secondFigmaPendingBeforeClaim.json().jobs[0].id, taskId);

  const claim = await api.inject({
    method: "POST",
    url: `/v1/conversion-jobs/${taskId}/claim`,
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(claim.statusCode, 200);
  assert.deepEqual(claim.json().encryption, { algorithm: "A256GCM", key: packageEncryptionKey });
  assert.deepEqual(claim.json().downloadJson, {
    method: "GET",
    url: `/v1/conversion-jobs/${taskId}/package-json`,
  });

  const sameFigmaPendingAfterClaim = await api.inject({
    method: "GET",
    url: "/v1/conversion-jobs/pending",
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(sameFigmaPendingAfterClaim.statusCode, 200);
  assert.equal(sameFigmaPendingAfterClaim.json().jobs[0].id, taskId);
  assert.equal(sameFigmaPendingAfterClaim.json().jobs[0].status, "claimed");

  const secondFigmaPendingAfterClaim = await api.inject({
    method: "GET",
    url: "/v1/conversion-jobs/pending",
    headers: { authorization: `Bearer ${secondFigma.tokens.accessToken}` },
  });
  assert.equal(secondFigmaPendingAfterClaim.statusCode, 200);
  assert.deepEqual(secondFigmaPendingAfterClaim.json().jobs, []);

  const secondFigmaClaimAfterLock = await api.inject({
    method: "POST",
    url: `/v1/conversion-jobs/${taskId}/claim`,
    headers: { authorization: `Bearer ${secondFigma.tokens.accessToken}` },
  });
  assert.equal(secondFigmaClaimAfterLock.statusCode, 409);

  const duplicateClaim = await api.inject({
    method: "POST",
    url: `/v1/conversion-jobs/${taskId}/claim`,
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(duplicateClaim.statusCode, 200);
  assert.equal(duplicateClaim.json().taskId, taskId);

  const download = await api.inject({
    method: "GET",
    url: `/v1/conversion-jobs/${taskId}/package`,
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, encryptedPackage);

  const downloadJson = await api.inject({
    method: "GET",
    url: `/v1/conversion-jobs/${taskId}/package-json`,
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(downloadJson.statusCode, 200);
  assert.deepEqual(downloadJson.json().payload, packagePayload);

  const imported = await api.inject({
    method: "POST",
    url: `/v1/conversion-jobs/${taskId}/imported`,
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(imported.statusCode, 200);
  assert.equal(imported.json().status, "imported");
  assert.equal(
    (
      await pool.query<{ package_deleted_at: Date | string | null }>(
        "select package_deleted_at from conversion_jobs where id = $1",
        [taskId]
      )
    ).rows[0]?.package_deleted_at,
    null
  );

  const pendingAfterImport = await api.inject({
    method: "GET",
    url: "/v1/conversion-jobs/pending",
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(pendingAfterImport.statusCode, 200);
  assert.equal(pendingAfterImport.json().jobs[0].id, taskId);
  assert.equal(pendingAfterImport.json().jobs[0].status, "imported");

  const repeatClaim = await api.inject({
    method: "POST",
    url: `/v1/conversion-jobs/${taskId}/claim`,
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(repeatClaim.statusCode, 200);
  assert.equal(repeatClaim.json().status, "imported");

  const repeatDownloadJson = await api.inject({
    method: "GET",
    url: `/v1/conversion-jobs/${taskId}/package-json`,
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(repeatDownloadJson.statusCode, 200);
  assert.deepEqual(repeatDownloadJson.json().payload, packagePayload);

  const secondJobResponse = await api.inject({
    method: "POST",
    url: "/v1/conversion-jobs",
    headers: {
      authorization: `Bearer ${chrome.tokens.accessToken}`,
      "idempotency-key": "conversion-job-2",
    },
    payload: { scenePackageVersion: 1, packageEncryptionKey },
  });
  assert.equal(secondJobResponse.statusCode, 201);
  const secondTaskId = secondJobResponse.json().taskId as string;
  assert.equal(
    (
      await api.inject({
        method: "PUT",
        url: `/v1/conversion-jobs/${secondTaskId}/package`,
        headers: {
          authorization: `Bearer ${chrome.tokens.accessToken}`,
          "content-type": "application/octet-stream",
        },
        payload: encryptedPackage,
      })
    ).statusCode,
    200
  );

  const prematureImport = await api.inject({
    method: "POST",
    url: `/v1/conversion-jobs/${secondTaskId}/imported`,
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(prematureImport.statusCode, 409);

  assert.equal(
    (
      await api.inject({
        method: "POST",
        url: `/v1/conversion-jobs/${secondTaskId}/claim`,
        headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
      })
    ).statusCode,
    200
  );
  const cancelled = await api.inject({
    method: "POST",
    url: `/v1/conversion-jobs/${secondTaskId}/cancelled`,
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().status, "cancelled");
  assert.ok(
    (
      await pool.query<{ package_deleted_at: Date | string | null }>(
        "select package_deleted_at from conversion_jobs where id = $1",
        [secondTaskId]
      )
    ).rows[0]?.package_deleted_at
  );

  const thirdJobResponse = await api.inject({
    method: "POST",
    url: "/v1/conversion-jobs",
    headers: {
      authorization: `Bearer ${chrome.tokens.accessToken}`,
      "idempotency-key": "conversion-job-3",
    },
    payload: { scenePackageVersion: 1, packageEncryptionKey },
  });
  assert.equal(thirdJobResponse.statusCode, 201);
  const captureFailed = await api.inject({
    method: "POST",
    url: `/v1/conversion-jobs/${thirdJobResponse.json().taskId}/capture-failed`,
    headers: { authorization: `Bearer ${chrome.tokens.accessToken}` },
  });
  assert.equal(captureFailed.statusCode, 200);
  assert.equal(captureFailed.json().status, "capture_failed");

  const me = await api.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: "Bearer clerk-session" },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().quota.used, 1);
  assert.equal(me.json().quota.remaining, 1);

  await api.close();
  await database.close();
});

test("cloud capture storage keeps the newest ten uploaded webpages", async () => {
  const database = await migratedPglite();
  const pool = pglitePool(database);
  const config = {
    ...testConfig(),
    conversions: {
      ...testConfig().conversions,
      maxActiveJobs: 20,
      maxStoredCaptures: 10,
      packageStorageDir: await mkdtemp(join(tmpdir(), "web-to-figma-packages-")),
    },
  };
  const previewStorage = new MemoryPreviewStorage();
  const api = await createApi({
    config,
    authenticator,
    currentUsers: new PostgresCurrentUserRepository(pool),
    deviceConnections: new DeviceConnectionService(new PostgresDeviceConnectionRepository(pool), config),
    conversionJobs: new PostgresConversionJobRepository(pool),
    packageStorage: new LocalPackageStorage(config.conversions.packageStorageDir),
    previewStorage,
  });

  const chrome = await connectInstallation(api, "chrome_extension");
  await pool.query(
    `
      UPDATE entitlements
      SET plan = 'pro',
          subscription_status = 'active',
          current_period_end = $2
      WHERE user_id = (
        SELECT user_id FROM installations WHERE id = $1
      )
    `,
    [chrome.installationId, new Date(Date.now() + 86_400_000)]
  );

  const taskIds: string[] = [];
  for (let index = 0; index < 11; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    const createJob = await api.inject({
      method: "POST",
      url: "/v1/conversion-jobs",
      headers: {
        authorization: `Bearer ${chrome.tokens.accessToken}`,
        "idempotency-key": `stored-capture-${index}`,
      },
      payload: {
        scenePackageVersion: 1,
        packageEncryptionKey,
        preview: {
          sourceUrl: `https://example.com/page-${index}`,
          sourceTitle: `Stored page ${index}`,
          previewImageDataUrl: "data:image/jpeg;base64,AAAA",
        },
      },
    });
    assert.equal(createJob.statusCode, 201);
    const taskId = createJob.json().taskId as string;
    taskIds.push(taskId);
    const upload = await api.inject({
      method: "PUT",
      url: `/v1/conversion-jobs/${taskId}/package`,
      headers: {
        authorization: `Bearer ${chrome.tokens.accessToken}`,
        "content-type": "application/octet-stream",
      },
      payload: createEncryptedScenePackage({ ...packagePayload, source: { url: `https://example.com/page-${index}` } }),
    });
    assert.equal(upload.statusCode, 200);
  }

  const oldest = await pool.query<{
    status: string;
    package_deleted_at: Date | string | null;
    preview_object_key: string | null;
    preview_deleted_at: Date | string | null;
  }>(
    "select status, package_deleted_at, preview_object_key, preview_deleted_at from conversion_jobs where id = $1",
    [taskIds[0]]
  );
  assert.equal(oldest.rows[0]?.status, "expired");
  assert.ok(oldest.rows[0]?.package_deleted_at);
  assert.ok(oldest.rows[0]?.preview_deleted_at);
  assert.equal(previewStorage.objects.has(oldest.rows[0]!.preview_object_key!), false);
  assert.equal(previewStorage.objects.size, 10);

  const figma = await connectInstallation(api, "figma_plugin");
  const pending = await api.inject({
    method: "GET",
    url: "/v1/conversion-jobs/pending",
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.json().jobs.length, 10);
  assert.equal(
    pending.json().jobs.some((job: { id: string }) => job.id === taskIds[0]),
    false
  );

  const claimPruned = await api.inject({
    method: "POST",
    url: `/v1/conversion-jobs/${taskIds[0]}/claim`,
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(claimPruned.statusCode, 409);

  await api.close();
  await database.close();
});
