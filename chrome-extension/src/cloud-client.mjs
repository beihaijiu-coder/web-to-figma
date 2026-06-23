export const DEFAULT_API_BASE_URL = "http://localhost:8787";
export const SCENE_PACKAGE_VERSION = 1;

const SCENE_PACKAGE_MAGIC = new Uint8Array([0x57, 0x32, 0x46, 0x31]);
const SCENE_PACKAGE_IV_BYTES = 12;
const SENSITIVE_SCENE_FIELD_NAMES = new Set([
  "accesstoken",
  "authorization",
  "cookie",
  "cookies",
  "password",
  "refreshtoken",
  "session",
  "sessiondata",
  "sessionstorage",
  "sessiontoken",
]);
const URL_SCENE_FIELD_NAMES = new Set(["currentsrc", "href", "poster", "rawhref", "src", "url"]);

export class WebToFigmaApiError extends Error {
  constructor(message, { status = 0, code = "REQUEST_FAILED", body = null } = {}) {
    super(message);
    this.name = "WebToFigmaApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function normalizeApiBaseUrl(rawValue, fallback = DEFAULT_API_BASE_URL) {
  const value = String(rawValue || "").trim() || fallback;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebToFigmaApiError("API URL must start with http:// or https://", {
      code: "INVALID_API_URL",
    });
  }
  return url.origin;
}

export function apiUrl(baseUrl, path) {
  return new URL(path, `${normalizeApiBaseUrl(baseUrl)}/`).toString();
}

function bytesFrom(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new WebToFigmaApiError("Expected binary scene package data", { code: "INVALID_SCENE_PACKAGE" });
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function scenePackageHeader(iv) {
  const header = new Uint8Array(SCENE_PACKAGE_MAGIC.length + SCENE_PACKAGE_IV_BYTES);
  header.set(SCENE_PACKAGE_MAGIC, 0);
  header.set(iv, SCENE_PACKAGE_MAGIC.length);
  return header;
}

function sanitizeWebUrl(rawValue, { removeHash = false } = {}) {
  const value = String(rawValue || "");
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return value;
    url.username = "";
    url.password = "";
    url.search = "";
    if (removeHash) url.hash = "";
    return url.toString();
  } catch {
    const hashIndex = value.indexOf("#");
    const queryIndex = value.indexOf("?");
    if (queryIndex < 0) return removeHash && hashIndex >= 0 ? value.slice(0, hashIndex) : value;
    const suffix = !removeHash && hashIndex > queryIndex ? value.slice(hashIndex) : "";
    return `${value.slice(0, queryIndex)}${suffix}`;
  }
}

function sanitizeEmbeddedWebUrls(value) {
  return String(value || "").replace(/https?:\/\/[^\s"'<>\\)]+/gi, (match) => sanitizeWebUrl(match));
}

export function sanitizeSceneCaptureForCloud(payload) {
  function sanitize(value, path = []) {
    if (Array.isArray(value)) return value.map((item, index) => sanitize(item, [...path, String(index)]));
    if (!value || typeof value !== "object") {
      if (typeof value !== "string") return value;
      const fieldName = String(path.at(-1) || "").toLowerCase();
      const isPageSourceUrl = path.length === 2 && path[0] === "source" && fieldName === "url";
      if (URL_SCENE_FIELD_NAMES.has(fieldName)) {
        return sanitizeWebUrl(value, { removeHash: isPageSourceUrl });
      }
      return sanitizeEmbeddedWebUrls(value);
    }

    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_SCENE_FIELD_NAMES.has(key.toLowerCase())) continue;
      result[key] = sanitize(child, [...path, key]);
    }
    return result;
  }

  return sanitize(payload);
}

export async function encryptSceneCapture(payload, { cryptoImpl = globalThis.crypto } = {}) {
  if (!cryptoImpl?.subtle || !cryptoImpl.getRandomValues) {
    throw new WebToFigmaApiError("Web Crypto is unavailable", { code: "CRYPTO_UNAVAILABLE" });
  }

  const rawKey = cryptoImpl.getRandomValues(new Uint8Array(32));
  const iv = cryptoImpl.getRandomValues(new Uint8Array(SCENE_PACKAGE_IV_BYTES));
  const key = await cryptoImpl.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const safePayload = sanitizeSceneCaptureForCloud(payload);
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ source: "web-to-figma", type: "capture-scene", payload: safePayload })
  );
  const ciphertext = new Uint8Array(
    await cryptoImpl.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: SCENE_PACKAGE_MAGIC, tagLength: 128 },
      key,
      plaintext
    )
  );
  const header = scenePackageHeader(iv);
  const body = new Uint8Array(header.length + ciphertext.length);
  body.set(header, 0);
  body.set(ciphertext, header.length);

  return {
    body,
    packageEncryptionKey: encodeBase64Url(rawKey),
    algorithm: "A256GCM",
    version: SCENE_PACKAGE_VERSION,
  };
}

