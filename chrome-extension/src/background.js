import { normalizeSceneAssetsForFigma } from "./core/asset-normalizer.mjs";
import { normalizeFixedShellOverlaps } from "./core/app-shell-normalizer.mjs";
import { visibleCaptureBounds } from "./core/screenshot-geometry.mjs";
import {
  DEFAULT_API_BASE_URL,
  WebToFigmaApiError,
  createConversionJob,
  createDeviceConnection,
  encryptSceneCapture,
  getDeviceMe,
  listInstallations,
  normalizeApiBaseUrl,
  markCaptureFailed,
  pollDeviceConnection,
  refreshDeviceTokens,
  revokeOwnInstallation,
  uploadScenePackage,
} from "./cloud-client.mjs";

const WORLD = "ISOLATED";
const CAPTURE_FILE = "src/scene-capture.js";
const RUNNER_FILE = "src/runner.js";
const TOOLBAR_FILE = "src/inpage-toolbar.js";
const FIGMA_CAPTURE_CONCURRENCY_KEY = "proxyFetchConcurrency";
const FIGMA_CAPTURE_ALLOWED_CONCURRENCY = new Set([4, 6, 8, 10, 12, 16, 20]);
const FIGMA_CAPTURE_DEFAULT_CONCURRENCY = 8;
const FIGMA_CAPTURE_PROXY_SESSION_KEY = "figmaCaptureProxyAssetCacheV1";
const FIGMA_CAPTURE_PROXY_DIAG_KEY = "figmaCaptureProxyDiagnosticsV1";
const FIGMA_CAPTURE_PROXY_MAX_DIAG = 500;
const FIGMA_CAPTURE_FETCH_TIMEOUT_MS = 8000;
const FIGMA_CAPTURE_SCREENSHOT_FALLBACK_LIMIT = 12;
const WEB_TO_FIGMA_API_BASE_URL_KEY = "webToFigmaApiBaseUrl";
const WEB_TO_FIGMA_ACCESS_TOKEN_KEY = "webToFigmaAccessToken";
const WEB_TO_FIGMA_ACCESS_TOKEN_EXPIRES_AT_KEY = "webToFigmaAccessTokenExpiresAt";
const WEB_TO_FIGMA_REFRESH_TOKEN_KEY = "webToFigmaRefreshToken";
const WEB_TO_FIGMA_REFRESH_TOKEN_EXPIRES_AT_KEY = "webToFigmaRefreshTokenExpiresAt";
const WEB_TO_FIGMA_PENDING_CONNECTION_KEY = "webToFigmaPendingConnection";
const WEB_TO_FIGMA_CLIENT_TYPE = "chrome_extension";
const CLOUD_TASK_PREVIEW_MAX_WIDTH = 560;
const CLOUD_TASK_PREVIEW_MAX_HEIGHT = 320;
const CLOUD_TASK_PREVIEW_MAX_DATA_URL_LENGTH = 450_000;

const figmaProxyQueue = [];
const figmaProxyInFlight = new Map();
const figmaProxyMemCache = new Map();

let figmaProxyActive = 0;
let figmaProxyMaxConcurrency = FIGMA_CAPTURE_DEFAULT_CONCURRENCY;
let figmaProxySessionLoaded = false;
let figmaProxySessionCache = {};
let figmaProxyDiagnostics = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getCloudApiBaseUrl() {
  try {
    const data = await chrome.storage.local.get({
      [WEB_TO_FIGMA_API_BASE_URL_KEY]: DEFAULT_API_BASE_URL,
    });
    return normalizeApiBaseUrl(data?.[WEB_TO_FIGMA_API_BASE_URL_KEY]);
  } catch {
    return DEFAULT_API_BASE_URL;
  }
}

async function setCloudApiBaseUrl(rawValue) {
  const normalized = normalizeApiBaseUrl(rawValue);
  await chrome.storage.local.set({ [WEB_TO_FIGMA_API_BASE_URL_KEY]: normalized });
  return normalized;
}

async function getCloudTokens() {
  const sessionData = chrome.storage.session
    ? await chrome.storage.session.get({
        [WEB_TO_FIGMA_ACCESS_TOKEN_KEY]: null,
        [WEB_TO_FIGMA_ACCESS_TOKEN_EXPIRES_AT_KEY]: 0,
        [WEB_TO_FIGMA_REFRESH_TOKEN_KEY]: null,
        [WEB_TO_FIGMA_REFRESH_TOKEN_EXPIRES_AT_KEY]: 0,
      })
    : {};

  return {
    accessToken: sessionData?.[WEB_TO_FIGMA_ACCESS_TOKEN_KEY] || null,
    accessTokenExpiresAt: Number(sessionData?.[WEB_TO_FIGMA_ACCESS_TOKEN_EXPIRES_AT_KEY] || 0),
    refreshToken: sessionData?.[WEB_TO_FIGMA_REFRESH_TOKEN_KEY] || null,
    refreshTokenExpiresAt: Number(sessionData?.[WEB_TO_FIGMA_REFRESH_TOKEN_EXPIRES_AT_KEY] || 0),
  };
}

