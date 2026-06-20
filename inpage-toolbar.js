(() => {
  const ROOT_ID = "__figma_capture_toolbar__";
  const STYLE_ID = "__figma_capture_toolbar_style__";
  const SELECT_OVERLAY_ID = "__figma_capture_select_overlay__";
  const STORAGE_PROXY_KEY = "enableAssetProxyFetch";
  const STORAGE_CONCURRENCY_KEY = "proxyFetchConcurrency";
  const STORAGE_QUALITY_KEY = "captureQualityMode";
  const PROGRESS_EVENT = "__FIGMA_CAPTURE_PROGRESS__";
  const DEFAULT_CONCURRENCY = "8";
  const DEFAULT_QUALITY = "standard";
  const ALLOWED = new Set(["4", "6", "8", "10", "12", "16", "20", "infinite"]);
  const ALLOWED_QUALITY = new Set(["standard", "hd"]);
  let activeSelectionCleanup = null;

  function normalizeConcurrency(value) {
    const str = String(value ?? "");
    return ALLOWED.has(str) ? str : DEFAULT_CONCURRENCY;
  }

  function normalizeQuality(value) {
    const str = String(value ?? "");
    return ALLOWED_QUALITY.has(str) ? str : DEFAULT_QUALITY;
  }

  function removeExisting() {
    if (activeSelectionCleanup) {
      activeSelectionCleanup();
      activeSelectionCleanup = null;
    }

    const oldRoot = document.getElementById(ROOT_ID);
    if (oldRoot) oldRoot.remove();

    const oldStyle = document.getElementById(STYLE_ID);
    if (oldStyle) oldStyle.remove();

    const oldOverlay = document.getElementById(SELECT_OVERLAY_ID);
    if (oldOverlay) oldOverlay.remove();
  }

  function createStyle() {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        top: 16px;
        right: 16px;
        width: 320px;
        z-index: 2147483647;
        border-radius: 14px;
        border: 1px solid #d9dee5;
        background: #ffffff;
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #111827;
        overflow: hidden;
      }

      #${ROOT_ID} * {
        box-sizing: border-box;
      }

      #${ROOT_ID} .bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        border-bottom: 1px solid #e5e7eb;
        background: linear-gradient(180deg, #f9fafb 0%, #ffffff 100%);
      }

      #${ROOT_ID} .title {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        font-weight: 600;
      }

      #${ROOT_ID} .title-logo {
        width: 16px;
        height: 16px;
        display: block;
        flex-shrink: 0;
      }

      #${ROOT_ID} .close {
        border: 0;
        background: transparent;
        cursor: pointer;
        color: #6b7280;
        font-size: 20px;
        line-height: 1;
        border-radius: 6px;
        transition: background 0.15s ease, color 0.15s ease;
      }

      #${ROOT_ID} .close:hover {
        background: #f3f4f6;
        color: #374151;
      }

      #${ROOT_ID} .body {
        padding: 12px;
        display: grid;
        gap: 10px;
      }

      #${ROOT_ID} .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        font-size: 13px;
      }

      #${ROOT_ID} .switch {
        position: relative;
        display: inline-flex;
        width: 40px;
        height: 22px;
        flex-shrink: 0;
      }

      #${ROOT_ID} .switch input {
        position: absolute;
        opacity: 0;
        width: 0;
        height: 0;
      }

      #${ROOT_ID} .switch-slider {
        width: 100%;
        height: 100%;
        border-radius: 999px;
        background: #d1d5db;
        transition: background 0.18s ease;
        position: relative;
      }

      #${ROOT_ID} .switch-slider::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #ffffff;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
        transition: transform 0.18s ease;
      }

      #${ROOT_ID} .switch input:checked + .switch-slider {
        background: #111827;
      }

      #${ROOT_ID} .switch input:checked + .switch-slider::after {
        transform: translateX(18px);
      }

      #${ROOT_ID} select {
        min-width: 88px;
        padding: 4px 6px;
        border-radius: 8px;
        border: 1px solid #d1d5db;
        background: #fff;
        color: #111827;
      }

      #${ROOT_ID} .hint {
        font-size: 12px;
        color: #6b7280;
        margin: 0;
      }

      #${ROOT_ID} .status {
        min-height: 18px;
        font-size: 12px;
        color: #4b5563;
        margin: 0;
        line-height: 1.45;
      }

      #${ROOT_ID} .status.success {
        color: #166534;
      }

      #${ROOT_ID} .status.error {
        color: #b91c1c;
      }

      #${ROOT_ID} .safety {
        margin: 0;
        padding: 8px;
        border-radius: 8px;
        background: #f9fafb;
        color: #6b7280;
        font-size: 12px;
        line-height: 1.45;
      }

      #${ROOT_ID} .actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      #${ROOT_ID} .capture {
        width: 100%;
        border: 0;
        border-radius: 8px;
        background: #111827;
        color: #fff;
        font-size: 13px;
        padding: 9px 12px;
        cursor: pointer;
        transition: transform 0.08s ease, box-shadow 0.2s ease, background 0.15s ease;
      }

      #${ROOT_ID} .capture:hover {
        background: #1f2937;
        box-shadow: 0 6px 16px rgba(17, 24, 39, 0.2);
      }

      #${ROOT_ID} .capture.secondary {
        background: #f3f4f6;
        color: #111827;
      }

      #${ROOT_ID} .capture.secondary:hover {
        background: #e5e7eb;
        box-shadow: none;
      }

      #${ROOT_ID} .capture:active {
        transform: translateY(1px);
      }

      #${ROOT_ID} .capture:disabled {
        opacity: 0.65;
        cursor: default;
      }

      #${ROOT_ID} .hidden {
        display: none !important;
      }
    `;
    return style;
  }

  function createToolbar() {
    const logoUrl =
      typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
        ? chrome.runtime.getURL("logo/icon16.png")
        : "";
    const root = document.createElement("section");

    root.id = ROOT_ID;
    root.setAttribute("data-figma-capture-ignore", "1");
    root.innerHTML = `
      <div class="bar" data-figma-capture-ignore="1">
        <div class="title" data-figma-capture-ignore="1">
          <img class="title-logo" src="${logoUrl}" alt="" data-figma-capture-ignore="1" />
          <span data-figma-capture-ignore="1">Web to Figma</span>
        </div>
        <button class="close" type="button" title="关闭" data-figma-capture-ignore="1">×</button>
      </div>
      <div class="body" data-figma-capture-ignore="1">
        <label class="row" data-figma-capture-ignore="1">
          <span data-figma-capture-ignore="1">图片质量</span>
          <select id="figmaQualityMode" data-figma-capture-ignore="1">
            <option value="standard">标准</option>
            <option value="hd">高清</option>
          </select>
        </label>
        <label class="row" data-figma-capture-ignore="1">
          <span data-figma-capture-ignore="1">跨域图片代理模式</span>
          <span class="switch" data-figma-capture-ignore="1">
            <input id="figmaProxyToggle" type="checkbox" data-figma-capture-ignore="1" />
            <span class="switch-slider" data-figma-capture-ignore="1"></span>
          </span>
        </label>
        <label class="row" id="figmaConcurrencyRow" data-figma-capture-ignore="1">
          <span data-figma-capture-ignore="1">图片采集并发</span>
          <select id="figmaProxyConcurrency" data-figma-capture-ignore="1">
            <option value="4">4</option>
            <option value="6">6</option>
            <option value="8">8</option>
            <option value="10">10</option>
            <option value="12">12</option>
            <option value="16">16</option>
            <option value="20">20</option>
            <option value="infinite">无限</option>
          </select>
        </label>
        <p class="hint" data-figma-capture-ignore="1">高清会优先采集大图；代理可减少丢图，但会变慢。</p>
        <p class="safety" data-figma-capture-ignore="1">请只采集普通或公开网页，别在银行、邮箱、后台、聊天记录、私人文档页面使用。</p>
        <p class="status" id="figmaCaptureStatus" data-figma-capture-ignore="1"></p>
        <div class="actions" data-figma-capture-ignore="1">
          <button class="capture" id="figmaCaptureBtn" type="button" data-figma-capture-ignore="1">开始采集</button>
          <button class="capture secondary" id="figmaSelectBtn" type="button" data-figma-capture-ignore="1">选择组件</button>
        </div>
      </div>
    `;
    return root;
  }

  function syncProxyDependentUI(toggleNode, concurrencyRow) {
    concurrencyRow.classList.toggle("hidden", !toggleNode.checked);
  }

  function progressText(stage, detail = {}) {
    const map = {
      preparing: "准备页面...",
      scrolling: "正在滚动页面加载图片...",
      "loading-images": `正在等待图片加载... 已发现 ${detail.imagesDiscovered ?? 0} 张`,
      "loading-fonts": "正在等待字体加载...",
      capturing: "正在生成采集文件...",
    };

    return map[stage] || "正在采集...";
  }

  function summarizeDiagnostics(diagnostics) {
    const preparation = diagnostics?.preparation || {};
    const payload = diagnostics?.payload || {};
    const proxy = diagnostics?.proxy || {};
    const parts = [];

    if (typeof preparation.imagesDiscovered === "number") {
      parts.push(`发现 ${preparation.imagesDiscovered} 张图片`);
    }

    if (preparation.hdImagesPromoted || preparation.hdBackgroundsPromoted) {
      parts.push(
        `高清替换 ${(preparation.hdImagesPromoted || 0) + (preparation.hdBackgroundsPromoted || 0)} 处`
      );
    }

    if (payload.assetFailures) {
      parts.push(`${payload.assetFailures} 张图片失败，可尝试开启代理`);
    }

    if (proxy.requests) {
      parts.push(`代理成功 ${proxy.successes || 0} 个，失败 ${proxy.failures || 0} 个`);
    }

    return parts.length ? parts.join("；") : "已触发下载。";
  }

  function escapeSelectorPart(value) {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function elementLabel(element) {
    if (!element?.tagName) return "";

    const tag = element.tagName.toLowerCase();
    if (element.id) return `${tag}#${element.id}`;
    if (element.classList?.length) {
      return `${tag}.${Array.from(element.classList).slice(0, 2).join(".")}`;
    }

    return tag;
  }

  function selectorForElement(element) {
    if (!element || element === document.body) return "body";
    if (element === document.documentElement) return "html";

    if (element.id) {
      const idSelector = `#${escapeSelectorPart(element.id)}`;
      if (document.querySelectorAll(idSelector).length === 1) return idSelector;
    }

    const parts = [];
    let node = element;

    while (node && node !== document.body && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();

      if (node.id) {
        parts.unshift(`#${escapeSelectorPart(node.id)}`);
        break;
      }

      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
      }

      parts.unshift(part);
      node = parent;
    }

    return parts.length ? parts.join(" > ") : "body";
  }

  function isIgnoredNode(node) {
    return !node || root.contains(node) || node.closest?.("[data-figma-capture-ignore='1']");
  }

  removeExisting();
  document.documentElement.appendChild(createStyle());

  const root = createToolbar();
  document.documentElement.appendChild(root);

  const closeBtn = root.querySelector(".close");
  const quality = root.querySelector("#figmaQualityMode");
  const toggle = root.querySelector("#figmaProxyToggle");
  const concurrency = root.querySelector("#figmaProxyConcurrency");
  const concurrencyRow = root.querySelector("#figmaConcurrencyRow");
  const captureBtn = root.querySelector("#figmaCaptureBtn");
  const selectBtn = root.querySelector("#figmaSelectBtn");
  const status = root.querySelector("#figmaCaptureStatus");

  function setStatus(text, tone = "") {
    status.textContent = text || "";
    status.classList.toggle("success", tone === "success");
    status.classList.toggle("error", tone === "error");
  }

  function setBusy(busy) {
    captureBtn.disabled = busy;
    captureBtn.textContent = busy ? "采集中..." : "开始采集";
    quality.disabled = busy;
    toggle.disabled = busy;
    concurrency.disabled = busy;
    selectBtn.disabled = busy;
  }

  function startCapture(selector = "body") {
    setBusy(true);
    setStatus(selector === "body" ? "准备开始采集..." : `准备采集：${selector}`);
    chrome.runtime.sendMessage(
      {
        type: "FIGMA_CAPTURE_START",
        options: {
          qualityMode: normalizeQuality(quality.value),
          selector,
        },
      },
      (res) => {
        setBusy(false);
        const err = chrome.runtime.lastError;
        if (err) {
          setStatus(`采集失败：${err.message}`, "error");
          console.error("Capture failed:", err.message);
          return;
        }

        if (!res || !res.ok) {
          const message = (res && res.error) || "未知错误";
          setStatus(`采集失败：${message}`, "error");
          console.error("Capture failed:", message);
          return;
        }

        const summary = summarizeDiagnostics(res.diagnostics);
        setStatus(summary === "已触发下载。" ? summary : `已触发下载。${summary}`, "success");
      }
    );
  }

  function startSelectionMode() {
    if (activeSelectionCleanup) activeSelectionCleanup();

    let current = null;
    const overlay = document.createElement("div");

    overlay.id = SELECT_OVERLAY_ID;
    overlay.setAttribute("data-figma-capture-ignore", "1");
    Object.assign(overlay.style, {
      position: "fixed",
      pointerEvents: "none",
      zIndex: "2147483646",
      display: "none",
      border: "2px solid #2563eb",
      background: "rgba(37, 99, 235, 0.1)",
      boxSizing: "border-box",
    });
    document.documentElement.appendChild(overlay);
    setStatus("移动鼠标选择组件，点击确认，Esc 取消。");

    function updateOverlay(element) {
      current = element;
      if (!current) {
        overlay.style.display = "none";
        return;
      }

      const rect = current.getBoundingClientRect();
      Object.assign(overlay.style, {
        display: "block",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      overlay.title = elementLabel(current);
    }

    function elementFromPoint(event) {
      return (
        document
          .elementsFromPoint(event.clientX, event.clientY)
          .find((node) => node instanceof Element && !isIgnoredNode(node)) || null
      );
    }

    function cleanup(message) {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      activeSelectionCleanup = null;
      if (message) setStatus(message);
    }

    function onMove(event) {
      updateOverlay(elementFromPoint(event));
    }

    function confirmSelection(event) {
      if (!current) return;
      event.preventDefault();
      event.stopPropagation();
      const selector = selectorForElement(current);
      cleanup("");
      startCapture(selector);
    }

    function onClick(event) {
      confirmSelection(event);
    }

    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup("已取消选择。");
        return;
      }

      if ((event.key === "[" || event.key === "ArrowUp") && current?.parentElement) {
        event.preventDefault();
        if (!isIgnoredNode(current.parentElement)) updateOverlay(current.parentElement);
        return;
      }

      if ((event.key === "]" || event.key === "ArrowDown") && current?.firstElementChild) {
        event.preventDefault();
        if (!isIgnoredNode(current.firstElementChild)) updateOverlay(current.firstElementChild);
        return;
      }

      if (event.key === "Enter") {
        confirmSelection(event);
      }
    }

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    activeSelectionCleanup = cleanup;
  }

  closeBtn.addEventListener("click", () => {
    removeExisting();
  });

  chrome.storage.local.get(
    {
      [STORAGE_PROXY_KEY]: false,
      [STORAGE_CONCURRENCY_KEY]: DEFAULT_CONCURRENCY,
      [STORAGE_QUALITY_KEY]: DEFAULT_QUALITY,
    },
    (res) => {
      toggle.checked = Boolean(res[STORAGE_PROXY_KEY]);
      quality.value = normalizeQuality(res[STORAGE_QUALITY_KEY]);
      concurrency.value = normalizeConcurrency(res[STORAGE_CONCURRENCY_KEY]);
      syncProxyDependentUI(toggle, concurrencyRow);
    }
  );

  quality.addEventListener("change", () => {
    const value = normalizeQuality(quality.value);
    quality.value = value;
    chrome.storage.local.set({ [STORAGE_QUALITY_KEY]: value });
  });

  toggle.addEventListener("change", () => {
    syncProxyDependentUI(toggle, concurrencyRow);
    chrome.storage.local.set({ [STORAGE_PROXY_KEY]: toggle.checked });
  });

  concurrency.addEventListener("change", () => {
    const value = normalizeConcurrency(concurrency.value);
    concurrency.value = value;
    chrome.storage.local.set({ [STORAGE_CONCURRENCY_KEY]: value });
  });

  window.addEventListener(PROGRESS_EVENT, (event) => {
    setStatus(progressText(event.detail?.stage, event.detail || {}));
  });

  captureBtn.addEventListener("click", () => {
    startCapture("body");
  });

  selectBtn.addEventListener("click", () => {
    startSelectionMode();
  });
})();
