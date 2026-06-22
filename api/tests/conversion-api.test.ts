import { mkdtemp } from "node:fs/promises";
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
import { LocalPackageStorage } from "../src/storage/local-package-storage.js";
import { migratedPglite, pglitePool, testConfig } from "./helpers.js";

const authenticator: Authenticator = {
  async authenticate(header) {
    if (!header) return null;
    return { clerkUserId: "user_conversion", sessionId: "sess_conversion", email: "conversion@example.com" };
  },
};

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

test("Chrome and Figma tokens complete a local encrypted task handoff and settle Free usage", async () => {
  const database = await migratedPglite();
  const pool = pglitePool(database);
  const config = {
    ...testConfig(),
    conversions: {
      ...testConfig().conversions,
      packageStorageDir: await mkdtemp(join(tmpdir(), "web-to-figma-packages-")),
    },
  };
  const api = await createApi({
    config,
    authenticator,
    currentUsers: new PostgresCurrentUserRepository(pool),
    deviceConnections: new DeviceConnectionService(new PostgresDeviceConnectionRepository(pool), config),
    conversionJobs: new PostgresConversionJobRepository(pool),
    packageStorage: new LocalPackageStorage(config.conversions.packageStorageDir),
  });

  const figma = await connectInstallation(api, "figma_plugin");
  const chrome = await connectInstallation(api, "chrome_extension");

  const createJob = await api.inject({
    method: "POST",
    url: "/v1/conversion-jobs",
    headers: {
      authorization: `Bearer ${chrome.tokens.accessToken}`,
      "idempotency-key": "conversion-job-1",
    },
    payload: { targetInstallationId: figma.installationId, scenePackageVersion: 1 },
  });
  assert.equal(createJob.statusCode, 201);
  const taskId = createJob.json().taskId as string;

  const duplicateCreate = await api.inject({
    method: "POST",
    url: "/v1/conversion-jobs",
    headers: {
      authorization: `Bearer ${chrome.tokens.accessToken}`,
      "idempotency-key": "conversion-job-1",
    },
    payload: { targetInstallationId: figma.installationId, scenePackageVersion: 1 },
  });
  assert.equal(duplicateCreate.statusCode, 201);
  assert.equal(duplicateCreate.json().taskId, taskId);

  const encryptedPackage = Buffer.from("encrypted scene package");
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

  const pending = await api.inject({
    method: "GET",
    url: "/v1/conversion-jobs/pending",
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.json().jobs[0].id, taskId);

  const claim = await api.inject({
    method: "POST",
    url: `/v1/conversion-jobs/${taskId}/claim`,
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(claim.statusCode, 200);

  const download = await api.inject({
    method: "GET",
    url: `/v1/conversion-jobs/${taskId}/package`,
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(download.statusCode, 200);
  assert.equal(download.body, encryptedPackage.toString());

  const imported = await api.inject({
    method: "POST",
    url: `/v1/conversion-jobs/${taskId}/imported`,
    headers: { authorization: `Bearer ${figma.tokens.accessToken}` },
  });
  assert.equal(imported.statusCode, 200);
  assert.equal(imported.json().status, "imported");

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