export async function decryptSceneCapture(
  encryptedBody,
  packageEncryptionKey,
  { cryptoImpl = globalThis.crypto } = {}
) {
  if (!cryptoImpl?.subtle) {
    throw new WebToFigmaApiError("Web Crypto is unavailable", { code: "CRYPTO_UNAVAILABLE" });
  }
  const body = bytesFrom(encryptedBody);
  const minimumLength = SCENE_PACKAGE_MAGIC.length + SCENE_PACKAGE_IV_BYTES + 16;
  if (body.length < minimumLength) {
    throw new WebToFigmaApiError("Scene package is truncated", { code: "INVALID_SCENE_PACKAGE" });
  }
  for (let index = 0; index < SCENE_PACKAGE_MAGIC.length; index += 1) {
    if (body[index] !== SCENE_PACKAGE_MAGIC[index]) {
      throw new WebToFigmaApiError("Scene package format is not supported", { code: "INVALID_SCENE_PACKAGE" });
    }
  }

  const rawKey = decodeBase64Url(packageEncryptionKey);
  if (rawKey.length !== 32) {
    throw new WebToFigmaApiError("Scene package key is invalid", { code: "INVALID_SCENE_PACKAGE_KEY" });
  }
  const iv = body.slice(SCENE_PACKAGE_MAGIC.length, SCENE_PACKAGE_MAGIC.length + SCENE_PACKAGE_IV_BYTES);
  const ciphertext = body.slice(SCENE_PACKAGE_MAGIC.length + SCENE_PACKAGE_IV_BYTES);

  try {
    const key = await cryptoImpl.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    const plaintext = await cryptoImpl.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: SCENE_PACKAGE_MAGIC, tagLength: 128 },
      key,
      ciphertext
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext));
    if (parsed?.source !== "web-to-figma" || parsed?.type !== "capture-scene" || !parsed.payload) {
      throw new Error("Unexpected scene package payload");
    }
    return parsed.payload;
  } catch (error) {
    if (error instanceof WebToFigmaApiError) throw error;
    throw new WebToFigmaApiError("Scene package authentication or decoding failed", {
      code: "SCENE_PACKAGE_DECRYPTION_FAILED",
    });
  }
}

export async function sha256Hex(value, { cryptoImpl = globalThis.crypto } = {}) {
  if (!cryptoImpl?.subtle) {
    throw new WebToFigmaApiError("Web Crypto is unavailable", { code: "CRYPTO_UNAVAILABLE" });
  }
  const digest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", bytesFrom(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function parseResponseBody(response) {
  const contentType = response.headers?.get?.("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  try {
    return await response.text();
  } catch {
    return null;
  }
}

function errorFromResponse(response, body) {
  const code = body && typeof body === "object" && body.error?.code ? body.error.code : `HTTP_${response.status}`;
  const message =
    body && typeof body === "object" && body.error?.message
      ? body.error.message
      : `Web to Figma API request failed with HTTP ${response.status}`;
  return new WebToFigmaApiError(message, { status: response.status, code, body });
}

