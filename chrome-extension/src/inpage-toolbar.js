(() => {
  const ROOT_ID = "__figma_capture_toolbar__";
  const STYLE_ID = "__figma_capture_toolbar_style__";
  const SELECT_OVERLAY_ID = "__figma_capture_select_overlay__";
  const STORAGE_PROXY_KEY = "enableAssetProxyFetch";
  const STORAGE_CONCURRENCY_KEY = "proxyFetchConcurrency";
  const STORAGE_QUALITY_KEY = "captureQualityMode";
  const STORAGE_TARGET_KEY = "webToFigmaTargetInstallationId";
  const PROGRESS_EVENT = "__FIGMA_CAPTURE_PROGRESS__";
  const STOP_SCROLL_KEY = "__FIGMA_CAPTURE_STOP_SCROLL_REQUESTED__";
  const DEFAULT_CONCURRENCY = "8";
  const DEFAULT_QUALITY = "standard";
  const ALLOWED = new Set(["4", "6", "8", "10", "12", "16", "20", "infinite"]);
  const ALLOWED_QUALITY = new Set(["standard", "hd"]);
  let activeSelectionCleanup = null;
  let targetInstallationId = "";

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

      #${ROOT_ID} .copy-card {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 132px;
        gap: 12px;
        align-items: center;
        padding: 12px;
        border-radius: 12px;
        border: 1px solid #dbeafe;
        background: #f8fbff;
      }

      #${ROOT_ID} .copy-card-text {
        min-width: 0;
        display: grid;
        gap: 4px;
      }

      #${ROOT_ID} .copy-title {
        margin: 0;
        font-size: 15px;
        line-height: 1.2;
        font-weight: 700;
        color: #111827;
      }

      #${ROOT_ID} .copy-description {
        margin: 0;
        font-size: 12px;
        line-height: 1.4;
        color: #4b5563;
      }

      #${ROOT_ID} .copy-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        width: 100%;
        min-height: 48px;
        border: 0;
        border-radius: 10px;
        background: #1d9bf0;
        color: #fff;
        font-size: 17px;
        font-weight: 650;
        cursor: pointer;
        box-shadow: 0 8px 20px rgba(29, 155, 240, 0.22);
        transition: transform 0.08s ease, background 0.15s ease, box-shadow 0.15s ease;
      }

      #${ROOT_ID} .copy-action:hover {
        background: #0f8de3;
        box-shadow: 0 10px 24px rgba(29, 155, 240, 0.28);
      }

      #${ROOT_ID} .copy-action:active {
        transform: translateY(1px);
      }

      #${ROOT_ID} .copy-action:disabled {
        opacity: 0.65;
        cursor: default;
      }

      #${ROOT_ID} .copy-icon {
        width: 21px;
        height: 21px;
        display: block;
        flex-shrink: 0;
      }

      #${ROOT_ID} .copy-json {
        width: max-content;
        border: 0;
        background: transparent;
        color: #2563eb;
        font-size: 12px;
        font-weight: 650;
        padding: 0;
        cursor: pointer;
        text-align: left;
      }

      #${ROOT_ID} .copy-json:hover {
        text-decoration: underline;
      }

      #${ROOT_ID} .copy-json:disabled {
        opacity: 0.55;
        cursor: default;
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

      #${ROOT_ID} .capture.continue {
        grid-column: 1 / -1;
        background: #eef6ff;
        color: #075985;
      }

      #${ROOT_ID} .capture.continue:hover {
        background: #dff0ff;
        box-shadow: none;
      }

      #${ROOT_ID} .capture.stop-scroll {
        grid-column: 1 / -1;
        background: #fff7ed;
        color: #9a3412;
      }

      #${ROOT_ID} .capture.stop-scroll:hover {
        background: #ffedd5;
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
        ? chrome.runtime.getURL("assets/icons/icon16.png")
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
        <p class="status" id="figmaCaptureStatus" data-figma-capture-ignore="1"></p>
        <section class="copy-card hidden" id="figmaCopyCard" data-figma-capture-ignore="1">
          <div class="copy-card-text" data-figma-capture-ignore="1">
            <p class="copy-title" data-figma-capture-ignore="1">Copy to clipboard</p>
            <p class="copy-description" id="figmaCopyDescription" data-figma-capture-ignore="1">
              Capture is ready for Figma import.
            </p>
            <button class="copy-json" id="figmaCopyJsonBtn" type="button" data-figma-capture-ignore="1">
              Copy JSON for plugin import
            </button>
          </div>
          <button class="copy-action" id="figmaCopyBtn" type="button" data-figma-capture-ignore="1">
            <svg class="copy-icon" viewBox="0 0 24 24" aria-hidden="true" data-figma-capture-ignore="1">
              <path d="M8 8h10v12H8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"></path>
              <path d="M5 16H4V4h12v1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>
            <span data-figma-capture-ignore="1">Copy</span>
          </button>
        </section>
        <div class="actions" data-figma-capture-ignore="1">
          <button class="capture" id="figmaCaptureBtn" type="button" data-figma-capture-ignore="1">捕获当前网页</button>
          <button class="capture secondary" id="figmaSelectBtn" type="button" data-figma-capture-ignore="1">选择组件</button>
          <button class="capture continue" id="figmaAccountBtn" type="button" data-figma-capture-ignore="1">账号与发送目标</button>
          <button class="capture stop-scroll hidden" id="figmaStopScrollBtn" type="button" data-figma-capture-ignore="1">停止滚动并生成</button>
          <button class="capture continue hidden" id="figmaContinueFlowBtn" type="button" data-figma-capture-ignore="1">继续采集下一段</button>
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
      "scroll-stopped": "已停止滚动，正在整理当前已加载内容...",
      "loading-images": `正在等待图片加载... 已发现 ${detail.imagesDiscovered ?? 0} 张`,
      "loading-fonts": "正在等待字体加载...",
      "continuous-content": `检测到连续内容流，正在整理第 ${detail.segmentIndex ?? 1} 段...`,
      capturing: "正在生成转换数据...",
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

    return parts.length ? parts.join("；") : "已复制转换结果。";
  }

  async function copyPayloadForFigma(payload) {
    const text = JSON.stringify({
      source: "web-to-figma",
      type: "capture-scene",
      payload,
    });

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    Object.assign(textarea.style, {
      position: "fixed",
      top: "0",
      left: "-9999px",
    });
    document.documentElement.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function escapeXml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function numberAttr(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : fallback;
  }

  function rgbaToHex(value, fallback = "") {
    const raw = String(value || "").trim();
    const match = raw.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
    if (!match) return raw || fallback;

    const toHex = (part) => Math.max(0, Math.min(255, Math.round(Number(part))))
      .toString(16)
      .padStart(2, "0");
    return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
  }

  function opacityFromRgba(value) {
    const match = String(value || "").match(/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/i);
    return match ? Number(match[1]) : 1;
  }

  function assetDataUri(scene, assetId) {
    const asset = scene?.assets?.[assetId];
    if (!asset) return "";
    if (asset.src && String(asset.src).startsWith("data:")) return asset.src;
    const base64 = asset.base64 || asset.data || "";
    if (!base64) return asset.src || "";
    return `data:${asset.contentType || "image/png"};base64,${base64}`;
  }

  function svgStyleAttrs(style = {}) {
    const attrs = [];
    const fill = style.backgroundColor || style.fill;
    if (fill && fill !== "transparent" && !String(fill).includes("gradient(")) {
      attrs.push(`fill="${escapeXml(rgbaToHex(fill, "none"))}"`);
      const opacity = opacityFromRgba(fill);
      if (opacity < 1) attrs.push(`fill-opacity="${opacity}"`);
    } else {
      attrs.push('fill="none"');
    }

    if (style.borderColor && Number(style.borderWidth || 0) > 0) {
      attrs.push(`stroke="${escapeXml(rgbaToHex(style.borderColor, "none"))}"`);
      attrs.push(`stroke-width="${numberAttr(style.borderWidth, 1)}"`);
    }

    if (style.opacity !== undefined) attrs.push(`opacity="${numberAttr(style.opacity, 1)}"`);
    return attrs.join(" ");
  }

  function textValueForSvg(node) {
    const style = node.style || {};
    let value = String(node.text || "");
    const transform = String(style.textTransform || "").toLowerCase();
    if (transform === "uppercase") value = value.toUpperCase();
    if (transform === "lowercase") value = value.toLowerCase();
    return value;
  }

  function renderTextToSvg(node, rootRect) {
    const rect = node.rect || {};
    const style = node.style || {};
    const x = numberAttr(rect.x - rootRect.x);
    const y = numberAttr(rect.y - rootRect.y);
    const fontSize = numberAttr(style.fontSize, 16);
    const lineHeight = Number.parseFloat(String(style.lineHeight || "")) || fontSize * 1.2;
    const color = rgbaToHex(style.color || "rgb(17, 24, 39)", "#111827");
    const weight = String(style.fontWeight || "400");
    const family = String(style.fontFamily || "Inter").split(",")[0].replace(/^["']|["']$/g, "");
    const text = escapeXml(textValueForSvg(node));

    return `<text x="${x}" y="${numberAttr(y + fontSize)}" font-family="${escapeXml(family)}" font-size="${fontSize}" font-weight="${escapeXml(weight)}" fill="${escapeXml(color)}" dominant-baseline="alphabetic">${text}</text>`;
  }

  function renderImageToSvg(scene, node, rootRect) {
    const rect = node.rect || {};
    const href = assetDataUri(scene, node.assetId || node.src || node.style?.backgroundAssetId);
    if (!href) return "";
    return `<image x="${numberAttr(rect.x - rootRect.x)}" y="${numberAttr(rect.y - rootRect.y)}" width="${numberAttr(rect.width, 1)}" height="${numberAttr(rect.height, 1)}" href="${escapeXml(href)}" preserveAspectRatio="xMidYMid slice" />`;
  }

  function renderNodeToSvg(scene, node, rootRect) {
    if (!node) return "";
    if (node.kind === "text") return renderTextToSvg(node, rootRect);
    if (node.kind === "image" || node.kind === "raster") return renderImageToSvg(scene, node, rootRect);
    if (node.kind === "svg") {
      const rect = node.rect || {};
      return `<svg x="${numberAttr(rect.x - rootRect.x)}" y="${numberAttr(rect.y - rootRect.y)}" width="${numberAttr(rect.width, 1)}" height="${numberAttr(rect.height, 1)}">${node.svg || ""}</svg>`;
    }

    const rect = node.rect || {};
    const style = node.style || {};
    const parts = [];
    const radius = numberAttr(style.borderRadius, 0);
    if (style.backgroundColor || style.borderColor) {
      parts.push(
        `<rect x="${numberAttr(rect.x - rootRect.x)}" y="${numberAttr(rect.y - rootRect.y)}" width="${numberAttr(rect.width, 1)}" height="${numberAttr(rect.height, 1)}" rx="${radius}" ry="${radius}" ${svgStyleAttrs(style)} />`
      );
    }

    const backgroundImage = renderImageToSvg(
      scene,
      { kind: "image", assetId: style.backgroundAssetId, rect },
      rootRect
    );
    if (backgroundImage) parts.push(backgroundImage);
    if (!backgroundImage && !style.backgroundColor && !style.borderColor) {
      parts.push(
        `<rect x="${numberAttr(rect.x - rootRect.x)}" y="${numberAttr(rect.y - rootRect.y)}" width="${numberAttr(rect.width, 1)}" height="${numberAttr(rect.height, 1)}" rx="${radius}" ry="${radius}" ${svgStyleAttrs(style)} />`
      );
    }

    for (const child of node.children || []) {
      parts.push(renderNodeToSvg(scene, child, rootRect));
    }
    return parts.join("");
  }

  function sceneToSvg(scene) {
    const rootNode = scene?.root;
    if (!rootNode || !rootNode.rect) throw new Error("Capture scene is missing a root node.");
    const rootRect = rootNode.rect;
    const width = numberAttr(rootRect.width, 1);
    const height = numberAttr(rootRect.height, 1);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${renderNodeToSvg(scene, rootNode, rootRect)}</svg>`;
  }

  async function copyCanvasSvgForFigma(payload) {
    const svg = sceneToSvg(payload);
    const html = `<meta charset="utf-8">${svg}`;

    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([svg], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
          "image/svg+xml": new Blob([svg], { type: "image/svg+xml" }),
        }),
      ]);
      return;
    }

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(svg);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = svg;
    textarea.setAttribute("readonly", "");
    Object.assign(textarea.style, {
      position: "fixed",
      top: "0",
      left: "-9999px",
    });
    document.documentElement.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
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
  const accountBtn = root.querySelector("#figmaAccountBtn");
  const stopScrollBtn = root.querySelector("#figmaStopScrollBtn");
  const continueFlowBtn = root.querySelector("#figmaContinueFlowBtn");
  const copyCard = root.querySelector("#figmaCopyCard");
  const copyBtn = root.querySelector("#figmaCopyBtn");
  const copyJsonBtn = root.querySelector("#figmaCopyJsonBtn");
  const copyDescription = root.querySelector("#figmaCopyDescription");
  const status = root.querySelector("#figmaCaptureStatus");
  let pendingCopyPayload = null;
  let pendingContentFlow = null;
  let stopScrollAvailable = false;
  let stopScrollRequested = false;

  function setStatus(text, tone = "") {
    status.textContent = text || "";
    status.classList.toggle("success", tone === "success");
    status.classList.toggle("error", tone === "error");
  }

  function setBusy(busy) {
    captureBtn.disabled = busy;
    captureBtn.textContent = busy ? "转换中..." : pendingCopyPayload ? "复制结果" : "捕获当前网页";
    quality.disabled = busy;
    toggle.disabled = busy;
    concurrency.disabled = busy;
    selectBtn.disabled = busy;
    accountBtn.disabled = busy;
    stopScrollBtn.disabled = !stopScrollAvailable || stopScrollRequested;
    continueFlowBtn.disabled = busy || !pendingContentFlow;
    copyBtn.disabled = busy || !pendingCopyPayload;
    copyJsonBtn.disabled = busy || !pendingCopyPayload;
  }

  function setStopScrollAvailable(available) {
    stopScrollAvailable = Boolean(available);
    stopScrollBtn.classList.toggle("hidden", !stopScrollAvailable);
    stopScrollBtn.disabled = !stopScrollAvailable || stopScrollRequested;
    stopScrollBtn.textContent = stopScrollRequested ? "正在停止滚动..." : "停止滚动并生成";
  }

  function setContinueFlow(flow) {
    pendingContentFlow = flow && flow.isSegment && flow.hasMore ? flow : null;
    continueFlowBtn.classList.toggle("hidden", !pendingContentFlow);
    continueFlowBtn.disabled = !pendingContentFlow;
    if (pendingContentFlow) {
      continueFlowBtn.textContent = `继续采集第 ${pendingContentFlow.segmentIndex + 1} 段`;
    }
  }

  function setCopyCard(visible, text) {
    copyCard.classList.toggle("hidden", !visible);
    if (text) copyDescription.textContent = text;
    copyBtn.disabled = !pendingCopyPayload;
    copyJsonBtn.disabled = !pendingCopyPayload;
  }

  function flowCopyText(flow) {
    if (!flow || !flow.isSegment) return "Copied as SVG. Go to the Figma canvas and press Ctrl/Cmd+V.";
    if (flow.stoppedByUser) return "已按停止位置复制当前已加载内容。";
    return flow.hasMore
      ? `已复制内容流第 ${flow.segmentIndex} 段。可先导入 Figma，再继续采集下一段。`
      : `已复制内容流第 ${flow.segmentIndex} 段。页面已到达结尾。`;
  }

  function flowStatusText(flow, summary) {
    if (!flow || !flow.isSegment) return summary;
    const base = flow.stoppedByUser
      ? "已按停止位置采集当前已加载内容。"
      : flow.hasMore
      ? `检测到连续内容流，已采集第 ${flow.segmentIndex} 段。`
      : `连续内容流第 ${flow.segmentIndex} 段已采集，页面已到达结尾。`;
    return `${base}${summary === "已复制转换结果。" ? "" : summary}`;
  }

  function startCapture(selector = "body", contentFlow = { action: "auto" }) {
    pendingCopyPayload = null;
    stopScrollRequested = false;
    window[STOP_SCROLL_KEY] = false;
    setStopScrollAvailable(false);
    setContinueFlow(null);
    setCopyCard(false);
    setBusy(true);
    setStatus(selector === "body" ? "准备开始采集..." : `准备采集：${selector}`);
    chrome.runtime.sendMessage(
      {
        type: "FIGMA_CAPTURE_START",
        options: {
          qualityMode: normalizeQuality(quality.value),
          selector,
          contentFlow,
        },
        targetInstallationId: targetInstallationId || null,
      },
      (res) => {
        setStopScrollAvailable(false);
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

        if (res.handoff) {
          pendingCopyPayload = null;
          setContinueFlow(res.contentFlow || null);
          setCopyCard(false);
          setStatus("已加密发送到目标 Figma 插件，请回到 Figma 领取导入。", "success");
          return;
        }

        if (!res.payload) {
          setStatus(`任务中转失败：${res.handoffError?.message || "没有可导入的采集结果"}`, "error");
          return;
        }

        copyCanvasSvgForFigma(res.payload)
          .then(() => {
            pendingCopyPayload = res.payload;
            const flow = res.payload?.capture?.contentFlow || null;
            setContinueFlow(flow);
            const summary = summarizeDiagnostics(res.diagnostics);
            setCopyCard(true, flowCopyText(flow));
            setBusy(false);
            setStatus(
              flow
                ? flowStatusText(flow, summary)
                : res.handoffError
                ? `云端发送失败，已改用剪贴板：${res.handoffError.message}`
                : summary === "已复制转换结果。"
                ? "已复制为 SVG，请回到 Figma 画布直接粘贴。"
                : `已复制为 SVG，请回到 Figma 画布直接粘贴。${summary}`,
              "success"
            );
          })
          .catch((error) => {
            pendingCopyPayload = res.payload;
            const flow = res.payload?.capture?.contentFlow || null;
            setContinueFlow(flow);
            setStopScrollAvailable(false);
            setCopyCard(true, "Automatic SVG copy failed. Click Copy to place SVG on your clipboard.");
            captureBtn.textContent = "复制结果";
            setStatus(`采集完成，但自动复制失败：${error.message || error}。请点击“复制结果”。`);
          });
      }
    );
  }

  function copyPendingPayload() {
    if (!pendingCopyPayload) return false;
    setBusy(true);
    copyCanvasSvgForFigma(pendingCopyPayload)
      .then(() => {
        setBusy(false);
        setCopyCard(true, "Copied as SVG. Go to the Figma canvas and press Ctrl/Cmd+V.");
        setStatus("已复制为 SVG，请回到 Figma 画布直接粘贴。", "success");
      })
      .catch((error) => {
        setBusy(false);
        setStatus(`复制失败：${error.message || error}`, "error");
      });
    return true;
  }

  function copyPendingJsonPayload() {
    if (!pendingCopyPayload) return false;
    setBusy(true);
    copyPayloadForFigma(pendingCopyPayload)
      .then(() => {
        setBusy(false);
        setCopyCard(true, "Copied JSON. Use the Figma plugin import button, not canvas paste.");
        setStatus("已复制 JSON，请回到 Figma 插件导入。", "success");
      })
      .catch((error) => {
        setBusy(false);
        setStatus(`复制 JSON 失败：${error.message || error}`, "error");
      });
    return true;
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
      [STORAGE_TARGET_KEY]: "",
    },
    (res) => {
      toggle.checked = Boolean(res[STORAGE_PROXY_KEY]);
      quality.value = normalizeQuality(res[STORAGE_QUALITY_KEY]);
      concurrency.value = normalizeConcurrency(res[STORAGE_CONCURRENCY_KEY]);
      targetInstallationId = String(res[STORAGE_TARGET_KEY] || "");
      syncProxyDependentUI(toggle, concurrencyRow);
    }
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes?.[STORAGE_TARGET_KEY]) {
      targetInstallationId = String(changes[STORAGE_TARGET_KEY].newValue || "");
    }
  });

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
    const detail = event.detail || {};
    const stage = detail.stage;
    if (stage === "scrolling" && detail.canStopScroll) {
      setStopScrollAvailable(true);
    } else if (stage && stage !== "scrolling") {
      setStopScrollAvailable(false);
    }

    if (stage === "scrolling" && stopScrollRequested) {
      setStatus("已收到停止指令，正在生成当前已加载内容...");
      return;
    }

    setStatus(progressText(stage, detail));
  });

  captureBtn.addEventListener("click", () => {
    if (copyPendingPayload()) return;
    startCapture("body");
  });

  accountBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "WEB_TO_FIGMA_CLOUD_OPEN_SETTINGS" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        setStatus(`无法打开账号设置：${chrome.runtime.lastError?.message || response?.error || "未知错误"}`, "error");
      }
    });
  });

  continueFlowBtn.addEventListener("click", () => {
    if (!pendingContentFlow) return;
    startCapture("body", {
      action: "next",
      segmentScreens: pendingContentFlow.segmentScreens,
    });
  });

  stopScrollBtn.addEventListener("click", () => {
    if (!stopScrollAvailable || stopScrollRequested) return;
    stopScrollRequested = true;
    window[STOP_SCROLL_KEY] = true;
    stopScrollBtn.disabled = true;
    stopScrollBtn.textContent = "正在停止滚动...";
    setStatus("已停止滚动，正在生成当前已加载内容...");
  });

  copyBtn.addEventListener("click", () => {
    copyPendingPayload();
  });

  copyJsonBtn.addEventListener("click", () => {
    copyPendingJsonPayload();
  });

  selectBtn.addEventListener("click", () => {
    startSelectionMode();
  });
})();
