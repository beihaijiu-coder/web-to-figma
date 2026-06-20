const STORAGE_KEY = "enableAssetProxyFetch";
const CONCURRENCY_KEY = "proxyFetchConcurrency";
const DEFAULT_CONCURRENCY = "8";
const ALLOWED_CONCURRENCY = new Set(["4", "6", "8", "10", "12", "16", "20", "infinite"]);

const toggle = document.getElementById("assetProxyToggle");
const concurrency = document.getElementById("proxyConcurrency");
const captureBtn = document.getElementById("captureBtn");
const status = document.getElementById("status");

function setStatus(text) {
  status.textContent = text || "";
}

function setBusy(busy) {
  captureBtn.disabled = busy;
  captureBtn.textContent = busy ? "采集中..." : "开始采集";
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

    setStatus("已触发采集，请查看下载文件。");
    setTimeout(() => window.close(), 600);
  });
});
