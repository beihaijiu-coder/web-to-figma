import assert from "node:assert/strict";
import test from "node:test";

import { PostgresDeviceConnectionRepository } from "../src/db/device-connections.js";
import { PostgresCurrentUserRepository } from "../src/db/postgres.js";
import {
  DeviceConnectionService,
  hashOpaqueToken,
  type DevicePollResult,
} from "../src/device/device-connection.js";
import { migratedPglite, pglitePool, testConfig } from "./helpers.js";

function expectApproved(result: DevicePollResult | "not_found"): Extract<DevicePollResult, { status: "approved" }> {
  if (result === "not_found" || result.status !== "approved") {
    throw new Error("Expected approved device connection");
  }
  return result;
}

test("device connection approves once and exchanges a device code for installation tokens", async () => {
  const database = await migratedPglite();
  const pool = pglitePool(database);
  const users = new PostgresCurrentUserRepository(pool);
  const connections = new PostgresDeviceConnectionRepository(pool);
  const service = new DeviceConnectionService(connections, testConfig());
  const user = await users.resolveCurrentUser({
    clerkUserId: "user_clerk_device",
    sessionId: "sess_device",
    email: "device@example.com",
  });

  const created = await service.create({
    clientType: "figma_plugin",
    requestedClientName: "Figma on Mac",
  });
  assert.match(created.deviceCode, /^w2f_dc_/);
  assert.match(created.userCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal(created.verificationUri, "http://localhost:4173/connect/device/");
  assert.match(created.verificationUriComplete, /user_code=/);

  const now = new Date();
  const pending = await connections.pollConnection({
    deviceCodeHash: hashOpaqueToken(created.deviceCode),
    now,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
  });
  assert.deepEqual(pending, { status: "pending", interval: 5 });

  const approval = await service.approve(created.userCode.toLowerCase(), user.user.id);
  assert.ok(approval);
  assert.equal(approval.clientType, "figma_plugin");
  assert.equal(approval.requestedClientName, "Figma on Mac");

  const exchanged = await connections.pollConnection({
    deviceCodeHash: hashOpaqueToken(created.deviceCode),
    now: new Date(now.getTime() + 6_000),
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
  });
  const issued = expectApproved(exchanged);
  assert.match(issued.tokens.accessToken, /^w2f_at_/);
  assert.match(issued.tokens.refreshToken, /^w2f_rt_/);

  const principal = await connections.authenticateAccessToken({
    accessTokenHash: hashOpaqueToken(issued.tokens.accessToken),
    now: new Date(now.getTime() + 7_000),
  });
  assert.deepEqual(principal, {
    userId: user.user.id,
    installationId: approval.installationId,
    clientType: "figma_plugin",
  });

  const consumed = await connections.pollConnection({
    deviceCodeHash: hashOpaqueToken(created.deviceCode),
    now: new Date(now.getTime() + 12_000),
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
  });
  assert.deepEqual(consumed, { status: "consumed" });

  await database.close();
});

test("reconnecting the same named client reuses its installation and revokes old credentials", async () => {
  const database = await migratedPglite();
  const pool = pglitePool(database);
  const users = new PostgresCurrentUserRepository(pool);
  const connections = new PostgresDeviceConnectionRepository(pool);
  const service = new DeviceConnectionService(connections, testConfig());
  const user = await users.resolveCurrentUser({
    clerkUserId: "user_clerk_reconnect",
    sessionId: "sess_reconnect",
    email: "reconnect@example.com",
  });

  const firstConnection = await service.create({
    clientType: "chrome_extension",
    requestedClientName: "Chrome extension",
  });
  const firstApproval = await service.approve(firstConnection.userCode, user.user.id);
  assert.ok(firstApproval);
  const firstTokenResult = expectApproved(
    await connections.pollConnection({
      deviceCodeHash: hashOpaqueToken(firstConnection.deviceCode),
      now: new Date(Date.now() + 6_000),
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
    })
  );

  const secondConnection = await service.create({
    clientType: "chrome_extension",
    requestedClientName: "Chrome extension",
  });
  const secondApproval = await service.approve(secondConnection.userCode, user.user.id);
  assert.ok(secondApproval);
  assert.equal(secondApproval.installationId, firstApproval.installationId);

  const oldPrincipal = await connections.authenticateAccessToken({
    accessTokenHash: hashOpaqueToken(firstTokenResult.tokens.accessToken),
    now: new Date(Date.now() + 7_000),
  });
  assert.equal(oldPrincipal, null);

  const secondTokenResult = expectApproved(
    await connections.pollConnection({
      deviceCodeHash: hashOpaqueToken(secondConnection.deviceCode),
      now: new Date(Date.now() + 8_000),
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
    })
  );
  const newPrincipal = await connections.authenticateAccessToken({
    accessTokenHash: hashOpaqueToken(secondTokenResult.tokens.accessToken),
    now: new Date(Date.now() + 9_000),
  });
  assert.equal(newPrincipal?.installationId, firstApproval.installationId);

  const activeInstallations = await service.listUserInstallations(user.user.id);
  assert.deepEqual(activeInstallations.map((installation) => installation.id), [firstApproval.installationId]);

  await database.close();
});

test("refresh token rotation detects reuse and revokes installation access", async () => {
  const database = await migratedPglite();
  const pool = pglitePool(database);
  const users = new PostgresCurrentUserRepository(pool);
  const connections = new PostgresDeviceConnectionRepository(pool);
  const service = new DeviceConnectionService(connections, testConfig());
  const user = await users.resolveCurrentUser({
    clerkUserId: "user_clerk_refresh",
    sessionId: "sess_refresh",
    email: "refresh@example.com",
  });
  const created = await service.create({ clientType: "chrome_extension" });
  const approval = await service.approve(created.userCode, user.user.id);
  assert.ok(approval);

  const initial = await connections.pollConnection({
    deviceCodeHash: hashOpaqueToken(created.deviceCode),
    now: new Date(Date.now() + 6_000),
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
  });
  const issued = expectApproved(initial);

  const rotated = await connections.refreshToken({
    refreshTokenHash: hashOpaqueToken(issued.tokens.refreshToken),
    now: new Date(Date.now() + 7_000),
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
  });
  assert.notEqual(rotated, "invalid");
  assert.notEqual(rotated, "reuse_detected");
  if (typeof rotated === "string") throw new Error("Expected rotated token pair");
  assert.notEqual(rotated.refreshToken, issued.tokens.refreshToken);

  const replay = await connections.refreshToken({
    refreshTokenHash: hashOpaqueToken(issued.tokens.refreshToken),
    now: new Date(Date.now() + 8_000),
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
  });
  assert.equal(replay, "reuse_detected");

  const oldAccess = await connections.authenticateAccessToken({
    accessTokenHash: hashOpaqueToken(issued.tokens.accessToken),
    now: new Date(Date.now() + 9_000),
  });
  assert.equal(oldAccess, null);

  await database.close();
});
