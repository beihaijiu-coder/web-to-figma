const STORAGE_KEY = "enableAssetProxyFetch";
const CONCURRENCY_KEY = "proxyFetchConcurrency";
const DEFAULT_CONCURRENCY = "8";
const TARGET_INSTALLATION_KEY = "webToFigmaTargetInstallationId";
const ALLOWED_CONCURRENCY = new Set(["4", "6", "8", "10", "12", "16", "20", "infinite"]);
const DEFAULT_API_BASE_URL = "https://web-to-figmaapi-production.up.railway.app";
const LEGACY_LOCAL_API_ORIGINS = new Set(["http://localhost:8787", "http://127.0.0.1:8787"]);

const toggle = document.getElementById("assetProxyToggle");
const concurrency = document.getElementById("proxyConcurrency");
const captureBtn = document.getElementById("captureBtn");
const status = document.getElementById("status");
const apiBaseUrl = document.getElementById("apiBaseUrl");
const connectAccountBtn = document.getElementById("connectAccountBtn");
const disconnectAccountBtn = document.getElementById("disconnectAccountBtn");
const cloudStatus = document.getElementById("cloudStatus");
const figmaTarget = document.getElementById("figmaTarget");
const sourceTabId = Number(new URLSearchParams(window.location.search).get("sourceTabId") || 0);
let pendingCopyPayload = null;
let cloudBusy = false;

function setStatus(text) {
  status.textContent = text || "";
}

function setCloudStatus(text) {
  cloudStatus.textContent = text || "";
}

function setBusy(busy) {
  captureBtn.disabled = busy;
  captureBtn.textContent = busy ? "转换中..." : pendingCopyPayload ? "复制结果" : "捕获当前网页";
}

function setCloudBusy(busy) {
  cloudBusy = busy;
  connectAccountBtn.disabled = busy;
  disconnectAccountBtn.disabled = busy;
}

