const STORAGE_KEY = "enableAssetProxyFetch";
const CONCURRENCY_KEY = "proxyFetchConcurrency";
const DEFAULT_CONCURRENCY = "8";
const ALLOWED_CONCURRENCY = new Set(["4", "6", "8", "10", "12", "16", "20", "infinite"]);

const toggle = document.getElementById("assetProxyToggle");
const concurrency = document.getElementById("proxyConcurrency");
const captureBtn = document.getElementById("captureBtn");
const status = document.getElementById("status");
let pendingCopyPayload = null;

function setStatus(text) {
  status.textContent = text || "";
}

function setBusy(busy) {
  captureBtn.disabled = busy;
  captureBtn.textContent = busy ? "转换中..." : pendingCopyPayload ? "复制结果" : "捕获当前网页";
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

chrome.storage.local.get(
  {
    [STORAGE_KEY]: false,
    [CONCURRENCY_KEY]: DEFAULT_CONCURRENCY,
  },
  (res) => {
    toggle.checked = Boolean(res[STORAGE_KEY]);
    concurrency.value = normalizeConcurrency(res[CONCURRENCY_KEY]);
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
