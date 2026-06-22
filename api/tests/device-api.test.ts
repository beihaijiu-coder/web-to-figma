import assert from "node:assert/strict";
import test from "node:test";

import { createApi } from "../src/app.js";
import type { Authenticator } from "../src/auth/authenticator.js";
import { PostgresDeviceConnectionRepository } from "../src/db/device-connections.js";
import { PostgresCurrentUserRepository } from "../src/db/postgres.js";
import { DeviceConnectionService } from "../src/device/device-connection.js";
import { migratedPglite, pglitePool, testConfig } from "./helpers.js";

const authenticator: Authenticator = {
  async authenticate(header) {
    if (!header) return null;
    return { clerkUserId: "user_api_device", sessionId: "sess_api_device", email: "api-device@example.com" };
  },
};

test("device connection API creates, approves, exchanges, and refreshes installation tokens", async () => {
  const database = await migratedPglite();
  const pool = pglitePool(database);
  const currentUsers = new PostgresCurrentUserRepository(pool);
  const deviceConnections = new DeviceConnectionService(new PostgresDeviceConnectionRepository(pool), testConfig());
  const api = await createApi({ config: testConfig(), authenticator, currentUsers, deviceConnections });

  const createResponse = await api.inject({
    method: "POST",
    url: "/v1/device-connections",
    payload: { clientType: "chrome_extension", requestedClientName: "Chrome on Mac" },
  });
  assert.equal(createResponse.statusCode, 201);
  const created = createResponse.json();
  assert.match(created.userCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.match(created.deviceCode, /^w2f_dc_/);

  const approvalResponse = await api.inject({
    method: "POST",
    url: "/v1/device-connections/approve",
    headers: { authorization: "Bearer clerk-session" },
    payload: { userCode: created.userCode },
  });
  assert.equal(approvalResponse.statusCode, 200);
  assert.equal(approvalResponse.json().installationId.length > 20, true);

  const tokenResponse = await api.inject({
    method: "POST",
    url: "/v1/device-connections/token",
    payload: { deviceCode: created.deviceCode },
  });
  assert.equal(tokenResponse.statusCode, 200);
  const tokens = tokenResponse.json();
  assert.match(tokens.accessToken, /^w2f_at_/);
  assert.match(tokens.refreshToken, /^w2f_rt_/);

  const refreshResponse = await api.inject({
    method: "POST",
    url: "/v1/tokens/refresh",
    payload: { refreshToken: tokens.refreshToken },
  });
  assert.equal(refreshResponse.statusCode, 200);
  assert.match(refreshResponse.json().accessToken, /^w2f_at_/);

  const figmaCreateResponse = await api.inject({
    method: "POST",
    url: "/v1/device-connections",
    payload: { clientType: "figma_plugin", requestedClientName: "Figma desktop" },
  });
  assert.equal(figmaCreateResponse.statusCode, 201);
  const figmaCreated = figmaCreateResponse.json();
  const figmaApprovalResponse = await api.inject({
    method: "POST",
    url: "/v1/device-connections/approve",
    headers: { authorization: "Bearer clerk-session" },
    payload: { userCode: figmaCreated.userCode },
  });
  assert.equal(figmaApprovalResponse.statusCode, 200);
  const figmaInstallationId = figmaApprovalResponse.json().installationId;
  const figmaTokenResponse = await api.inject({
    method: "POST",
    url: "/v1/device-connections/token",
    payload: { deviceCode: figmaCreated.deviceCode },
  });
  assert.equal(figmaTokenResponse.statusCode, 200);

  const deviceMeResponse = await api.inject({
    method: "GET",
    url: "/v1/device/me",
    headers: { authorization: `Bearer ${figmaTokenResponse.json().accessToken}` },
  });
  assert.equal(deviceMeResponse.statusCode, 200);
  assert.equal(deviceMeResponse.json().installation.installationId, figmaInstallationId);
  assert.equal(deviceMeResponse.json().installation.clientType, "figma_plugin");
  assert.equal(typeof deviceMeResponse.json().installation.userId, "string");

  const installationsResponse = await api.inject({
    method: "GET",
    url: "/v1/installations?clientType=figma_plugin",
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  assert.equal(installationsResponse.statusCode, 200);
  assert.deepEqual(
    installationsResponse.json().installations.map((installation: { id: string; clientType: string; displayName: string | null }) => ({
      id: installation.id,
      clientType: installation.clientType,
      displayName: installation.displayName,
    })),
    [{ id: figmaInstallationId, clientType: "figma_plugin", displayName: "Figma desktop" }]
  );

  const websiteInstallations = await api.inject({
    method: "GET",
    url: "/v1/me/installations",
    headers: { authorization: "Bearer clerk-session" },
  });
  assert.equal(websiteInstallations.statusCode, 200);
  assert.equal(websiteInstallations.json().installations.length, 2);

  const websiteRevoke = await api.inject({
    method: "DELETE",
    url: `/v1/me/installations/${figmaInstallationId}`,
    headers: { authorization: "Bearer clerk-session" },
  });
  assert.equal(websiteRevoke.statusCode, 200);
  assert.equal(
    (
      await api.inject({
        method: "GET",
        url: "/v1/device/me",
        headers: { authorization: `Bearer ${figmaTokenResponse.json().accessToken}` },
      })
    ).statusCode,
    401
  );

  const ownRevoke = await api.inject({
    method: "DELETE",
    url: "/v1/device/me",
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  assert.equal(ownRevoke.statusCode, 200);
  assert.equal(
    (
      await api.inject({
        method: "GET",
        url: "/v1/device/me",
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
    ).statusCode,
    401
  );

  await api.close();
  await database.close();
});