function migratedApiBaseUrl(rawValue) {
  try {
    const origin = new URL(String(rawValue || DEFAULT_API_BASE_URL).trim()).origin;
    return LEGACY_LOCAL_API_ORIGINS.has(origin) ? DEFAULT_API_BASE_URL : origin;
  } catch {
    return DEFAULT_API_BASE_URL;
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

async function copyPayloadForFigma(payload) {
  const text = JSON.stringify({
    source: "web-to-figma",
    type: "capture-scene",
    payload,
  });

  await navigator.clipboard.writeText(text);
}

function normalizeConcurrency(value) {
  const str = String(value ?? "");
  return ALLOWED_CONCURRENCY.has(str) ? str : DEFAULT_CONCURRENCY;
}

function renderFigmaTargets(installations, selectedId = figmaTarget.value) {
  const targets = Array.isArray(installations) ? installations : [];
  figmaTarget.replaceChildren(new Option("账号任务队列（推荐）", ""));
  for (const [index, installation] of targets.entries()) {
    const label = installation.displayName || `定向到 Figma 插件 ${index + 1}`;
    figmaTarget.append(new Option(label, installation.id));
  }
  if (targets.some((installation) => installation.id === selectedId)) {
    figmaTarget.value = selectedId;
  }
  chrome.storage.local.set({ [TARGET_INSTALLATION_KEY]: figmaTarget.value });
}

async function refreshCloudStatus() {
  if (cloudBusy) return;
  try {
    const res = await sendRuntimeMessage({ type: "WEB_TO_FIGMA_CLOUD_STATUS" });
    if (!res || !res.ok) {
      setCloudStatus(`连接状态读取失败：${(res && res.error) || "未知错误"}`);
      return;
    }

    apiBaseUrl.value = res.apiBaseUrl || apiBaseUrl.value;
    if (res.connected) {
      const stored = await chrome.storage.local.get({ [TARGET_INSTALLATION_KEY]: "" });
      renderFigmaTargets(res.figmaInstallations, stored[TARGET_INSTALLATION_KEY]);
      setCloudStatus("已连接。采集结果会加密上传到账号任务队列，Figma 插件登录后可领取。");
      return;
    }

    if (res.connection?.status === "pending") {
      setCloudStatus(`等待网页确认，验证码：${res.connection.userCode}`);
      return;
    }

    if (res.connection?.status === "error") {
      setCloudStatus(`连接失败：${res.connection.error || res.connection.code}`);
      return;
    }

    setCloudStatus("未连接。先连接账号，再使用云端任务中转。");
    renderFigmaTargets([]);
  } catch (error) {
    setCloudStatus(`连接状态读取失败：${error.message || error}`);
  }
}

chrome.storage.local.get(
  {
    [STORAGE_KEY]: false,
    [CONCURRENCY_KEY]: DEFAULT_CONCURRENCY,
    webToFigmaApiBaseUrl: DEFAULT_API_BASE_URL,
    [TARGET_INSTALLATION_KEY]: "",
  },
  (res) => {
    toggle.checked = Boolean(res[STORAGE_KEY]);
    concurrency.value = normalizeConcurrency(res[CONCURRENCY_KEY]);
    const effectiveApiBaseUrl = migratedApiBaseUrl(res.webToFigmaApiBaseUrl);
    apiBaseUrl.value = effectiveApiBaseUrl;
    if (effectiveApiBaseUrl !== res.webToFigmaApiBaseUrl) {
      chrome.storage.local.set({ webToFigmaApiBaseUrl: effectiveApiBaseUrl });
    }
    figmaTarget.value = res[TARGET_INSTALLATION_KEY] || "";
    refreshCloudStatus();
  }
);

setInterval(() => void refreshCloudStatus(), 5_000);

figmaTarget.addEventListener("change", () => {
  chrome.storage.local.set({ [TARGET_INSTALLATION_KEY]: figmaTarget.value });
});

toggle.addEventListener("change", () => {
  chrome.storage.local.set({ [STORAGE_KEY]: toggle.checked }, () => {
    setStatus(toggle.checked ? "已开启跨域图片代理模式" : "已关闭跨域图片代理模式");
  });
});

concurrency.addEventListener("change", () => {
  const value = normalizeConcurrency(concurrency.value);
  concurrency.value = value;
  chrome.storage.local.set({ [CONCURRENCY_KEY]: value }, () => {
    setStatus(`图片采集并发已设为：${value === "infinite" ? "无限" : value}`);
  });
});

connectAccountBtn.addEventListener("click", async () => {
  setCloudBusy(true);
  setCloudStatus("正在创建连接请求...");
  try {
    const apiResult = await sendRuntimeMessage({
      type: "WEB_TO_FIGMA_CLOUD_SET_API_BASE_URL",
      apiBaseUrl: apiBaseUrl.value,
    });
    if (!apiResult || !apiResult.ok) {
      throw new Error((apiResult && apiResult.error) || "API 地址无效");
    }

    const res = await sendRuntimeMessage({ type: "WEB_TO_FIGMA_CLOUD_CONNECT" });
    if (!res || !res.ok) throw new Error((res && res.error) || "连接请求失败");

    apiBaseUrl.value = res.apiBaseUrl || apiBaseUrl.value;
    setCloudStatus(`已打开连接网页。验证码：${res.userCode}`);
  } catch (error) {
    setCloudStatus(`连接失败：${error.message || error}`);
  } finally {
    setCloudBusy(false);
  }
});

disconnectAccountBtn.addEventListener("click", async () => {
  setCloudBusy(true);
  try {
    const res = await sendRuntimeMessage({ type: "WEB_TO_FIGMA_CLOUD_DISCONNECT" });
    if (!res || !res.ok) throw new Error((res && res.error) || "断开失败");
    setCloudStatus("已断开本机扩展连接。");
    renderFigmaTargets([]);
  } catch (error) {
    setCloudStatus(`断开失败：${error.message || error}`);
  } finally {
    setCloudBusy(false);
  }
});

captureBtn.addEventListener("click", () => {
  if (pendingCopyPayload) {
    setBusy(true);
    copyPayloadForFigma(pendingCopyPayload)
      .then(() => {
        pendingCopyPayload = null;
        setBusy(false);
        setStatus("已复制转换结果，请回到 Figma 插件导入。");
      })
      .catch((error) => {
        setBusy(false);
        setStatus(`复制失败：${error.message || error}`);
      });
    return;
  }

  setBusy(true);
  setStatus("");
  chrome.runtime.sendMessage(
    {
      type: "FIGMA_CAPTURE_START",
      sourceTabId: Number.isInteger(sourceTabId) && sourceTabId > 0 ? sourceTabId : null,
      targetInstallationId: figmaTarget.value || null,
    },
    (res) => {
    setBusy(false);

    const err = chrome.runtime.lastError;
    if (err) {
      setStatus(`采集失败：${err.message}`);
      return;
    }

    if (!res || !res.ok) {
      setStatus(`采集失败：${(res && res.error) || "未知错误"}`);
      return;
    }

    if (res.handoff) {
      pendingCopyPayload = null;
      setStatus("已加密上传到账号任务队列。请回到 Figma 插件领取并导入。");
      setTimeout(() => window.close(), 1100);
      return;
    }

    if (!res.payload) {
      setStatus(`任务中转失败：${res.handoffError?.message || "没有可导入的采集结果"}`);
      return;
    }

    copyPayloadForFigma(res.payload)
      .then(() => {
        pendingCopyPayload = null;
        setStatus(
          res.handoffError
            ? `云端发送失败，已改用剪贴板：${res.handoffError.message}`
            : "已复制转换结果，请回到 Figma 插件点击“导入剪贴板”。"
        );
        setTimeout(() => window.close(), 900);
      })
      .catch((error) => {
        pendingCopyPayload = res.payload;
        captureBtn.textContent = "复制结果";
        setStatus(`采集完成，但自动复制失败：${error.message || error}。请点击“复制结果”。`);
      });
    }
  );
});
