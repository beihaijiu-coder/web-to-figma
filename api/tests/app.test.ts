import assert from "node:assert/strict";
import test from "node:test";

import { AuthenticationError, type Authenticator } from "../src/auth/authenticator.js";
import { createApi } from "../src/app.js";
import type { CurrentUser, CurrentUserRepository } from "../src/domain/current-user.js";
import { testConfig } from "./helpers.js";

const currentUser: CurrentUser = {
  user: {
    id: "2689f6e4-cd15-4f11-a2ab-9a074d630681",
    clerkUserId: "user_123",
    email: "hello@example.com",
    createdAt: "2026-06-22T00:00:00.000Z",
  },
  entitlement: {
    plan: "free",
    subscriptionStatus: "inactive",
    billingPeriod: null,
    currentPeriodEnd: null,
  },
  quota: {
    weekStartsAt: "2026-06-22T00:00:00.000Z",
    weekEndsAt: "2026-06-29T00:00:00.000Z",
    limit: 2,
    used: 0,
    reserved: 0,
    remaining: 2,
    unlimited: false,
  },
};

const authenticator: Authenticator = {
  async authenticate(header) {
    if (!header) return null;
    if (header === "Bearer invalid") throw new AuthenticationError();
    return { clerkUserId: "user_123", sessionId: "sess_123", email: "hello@example.com" };
  },
};

const repository: CurrentUserRepository = {
  async resolveCurrentUser() {
    return currentUser;
  },
};

async function testApi() {
  return createApi({ config: testConfig(), authenticator, currentUsers: repository });
}

test("health check does not need authentication", async () => {
  const api = await testApi();
  const response = await api.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    service: "web-to-figma-api",
    version: "0.1.0",
  });
  await api.close();
});

test("GET /v1/me rejects absent or invalid credentials without leaking details", async () => {
  const api = await testApi();

  const absent = await api.inject({ method: "GET", url: "/v1/me" });
  assert.equal(absent.statusCode, 401);
  assert.deepEqual(absent.json(), {
    error: { code: "UNAUTHORIZED", message: "Authentication required" },
  });

  const invalid = await api.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: "Bearer invalid" },
  });
  assert.equal(invalid.statusCode, 401);
  assert.deepEqual(invalid.json(), absent.json());
  await api.close();
});

test("GET /v1/me returns server-owned entitlement and quota data", async () => {
  const api = await testApi();
  const response = await api.inject({
    method: "GET",
    url: "/v1/me",
    headers: {
      authorization: "Bearer valid",
      origin: "http://localhost:4173",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["access-control-allow-origin"], "http://localhost:4173");
  assert.deepEqual(response.json(), currentUser);
  await api.close();
});

test("CORS rejects unconfigured browser origins", async () => {
  const api = await testApi();
  const response = await api.inject({
    method: "GET",
    url: "/health",
    headers: { origin: "https://untrusted.example" },
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), {
    error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin is not allowed" },
  });
  await api.close();
});

test("server failures do not expose database or provider details", async () => {
  const failingRepository: CurrentUserRepository = {
    async resolveCurrentUser() {
      throw new Error("database password must never appear in this response");
    },
  };
  const api = await createApi({ config: testConfig(), authenticator, currentUsers: failingRepository });
  const response = await api.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: "Bearer valid" },
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    error: { code: "INTERNAL_ERROR", message: "The request could not be completed" },
  });
  await api.close();
});

test("unknown routes have a stable error shape", async () => {
  const api = await testApi();
  const response = await api.inject({ method: "GET", url: "/missing" });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: { code: "NOT_FOUND", message: "Route not found" },
  });
  await api.close();
});
