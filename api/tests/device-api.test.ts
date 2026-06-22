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

  await api.close();
  await database.close();
});
