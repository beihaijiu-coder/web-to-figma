(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(root);
  } else {
    root.WebToFigmaImporter = factory(root);
  }
})(typeof self !== "undefined" ? self : this, function (runtimeRoot) {
  const DEFAULT_FONT = { family: "Inter", style: "Regular" };
  const RUNTIME_GLOBAL = runtimeRoot || {};

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function rectOf(node) {
    const rect = node && node.rect ? node.rect : {};
    return {
      x: number(rect.x),
      y: number(rect.y),
      width: Math.max(1, number(rect.width, 1)),
      height: Math.max(1, number(rect.height, 1)),
    };
  }

  function titleCase(value) {
    return String(value || "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function textSummary(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > 40 ? `${text.slice(0, 37)}...` : text;
  }

  function semanticName(node, fallback) {
    if (node && node.kind === "text" && !node.name) {
      const prefix = titleCase(node.role || node.tag || "Text");
      const summary = textSummary(node.text);
      return summary ? `${prefix} · ${summary}` : prefix;
    }

    const raw = String((node && (node.name || node.ariaLabel || node.role || node.tag)) || fallback || "")
      .replace(/\s+/g, " ")
      .trim();
    return raw || fallback;
  }

  function rootName(scene, rootNode) {
    return `Web to Figma · ${semanticName(rootNode, (scene && scene.source && scene.source.url) || "Capture")}`;
  }

  function fontStyleFromWeight(weight) {
    const numeric = number(weight, 400);
    if (numeric >= 800) return "Bold";
    if (numeric >= 700) return "Bold";
    if (numeric >= 600) return "Semi Bold";
    if (numeric <= 300) return "Light";
    return "Regular";
  }

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function parseHexColor(value) {
    const hex = String(value || "").trim().replace("#", "");
    if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex)) return null;
    const expanded =
      hex.length === 3
        ? hex
            .split("")
            .map((part) => part + part)
            .join("")
        : hex;
    const int = Number.parseInt(expanded, 16);
    return {
      r: ((int >> 16) & 255) / 255,
      g: ((int >> 8) & 255) / 255,
      b: (int & 255) / 255,
      a: 1,
    };
  }

  function parseColor(value) {
    const raw = String(value || "").trim();
    if (!raw || raw === "transparent" || raw === "rgba(0, 0, 0, 0)") return null;
    if (raw.startsWith("#")) return parseHexColor(raw);

    const match = raw.match(
      /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i
    );
    if (!match) return null;

    return {
      r: clamp01(Number(match[1]) / 255),
      g: clamp01(Number(match[2]) / 255),
      b: clamp01(Number(match[3]) / 255),
      a: match[4] === undefined ? 1 : clamp01(Number(match[4])),
    };
  }

  function solidPaint(value) {
    const color = parseColor(value);
    if (!color) return null;
    return {
      type: "SOLID",
      color: { r: color.r, g: color.g, b: color.b },
      opacity: color.a,
    };
  }

  function gradientPaint(value) {
    const raw = String(value || "");
    if (!/^linear-gradient\(/i.test(raw)) return null;

    const colors = [];
    const colorRegex = /(#[0-9a-f]{3,6}|rgba?\([^)]+\))/gi;
    let match = colorRegex.exec(raw);
    while (match) {
      const color = parseColor(match[1]);
      if (color) colors.push(color);
      match = colorRegex.exec(raw);
    }
    if (colors.length < 2) return null;

    return {
      type: "GRADIENT_LINEAR",
      gradientStops: colors.map((color, index) => ({
        position: colors.length === 1 ? 0 : index / (colors.length - 1),
        color: { r: color.r, g: color.g, b: color.b, a: color.a },
      })),
      gradientTransform: [
        [1, 0, 0],
        [0, 1, 0],
      ],
    };
  }

  function fillPaint(value) {
    return gradientPaint(value) || solidPaint(value);
  }

  function parseShadow(value) {
    const raw = String(value || "");
    if (!raw || raw === "none") return null;
    const colorMatch = raw.match(/rgba?\([^)]+\)|#[0-9a-f]{3,6}/i);
    const colorMatchValue = colorMatch ? colorMatch[0] : "";
    const color = parseColor(colorMatchValue || "rgba(0, 0, 0, 0.2)");
    const numeric = raw
      .replace(colorMatchValue || "", "")
      .trim()
      .split(/\s+/)
      .map((part) => Number.parseFloat(part))
      .filter(Number.isFinite);
    return {
      type: "DROP_SHADOW",
      visible: true,
      color: {
        r: color ? color.r : 0,
        g: color ? color.g : 0,
        b: color ? color.b : 0,
        a: color ? color.a : 0.2,
      },
      offset: { x: numeric[0] || 0, y: numeric[1] || 0 },
      radius: Math.max(0, numeric[2] || 0),
      spread: numeric[3] || 0,
      blendMode: "NORMAL",
    };
  }

  function applyStyle(node, sourceNode, scene, options = {}) {
    const style = sourceNode && sourceNode.style ? sourceNode.style : {};
    const backgroundImageHash = style.backgroundAssetId
      ? imageHashFor(figmaFromOptions(options), scene, { assetId: style.backgroundAssetId }, options)
      : null;
    const background = backgroundImageHash
      ? {
          type: "IMAGE",
          scaleMode: imageScaleMode(sourceNode),
          imageHash: backgroundImageHash,
        }
      : fillPaint(style.backgroundColor || style.background || style.fill);
    if (background) node.fills = [background];

    const stroke = solidPaint(style.borderColor);
    if (stroke) node.strokes = [stroke];
    if (style.borderWidth !== undefined) node.strokeWeight = number(style.borderWidth, 1);
    if (style.borderRadius !== undefined) node.cornerRadius = number(style.borderRadius, 0);
    if (style.opacity !== undefined) node.opacity = number(style.opacity, 1);
    if (style.overflow === "hidden" || style.clipsContent === true) node.clipsContent = true;

    const shadow = parseShadow(style.boxShadow || style.shadow);
    if (shadow) node.effects = [shadow];
  }

  function figmaFromOptions(options = {}) {
    return options.figma || RUNTIME_GLOBAL.figma;
  }

  function applyLayout(node, sourceNode, options = {}) {
    if (options.layoutMode !== "editable") return;

    const layout = sourceNode && sourceNode.layout ? sourceNode.layout : {};
    const display = String(layout.display || "").toLowerCase();
    const direction = String(layout.flexDirection || layout.direction || "row").toLowerCase();
    const isFlex = display === "flex" || display === "inline-flex";
    const isSimpleGrid = display === "grid" && !layout.isComplex;
    if (!isFlex && !isSimpleGrid) return;

    node.layoutMode = direction.includes("column") ? "VERTICAL" : "HORIZONTAL";
    node.itemSpacing = number(
      layout.gap !== undefined ? layout.gap : layout.columnGap !== undefined ? layout.columnGap : layout.rowGap,
      0
    );

    const align = String(layout.alignItems || "").toLowerCase();
    if (align === "center") node.counterAxisAlignItems = "CENTER";
    if (align === "flex-end" || align === "end") node.counterAxisAlignItems = "MAX";
    if (align === "stretch") node.counterAxisAlignItems = "STRETCH";

    const justify = String(layout.justifyContent || "").toLowerCase();
    if (justify === "center") node.primaryAxisAlignItems = "CENTER";
    if (justify === "flex-end" || justify === "end") node.primaryAxisAlignItems = "MAX";
    if (justify === "space-between") node.primaryAxisAlignItems = "SPACE_BETWEEN";
  }

  function decodeBase64(base64) {
    const text = String(base64 || "");
    if (!text) return new Uint8Array();

    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(text, "base64"));
    }

    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function imageScaleMode(sourceNode) {
    const fit = String(
      (sourceNode && sourceNode.style && sourceNode.style.objectFit) || (sourceNode && sourceNode.fit) || ""
    ).toLowerCase();
    if (fit === "contain" || fit === "scale-down") return "FIT";
    if (fit === "fill") return "STRETCH";
    if (fit === "tile") return "TILE";
    return "FILL";
  }

  async function loadFont(figma, node, fallbackFont = DEFAULT_FONT) {
    const family = String((node && node.style && node.style.fontFamily) || DEFAULT_FONT.family)
      .split(",")[0]
      .replace(/^["']|["']$/g, "")
      .trim() || DEFAULT_FONT.family;
    const fontName = {
      family,
      style: fontStyleFromWeight(node && node.style ? node.style.fontWeight : undefined),
    };

    try {
      await figma.loadFontAsync(fontName);
      return fontName;
    } catch (error) {
      await figma.loadFontAsync(fallbackFont);
      return fallbackFont;
    }
  }

  function place(node, rect, parentRect) {
    node.x = rect.x - parentRect.x;
    node.y = rect.y - parentRect.y;
    if (typeof node.resize === "function") node.resize(rect.width, rect.height);
  }

  function append(parent, child) {
    if (typeof parent.appendChild === "function") {
      parent.appendChild(child);
    }
  }

  function progress(options, stage, detail = {}) {
    if (options && typeof options.onProgress === "function") {
      const event = { stage: stage };
      for (const key in detail || {}) {
        if (Object.prototype.hasOwnProperty.call(detail, key)) event[key] = detail[key];
      }
      options.onProgress(event);
    }
  }

  function isCancelled(options) {
    if (options && typeof options.shouldCancel === "function" && options.shouldCancel()) return true;
    if (options && options.signal && options.signal.aborted) return true;
    return false;
  }

  function cleanupCancelled(figma, rootFrame, options) {
    try {
      if (figma && figma.currentPage) figma.currentPage.selection = [];
      if (rootFrame && typeof rootFrame.remove === "function") rootFrame.remove();
    } finally {
      progress(options, "cancelled");
    }
  }

  function createFrame(figma, sourceNode, parentRect, options) {
    const rect = rectOf(sourceNode);
    const frame = figma.createFrame();
    frame.name = semanticName(sourceNode, "Frame");
    place(frame, rect, parentRect);
    applyStyle(frame, sourceNode, options && options.scene, options);
    applyLayout(frame, sourceNode, options);
    return frame;
  }

  async function createText(figma, sourceNode, parentRect, options) {
    const rect = rectOf(sourceNode);
    const text = figma.createText();
    text.name = semanticName(sourceNode, "Text");
    text.fontName = await loadFont(figma, sourceNode, (options && options.fallbackFont) || DEFAULT_FONT);
    text.characters = String((sourceNode && sourceNode.text) || "");
    if (sourceNode && sourceNode.style && sourceNode.style.fontSize) text.fontSize = number(sourceNode.style.fontSize, 16);
    const color = solidPaint(sourceNode && sourceNode.style ? sourceNode.style.color : undefined);
    if (color) text.fills = [color];
    place(text, rect, parentRect);
    return text;
  }

  function imageHashFor(figma, scene, sourceNode, options) {
    const assetId = (sourceNode && (sourceNode.assetId || sourceNode.src)) || "";
    const asset = (scene && scene.assets && scene.assets[assetId]) || (sourceNode && sourceNode.asset) || null;
    const cacheKey = assetId || (asset && asset.src) || (sourceNode && sourceNode.src);
    if (!cacheKey || !asset) return null;

    if (!options.assetCache) options.assetCache = new Map();
    if (options.assetCache.has(cacheKey)) return options.assetCache.get(cacheKey);

    const bytes = decodeBase64(asset.base64 || asset.data || "");
    const image = figma.createImage(bytes);
    options.assetCache.set(cacheKey, image.hash);
    return image.hash;
  }

  function createImageNode(figma, scene, sourceNode, parentRect, options) {
    const rect = rectOf(sourceNode);
    const imageNode =
      typeof figma.createRectangle === "function" ? figma.createRectangle() : figma.createFrame();
    imageNode.name = semanticName(sourceNode, "Image");
    place(imageNode, rect, parentRect);
    applyStyle(imageNode, sourceNode, scene, options);

    const imageHash = imageHashFor(figma, scene, sourceNode, options);
    if (imageHash) {
      imageNode.fills = [
        {
          type: "IMAGE",
          scaleMode: imageScaleMode(sourceNode),
          imageHash,
        },
      ];
    }

    return imageNode;
  }

  function createSvgNode(figma, sourceNode, parentRect) {
    const rect = rectOf(sourceNode);
    const vector =
      typeof figma.createNodeFromSvg === "function"
        ? figma.createNodeFromSvg(String(sourceNode.svg || "<svg />"))
        : figma.createFrame();
    vector.name = semanticName(sourceNode, "Vector");
    place(vector, rect, parentRect);
    applyStyle(vector, sourceNode, null, {});
    return vector;
  }

  async function createNode(figma, scene, sourceNode, parentRect, options) {
    if (sourceNode && sourceNode.kind === "text") {
      return createText(figma, sourceNode, parentRect, options);
    }

    if (sourceNode && (sourceNode.kind === "image" || sourceNode.kind === "raster")) {
      return createImageNode(figma, scene, sourceNode, parentRect, options);
    }

    if (sourceNode && sourceNode.kind === "svg") {
      return createSvgNode(figma, sourceNode, parentRect);
    }

    const frame = createFrame(figma, sourceNode, parentRect, options);
    const frameRect = rectOf(sourceNode);
    for (const child of (sourceNode && sourceNode.children) || []) {
      append(frame, await createNode(figma, scene, child, frameRect, options));
    }
    return frame;
  }

  async function importSceneToFigma(scene, options = {}) {
    const figma = options.figma || RUNTIME_GLOBAL.figma;
    if (!figma) {
      throw new Error("Figma API is not available");
    }

    const sourceRoot = scene && scene.root;
    if (!sourceRoot) {
      throw new Error("Capture scene is missing a root node");
    }

    const rootRect = rectOf(sourceRoot);
    progress(options, "import-started", { totalNodes: (sourceRoot.children || []).length + 1 });
    const rootFrame = figma.createFrame();
    rootFrame.name = rootName(scene, sourceRoot);
    rootFrame.x = 0;
    rootFrame.y = 0;
    rootFrame.resize(rootRect.width, rootRect.height);
    const importOptions = {};
    for (const key in options || {}) {
      if (Object.prototype.hasOwnProperty.call(options, key)) importOptions[key] = options[key];
    }
    importOptions.assetCache = new Map();
    importOptions.figma = figma;
    importOptions.scene = scene;
    applyStyle(rootFrame, sourceRoot, scene, importOptions);
    applyLayout(rootFrame, sourceRoot, importOptions);
    const children = sourceRoot.children || [];
    for (let index = 0; index < children.length; index++) {
      progress(options, "creating-nodes", { current: index + 1, total: children.length });
      if (isCancelled(options)) {
        cleanupCancelled(figma, rootFrame, options);
        return { ok: false, cancelled: true, root: rootFrame };
      }
      const child = children[index];
      append(rootFrame, await createNode(figma, scene, child, rootRect, importOptions));
      if (isCancelled(options)) {
        cleanupCancelled(figma, rootFrame, options);
        return { ok: false, cancelled: true, root: rootFrame };
      }
    }

    figma.currentPage.appendChild(rootFrame);
    figma.currentPage.selection = [rootFrame];
    figma.viewport.scrolledAndZoomedIntoView([rootFrame]);
    progress(options, "completed");

    return { ok: true, root: rootFrame };
  }

  return {
    importSceneToFigma,
  };
});

(function (runtimeRoot) {
  if (typeof figma === "undefined" || !figma.showUI || !runtimeRoot.WebToFigmaImporter) {
    return;
  }

  let cancelled = false;

  function post(type, payload = {}) {
    const message = { type: type };
    for (const key in payload || {}) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) message[key] = payload[key];
    }
    figma.ui.postMessage(message);
  }

  figma.showUI(__html__, {
    width: 420,
    height: 640,
    themeColors: true,
  });

  figma.ui.onmessage = async (message) => {
    if (!message || typeof message !== "object") return;

    if (message.type === "close") {
      figma.closePlugin();
      return;
    }

    if (message.type === "cancel-import") {
      cancelled = true;
      return;
    }

    if (message.type !== "import-capture") return;

    cancelled = false;
    try {
      const result = await runtimeRoot.WebToFigmaImporter.importSceneToFigma(message.payload, {
        figma,
        layoutMode: message.layoutMode || "visual",
        fallbackFont: message.fallbackFont || { family: "Inter", style: "Regular" },
        shouldCancel: () => cancelled,
        onProgress: (event) => {
          post("import-progress", event);
        },
      });

      if (result.cancelled) {
        post("import-cancelled");
        return;
      }

      post("import-complete");
    } catch (error) {
      post("import-failed", {
        message: (error && error.message) || String(error),
      });
    }
  };
})(typeof self !== "undefined" ? self : this);
