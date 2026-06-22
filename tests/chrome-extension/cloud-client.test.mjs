import assert from "node:assert/strict";
import test from "node:test";

import {
  WebToFigmaApiError,
  createDeviceConnection,
  listInstallations,
  normalizeApiBaseUrl,
  pollDeviceConnection,
  requestJson,
} from "../../chrome-extension/src/cloud-client.mjs";

function jsonResponse(status, body) {
  return {
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type" ? "application/json" : "";
      },
    },
    async json() {
      return body;
    },
  };
}

test("cloud client normalizes API base URLs to origins", () => {
  assert.equal(normalizeApiBaseUrl("http://localhost:8787/v1/me"), "http://localhost:8787");
  assert.equal(normalizeApiBaseUrl("https://api.example.com/path?x=1"), "https://api.example.com");
  assert.throws(() => normalizeApiBaseUrl("ftp://example.com"), WebToFigmaApiError);
});

test("cloud client sends JSON requests with device authorization headers", async () => {
  const calls = [];
  const response = await requestJson({
    baseUrl: "https://api.example.com",
    path: "/v1/installations?clientType=figma_plugin",
    accessToken: "w2f_at_test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, { installations: [] });
    },
  });

  assert.deepEqual(response.body, { installations: [] });
  assert.equal(calls[0].url, "https://api.example.com/v1/installations?clientType=figma_plugin");
  assert.equal(calls[0].init.headers.Authorization, "Bearer w2f_at_test");
});

test("cloud client accepts pending and slow-down device polling statuses", async () => {
  const pending = await pollDeviceConnection({
    baseUrl: "https://api.example.com",
    deviceCode: "w2f_dc_pending",
    fetchImpl: async () => jsonResponse(202, { status: "pending", interval: 5 }),
  });
  assert.deepEqual(pending, { status: 202, body: { status: "pending", interval: 5 } });
});

test("cloud client maps API error responses to stable error details", async () => {
  await assert.rejects(
    () =>
      createDeviceConnection({
        baseUrl: "https://api.example.com",
        clientType: "chrome_extension",
        requestedClientName: "Chrome",
        fetchImpl: async () =>
          jsonResponse(400, {
            error: { code: "INVALID_REQUEST", message: "Invalid device connection request" },
          }),
      }),
    (error) => {
      assert.equal(error.name, "WebToFigmaApiError");
      assert.equal(error.status, 400);
      assert.equal(error.code, "INVALID_REQUEST");
      return true;
    }
  );
});

test("cloud client lists Figma target installations for a connected device", async () => {
  const calls = [];
  const result = await listInstallations({
    baseUrl: "https://api.example.com",
    accessToken: "w2f_at_test",
    clientType: "figma_plugin",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, {
        installations: [{ id: "figma-installation", clientType: "figma_plugin" }],
      });
    },
  });

  assert.equal(calls[0].url, "https://api.example.com/v1/installations?clientType=figma_plugin");
  assert.deepEqual(result.installations, [{ id: "figma-installation", clientType: "figma_plugin" }]);
});
