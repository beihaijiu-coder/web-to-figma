(function () {
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;
  const assetBySrc = new Map();

  function number(value, fallback = 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function px(value, fallback = 0) {
    return number(String(value || "").replace("px", ""), fallback);
  }

  function rectFor(node, _rootRect, fullPage = false) {
    const rect = node?.getBoundingClientRect
      ? node.getBoundingClientRect()
      : { x: 0, y: 0, left: 0, top: 0, width: 1, height: 1 };
    const x = number(rect.x ?? rect.left) + (window.scrollX || 0);
    const y = number(rect.y ?? rect.top) + (window.scrollY || 0);
    const width = Math.max(1, number(rect.width, 1));
    const height = fullPage
      ? Math.max(
          width ? 1 : 0,
          number(document.body?.scrollHeight),
          number(document.documentElement?.scrollHeight),
          number(rect.height, 1)
        )
      : Math.max(1, number(rect.height, 1));

    return {
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      width: Math.round(width * 100) / 100,
      height: Math.round(height * 100) / 100,
    };
  }

  function absoluteRect(node, fullPage = false) {
    return rectFor(node, null, fullPage);
  }

  function styleFor(element) {
    return window.getComputedStyle ? window.getComputedStyle(element) || {} : {};
  }

  function elementName(element) {
    const tag = String(element?.tagName || "node").toLowerCase();
    const id = element?.id ? `#${element.id}` : "";
    const className = String(element?.className || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => `.${part}`)
      .join("");
    return `${tag}${id || className}`;
  }

  function textName(text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    return clean.length > 40 ? `${clean.slice(0, 37)}...` : clean;
  }

  function isVisible(element, rect) {
    const style = styleFor(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    return rect.width > 0 && rect.height > 0;
  }

  function captureStyle(element) {
    const computed = styleFor(element);
    return {
      backgroundColor: computed.backgroundImage && computed.backgroundImage !== "none"
        ? computed.backgroundImage
        : computed.backgroundColor,
      borderColor: computed.borderColor || computed.borderTopColor,
      borderWidth: px(computed.borderWidth || computed.borderTopWidth),
      borderRadius: px(computed.borderRadius),
      boxShadow: computed.boxShadow,
      opacity: computed.opacity ? number(computed.opacity, 1) : undefined,
      overflow: computed.overflow,
      color: computed.color,
      fontFamily: computed.fontFamily,
      fontSize: px(computed.fontSize, 16),
      fontWeight: computed.fontWeight,
      lineHeight: computed.lineHeight,
      letterSpacing: computed.letterSpacing,
      objectFit: computed.objectFit,
    };
  }

  function captureLayout(element) {
    const computed = styleFor(element);
    return {
      display: computed.display,
      flexDirection: computed.flexDirection,
      gap: px(computed.gap),
      rowGap: px(computed.rowGap),
      columnGap: px(computed.columnGap),
      alignItems: computed.alignItems,
      justifyContent: computed.justifyContent,
    };
  }

  function assetIdFor(src, assets, extra = {}) {
    if (!src) return "";
    if (assetBySrc.has(src)) return assetBySrc.get(src);
    const id = `asset-${assetBySrc.size + 1}`;
    assetBySrc.set(src, id);
    assets[id] = { src, ...extra };
    return id;
  }

  function assetFromDataUrl(dataUrl, assets) {
    const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) return "";
    return assetIdFor(dataUrl, assets, {
      contentType: match[1],
      base64: match[2],
    });
  }

  function captureTextNode(node, rootRect) {
    const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return null;

    let rect = node.rect ? rectFor({ getBoundingClientRect: () => node.rect }, rootRect) : null;
    if (!rect && document.createRange) {
      const range = document.createRange();
      range.selectNodeContents(node);
      rect = rectFor(range, rootRect);
      range.detach?.();
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;

    const parentStyle = node.parentElement ? captureStyle(node.parentElement) : {};
    return {
      kind: "text",
      name: `Text · ${textName(text)}`,
      text,
      rect,
      style: parentStyle,
    };
  }

  function captureImage(element, rootRect, assets) {
    const src = element.currentSrc || element.src || element.getAttribute?.("src") || "";
    const rect = rectFor(element, rootRect);
    return {
      kind: "image",
      name: element.alt || element.getAttribute?.("aria-label") || elementName(element),
      assetId: assetIdFor(src, assets),
      rect,
      style: captureStyle(element),
    };
  }

  function captureSvg(element, rootRect) {
    return {
      kind: "svg",
      name: element.getAttribute?.("aria-label") || elementName(element),
      svg: element.outerHTML || "<svg />",
      rect: rectFor(element, rootRect),
      style: captureStyle(element),
    };
  }

  function captureNode(node, rootRect, assets) {
    if (!node) return null;
    if (node.nodeType === TEXT_NODE) return captureTextNode(node, rootRect);
    if (node.nodeType !== ELEMENT_NODE) return null;
    if (node.getAttribute?.("data-figma-capture-ignore") === "1") return null;

    const tag = String(node.tagName || "").toLowerCase();
    const rect = rectFor(node, rootRect);
    if (!isVisible(node, rect)) return null;
    if (tag === "img") return captureImage(node, rootRect, assets);
    if (tag === "svg") return captureSvg(node, rootRect);
    if (tag === "canvas" || tag === "video") {
      const rasterAssetId =
        tag === "canvas" && typeof node.toDataURL === "function"
          ? assetFromDataUrl(node.toDataURL("image/png"), assets)
          : assetIdFor(node.poster || node.currentSrc || "", assets);
      return {
        kind: "raster",
        name: elementName(node),
        assetId: rasterAssetId,
        rect,
        style: captureStyle(node),
      };
    }

    const children = Array.from(node.childNodes || [])
      .map((child) => {
        if (child.nodeType === TEXT_NODE) child.parentElement = node;
        return captureNode(child, rootRect, assets);
      })
      .filter(Boolean);

    return {
      kind: "frame",
      name: elementName(node),
      tag,
      role: node.getAttribute?.("role") || "",
      ariaLabel: node.getAttribute?.("aria-label") || "",
      rect,
      style: captureStyle(node),
      layout: captureLayout(node),
      children,
    };
  }

  async function webToFigmaCaptureScene(selector = "body", options = {}) {
    assetBySrc.clear();
    const target =
      selector === "body" || selector === "html" ? document.body : document.querySelector(selector);
    if (!target) throw new Error(`Element not found: ${selector}`);

    const fullPage = selector === "body" || selector === "html";
    const rootRect = absoluteRect(target, fullPage);
    const assets = {};
    const root = captureNode(target, rootRect, assets);
    root.rect = {
      x: rootRect.x,
      y: rootRect.y,
      width: rootRect.width,
      height: rootRect.height,
    };

    return {
      version: 1,
      source: {
        url: window.location.href,
        title: document.title || "",
        selector,
        capturedAt: new Date().toISOString(),
        qualityMode: options.qualityMode || "standard",
      },
      viewport: {
        width: window.innerWidth || rootRect.width,
        height: window.innerHeight || rootRect.height,
      },
      assets,
      root,
    };
  }

  window.webToFigmaCaptureScene = webToFigmaCaptureScene;
})();