async function saveCloudTokens(tokens) {
  const now = Date.now();
  const accessTokenExpiresAt = now + Math.max(0, Number(tokens.expiresIn || 0)) * 1_000;
  const refreshTokenExpiresAt = now + Math.max(0, Number(tokens.refreshExpiresIn || 0)) * 1_000;

  await Promise.all([
    chrome.storage.session
      ? chrome.storage.session.set({
          [WEB_TO_FIGMA_ACCESS_TOKEN_KEY]: tokens.accessToken,
          [WEB_TO_FIGMA_ACCESS_TOKEN_EXPIRES_AT_KEY]: accessTokenExpiresAt,
          [WEB_TO_FIGMA_REFRESH_TOKEN_KEY]: tokens.refreshToken,
          [WEB_TO_FIGMA_REFRESH_TOKEN_EXPIRES_AT_KEY]: refreshTokenExpiresAt,
        })
      : Promise.resolve(),
  ]);
}

async function clearCloudTokens() {
  await (
    chrome.storage.session
      ? chrome.storage.session.remove([
          WEB_TO_FIGMA_ACCESS_TOKEN_KEY,
          WEB_TO_FIGMA_ACCESS_TOKEN_EXPIRES_AT_KEY,
          WEB_TO_FIGMA_REFRESH_TOKEN_KEY,
          WEB_TO_FIGMA_REFRESH_TOKEN_EXPIRES_AT_KEY,
          WEB_TO_FIGMA_PENDING_CONNECTION_KEY,
        ])
      : Promise.resolve()
  );
}

async function getPendingCloudConnection() {
  if (!chrome.storage.session) return null;
  const data = await chrome.storage.session.get({ [WEB_TO_FIGMA_PENDING_CONNECTION_KEY]: null });
  const pending = data?.[WEB_TO_FIGMA_PENDING_CONNECTION_KEY] || null;
  if (!pending) return null;
  if (Number(pending.expiresAt || 0) <= Date.now()) {
    await chrome.storage.session.remove([WEB_TO_FIGMA_PENDING_CONNECTION_KEY]);
    return null;
  }
  return pending;
}

async function savePendingCloudConnection(pending) {
  if (!chrome.storage.session) return;
  await chrome.storage.session.set({ [WEB_TO_FIGMA_PENDING_CONNECTION_KEY]: pending });
}

async function clearPendingCloudConnection() {
  if (!chrome.storage.session) return;
  await chrome.storage.session.remove([WEB_TO_FIGMA_PENDING_CONNECTION_KEY]);
}

async function refreshCloudAccessToken(baseUrl, refreshToken) {
  const tokens = await refreshDeviceTokens({ baseUrl, refreshToken });
  await saveCloudTokens(tokens);
  return tokens.accessToken;
}

async function getCloudAccessToken(baseUrl) {
  const tokens = await getCloudTokens();
  const now = Date.now();
  if (tokens.accessToken && tokens.accessTokenExpiresAt > now + 30_000) {
    return tokens.accessToken;
  }
  if (!tokens.refreshToken || tokens.refreshTokenExpiresAt <= now) {
    return null;
  }

  try {
    return await refreshCloudAccessToken(baseUrl, tokens.refreshToken);
  } catch {
    await clearCloudTokens();
    return null;
  }
}

async function getCloudAccountStatus() {
  const baseUrl = await getCloudApiBaseUrl();
  const accessToken = await getCloudAccessToken(baseUrl);
  const pendingConnection = await getPendingCloudConnection();
  if (!accessToken) {
    if (pendingConnection) {
      try {
        const result = await pollDeviceConnection({
          baseUrl: pendingConnection.apiBaseUrl || baseUrl,
          deviceCode: pendingConnection.deviceCode,
        });
        if (result.status === 200) {
          await saveCloudTokens(result.body);
          await clearPendingCloudConnection();
          return getCloudAccountStatus();
        }
        if (result.body?.interval) {
          pendingConnection.interval = result.body.interval;
          await savePendingCloudConnection(pendingConnection);
        }
      } catch (error) {
        if (error instanceof WebToFigmaApiError && error.status === 410) {
          await clearPendingCloudConnection();
        } else {
          throw error;
        }
      }
    }
    return { ok: true, connected: false, apiBaseUrl: baseUrl, connection: pendingConnection };
  }

  try {
    const [me, targets] = await Promise.all([
      getDeviceMe({ baseUrl, accessToken }),
      listInstallations({ baseUrl, accessToken, clientType: "figma_plugin" }),
    ]);
    return {
      ok: true,
      connected: true,
      apiBaseUrl: baseUrl,
      installation: me.installation,
      figmaInstallations: targets.installations || [],
      connection: pendingConnection,
    };
  } catch (error) {
    if (error instanceof WebToFigmaApiError && error.status === 401) {
      await clearCloudTokens();
      return { ok: true, connected: false, apiBaseUrl: baseUrl, connection: pendingConnection };
    }
    throw error;
  }
}

