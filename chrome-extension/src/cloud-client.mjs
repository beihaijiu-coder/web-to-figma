export const DEFAULT_API_BASE_URL = "http://localhost:8787";

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
  idempotencyKey,
  scenePackageVersion = 1,
  fetchImpl,
}) {
  const { body } = await requestJson({
    baseUrl,
    path: "/v1/conversion-jobs",
    method: "POST",
    accessToken,
    idempotencyKey,
    body: { targetInstallationId, scenePackageVersion },
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