export async function requestJson({
  baseUrl,
  path,
  method = "GET",
  accessToken,
  idempotencyKey,
  body,
  acceptedStatuses = [200],
  fetchImpl = fetch,
}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const response = await fetchImpl(apiUrl(baseUrl, path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await parseResponseBody(response);
  if (!acceptedStatuses.includes(response.status)) throw errorFromResponse(response, parsed);
  return { status: response.status, body: parsed };
}

export async function requestBytes({
  baseUrl,
  path,
  method = "GET",
  accessToken,
  body,
  contentType = "application/octet-stream",
  acceptedStatuses = [200],
  fetchImpl = fetch,
}) {
  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (body !== undefined) headers["Content-Type"] = contentType;

  const response = await fetchImpl(apiUrl(baseUrl, path), {
    method,
    headers,
    body,
  });
  if (!acceptedStatuses.includes(response.status)) {
    throw errorFromResponse(response, await parseResponseBody(response));
  }
  return response;
}

export async function createDeviceConnection({ baseUrl, clientType, requestedClientName, fetchImpl }) {
  const { body } = await requestJson({
    baseUrl,
    path: "/v1/device-connections",
    method: "POST",
    body: { clientType, requestedClientName },
    acceptedStatuses: [201],
    fetchImpl,
  });
  return body;
}

export async function pollDeviceConnection({ baseUrl, deviceCode, fetchImpl }) {
  const { status, body } = await requestJson({
    baseUrl,
    path: "/v1/device-connections/token",
    method: "POST",
    body: { deviceCode },
    acceptedStatuses: [200, 202, 429],
    fetchImpl,
  });
  return { status, body };
}

export async function refreshDeviceTokens({ baseUrl, refreshToken, fetchImpl }) {
  const { body } = await requestJson({
    baseUrl,
    path: "/v1/tokens/refresh",
    method: "POST",
    body: { refreshToken },
    fetchImpl,
  });
  return body;
}

export async function getDeviceMe({ baseUrl, accessToken, fetchImpl }) {
  const { body } = await requestJson({
    baseUrl,
    path: "/v1/device/me",
    accessToken,
    fetchImpl,
  });
  return body;
}

export async function revokeOwnInstallation({ baseUrl, accessToken, fetchImpl }) {
  const { body } = await requestJson({
    baseUrl,
    path: "/v1/device/me",
    method: "DELETE",
    accessToken,
    fetchImpl,
  });
  return body;
}

export async function listInstallations({ baseUrl, accessToken, clientType, fetchImpl }) {
  const query = clientType ? `?clientType=${encodeURIComponent(clientType)}` : "";
  const { body } = await requestJson({
    baseUrl,
    path: `/v1/installations${query}`,
    accessToken,
    fetchImpl,
  });
  return body;
}

export async function createConversionJob({
  baseUrl,
  accessToken,
  targetInstallationId,
  preview,
  idempotencyKey,
  packageEncryptionKey,
  scenePackageVersion = 1,
  fetchImpl,
}) {
  const requestBody = { scenePackageVersion, packageEncryptionKey };
  if (targetInstallationId) requestBody.targetInstallationId = targetInstallationId;
  if (preview) requestBody.preview = preview;
  const { body } = await requestJson({
    baseUrl,
    path: "/v1/conversion-jobs",
    method: "POST",
    accessToken,
    idempotencyKey,
    body: requestBody,
    acceptedStatuses: [201],
    fetchImpl,
  });
  return body;
}

export async function uploadScenePackage({ baseUrl, accessToken, upload, body, fetchImpl }) {
  const response = await requestBytes({
    baseUrl,
    path: upload.url,
    method: upload.method || "PUT",
    accessToken,
    body,
    contentType: upload.contentType || "application/octet-stream",
    fetchImpl,
  });
  return response.json();
}

export async function markCaptureFailed({ baseUrl, accessToken, taskId, fetchImpl }) {
  const { body } = await requestJson({
    baseUrl,
    path: `/v1/conversion-jobs/${encodeURIComponent(taskId)}/capture-failed`,
    method: "POST",
    accessToken,
    fetchImpl,
  });
  return body;
}

export async function listPendingConversionJobs({ baseUrl, accessToken, fetchImpl }) {
  const { body } = await requestJson({
    baseUrl,
    path: "/v1/conversion-jobs/pending",
    accessToken,
    fetchImpl,
  });
  return body;
}

export async function claimConversionJob({ baseUrl, accessToken, taskId, fetchImpl }) {
  const { body } = await requestJson({
    baseUrl,
    path: `/v1/conversion-jobs/${encodeURIComponent(taskId)}/claim`,
    method: "POST",
    accessToken,
    fetchImpl,
  });
  return body;
}

export async function downloadScenePackage({ baseUrl, accessToken, download, fetchImpl }) {
  const response = await requestBytes({
    baseUrl,
    path: download.url,
    method: download.method || "GET",
    accessToken,
    fetchImpl,
  });
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    packageSha256: response.headers?.get?.("x-scene-package-sha256") || null,
  };
}

export async function markConversionImported({ baseUrl, accessToken, taskId, fetchImpl }) {
  const { body } = await requestJson({
    baseUrl,
    path: `/v1/conversion-jobs/${encodeURIComponent(taskId)}/imported`,
    method: "POST",
    accessToken,
    fetchImpl,
  });
  return body;
}

export async function markConversionFailed({ baseUrl, accessToken, taskId, cancelled = false, fetchImpl }) {
  const terminalPath = cancelled ? "cancelled" : "failed";
  const { body } = await requestJson({
    baseUrl,
    path: `/v1/conversion-jobs/${encodeURIComponent(taskId)}/${terminalPath}`,
    method: "POST",
    accessToken,
    fetchImpl,
  });
  return body;
}
