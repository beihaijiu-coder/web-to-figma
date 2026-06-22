const STORAGE_KEY = "enableAssetProxyFetch";
const CONCURRENCY_KEY = "proxyFetchConcurrency";
const DEFAULT_CONCURRENCY = "8";
const ALLOWED_CONCURRENCY = new Set(["4", "6", "8", "10", "12", "16", "20", "infinite"]);

const toggle = document.getElementById("assetProxyToggle");
const concurrency = document.getElementById("proxyConcurrency");
const captureBtn = document.getElementById("captureBtn");
const status = document.getElementById("status");
const apiBaseUrl = document.getElementById("apiBaseUrl");
const connectAccountBtn = document.getElementById("connectAccountBtn");
const disconnectAccountBtn = document.getElementById("disconnectAccountBtn");
const cloudStatus = document.getElementById("cloudStatus");
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
      const targets = Array.isArray(res.figmaInstallations) ? res.figmaInstallations.length : 0;
      setCloudStatus(`已连接。可用 Figma 插件：${targets} 个。`);
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
  } catch (error) {
    setCloudStatus(`连接状态读取失败：${error.message || error}`);
  }
}

chrome.storage.local.get(
  {
    [STORAGE_KEY]: false,
    [CONCURRENCY_KEY]: DEFAULT_CONCURRENCY,
    webToFigmaApiBaseUrl: "http://localhost:8787",
  },
  (res) => {
    toggle.checked = Boolean(res[STORAGE_KEY]);
    concurrency.value = normalizeConcurrency(res[CONCURRENCY_KEY]);
    apiBaseUrl.value = res.webToFigmaApiBaseUrl || "http://localhost:8787";
    refreshCloudStatus();
  }
);

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
  chrome.runtime.sendMessage({ type: "FIGMA_CAPTURE_START" }, (res) => {
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

    copyPayloadForFigma(res.payload)
      .then(() => {
        pendingCopyPayload = null;
        setStatus("已复制转换结果，请回到 Figma 插件点击“导入剪贴板”。");
        setTimeout(() => window.close(), 900);
      })
      .catch((error) => {
        pendingCopyPayload = res.payload;
        captureBtn.textContent = "复制结果";
        setStatus(`采集完成，但自动复制失败：${error.message || error}。请点击“复制结果”。`);
      });
  });
});
