const WORLD = "ISOLATED";
const CAPTURE_FILE = "capture.js";
const RUNNER_FILE = "runner.js";
const TOOLBAR_FILE = "inpage-toolbar.js";
const FIGMA_CAPTURE_CONCURRENCY_KEY = "proxyFetchConcurrency";
const FIGMA_CAPTURE_ALLOWED_CONCURRENCY = new Set([4, 6, 8, 10, 12, 16, 20]);
const FIGMA_CAPTURE_DEFAULT_CONCURRENCY = 8;
const FIGMA_CAPTURE_PROXY_SESSION_KEY = "figmaCaptureProxyAssetCacheV1";
const FIGMA_CAPTURE_PROXY_DIAG_KEY = "figmaCaptureProxyDiagnosticsV1";
const FIGMA_CAPTURE_PROXY_MAX_DIAG = 500;
const FIGMA_CAPTURE_FETCH_TIMEOUT_MS = 8000;

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

function saveResult(result) {
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const filename = `figma-capture-${Date.now()}.json`;

  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  });
}

function parseResultDiagnostics(result) {
  try {
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    const assets = parsed && typeof parsed.assets === "object" ? parsed.assets : null;
    const failures = Array.isArray(parsed?.diagnostics?.failures)
      ? parsed.diagnostics.failures
      : [];

    return {
      assetsDiscovered: assets ? Object.keys(assets).length : 0,
      assetFailures: failures.length,
    };
  } catch {
    return {
      assetsDiscovered: 0,
      assetFailures: 0,
    };
  }
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
          credentials: "omit",
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "FIGMA_CAPTURE_START") return;

  (async () => {
    try {
      await loadProxySession();
      const proxyDiagStart = figmaProxyDiagnostics.length;
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];

      if (!tab?.id) {
        throw new Error("No active tab to capture");
      }

      const { result, diagnostics } = await runCapture(tab.id, msg.options || {});
      if (!result) {
        throw new Error("Capture returned empty result");
      }

      saveResult(result);
      const proxyEntries = figmaProxyDiagnostics.slice(proxyDiagStart);
      sendResponse({
        ok: true,
        diagnostics: {
          preparation: diagnostics,
          payload: parseResultDiagnostics(result),
          proxy: {
            requests: proxyEntries.length,
            successes: proxyEntries.filter((x) => x && x.ok === true).length,
            failures: proxyEntries.filter((x) => x && x.ok === false).length,
          },
        },
      });
    } catch (error) {
      console.error("Capture failed:", error);
      sendResponse({ ok: false, error: String(error) });
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