async function startCloudAccountConnection() {
  const baseUrl = await getCloudApiBaseUrl();
  const connection = await createDeviceConnection({
    baseUrl,
    clientType: WEB_TO_FIGMA_CLIENT_TYPE,
    requestedClientName: "Chrome extension",
  });

  await chrome.tabs.create({ url: connection.verificationUriComplete });
  await savePendingCloudConnection({
    status: "pending",
    apiBaseUrl: baseUrl,
    deviceCode: connection.deviceCode,
    userCode: connection.userCode,
    interval: connection.interval,
    expiresAt: Date.now() + Math.max(30, Number(connection.expiresIn) || 600) * 1_000,
    verificationUriComplete: connection.verificationUriComplete,
    startedAt: new Date().toISOString(),
  });

  return {
    ok: true,
    connected: false,
    status: "pending",
    apiBaseUrl: baseUrl,
    userCode: connection.userCode,
    verificationUriComplete: connection.verificationUriComplete,
  };
}

function truncateText(value, maxLength) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function sourceUrlFromPayload(payload, tab) {
  return truncateText(payload?.source?.url || payload?.url || tab?.url || "", 2048);
}

function sourceTitleFromPayload(payload, tab) {
  return truncateText(payload?.source?.title || payload?.title || tab?.title || "", 240);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${blob.type || "image/jpeg"};base64,${bytesToBase64(bytes)}`;
}

async function downscalePreviewDataUrl(dataUrl) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    return dataUrl.length <= CLOUD_TASK_PREVIEW_MAX_DATA_URL_LENGTH ? dataUrl : null;
  }

  const sourceBlob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const scale = Math.min(
      CLOUD_TASK_PREVIEW_MAX_WIDTH / Math.max(1, bitmap.width),
      CLOUD_TASK_PREVIEW_MAX_HEIGHT / Math.max(1, bitmap.height),
      1
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);

    for (const quality of [0.72, 0.58, 0.44]) {
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
      const preview = await blobToDataUrl(blob);
      if (preview.length <= CLOUD_TASK_PREVIEW_MAX_DATA_URL_LENGTH) return preview;
    }
    return null;
  } finally {
    if (typeof bitmap.close === "function") bitmap.close();
  }
}

async function downscalePreviewInPage(tabId, dataUrl) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: WORLD,
      func: (input, maxWidth, maxHeight, maxLength) =>
        new Promise((resolve) => {
          const image = new Image();
          image.onload = () => {
            try {
              const scale = Math.min(maxWidth / Math.max(1, image.naturalWidth), maxHeight / Math.max(1, image.naturalHeight), 1);
              const canvas = document.createElement("canvas");
              canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
              canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
              const context = canvas.getContext("2d");
              if (!context) {
                resolve(null);
                return;
              }
              context.drawImage(image, 0, 0, canvas.width, canvas.height);
              for (const quality of [0.72, 0.58, 0.44, 0.32, 0.22]) {
                const output = canvas.toDataURL("image/jpeg", quality);
                if (output.length <= maxLength) {
                  resolve(output);
                  return;
                }
              }
              resolve(null);
            } catch {
              resolve(null);
            }
          };
          image.onerror = () => resolve(null);
          image.src = input;
        }),
      args: [dataUrl, CLOUD_TASK_PREVIEW_MAX_WIDTH, CLOUD_TASK_PREVIEW_MAX_HEIGHT, CLOUD_TASK_PREVIEW_MAX_DATA_URL_LENGTH],
    });
    return typeof result === "string" && result.startsWith("data:image/") ? result : null;
  } catch {
    return null;
  }
}

async function captureCloudTaskPreview(tab) {
  if (!tab?.id || !tab?.windowId || !chrome.tabs.captureVisibleTab) return null;
  let ignoredUiHidden = false;
  try {
    await setIgnoredCaptureUiHidden(tab.id, true);
    ignoredUiHidden = true;
    for (const quality of [48, 34, 24, 16]) {
      const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality });
      if (raw.length <= CLOUD_TASK_PREVIEW_MAX_DATA_URL_LENGTH) return raw;
      const preview = (await downscalePreviewInPage(tab.id, raw)) || (await downscalePreviewDataUrl(raw));
      if (preview) return preview;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (ignoredUiHidden) await setIgnoredCaptureUiHidden(tab.id, false);
  }
}

async function createCloudTaskPreview(payload, tab, previewImageDataUrl = null) {
  return {
    sourceUrl: sourceUrlFromPayload(payload, tab),
    sourceTitle: sourceTitleFromPayload(payload, tab),
    previewImageDataUrl: previewImageDataUrl || (await captureCloudTaskPreview(tab)),
  };
}

async function submitCaptureToCloud(payload, targetInstallationId = null, tab = null, previewImageDataUrl = null) {
  const baseUrl = await getCloudApiBaseUrl();
  const preview = await createCloudTaskPreview(payload, tab, previewImageDataUrl);
  const accessToken = await getCloudAccessToken(baseUrl);
  if (!accessToken) {
    throw new WebToFigmaApiError("Connect the Chrome extension account before sending a cloud task", {
      status: 401,
      code: "CLOUD_ACCOUNT_REQUIRED",
    });
  }

  const encrypted = await encryptSceneCapture(payload);
  const idempotencyKey = `capture-${Date.now()}-${crypto.randomUUID()}`;
  const job = await createConversionJob({
    baseUrl,
    accessToken,
    targetInstallationId,
    preview,
    idempotencyKey,
    packageEncryptionKey: encrypted.packageEncryptionKey,
    scenePackageVersion: encrypted.version,
  });

  try {
    if (encrypted.body.byteLength > Number(job.upload?.maxBytes || 0)) {
      throw new WebToFigmaApiError("Encrypted scene package exceeds the task limit", {
        status: 413,
        code: "PACKAGE_TOO_LARGE",
      });
    }
    const uploaded = await uploadScenePackage({
      baseUrl,
      accessToken,
      upload: job.upload,
      body: encrypted.body,
    });
    return {
      taskId: job.taskId,
      status: uploaded.status,
      expiresAt: job.expiresAt,
      targetInstallationId: targetInstallationId || null,
      packageSizeBytes: encrypted.body.byteLength,
    };
  } catch (error) {
    await markCaptureFailed({ baseUrl, accessToken, taskId: job.taskId }).catch(() => undefined);
    throw error;
  }
}

async function disconnectCloudAccount() {
  const baseUrl = await getCloudApiBaseUrl();
  const accessToken = await getCloudAccessToken(baseUrl);
  if (accessToken) {
    try {
      await revokeOwnInstallation({ baseUrl, accessToken });
    } catch (error) {
      if (!(error instanceof WebToFigmaApiError) || error.status !== 401) throw error;
    }
  }
  await clearCloudTokens();
  return { ok: true, connected: false, apiBaseUrl: baseUrl, revoked: Boolean(accessToken) };
}

async function injectScriptFile(tabId, file) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: WORLD,
    files: [file],
  });
}

async function setCaptureOptions(tabId, options) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: WORLD,
    func: (captureOptions) => {
      window.__FIGMA_CAPTURE_OPTIONS__ = captureOptions || {};
    },
    args: [options || {}],
  });
}

async function readCaptureDiagnostics(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: WORLD,
      func: () => window.__FIGMA_CAPTURE_LAST_DIAGNOSTICS__ || null,
    });

    return result || null;
  } catch {
    return null;
  }
}

async function runCapture(tabId, options = {}) {
  await injectScriptFile(tabId, CAPTURE_FILE);
  await sleep(300);
  await setCaptureOptions(tabId, options);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: WORLD,
    files: [RUNNER_FILE],
  });

  return {
    result,
    diagnostics: await readCaptureDiagnostics(tabId),
  };
}

function parseResultDiagnostics(result) {
  try {
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    const assets = parsed && typeof parsed.assets === "object" ? parsed.assets : null;
    const diagnosticFailures = Array.isArray(parsed?.diagnostics?.failures)
      ? parsed.diagnostics.failures
      : [];
    const assetFailures = assets
      ? Object.values(assets).filter((asset) => asset && asset.error).length
      : 0;

    return {
      assetsDiscovered: assets ? Object.keys(assets).length : 0,
      assetFailures: diagnosticFailures.length + assetFailures,
    };
  } catch {
    return {
      assetsDiscovered: 0,
      assetFailures: 0,
    };
  }
}

function normalizeCapturePayload(result) {
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return { version: 1, root: null, raw: result };
    }
  }

  return result && typeof result === "object" ? result : null;
}

function visitSceneNodes(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) visitSceneNodes(child, visitor);
}

function assetNodeReferences(scene) {
  const references = {};
  visitSceneNodes(scene && scene.root, (node) => {
    if (node.assetId && node.rect) {
      if (!references[node.assetId]) references[node.assetId] = [];
      references[node.assetId].push({ node, rect: node.rect, role: "node" });
    }

    const backgroundAssetId = node.style && node.style.backgroundAssetId;
    if (backgroundAssetId && node.rect) {
      if (!references[backgroundAssetId]) references[backgroundAssetId] = [];
      references[backgroundAssetId].push({ node, rect: node.rect, role: "background" });
    }
  });
  return references;
}

function replaceCapturedRasterBounds(reference, rect) {
  if (!reference || reference.role !== "node" || reference.node?.kind !== "raster" || !rect) return;
  const bounds = {
    x: Number(rect.x),
    y: Number(rect.y),
    width: Number(rect.width),
    height: Number(rect.height),
  };
  reference.node.rect = bounds;
  if (reference.node.absoluteRect) reference.node.absoluteRect = { ...bounds };
  if (reference.node.design?.absoluteRect) reference.node.design.absoluteRect = { ...bounds };
}

async function scrollTabToRect(tabId, rect) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: WORLD,
      func: (targetRect) =>
        new Promise((resolve) => {
          const top = Math.max(0, Number(targetRect.y || 0) - Math.floor(window.innerHeight * 0.25));
          const left = Math.max(0, Number(targetRect.x || 0) - Math.floor(window.innerWidth * 0.1));
          window.scrollTo(left, top);
          requestAnimationFrame(() => setTimeout(resolve, 180));
        }),
      args: [rect],
    });
  } catch {
    // Screenshot fallback is best-effort only.
  }
}

async function readTabViewportMetrics(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: WORLD,
      func: () => ({
        scrollX: window.scrollX || 0,
        scrollY: window.scrollY || 0,
        innerWidth: window.innerWidth || 0,
        innerHeight: window.innerHeight || 0,
        devicePixelRatio: window.devicePixelRatio || 1,
      }),
    });
    return result || null;
  } catch {
    return null;
  }
}

async function setIgnoredCaptureUiHidden(tabId, hidden) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: WORLD,
      func: (shouldHide) => {
        const property = "__figmaCaptureScreenshotStyle";
        for (const element of Array.from(document.querySelectorAll("[data-figma-capture-ignore='1']"))) {
          if (!element.style) continue;

          if (shouldHide) {
            if (!element[property]) {
              element[property] = {
                display: element.style.display,
                visibility: element.style.visibility,
                pointerEvents: element.style.pointerEvents,
              };
            }
            element.style.display = "none";
            element.style.visibility = "hidden";
            element.style.pointerEvents = "none";
            continue;
          }

          const original = element[property];
          if (!original) continue;
          element.style.display = original.display;
          element.style.visibility = original.visibility;
          element.style.pointerEvents = original.pointerEvents;
          delete element[property];
        }
      },
      args: [Boolean(hidden)],
    });
  } catch {
    // The fallback stays best-effort when the page cannot be scripted.
  }
}

async function cropCapturedDataUrl(dataUrl, rect, metrics) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    return null;
  }

  const response = await fetch(dataUrl);
  const bitmap = await createImageBitmap(await response.blob());
  const dpr = Number(metrics.devicePixelRatio) || 1;
  const captureBounds = visibleCaptureBounds(rect, {
    scrollX: metrics.scrollX,
    scrollY: metrics.scrollY,
    innerWidth: Math.min(Number(metrics.innerWidth || 0), bitmap.width / dpr),
    innerHeight: Math.min(Number(metrics.innerHeight || 0), bitmap.height / dpr),
  });
  if (!captureBounds) return null;

  const sx = Math.max(0, Math.round((captureBounds.x - Number(metrics.scrollX || 0)) * dpr));
  const sy = Math.max(0, Math.round((captureBounds.y - Number(metrics.scrollY || 0)) * dpr));
  const sw = Math.min(bitmap.width - sx, Math.round(captureBounds.width * dpr));
  const sh = Math.min(bitmap.height - sy, Math.round(captureBounds.height * dpr));

  if (sw <= 0 || sh <= 0) return null;

  const canvas = new OffscreenCanvas(sw, sh);
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return {
    contentType: "image/png",
    base64: toBase64(await blob.arrayBuffer()),
    rect: {
      x: captureBounds.x,
      y: captureBounds.y,
      width: sw / dpr,
      height: sh / dpr,
    },
  };
}

async function hydrateFailedAssetsFromScreenshots(scene, tab) {
  const tabId = tab && tab.id;
  if (!tabId || !chrome.tabs.captureVisibleTab) return;
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return;

  const assets = scene && typeof scene.assets === "object" ? scene.assets : null;
  if (!assets) return;

  const referencesByAssetId = assetNodeReferences(scene);
  const failedAssetIds = Object.entries(assets)
    .filter(([, asset]) => asset && asset.error && !asset.base64 && !asset.data)
    .map(([assetId]) => assetId)
    .slice(0, FIGMA_CAPTURE_SCREENSHOT_FALLBACK_LIMIT);

  for (const assetId of failedAssetIds) {
    const reference = (referencesByAssetId[assetId] || [])[0];
    const rect = reference && reference.rect;
    if (!rect) continue;

    let ignoredUiHidden = false;
    try {
      await setIgnoredCaptureUiHidden(tabId, true);
      ignoredUiHidden = true;
      await scrollTabToRect(tabId, rect);
      const metrics = await readTabViewportMetrics(tabId);
      if (!metrics) continue;

      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      const cropped = await cropCapturedDataUrl(dataUrl, rect, metrics);
      if (!cropped) continue;

      assets[assetId].base64 = cropped.base64;
      assets[assetId].contentType = cropped.contentType;
      assets[assetId].fallback = "visible-tab-screenshot";
      assets[assetId].captureRect = cropped.rect;
      replaceCapturedRasterBounds(reference, cropped.rect);
      delete assets[assetId].error;
      pushDiag({
        url: assets[assetId].src || assetId,
        phase: "screenshot-fallback",
        ok: true,
        status: 200,
      });
    } catch (error) {
      pushDiag({
        url: assets[assetId].src || assetId,
        phase: "screenshot-fallback",
        ok: false,
        status: 0,
        error: String(error),
      });
    } finally {
      if (ignoredUiHidden) await setIgnoredCaptureUiHidden(tabId, false);
    }
  }
}

async function hydrateSceneAssets(scene, tab) {
  const assets = scene && typeof scene.assets === "object" ? scene.assets : null;
  if (!assets) return scene;

  await loadProxySession();
  await Promise.all(
    Object.values(assets).map(async (asset) => {
      if (!asset || asset.base64 || asset.data || !asset.src) return;
      const fetched = await proxyFetchAsset(asset.src);
      if (fetched?.ok && fetched.base64) {
        asset.base64 = fetched.base64;
        asset.contentType = fetched.contentType || asset.contentType || "application/octet-stream";
      } else {
        asset.error = fetched?.error || "ASSET_FETCH_FAILED";
      }
    })
  );
  await hydrateFailedAssetsFromScreenshots(scene, tab);
  normalizeFixedShellOverlaps(scene);
  await normalizeSceneAssetsForFigma(scene, {
    onDiagnostic(entry) {
      pushDiag({
        ...entry,
        url: entry.src || entry.assetId || "embedded-image",
      });
    },
  });

  return scene;
}

function normalizeConcurrency(value) {
  if (value === "infinite" || value === "∞") {
    return Number.POSITIVE_INFINITY;
  }

  const numeric = Number(value);
  if (FIGMA_CAPTURE_ALLOWED_CONCURRENCY.has(numeric)) {
    return numeric;
  }

  return FIGMA_CAPTURE_DEFAULT_CONCURRENCY;
}

function concurrencyLabel() {
  return Number.isFinite(figmaProxyMaxConcurrency) ? String(figmaProxyMaxConcurrency) : "infinite";
}

function normalizeProxyUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

async function loadConcurrencyConfig() {
  try {
    const data = await chrome.storage.local.get({
      [FIGMA_CAPTURE_CONCURRENCY_KEY]: String(FIGMA_CAPTURE_DEFAULT_CONCURRENCY),
    });

    figmaProxyMaxConcurrency = normalizeConcurrency(data?.[FIGMA_CAPTURE_CONCURRENCY_KEY]);
  } catch {
    figmaProxyMaxConcurrency = FIGMA_CAPTURE_DEFAULT_CONCURRENCY;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes || !changes[FIGMA_CAPTURE_CONCURRENCY_KEY]) {
    return;
  }

  figmaProxyMaxConcurrency = normalizeConcurrency(
    changes[FIGMA_CAPTURE_CONCURRENCY_KEY].newValue
  );
  pumpProxyQueue();
});

function pushDiag(entry) {
  figmaProxyDiagnostics.push({ ts: Date.now(), ...entry });

  if (figmaProxyDiagnostics.length > FIGMA_CAPTURE_PROXY_MAX_DIAG) {
    figmaProxyDiagnostics = figmaProxyDiagnostics.slice(-FIGMA_CAPTURE_PROXY_MAX_DIAG);
  }

  if (chrome?.storage?.session) {
    chrome.storage.session
      .set({ [FIGMA_CAPTURE_PROXY_DIAG_KEY]: figmaProxyDiagnostics })
      .catch(() => {});
  }
}

async function loadProxySession() {
  if (figmaProxySessionLoaded) return;

  figmaProxySessionLoaded = true;
  if (!chrome?.storage?.session) return;

  try {
    const data = await chrome.storage.session.get({
      [FIGMA_CAPTURE_PROXY_SESSION_KEY]: {},
      [FIGMA_CAPTURE_PROXY_DIAG_KEY]: [],
    });

    figmaProxySessionCache = data?.[FIGMA_CAPTURE_PROXY_SESSION_KEY] || {};
    figmaProxyDiagnostics = Array.isArray(data?.[FIGMA_CAPTURE_PROXY_DIAG_KEY])
      ? data[FIGMA_CAPTURE_PROXY_DIAG_KEY]
      : [];
  } catch {
    figmaProxySessionCache = {};
    figmaProxyDiagnostics = [];
  }
}

async function persistProxySession() {
  if (!chrome?.storage?.session) return;

  try {
    await chrome.storage.session.set({
      [FIGMA_CAPTURE_PROXY_SESSION_KEY]: figmaProxySessionCache,
      [FIGMA_CAPTURE_PROXY_DIAG_KEY]: figmaProxyDiagnostics,
    });
  } catch {
    // Session cache is best-effort only.
  }
}

function enqueueProxyTask(task) {
  return new Promise((resolve, reject) => {
    figmaProxyQueue.push({ task, resolve, reject });
    pumpProxyQueue();
  });
}

function pumpProxyQueue() {
  while (figmaProxyActive < figmaProxyMaxConcurrency && figmaProxyQueue.length) {
    const item = figmaProxyQueue.shift();

    figmaProxyActive++;
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        figmaProxyActive--;
        pumpProxyQueue();
      });
  }
}

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunk = 32768;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return btoa(binary);
}

async function proxyFetchAsset(rawUrl) {
  const url = normalizeProxyUrl(rawUrl);

  if (!url) {
    return { ok: false, status: 0, error: "UNSUPPORTED_URL_SCHEME" };
  }

  await loadProxySession();

  const fromMemory = figmaProxyMemCache.get(url);
  if (fromMemory) {
    pushDiag({ url, phase: "proxy-cache-memory", ok: true, status: 200 });
    return { ok: true, status: 200, cacheHit: "memory", ...fromMemory };
  }

  const fromSession = figmaProxySessionCache[url];
  if (fromSession) {
    figmaProxyMemCache.set(url, fromSession);
    pushDiag({ url, phase: "proxy-cache-session", ok: true, status: 200 });
    return { ok: true, status: 200, cacheHit: "session", ...fromSession };
  }

  if (figmaProxyInFlight.has(url)) {
    return figmaProxyInFlight.get(url);
  }

  const promise = enqueueProxyTask(async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FIGMA_CAPTURE_FETCH_TIMEOUT_MS);
      let response;

      try {
        response = await fetch(url, {
          credentials: "include",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        pushDiag({
          url,
          phase: "proxy-fetch",
          ok: false,
          status: response.status,
          error: `HTTP_${response.status}`,
        });
        return { ok: false, status: response.status, error: `HTTP_${response.status}` };
      }

      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const base64 = toBase64(await response.arrayBuffer());
      const payload = { contentType, base64 };

      figmaProxyMemCache.set(url, payload);
      figmaProxySessionCache[url] = payload;
      persistProxySession();

      pushDiag({
        url,
        phase: "proxy-fetch",
        ok: true,
        status: response.status,
        bytes: base64.length,
      });

      return {
        ok: true,
        status: response.status,
        contentType,
        base64,
        cacheHit: "miss",
      };
    } catch (error) {
      const message = String(error);
      pushDiag({ url, phase: "proxy-fetch", ok: false, status: 0, error: message });
      return { ok: false, status: 0, error: message };
    }
  }).finally(() => {
    figmaProxyInFlight.delete(url);
  });

  figmaProxyInFlight.set(url, promise);
  return promise;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  try {
    await injectScriptFile(tab.id, TOOLBAR_FILE);
  } catch (error) {
    console.error("Toolbar inject failed:", error);
  }
});

function isCapturableTab(tab) {
  return Boolean(tab?.id && /^https?:\/\//i.test(tab.url || ""));
}

function captureAccessErrorMessage(error) {
  const message = String(error?.message || error || "");
  if (/Cannot access contents of the page|Extension manifest must request permission/i.test(message)) {
    return "无法访问当前标签页。请确认 Chrome 扩展已重新加载，并在普通 http/https 网页上发起采集。";
  }
  return message || "采集失败";
}

async function resolveCaptureTab(msg, sender) {
  const requestedTabId = Number(msg?.sourceTabId || 0);
  if (Number.isInteger(requestedTabId) && requestedTabId > 0) {
    try {
      const tab = await chrome.tabs.get(requestedTabId);
      if (isCapturableTab(tab)) return tab;
    } catch {
      // Fall through to the sender/active tab checks below.
    }
  }

  if (isCapturableTab(sender?.tab)) return sender.tab;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (isCapturableTab(tab)) return tab;

  throw new Error("无法采集扩展页、设置页或浏览器内部页面。请切回要采集的网页，再打开 Web to Figma 浮窗采集。");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !String(msg.type || "").startsWith("WEB_TO_FIGMA_CLOUD_")) return;

  (async () => {
    try {
      if (msg.type === "WEB_TO_FIGMA_CLOUD_SET_API_BASE_URL") {
        const apiBaseUrl = await setCloudApiBaseUrl(msg.apiBaseUrl);
        sendResponse({ ok: true, apiBaseUrl });
        return;
      }

      if (msg.type === "WEB_TO_FIGMA_CLOUD_STATUS") {
        sendResponse(await getCloudAccountStatus());
        return;
      }

      if (msg.type === "WEB_TO_FIGMA_CLOUD_CONNECT") {
        sendResponse(await startCloudAccountConnection());
        return;
      }

      if (msg.type === "WEB_TO_FIGMA_CLOUD_OPEN_SETTINGS") {
        const params = new URLSearchParams();
        if (isCapturableTab(sender?.tab)) params.set("sourceTabId", String(sender.tab.id));
        const query = params.toString();
        await chrome.tabs.create({ url: chrome.runtime.getURL(`popup/popup.html${query ? `?${query}` : ""}`) });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "WEB_TO_FIGMA_CLOUD_DISCONNECT") {
        sendResponse(await disconnectCloudAccount());
        return;
      }

      sendResponse({ ok: false, error: "Unknown cloud command" });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error?.message || String(error),
        code: error?.code || "REQUEST_FAILED",
        status: error?.status || 0,
      });
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "FIGMA_CAPTURE_START") return;

  (async () => {
    try {
      await loadProxySession();
      const proxyDiagStart = figmaProxyDiagnostics.length;
      const tab = await resolveCaptureTab(msg, sender);
      const previewImageDataUrl = await captureCloudTaskPreview(tab);

      const { result, diagnostics } = await runCapture(tab.id, msg.options || {});
      const payload = await hydrateSceneAssets(normalizeCapturePayload(result), tab);
      if (!payload) {
        throw new Error("Capture returned empty result");
      }

      const proxyEntries = figmaProxyDiagnostics.slice(proxyDiagStart);
      let handoff = null;
      let handoffError = null;
      let canUploadToCloud = false;
      try {
        canUploadToCloud = Boolean(await getCloudAccessToken(await getCloudApiBaseUrl()));
      } catch (error) {
        handoffError = {
          message: error?.message || String(error),
          code: error?.code || "CLOUD_STATUS_FAILED",
          status: error?.status || 0,
        };
      }
      if (canUploadToCloud) {
        try {
          handoff = await submitCaptureToCloud(payload, msg.targetInstallationId || null, tab, previewImageDataUrl);
        } catch (error) {
          handoffError = {
            message: error?.message || String(error),
            code: error?.code || "CLOUD_HANDOFF_FAILED",
            status: error?.status || 0,
          };
        }
      }
      sendResponse({
        ok: true,
        payload: handoff ? undefined : payload,
        handoff,
        handoffError,
        contentFlow: payload?.capture?.contentFlow || null,
        diagnostics: {
          preparation: diagnostics,
          payload: parseResultDiagnostics(payload),
          proxy: {
            requests: proxyEntries.length,
            successes: proxyEntries.filter((x) => x && x.ok === true).length,
            failures: proxyEntries.filter((x) => x && x.ok === false).length,
          },
        },
      });
    } catch (error) {
      console.error("Capture failed:", error);
      sendResponse({ ok: false, error: captureAccessErrorMessage(error) });
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "FIGMA_CAPTURE_FETCH_ASSET" || !msg.url) return;

  (async () => {
    const result = await proxyFetchAsset(msg.url);
    sendResponse({
      ...result,
      diagnostics: {
        phase: "proxy",
        cacheHit: result.cacheHit || null,
        queueDepth: figmaProxyQueue.length,
        activeRequests: figmaProxyActive,
        maxConcurrency: concurrencyLabel(),
      },
    });
  })();

  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "FIGMA_CAPTURE_GET_DIAGNOSTICS") return;

  (async () => {
    await loadProxySession();
    sendResponse({
      ok: true,
      diagnostics: {
        generatedAt: new Date().toISOString(),
        queueDepth: figmaProxyQueue.length,
        activeRequests: figmaProxyActive,
        inFlight: figmaProxyInFlight.size,
        maxConcurrency: concurrencyLabel(),
        failures: figmaProxyDiagnostics.filter((x) => x && x.ok === false),
      },
    });
  })();

  return true;
});

loadConcurrencyConfig();
