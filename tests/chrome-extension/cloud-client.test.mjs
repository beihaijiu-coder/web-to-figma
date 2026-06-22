import assert from "node:assert/strict";
import test from "node:test";

import {
  WebToFigmaApiError,
  claimConversionJob,
  createDeviceConnection,
  decryptSceneCapture,
  encryptSceneCapture,
  listInstallations,
  listPendingConversionJobs,
  normalizeApiBaseUrl,
  pollDeviceConnection,
  requestJson,
  sanitizeSceneCaptureForCloud,
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

test("scene packages round-trip through authenticated AES-GCM encryption", async () => {
  const payload = {
    version: 1,
    source: { url: "https://example.com/private" },
    root: { id: "root", children: [{ type: "text", text: "private design" }] },
  };

  const encrypted = await encryptSceneCapture(payload);
  assert.equal(encrypted.algorithm, "A256GCM");
  assert.equal(encrypted.packageEncryptionKey.length, 43);
  assert.notEqual(new TextDecoder().decode(encrypted.body).includes("private design"), true);
  assert.deepEqual(await decryptSceneCapture(encrypted.body, encrypted.packageEncryptionKey), payload);
});

test("scene package tampering fails authentication instead of returning partial data", async () => {
  const encrypted = await encryptSceneCapture({ version: 1, root: { id: "root" } });
  const tampered = encrypted.body.slice();
  tampered[tampered.length - 1] ^= 1;

  await assert.rejects(
    () => decryptSceneCapture(tampered, encrypted.packageEncryptionKey),
    (error) => error instanceof WebToFigmaApiError && error.code === "SCENE_PACKAGE_DECRYPTION_FAILED"
  );
});

test("cloud scene packages remove credentials, sensitive fields, and unrelated URL parameters", async () => {
  const payload = {
    source: { url: "https://viewer:secret@example.com/private?session=abc#oauth-token" },
    assets: {
      image: {
        src: "https://cdn.example.com/image.png?X-Amz-Signature=secret#asset",
      },
    },
    root: {
      style: {
        backgroundImage: 'url("https://cdn.example.com/bg.png?signed=secret#layer")',
      },
      accessToken: "must-not-leave-the-browser",
      cookies: ["session=secret"],
      text: "Visible page content remains available for conversion.",
    },
  };

  const safe = sanitizeSceneCaptureForCloud(payload);
  assert.equal(safe.source.url, "https://example.com/private");
  assert.equal(safe.assets.image.src, "https://cdn.example.com/image.png#asset");
  assert.equal(safe.root.style.backgroundImage, 'url("https://cdn.example.com/bg.png#layer")');
  assert.equal(safe.root.accessToken, undefined);
  assert.equal(safe.root.cookies, undefined);
  assert.equal(safe.root.text, payload.root.text);

  const encrypted = await encryptSceneCapture(payload);
  assert.deepEqual(await decryptSceneCapture(encrypted.body, encrypted.packageEncryptionKey), safe);
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

test("cloud client lists and claims only the selected Figma task", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/pending")) return jsonResponse(200, { jobs: [{ id: "task-1" }] });
    return jsonResponse(200, {
      taskId: "task-1",
      download: { method: "GET", url: "/v1/conversion-jobs/task-1/package" },
      encryption: { algorithm: "A256GCM", key: "A".repeat(43) },
    });
  };

  const pending = await listPendingConversionJobs({
    baseUrl: "https://api.example.com",
    accessToken: "figma-token",
    fetchImpl,
  });
  const claim = await claimConversionJob({
    baseUrl: "https://api.example.com",
    accessToken: "figma-token",
    taskId: pending.jobs[0].id,
    fetchImpl,
  });

  assert.equal(claim.taskId, "task-1");
  assert.equal(calls[1].url, "https://api.example.com/v1/conversion-jobs/task-1/claim");
  assert.equal(calls[1].init.headers.Authorization, "Bearer figma-token");
});
