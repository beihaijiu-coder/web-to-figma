import assert from "node:assert/strict";
import test from "node:test";

import { ConfigurationError, createConfig } from "../src/config.js";

const baseEnvironment = {
  NODE_ENV: "test",
  API_HOST: "127.0.0.1",
  API_PORT: "8787",
  DATABASE_URL: "postgresql://user:password@localhost:5432/web_to_figma",
  CLERK_PUBLISHABLE_KEY: "pk_test_example",
  CLERK_SECRET_KEY: "sk_test_example",
  CLERK_AUTHORIZED_PARTIES: "http://localhost:4173, https://app.example.com",
  CORS_ALLOWED_ORIGINS: "http://localhost:4173, https://app.example.com, null, chrome-extension://*",
  CLERK_AUDIENCE: "web-to-figma-web",
  PUBLIC_WEB_URL: "http://localhost:4173",
  R2_ACCOUNT_ID: "test-account-id",
  R2_ACCESS_KEY_ID: "test-access-key-id",
  R2_SECRET_ACCESS_KEY: "test-secret-access-key",
  R2_BUCKET_NAME: "web-to-figma-test",
  R2_ENDPOINT: "https://test-account-id.r2.cloudflarestorage.com",
  R2_REGION: "auto",
};

test("configuration parses origin lists and optional audience", () => {
  const config = createConfig(baseEnvironment);

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8787);
  assert.deepEqual(config.clerk.authorizedParties, [
    "http://localhost:4173",
    "https://app.example.com",
  ]);
  assert.deepEqual(config.corsAllowedOrigins, [
    "http://localhost:4173",
    "https://app.example.com",
    "null",
    "chrome-extension://*",
  ]);
  assert.deepEqual(config.clerk.audience, ["web-to-figma-web"]);
  assert.equal(config.device.connectionTtlSeconds, 600);
  assert.equal(config.r2.bucketName, "web-to-figma-test");
});

test("Railway PORT binds the API to all interfaces", () => {
  const { API_HOST: _apiHost, API_PORT: _apiPort, ...railwayEnvironment } = baseEnvironment;
  const config = createConfig({ ...railwayEnvironment, PORT: "4321" });

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 4321);
});

test("explicit API host and port override Railway defaults", () => {
  const config = createConfig({
    ...baseEnvironment,
    API_HOST: "127.0.0.2",
    API_PORT: "9876",
    PORT: "4321",
  });

  assert.equal(config.host, "127.0.0.2");
  assert.equal(config.port, 9876);
});

test("configuration rejects missing secrets before the server starts", () => {
  assert.throws(
    () => createConfig({ ...baseEnvironment, CLERK_SECRET_KEY: "" }),
    (error) => error instanceof ConfigurationError && error.issues.some((issue) => issue.includes("CLERK_SECRET_KEY"))
  );
});

test("configuration rejects missing R2 credentials before the server starts", () => {
  assert.throws(
    () => createConfig({ ...baseEnvironment, R2_SECRET_ACCESS_KEY: "" }),
    (error) => error instanceof ConfigurationError && error.issues.some((issue) => issue.includes("R2_SECRET_ACCESS_KEY"))
  );
});

test("configuration allows development without a custom session-token audience", () => {
  const config = createConfig({ ...baseEnvironment, CLERK_AUDIENCE: "" });
  assert.equal(config.clerk.audience, undefined);
});

test("development configuration adds Figma and Chrome client origins for local plugin testing", () => {
  const config = createConfig({
    ...baseEnvironment,
    NODE_ENV: "development",
    CORS_ALLOWED_ORIGINS: "http://localhost:4173",
    CLERK_AUDIENCE: "",
  });

  assert.deepEqual(config.corsAllowedOrigins, [
    "http://localhost:4173",
    "null",
    "https://www.figma.com",
    "https://figma.com",
    "chrome-extension://*",
  ]);
});

test("production configuration rejects insecure origins and missing audience", () => {
  assert.throws(
    () =>
      createConfig({
        ...baseEnvironment,
        NODE_ENV: "production",
        CLERK_AUTHORIZED_PARTIES: "http://localhost:4173",
        CORS_ALLOWED_ORIGINS: "http://localhost:4173",
        CLERK_AUDIENCE: "",
      }),
    (error) => error instanceof ConfigurationError && error.issues.some((issue) => issue.includes("HTTPS"))
  );
});

test("production CORS requires a concrete published Chrome extension origin", () => {
  assert.throws(
    () =>
      createConfig({
        ...baseEnvironment,
        NODE_ENV: "production",
        CLERK_AUTHORIZED_PARTIES: "https://app.example.com",
        CORS_ALLOWED_ORIGINS: "https://app.example.com,null,chrome-extension://*",
      }),
    (error) =>
      error instanceof ConfigurationError &&
      error.issues.some((issue) => issue.includes("cannot use chrome-extension://*"))
  );
});
