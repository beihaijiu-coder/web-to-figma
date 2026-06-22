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

  function cssNumber(value, fallback = 0) {
    const parsed = Number.parseFloat(String(value || "").replace("px", ""));
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

  function assignSourceRect(node, rect) {
    if (!node) return;
    const next = {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };

    node.rect = next;
    if (node.absoluteRect) {
      node.absoluteRect = {
        x: next.x,
        y: next.y,
        width: next.width,
        height: next.height,
      };
    }
    if (node.design && node.design.absoluteRect) {
      node.design.absoluteRect = {
        x: next.x,
        y: next.y,
        width: next.width,
        height: next.height,
      };
    }
    if (node.layout && node.layout.absolute) {
      node.layout.absolute = {
        x: next.x,
        y: next.y,
        width: next.width,
        height: next.height,
      };
    }
  }

  function visitSourceTree(node, visitor) {
    if (!node || typeof node !== "object") return;
    visitor(node);
    const children = node.children || [];
    for (let index = 0; index < children.length; index++) {
      visitSourceTree(children[index], visitor);
    }
  }

  function sourceRectsIntersect(a, b, tolerance) {
    const gap = tolerance || 0;
    return (
      a.x < b.x + b.width - gap &&
      a.x + a.width > b.x + gap &&
      a.y < b.y + b.height - gap &&
      a.y + a.height > b.y + gap
    );
  }

  function sourceRectIntersection(a, b) {
    if (!sourceRectsIntersect(a, b, 0)) return null;
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return {
      x,
      y,
      width: Math.max(0, right - x),
      height: Math.max(0, bottom - y),
    };
  }

  function isTransparentSourceColor(value) {
    const raw = String(value || "").trim().toLowerCase();
    return (
      !raw ||
      raw === "transparent" ||
      raw === "rgba(0, 0, 0, 0)" ||
      raw === "rgba(0,0,0,0)" ||
      /rgba\([^)]*,\s*0(?:\.0+)?\s*\)/.test(raw)
    );
  }

  function sourceHasVisiblePaint(node, options) {
    const nodeType = String((node && (node.kind || node.type)) || "").toLowerCase();
    const style = (node && node.style) || {};
    const includeBackground = options && options.includeBackground;

    if (nodeType === "text" && String((node && node.text) || "").trim()) return true;
    if (nodeType === "image" || nodeType === "raster" || nodeType === "svg") return true;
    if (node && (node.assetId || node.svg)) return true;
    if (style.backgroundAssetId || style.fill) return true;
    if (number(style.borderWidth) > 0 && !isTransparentSourceColor(style.borderColor)) return true;
    if (includeBackground && !isTransparentSourceColor(style.backgroundColor)) return true;
    return false;
  }

  function sourceHasVisibleContentInRegion(node, region, options) {
    let found = false;
    visitSourceTree(node, (candidate) => {
      if (found) return;
      const rect = rectOf(candidate);
      if (!sourceRectsIntersect(rect, region, 0.5)) return;
      const overlap = sourceRectIntersection(rect, region);
      if (!overlap || overlap.width < 1 || overlap.height < 1) return;
      if (sourceHasVisiblePaint(candidate, options)) found = true;
    });
    return found;
  }

  function isFixedShellSourceNode(node) {
    const style = (node && node.style) || {};
    const design = (node && node.design) || {};
    const position = String(style.position || design.position || "").toLowerCase();
    return position === "fixed" || position === "sticky";
  }

  function isTopShellSourceNode(node, rootRect) {
    const rect = rectOf(node);
    const maxHeight = Math.min(160, Math.max(48, rootRect.height * 0.3));
    return (
      rect.y <= rootRect.y + 4 &&
      rect.height >= 24 &&
      rect.height <= maxHeight &&
      rect.width >= Math.min(rootRect.width * 0.5, 480) &&
      rect.width >= rect.height * 3
    );
  }

  function isSideShellSourceNode(node, rootRect) {
    const rect = rectOf(node);
    const nearLeft = rect.x <= rootRect.x + 4;
    const nearRight = rect.x + rect.width >= rootRect.x + rootRect.width - 4;
    return (
      (nearLeft || nearRight) &&
      rect.y <= rootRect.y + 4 &&
      rect.width >= 72 &&
      rect.width <= rootRect.width * 0.45 &&
      rect.height >= 160 &&
      rect.height >= rect.width * 1.5
    );
  }

  function translateSourceTree(node, deltaY) {
    if (!node || !Number.isFinite(deltaY) || Math.abs(deltaY) < 0.5) return;
    const rect = rectOf(node);
    assignSourceRect(node, {
      x: rect.x,
      y: rect.y + deltaY,
      width: rect.width,
      height: rect.height,
    });
    const children = node.children || [];
    for (let index = 0; index < children.length; index++) {
      translateSourceTree(children[index], deltaY);
    }
  }

  function moveSideShellSourceBelowTop(sideNode, targetTop) {
    const rect = rectOf(sideNode);
    const deltaY = targetTop - rect.y;
    if (deltaY <= 0.5 || targetTop >= rect.y + rect.height - 24) return false;

    translateSourceTree(sideNode, deltaY);
    const nextRect = rectOf(sideNode);
    assignSourceRect(sideNode, {
      x: nextRect.x,
      y: nextRect.y,
      width: nextRect.width,
      height: Math.max(1, rect.y + rect.height - targetTop),
    });
    return true;
  }

  function isInsetTopShellSourceItem(item, rootRect) {
    const rect = item && item.rect ? item.rect : rectOf(item && item.node);
    return rect.x > rootRect.x + 4 || rect.width < rootRect.width - 8;
  }

  function moveTopShellSourceBelowTop(shellNode, targetTop) {
    const rect = rectOf(shellNode);
    const deltaY = targetTop - rect.y;
    if (deltaY <= 0.5) return false;
    translateSourceTree(shellNode, deltaY);
    return true;
  }

  function normalizeFixedShellOverlaps(scene) {
    const root = scene && scene.root;
    if (!root) return 0;

    const rootRect = rectOf(root);
    const fixedNodes = [];
    visitSourceTree(root, (node) => {
      if (node === root || !isFixedShellSourceNode(node)) return;
      const rect = rectOf(node);
      if (rect.width <= 1 || rect.height <= 1) return;
      fixedNodes.push({ node, rect });
    });

    const topShells = [];
    const sideShells = [];
    for (let index = 0; index < fixedNodes.length; index++) {
      const item = fixedNodes[index];
      if (isTopShellSourceNode(item.node, rootRect)) topShells.push(item);
      if (isSideShellSourceNode(item.node, rootRect)) sideShells.push(item);
    }

    let adjusted = 0;
    for (let shellIndex = 0; shellIndex < topShells.length; shellIndex++) {
      const topShell = topShells[shellIndex];
      if (!isInsetTopShellSourceItem(topShell, rootRect)) continue;

      let targetTop = topShell.rect.y;
      for (let blockerIndex = 0; blockerIndex < topShells.length; blockerIndex++) {
        const blocker = topShells[blockerIndex];
        if (blocker.node === topShell.node) continue;
        if (isInsetTopShellSourceItem(blocker, rootRect)) continue;

        const overlap = sourceRectIntersection(topShell.rect, blocker.rect);
        if (!overlap || overlap.width < 8 || overlap.height < 8) continue;
        if (!sourceHasVisibleContentInRegion(blocker.node, overlap)) continue;
        if (!sourceHasVisibleContentInRegion(topShell.node, overlap, { includeBackground: true })) continue;
        targetTop = Math.max(targetTop, blocker.rect.y + blocker.rect.height);
      }

      if (moveTopShellSourceBelowTop(topShell.node, targetTop)) adjusted++;
    }

    for (let sideIndex = 0; sideIndex < sideShells.length; sideIndex++) {
      const sideShell = sideShells[sideIndex];
      let targetTop = sideShell.rect.y;

      for (let topIndex = 0; topIndex < topShells.length; topIndex++) {
        const topShell = topShells[topIndex];
        const overlap = sourceRectIntersection(sideShell.rect, topShell.rect);
        if (!overlap || overlap.width < 8 || overlap.height < 8) continue;
        if (!sourceHasVisibleContentInRegion(topShell.node, overlap)) continue;
        if (!sourceHasVisibleContentInRegion(sideShell.node, overlap, { includeBackground: true })) continue;
        targetTop = Math.max(targetTop, topShell.rect.y + topShell.rect.height);
      }

      if (moveSideShellSourceBelowTop(sideShell.node, targetTop)) adjusted++;
    }

    if (adjusted > 0) {
      scene.capture = scene.capture || {};
      scene.capture.normalizedFixedShells = {
        adjusted,
        strategy: "avoid-overlapping-fixed-top-and-side-shells",
      };
    }

    return adjusted;
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

  function rawNodeName(node, fallback) {
    return String((node && (node.name || node.ariaLabel || node.role || node.tag)) || fallback || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tagFromRawName(raw) {
    const match = String(raw || "").match(/^(h[1-6]|[a-z][a-z0-9-]*)(?:[.#]|$)/);
    return match ? match[1].toLowerCase() : "";
  }

  function inferredTag(node) {
    const source = node && node.source ? node.source : {};
    const tag = String((node && node.tag) || source.tag || "").toLowerCase();
    return tag || tagFromRawName(rawNodeName(node, ""));
  }

  function classNameFromRawName(raw) {
    const text = String(raw || "");
    const firstDot = text.indexOf(".");
    if (firstDot < 0) return "";
    return text.slice(firstDot + 1).replace(/\./g, " ");
  }

  function rawClassName(node) {
    const source = node && node.source ? node.source : {};
    return String(source.className || classNameFromRawName(rawNodeName(node, "")) || "");
  }

  function hasExactClass(node, className) {
    const classes = rawClassName(node).split(/\s+/);
    for (let index = 0; index < classes.length; index++) {
      if (classes[index] === className) return true;
    }
    return false;
  }

  function rawId(node) {
    const source = node && node.source ? node.source : {};
    if (source.id) return String(source.id);
    const match = rawNodeName(node, "").match(/#([A-Za-z0-9_-]+)/);
    return match ? match[1] : "";
  }

  function isUtilityClassName(value) {
    const part = String(value || "").trim();
    if (!part) return true;
    if (/^astro-/i.test(part)) return true;
    if (/^(?:sm|md|lg|xl|2xl):/.test(part)) return true;
    if (/[\[\]]/.test(part)) return true;
    return /^(?:sl-|css-|sc-|group|peer|flex|inline-flex|grid|block|hidden|relative|absolute|fixed|sticky|static|top-|right-|bottom-|left-|z-|w-|h-|min-|max-|p-|px-|py-|pt-|pr-|pb-|pl-|m-|mx-|my-|mt-|mr-|mb-|ml-|gap-|items-|justify-|content-|rounded|border|bg-|text-|font-|leading-|tracking-|opacity-|transition|duration-|ease-|shadow|overflow-|object-|list-|no-underline|underline|cursor-|select-)/i.test(
      part
    );
  }

  function meaningfulClasses(node) {
    return rawClassName(node)
      .split(/\s+/)
      .filter((part) => part && !isUtilityClassName(part));
  }

  function hasClassWord(node, pattern) {
    const haystack = `${rawClassName(node)} ${rawId(node)} ${rawNodeName(node, "")}`.toLowerCase();
    return pattern.test(haystack);
  }

  function hasClassOrIdWord(node, pattern) {
    const haystack = `${rawClassName(node)} ${rawId(node)}`.toLowerCase();
    return pattern.test(haystack);
  }

  function isDomLikeNodeName(node, raw, tag) {
    if (tag) return true;
    return /\.astro-|^astro-island$|^sl-[a-z0-9-]+/i.test(String(raw || ""));
  }

  function classBasedLayerName(node) {
    if (hasClassOrIdWord(node, /right-sidebar/)) return "Right Sidebar";
    if (rawId(node) === "starlight__sidebar" || hasExactClass(node, "sidebar") || hasExactClass(node, "sidebar-pane")) {
      return "Sidebar";
    }
    if (hasClassOrIdWord(node, /main-frame/)) return "Main Frame";
    if (hasClassOrIdWord(node, /main-pane/)) return "Main Pane";
    if (hasClassOrIdWord(node, /content-panel/)) return "Content Panel";
    if (hasClassOrIdWord(node, /pagination/)) return "Pagination";

    const classes = meaningfulClasses(node).filter((part) => part !== "page");
    return classes.length ? titleCase(classes[0]) : "";
  }

  function landmarkLayerName(tag, node) {
    if (tag === "body") return "Body";
    if (tag === "header") return "Header";
    if (tag === "main") return "Main";
    if (tag === "footer") return "Footer";
    if (tag === "nav") return hasClassWord(node, /\bsidebar\b/) ? "Sidebar" : "Navigation";
    if (tag === "aside") return hasClassWord(node, /right-sidebar/) ? "Right Sidebar" : "Aside";
    if (tag === "article") return "Article";
    if (tag === "section") return classBasedLayerName(node) || "Section";
    return "";
  }

  function textSummaryForNode(node) {
    return textSummary(sourceTextContent(node));
  }

  function semanticName(node, fallback) {
    if (node && node.kind === "text" && !node.name) {
      const prefix = titleCase(node.role || node.tag || "Text");
      const summary = textSummary(node.text);
      return summary ? `${prefix} · ${summary}` : prefix;
    }

    const raw = rawNodeName(node, fallback);
    const tag = inferredTag(node);
    const landmark = landmarkLayerName(tag, node);
    if (landmark) return landmark;

    if (tag === "a") {
      const linkText = textSummaryForNode(node);
      return linkText ? `Link · ${linkText}` : "Link";
    }
    if (tag === "button") {
      const buttonText = textSummaryForNode(node);
      return buttonText ? `Button · ${buttonText}` : "Button";
    }
    if (tag === "img") {
      const imageText = textSummary((node && (node.alt || node.ariaLabel)) || raw);
      return imageText ? `Image · ${imageText}` : "Image";
    }
    if (tag === "svg") return "Icon";
    if (tag === "ul" || tag === "ol") return classBasedLayerName(node) || "List";
    if (tag === "li") return "List Item";
    if (tag === "p") return "Paragraph";
    if (tag === "blockquote") return "Quote";
    if (tag === "figcaption") return "Caption";
    if (tag === "summary") return classBasedLayerName(node) || "Summary";
    if (tag === "details") return classBasedLayerName(node) || "Details";
    if (/^h[1-6]$/.test(tag)) {
      const headingText = textSummaryForNode(node);
      return headingText ? `Heading · ${headingText}` : "Heading";
    }

    const className = classBasedLayerName(node);
    if (className) return className;
    if (!isDomLikeNodeName(node, raw, tag)) return raw || fallback;
    return tag ? titleCase(tag) : raw || fallback;
  }

  function rootName(scene, rootNode) {
    const base = `Web to Figma · ${semanticName(rootNode, (scene && scene.source && scene.source.url) || "Capture")}`;
    const flow = scene && scene.capture && scene.capture.contentFlow;
    if (flow && flow.isSegment) {
      if (flow.stoppedByUser || flow.reason === "user-stopped") {
        return `${base} · 手动停止采集`;
      }
      return `${base} · 内容流第 ${number(flow.segmentIndex, 1)} 段`;
    }
    return base;
  }

  function fontStyleFromWeight(weight) {
    const numeric = number(weight, 400);
    if (numeric >= 800) return "Bold";
    if (numeric >= 700) return "Bold";
    if (numeric >= 600) return "Semi Bold";
    if (numeric <= 300) return "Light";
    return "Regular";
  }

  const GENERIC_FONT_FAMILIES = new Set([
    "cursive",
    "fantasy",
    "monospace",
    "sans-serif",
    "serif",
    "system-ui",
    "ui-monospace",
    "ui-rounded",
    "ui-sans-serif",
    "ui-serif",
  ]);

  function fontFamilies(value) {
    return splitCssLayers(value)
      .map((family) => family.trim().replace(/^["']|["']$/g, ""))
      .filter(
        (family) =>
          family && !GENERIC_FONT_FAMILIES.has(family.toLowerCase())
      );
  }

  function uniqueFontNames(fonts) {
    const seen = new Set();
    return (fonts || []).filter((font) => {
      if (!font || !font.family || !font.style) return false;
      const key = `${font.family.toLowerCase()}/${font.style.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function isIconFontFamily(family) {
    return /(?:^|[\s_-])(icon|icons|symbol|symbols|emoji)(?:$|[\s_-])/i.test(
      String(family || "")
    );
  }

  function textFontFamilies(families) {
    const list = families || [];
    const primaryIsIconFont = list.length > 0 && isIconFontFamily(list[0]);
    return list.filter(
      (family, index) =>
        index === 0 || primaryIsIconFont || !isIconFontFamily(family)
    );
  }

  function fontStyleWeight(style) {
    const value = String(style || "").toLowerCase().replace(/[-_]+/g, " ");
    if (/thin|hairline/.test(value)) return 100;
    if (/extra\s*light|ultra\s*light/.test(value)) return 200;
    if (/light/.test(value)) return 300;
    if (/medium/.test(value)) return 500;
    if (/semi\s*bold|demi\s*bold/.test(value)) return 600;
    if (/extra\s*bold|ultra\s*bold/.test(value)) return 800;
    if (/black|heavy/.test(value)) return 900;
    if (/bold/.test(value)) return 700;
    return 400;
  }

  function isItalicStyle(style) {
    return /italic|oblique/i.test(String(style || ""));
  }

  function fontStyleCandidates(weight, italic) {
    const numeric = number(weight, 400);
    let styles;
    if (numeric >= 850) styles = ["Black", "Heavy", "Extra Bold", "ExtraBold", "Bold"];
    else if (numeric >= 750) styles = ["Extra Bold", "ExtraBold", "Bold", "Semibold", "Semi Bold"];
    else if (numeric >= 650) styles = ["Bold", "Semibold", "Semi Bold", "Demi Bold"];
    else if (numeric >= 550) styles = ["Semibold", "Semi Bold", "Demi Bold", "Medium", "Bold"];
    else if (numeric >= 450) styles = ["Medium", "Regular", "Book"];
    else if (numeric <= 150) styles = ["Thin", "Hairline", "Light", "Regular"];
    else if (numeric <= 350) styles = ["Light", "Regular", "Book"];
    else styles = ["Regular", "Book", "Normal"];

    if (!italic) return styles;
    return styles
      .map((style) => (style === "Regular" || style === "Normal" ? "Italic" : `${style} Italic`))
      .concat("Italic");
  }

  function fontFaceScore(fontName, desiredWeight, desiredItalic) {
    const italicPenalty = isItalicStyle(fontName.style) === desiredItalic ? 0 : 1000;
    return italicPenalty + Math.abs(fontStyleWeight(fontName.style) - desiredWeight);
  }

  async function availableFontNames(figma, options) {
    if (!figma || typeof figma.listAvailableFontsAsync !== "function") return null;
    if (!options.availableFontsPromise) {
      options.availableFontsPromise = figma
        .listAvailableFontsAsync()
        .then((fonts) => (fonts || []).map((font) => font && font.fontName).filter(Boolean))
        .catch(() => null);
    }
    return options.availableFontsPromise;
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

  function parseGradientColor(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "transparent") {
      return { r: 0, g: 0, b: 0, a: 0 };
    }
    return parseColor(value);
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

  function splitCssLayers(value) {
    const raw = String(value || "");
    const layers = [];
    let start = 0;
    let depth = 0;
    let quote = "";

    for (let index = 0; index < raw.length; index++) {
      const char = raw[index];
      const previous = raw[index - 1];

      if (quote) {
        if (char === quote && previous !== "\\") quote = "";
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }

      if (char === "(") depth++;
      if (char === ")") depth = Math.max(0, depth - 1);
      if (char === "," && depth === 0) {
        const layer = raw.slice(start, index).trim();
        if (layer) layers.push(layer);
        start = index + 1;
      }
    }

    const tail = raw.slice(start).trim();
    if (tail) layers.push(tail);
    return layers;
  }

  function gradientPaint(value) {
    const raw = String(value || "");
    if (!/\b(?:linear|radial|conic|repeating-linear|repeating-radial|repeating-conic)-gradient\(/i.test(raw)) {
      return null;
    }

    const colors = [];
    const colorRegex = /(#[0-9a-f]{3,6}|rgba?\([^)]+\)|transparent)/gi;
    let match = colorRegex.exec(raw);
    while (match) {
      const color = parseGradientColor(match[1]);
      if (color) colors.push(color);
      match = colorRegex.exec(raw);
    }
    if (colors.length < 2) return null;

    return {
      type: /\bradial-gradient\(/i.test(raw) ? "GRADIENT_RADIAL" : "GRADIENT_LINEAR",
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

  function gradientPaints(value) {
    return splitCssLayers(value)
      .map((layer) => gradientPaint(layer))
      .filter(Boolean);
  }

  function fillPaint(value) {
    return gradientPaints(value)[0] || solidPaint(value);
  }

  function fillPaints(value) {
    const gradients = gradientPaints(value);
    if (gradients.length) return gradients;
    const solid = solidPaint(value);
    return solid ? [solid] : [];
  }

  function clearDefaultFill(node) {
    if (node && "fills" in node) node.fills = [];
  }

  function colorFromDesign(value) {
    if (!value) return null;
    if (typeof value === "string") return parseColor(value);
    if (typeof value === "object") {
      return {
        r: clamp01(number(value.r)),
        g: clamp01(number(value.g)),
        b: clamp01(number(value.b)),
        a: value.a === undefined ? 1 : clamp01(number(value.a, 1)),
      };
    }
    return null;
  }

  function solidPaintFromDesign(fill) {
    const color = colorFromDesign(fill && (fill.color || fill.css));
    if (!color) return null;
    return {
      type: "SOLID",
      color: { r: color.r, g: color.g, b: color.b },
      opacity: color.a,
    };
  }

  function strokePaintFromDefinition(stroke) {
    const color = colorFromDesign(stroke && (stroke.color || stroke.css || stroke.colorCss));
    if (!color) return null;
    return {
      type: "SOLID",
      color: { r: color.r, g: color.g, b: color.b },
      opacity: color.a,
    };
  }

  const BORDER_SIDES = [
    { side: "top", width: "borderTopWidth", color: "borderTopColor" },
    { side: "right", width: "borderRightWidth", color: "borderRightColor" },
    { side: "bottom", width: "borderBottomWidth", color: "borderBottomColor" },
    { side: "left", width: "borderLeftWidth", color: "borderLeftColor" },
  ];

  function styleStrokeDefinitions(style = {}) {
    const sideStrokes = BORDER_SIDES
      .map((entry) => {
        const width = number(style[entry.width], 0);
        const colorCss = style[entry.color] || style.borderColor;
        const paint = solidPaint(colorCss);
        if (!width || !paint) return null;
        return {
          side: entry.side,
          width,
          color: colorCss,
        };
      })
      .filter(Boolean);

    if (sideStrokes.length) return sideStrokes;

    const width = number(style.borderWidth, 0);
    const paint = solidPaint(style.borderColor);
    return width && paint
      ? [
          {
            side: "all",
            width,
            color: style.borderColor,
          },
        ]
      : [];
  }

  function strokeDefinitions(sourceNode) {
    const design = sourceNode && sourceNode.design ? sourceNode.design : {};
    if (Array.isArray(design.strokes) && design.strokes.length) {
      return design.strokes
        .map((stroke) => ({
          side: String(stroke.side || "all").toLowerCase(),
          width: number(stroke.width, 1),
          color: stroke.color || stroke.css || stroke.colorCss,
        }))
        .filter((stroke) => stroke.width > 0 && strokePaintFromDefinition(stroke));
    }

    return styleStrokeDefinitions((sourceNode && sourceNode.style) || {});
  }

  function sameStrokeDefinition(left, right) {
    if (!left || !right || number(left.width) !== number(right.width)) return false;
    const leftColor = colorFromDesign(left.color);
    const rightColor = colorFromDesign(right.color);
    if (!leftColor || !rightColor) return false;
    return (
      leftColor.r === rightColor.r &&
      leftColor.g === rightColor.g &&
      leftColor.b === rightColor.b &&
      leftColor.a === rightColor.a
    );
  }

  function uniformStrokeDefinition(sourceNode) {
    const strokes = strokeDefinitions(sourceNode);
    if (strokes.length === 1 && strokes[0].side === "all") return strokes[0];
    if (strokes.length === 4) {
      const sides = new Set(strokes.map((stroke) => stroke.side));
      const coversAllSides = BORDER_SIDES.every((entry) => sides.has(entry.side));
      if (coversAllSides && strokes.every((stroke) => sameStrokeDefinition(stroke, strokes[0]))) {
        return { side: "all", width: strokes[0].width, color: strokes[0].color };
      }
    }
    return null;
  }

  function sideStrokeDefinitions(sourceNode) {
    if (uniformStrokeDefinition(sourceNode)) return [];
    return strokeDefinitions(sourceNode).filter((stroke) => stroke.side && stroke.side !== "all");
  }

  function gradientPaintFromDesign(fill) {
    const stops = (fill && fill.stops) || [];
    if (!stops.length) return null;
    return {
      type: fill.type === "radial-gradient" ? "GRADIENT_RADIAL" : "GRADIENT_LINEAR",
      gradientStops: stops
        .map((stop, index) => {
          const color = colorFromDesign(stop.color);
          if (!color) return null;
          return {
            position: stop.position === undefined ? index / Math.max(1, stops.length - 1) : number(stop.position),
            color: { r: color.r, g: color.g, b: color.b, a: color.a },
          };
        })
        .filter(Boolean),
      gradientTransform: [
        [1, 0, 0],
        [0, 1, 0],
      ],
    };
  }

  function imagePaintFromDesign(figma, scene, fill, options) {
    const asset = assetFor(scene, { assetId: fill && fill.assetId });
    if (isSvgAsset(asset)) return null;
    const imageHash = imageHashFor(figma, scene, { assetId: fill && fill.assetId, style: { objectFit: fill && fill.fit } }, options);
    if (!imageHash) return null;
    return {
      type: "IMAGE",
      scaleMode: imageScaleMode({ style: { objectFit: fill && fill.fit } }),
      imageHash,
    };
  }

  function paintFromDesignFill(figma, scene, fill, options) {
    const type = String((fill && fill.type) || "").toLowerCase();
    if (type === "solid") return solidPaintFromDesign(fill);
    if (type === "linear-gradient" || type === "radial-gradient") return gradientPaintFromDesign(fill);
    if (type === "image") return imagePaintFromDesign(figma, scene, fill, options);
    return null;
  }

  function paintsFromDesign(figma, scene, sourceNode, options) {
    const fills = sourceNode && sourceNode.design && Array.isArray(sourceNode.design.fills)
      ? sourceNode.design.fills
      : [];
    return fills
      .map((fill) => paintFromDesignFill(figma, scene, fill, options))
      .filter(Boolean);
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
    const design = sourceNode && sourceNode.design ? sourceNode.design : {};
    const designFills = paintsFromDesign(figmaFromOptions(options), scene, sourceNode, options);
    const backgroundAsset = style.backgroundAssetId
      ? assetFor(scene, { assetId: style.backgroundAssetId })
      : null;
    const backgroundImageHash = style.backgroundAssetId
      && !isSvgAsset(backgroundAsset)
      ? imageHashFor(figmaFromOptions(options), scene, { assetId: style.backgroundAssetId }, options)
      : null;
    const fallbackFills = fillPaints(style.backgroundColor || style.background || style.fill);
    if (designFills.length) {
      node.fills = designFills;
    } else if (backgroundImageHash) {
      const fills = [
        {
          type: "IMAGE",
          scaleMode: imageScaleMode(sourceNode),
          imageHash: backgroundImageHash,
        },
      ];
      for (const fill of fallbackFills) fills.push(fill);
      node.fills = fills;
    } else if (fallbackFills.length) {
      node.fills = fallbackFills;
    }

    const uniformStroke = uniformStrokeDefinition(sourceNode);
    const stroke = strokePaintFromDefinition(uniformStroke);
    if (stroke) {
      node.strokes = [stroke];
      node.strokeWeight = number(uniformStroke.width, 1);
    }
    if (design.radius) {
      if ("topLeftRadius" in node) node.topLeftRadius = number(design.radius.topLeft);
      if ("topRightRadius" in node) node.topRightRadius = number(design.radius.topRight);
      if ("bottomRightRadius" in node) node.bottomRightRadius = number(design.radius.bottomRight);
      if ("bottomLeftRadius" in node) node.bottomLeftRadius = number(design.radius.bottomLeft);
      if (!("topLeftRadius" in node) && style.borderRadius !== undefined) {
        node.cornerRadius = number(style.borderRadius, 0);
      }
    } else if (style.borderRadius !== undefined) {
      node.cornerRadius = number(style.borderRadius, 0);
    }
    if (design.opacity !== undefined) node.opacity = number(design.opacity, 1);
    else if (style.opacity !== undefined) node.opacity = number(style.opacity, 1);
    const overflow = `${style.overflow || ""} ${style.overflowX || ""} ${style.overflowY || ""}`;
    // Figma has no scrollable-frame equivalent.  Keeping a browser's overflow crop
    // therefore hides valid captured layers such as off-canvas carousel slides.
    // Let callers choose whether this import is a browser-viewport snapshot or an
    // editable inventory of every captured layer.  This is deliberately based on
    // CSS semantics rather than page-specific selectors.
    const shouldPreserveOverflowClip = options.overflowMode !== "show";
    const shouldClip =
      shouldPreserveOverflowClip &&
      (design.clipsContent === true || /\b(hidden|clip|auto|scroll)\b/i.test(overflow) || style.clipsContent === true);
    if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") {
      node.clipsContent = shouldClip;
    }

    const shadow = parseShadow(style.boxShadow || style.shadow);
    if (shadow) node.effects = [shadow];
  }

  function figmaFromOptions(options = {}) {
    return options.figma || RUNTIME_GLOBAL.figma;
  }

  function applyLayout(node, sourceNode, options = {}) {
    if (options.layoutMode !== "editable" || options.enableAutoLayout !== true) return;

    const layout = sourceNode && sourceNode.layout ? sourceNode.layout : {};
    const candidate = layout.autoLayoutCandidate || {};
    const display = String(layout.display || "").toLowerCase();
    const direction = String(candidate.direction || layout.flexDirection || layout.direction || "row").toLowerCase();
    const isFlex = display === "flex" || display === "inline-flex";
    const wraps = String(layout.flexWrap || "").toLowerCase();
    const isSimpleGrid = display === "grid" && !layout.isComplex;
    const candidateAllowsAuto =
      candidate.enabled === true && number(candidate.confidence, 0) >= 0.75;
    if (!candidateAllowsAuto && ((!isFlex && !isSimpleGrid) || wraps === "wrap" || wraps === "wrap-reverse")) {
      return;
    }

    node.layoutMode = direction.includes("column") || direction === "vertical" ? "VERTICAL" : "HORIZONTAL";
    node.itemSpacing = number(
      candidate.gap !== undefined
        ? candidate.gap
        : layout.gap !== undefined
        ? layout.gap
        : layout.columnGap !== undefined
        ? layout.columnGap
        : layout.rowGap,
      0
    );

    const align = String(candidate.align || layout.alignItems || "").toLowerCase();
    if (align === "center") node.counterAxisAlignItems = "CENTER";
    if (align === "flex-end" || align === "end") node.counterAxisAlignItems = "MAX";
    if (align === "stretch") node.counterAxisAlignItems = "STRETCH";

    const justify = String(candidate.justify || layout.justifyContent || "").toLowerCase();
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

  function decodeBase64Text(base64) {
    const text = String(base64 || "");
    if (!text) return "";

    if (typeof Buffer !== "undefined") {
      return Buffer.from(text, "base64").toString("utf8");
    }

    const binary = atob(text);
    try {
      return decodeURIComponent(
        Array.prototype.map
          .call(binary, (char) => {
            const hex = char.charCodeAt(0).toString(16);
            return `%${hex.length === 1 ? `0${hex}` : hex}`;
          })
          .join("")
      );
    } catch (error) {
      return binary;
    }
  }

  function assetFor(scene, sourceNode) {
    const assetId = (sourceNode && (sourceNode.assetId || sourceNode.src)) || "";
    return (scene && scene.assets && scene.assets[assetId]) || (sourceNode && sourceNode.asset) || null;
  }

  function isSvgAsset(asset) {
    const contentType = String((asset && asset.contentType) || "").toLowerCase();
    const src = String((asset && asset.src) || "").toLowerCase();
    return contentType.indexOf("image/svg") >= 0 || src.indexOf("data:image/svg") === 0 || /\.svg(?:$|\?)/.test(src);
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function svgAttributeValue(attrs, name) {
    const pattern = new RegExp("\\b" + escapeRegExp(name) + "\\s*=\\s*([\"'])(.*?)\\1", "i");
    const match = String(attrs || "").match(pattern);
    return match ? match[2] : "";
  }

  function extractSvgSymbol(spriteSvg, symbolId) {
    const raw = String(spriteSvg || "");
    const id = String(symbolId || "");
    if (!raw || !id) return null;

    function scanTag(tag) {
      const symbolPattern = new RegExp("<" + tag + "\\b([^>]*)>([\\s\\S]*?)</" + tag + ">", "gi");
      let match = symbolPattern.exec(raw);
      while (match) {
        const attrs = match[1] || "";
        if (svgAttributeValue(attrs, "id") === id) {
          return {
            tag,
            attrs,
            content: match[2] || "",
            viewBox: svgAttributeValue(attrs, "viewBox"),
          };
        }
        match = symbolPattern.exec(raw);
      }
      return null;
    }

    return scanTag("symbol") || scanTag("g") || scanTag("svg");
  }

  function svgUsePresentationAttributes(useTag) {
    const raw = String(useTag || "");
    const attrs = [];
    const attrPattern = /\s([:\w-]+)\s*=\s*(["'])(.*?)\2/g;
    let match = attrPattern.exec(raw);
    while (match) {
      const name = match[1];
      if (/^(?:href|xlink:href|xmlns:xlink)$/i.test(name)) {
        match = attrPattern.exec(raw);
        continue;
      }
      if (
        /^(?:fill|stroke|stroke-width|stroke-linecap|stroke-linejoin|stroke-miterlimit|stroke-dasharray|stroke-dashoffset|opacity|fill-rule|clip-rule|style|class|transform|x|y|width|height)$/i.test(
          name
        )
      ) {
        attrs.push(`${name}=${match[2]}${match[3]}${match[2]}`);
      }
      match = attrPattern.exec(raw);
    }
    return attrs.length ? " " + attrs.join(" ") : "";
  }

  function sourceSvgUseReferences(sourceNode) {
    const explicit = sourceNode && sourceNode.svgUses;
    if (Array.isArray(explicit)) return explicit;
    if (sourceNode && sourceNode.svgUse) return [sourceNode.svgUse];
    return [];
  }

  function spriteTextForUse(scene, useReference) {
    const assetId = useReference && useReference.assetId;
    const asset = assetId ? assetFor(scene, { assetId }) : null;
    if (!asset) return "";
    return asset.svg || decodeBase64Text(asset.base64 || asset.data || "");
  }

  function applySvgViewBox(svg, viewBox) {
    const raw = String(svg || "");
    const box = String(viewBox || "").trim();
    if (!raw || !box || /\bviewBox\s*=/.test(raw)) return raw;
    return raw.replace(/<svg\b([^>]*)>/i, `<svg$1 viewBox="${box}">`);
  }

  function inlineSvgSpriteUses(svg, scene, sourceNode) {
    let output = String(svg || "");
    const uses = sourceSvgUseReferences(sourceNode);
    if (!output || !uses.length) return output;

    for (let index = 0; index < uses.length; index++) {
      const useReference = uses[index] || {};
      const symbolId = String(useReference.symbolId || "").trim();
      const spriteSvg = spriteTextForUse(scene, useReference);
      const symbol = extractSvgSymbol(spriteSvg, symbolId);
      if (!symbol || !symbol.content) continue;

      const symbolPattern = escapeRegExp("#" + symbolId);
      const usePattern = new RegExp(
        "<use\\b(?=[^>]*(?:href|xlink:href)\\s*=\\s*['\\\"][^'\\\"]*" +
          symbolPattern +
          "['\\\"])[^>]*(?:/>|>\\s*</use>)",
        "gi"
      );

      output = output.replace(usePattern, (useTag) => {
        const attrs = svgUsePresentationAttributes(useTag);
        return `<g${attrs}>${symbol.content}</g>`;
      });
      output = applySvgViewBox(output, symbol.viewBox);
    }

    return output;
  }

  function currentColorCss(sourceNode) {
    const style = (sourceNode && sourceNode.style) || {};
    const design = (sourceNode && sourceNode.design) || {};
    const designText = design.text || {};
    const raw = style.color || designText.color || "rgb(0, 0, 0)";
    return String(raw || "rgb(0, 0, 0)");
  }

  function normalizeSvgForFigma(svg, scene, sourceNode) {
    const inlined = inlineSvgSpriteUses(svg, scene, sourceNode);
    return String(inlined || "<svg />").replace(/\bcurrentColor\b/g, currentColorCss(sourceNode));
  }

  function imageScaleMode(sourceNode) {
    const designImage = sourceNode && sourceNode.design && sourceNode.design.image ? sourceNode.design.image : {};
    const fit = String(
      designImage.fit ||
        (sourceNode && sourceNode.style && sourceNode.style.objectFit) ||
        (sourceNode && sourceNode.fit) ||
        ""
    ).toLowerCase();
    if (fit === "contain" || fit === "scale-down") return "FIT";
    if (fit === "tile") return "TILE";
    return "FILL";
  }

  async function loadFont(figma, node, options = {}) {
    const designText = node && node.design && node.design.text ? node.design.text : {};
    const style = node && node.style ? node.style : {};
    const fallbackFont = options.fallbackFont || DEFAULT_FONT;
    const desiredWeight = number(designText.fontWeight || style.fontWeight, 400);
    const desiredItalic = /italic|oblique/i.test(
      String(designText.fontStyle || style.fontStyle || "")
    );
    const sourceFamilies = textFontFamilies(
      fontFamilies(designText.fontFamily || style.fontFamily)
    );
    const familyStack = sourceFamilies
      .concat(fallbackFont.family, DEFAULT_FONT.family)
      .filter(Boolean);
    const cacheKey = `${familyStack.join(",")}|${desiredWeight}|${desiredItalic}`;

    if (!options.fontCache) options.fontCache = new Map();
    const cached = options.fontCache.get(cacheKey);
    if (cached) {
      await figma.loadFontAsync(cached);
      return cached;
    }

    const available = await availableFontNames(figma, options);
    const candidates = [];

    if (Array.isArray(available) && available.length) {
      for (const family of familyStack) {
        const matches = available
          .filter((font) => font.family.toLowerCase() === String(family).toLowerCase())
          .sort(
            (left, right) =>
              fontFaceScore(left, desiredWeight, desiredItalic) -
              fontFaceScore(right, desiredWeight, desiredItalic)
          );
        for (const match of matches) candidates.push(match);
      }

      if (!candidates.length) {
        const sortedAvailable = available.slice().sort(
          (left, right) =>
            fontFaceScore(left, desiredWeight, desiredItalic) -
            fontFaceScore(right, desiredWeight, desiredItalic)
        );
        for (const fontName of sortedAvailable) candidates.push(fontName);
      }
    } else {
      const styles = fontStyleCandidates(desiredWeight, desiredItalic);
      for (const family of sourceFamilies) {
        for (const styleName of styles) candidates.push({ family, style: styleName });
      }
    }

    candidates.push(
      fallbackFont,
      DEFAULT_FONT,
      {
        family: familyStack[0] || DEFAULT_FONT.family,
        style: fontStyleFromWeight(desiredWeight),
      }
    );

    let lastError = null;
    for (const fontName of uniqueFontNames(candidates)) {
      try {
        await figma.loadFontAsync(fontName);
        options.fontCache.set(cacheKey, fontName);
        return fontName;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("No available Figma font could be loaded");
  }

  function place(node, rect, parentRect) {
    node.x = rect.x - parentRect.x;
    node.y = rect.y - parentRect.y;
    if (typeof node.resize === "function") node.resize(rect.width, rect.height);
  }

  function cssLineHeight(style) {
    const raw = String((style && style.lineHeight) || "").trim();
    const fontSize = cssNumber(style && style.fontSize, 16);
    if (!raw || raw === "normal") return null;
    if (raw.endsWith("%")) return (cssNumber(raw, 100) / 100) * fontSize;
    if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) * fontSize;
    return cssNumber(raw, null);
  }

  function applyTextMetrics(text, sourceNode) {
    const style = (sourceNode && sourceNode.style) || {};
    const designText = sourceNode && sourceNode.design && sourceNode.design.text ? sourceNode.design.text : {};
    const lineHeight = cssLineHeight(style);
    const letterSpacing = cssNumber(designText.letterSpacing || style.letterSpacing, null);

    const designLineHeight = cssNumber(designText.lineHeight, null);
    const finalLineHeight = designLineHeight !== null && Number.isFinite(designLineHeight)
      ? designLineHeight
      : lineHeight;
    if (finalLineHeight && Number.isFinite(finalLineHeight)) {
      text.lineHeight = { unit: "PIXELS", value: finalLineHeight };
    }
    if (letterSpacing !== null && Number.isFinite(letterSpacing)) {
      text.letterSpacing = { unit: "PIXELS", value: letterSpacing };
    }
  }

  function applyTextRendering(text, sourceNode) {
    const style = (sourceNode && sourceNode.style) || {};
    const designText = sourceNode && sourceNode.design && sourceNode.design.text ? sourceNode.design.text : {};
    const textTransform = String(designText.transform || style.textTransform || "").toLowerCase();
    const textAlign = String(designText.align || style.textAlign || "").toLowerCase();
    const textDecorationLine = String(designText.decoration || style.textDecorationLine || "").toLowerCase();

    if (textTransform === "uppercase") text.textCase = "UPPER";
    if (textTransform === "lowercase") text.textCase = "LOWER";
    if (textTransform === "capitalize") text.textCase = "TITLE";

    if (textAlign === "center") text.textAlignHorizontal = "CENTER";
    if (textAlign === "right" || textAlign === "end") text.textAlignHorizontal = "RIGHT";
    if (textAlign === "justify") text.textAlignHorizontal = "JUSTIFIED";
    if (textAlign === "left" || textAlign === "start") text.textAlignHorizontal = "LEFT";

    if (textDecorationLine.includes("underline")) text.textDecoration = "UNDERLINE";
    if (textDecorationLine.includes("line-through")) text.textDecoration = "STRIKETHROUGH";
  }

  function estimatedLineHeight(sourceNode, rect) {
    const style = (sourceNode && sourceNode.style) || {};
    const parsed = cssLineHeight(style);
    if (parsed && Number.isFinite(parsed)) return parsed;

    const fontSize = number(style.fontSize, 16);
    return Math.max(1, fontSize * 1.2, rect.height);
  }

  function textAutoResizeMode(sourceNode, rect) {
    const text = String((sourceNode && sourceNode.text) || "");
    if (!text.trim()) return "NONE";
    if (/[\r\n]/.test(text)) return "HEIGHT";

    const lineHeight = estimatedLineHeight(sourceNode, rect);
    const measuredLines = Math.max(1, rect.height / lineHeight);
    return measuredLines <= 1.35 ? "WIDTH_AND_HEIGHT" : "HEIGHT";
  }

  function append(parent, child) {
    if (typeof parent.appendChild === "function") {
      parent.appendChild(child);
    }
  }

  function appendAll(parent, children) {
    for (let index = 0; index < (children || []).length; index++) {
      append(parent, children[index]);
    }
  }

  const INLINE_TEXT_TAGS = new Set([
    "a",
    "abbr",
    "b",
    "bdi",
    "bdo",
    "br",
    "cite",
    "code",
    "data",
    "dfn",
    "em",
    "i",
    "kbd",
    "mark",
    "q",
    "s",
    "samp",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "time",
    "u",
    "var",
    "wbr",
  ]);
  const AGGREGATED_TEXT_TAGS = new Set(["p", "figcaption", "blockquote"]);

  function sourceTag(sourceNode) {
    return String((sourceNode && (sourceNode.tag || (sourceNode.source && sourceNode.source.tag))) || "").toLowerCase();
  }

  function sourceTextContent(sourceNode) {
    if (!sourceNode) return "";
    const nodeType = sourceNode.kind || sourceNode.type;
    if (nodeType === "text") return String(sourceNode.text || "");
    return (sourceNode.children || [])
      .map((child) => sourceTextContent(child))
      .join(" ");
  }

  function hasOnlyInlineTextChildren(sourceNode) {
    for (const child of (sourceNode && sourceNode.children) || []) {
      const nodeType = child && (child.kind || child.type);
      if (nodeType === "text") continue;
      if (nodeType !== "frame") return false;
      if (!INLINE_TEXT_TAGS.has(sourceTag(child))) return false;
      if (!hasOnlyInlineTextChildren(child)) return false;
    }
    return true;
  }

  function collapsedInlineTextSource(sourceNode) {
    if (!AGGREGATED_TEXT_TAGS.has(sourceTag(sourceNode))) return null;
    if (!hasOnlyInlineTextChildren(sourceNode)) return null;
    const text = sourceTextContent(sourceNode).replace(/\s+/g, " ").trim();
    if (!text) return null;
    return {
      kind: "text",
      name: `Text · ${textSummary(text)}`,
      text,
      rect: sourceNode && sourceNode.rect,
      style: sourceNode && sourceNode.style,
      design: {
        type: "text",
        text: sourceNode && sourceNode.design ? sourceNode.design.text : undefined,
      },
      source: sourceNode && sourceNode.source,
    };
  }

  function hasClippingLayerStyle(sourceNode) {
    const style = (sourceNode && sourceNode.style) || {};
    const design = (sourceNode && sourceNode.design) || {};
    const overflow = `${style.overflow || ""} ${style.overflowX || ""} ${style.overflowY || ""}`;
    return design.clipsContent === true || style.clipsContent === true || /\b(hidden|clip|auto|scroll)\b/i.test(overflow);
  }

  function hasVisibleDesignFill(sourceNode) {
    const design = (sourceNode && sourceNode.design) || {};
    const fills = Array.isArray(design.fills) ? design.fills : [];
    for (let index = 0; index < fills.length; index++) {
      const fill = fills[index] || {};
      const type = String(fill.type || "").toLowerCase();
      if (type === "image" || type === "linear-gradient" || type === "radial-gradient") return true;
      if (type === "solid") {
        const color = colorFromDesign(fill.color || fill.css);
        if (color && color.a > 0) return true;
      }
    }
    return false;
  }

  function hasVisibleStyleFill(sourceNode) {
    const style = (sourceNode && sourceNode.style) || {};
    if (style.backgroundAssetId) return true;
    return fillPaints(style.backgroundColor || style.background || style.fill).length > 0;
  }

  function hasVisibleLayerStyle(sourceNode) {
    const style = (sourceNode && sourceNode.style) || {};
    const design = (sourceNode && sourceNode.design) || {};
    if (hasVisibleDesignFill(sourceNode) || hasVisibleStyleFill(sourceNode)) return true;
    if (strokeDefinitions(sourceNode).length > 0) return true;
    if (Array.isArray(design.shadows) && design.shadows.length > 0) return true;
    if (style.boxShadow && style.boxShadow !== "none") return true;
    if (number(design.opacity, 1) !== 1 || number(style.opacity, 1) !== 1) return true;
    if (hasClippingLayerStyle(sourceNode)) return true;
    return false;
  }

  function shouldPreserveSemanticFrame(sourceNode) {
    const tag = inferredTag(sourceNode);
    if (
      tag === "header" ||
      tag === "main" ||
      tag === "footer" ||
      tag === "nav" ||
      tag === "aside" ||
      tag === "article" ||
      tag === "section" ||
      tag === "form" ||
      tag === "a" ||
      tag === "button" ||
      tag === "details" ||
      tag === "summary" ||
      tag === "ul" ||
      tag === "ol" ||
      tag === "li" ||
      tag === "p" ||
      tag === "figcaption" ||
      tag === "blockquote"
    ) {
      return true;
    }
    return false;
  }

  function isDomStructuralFrame(sourceNode) {
    const tag = inferredTag(sourceNode);
    const raw = rawNodeName(sourceNode, "");
    if (isDomLikeNodeName(sourceNode, raw, tag)) return true;
    return Boolean(tag);
  }

  function isMeaningfulStructuralGroup(sourceNode) {
    const classes = rawClassName(sourceNode).split(/\s+/);
    for (let index = 0; index < classes.length; index++) {
      if (/^pagination(?:-|$)/.test(classes[index])) return true;
    }
    return false;
  }

  function hasSingleChildWithSameLayerName(sourceNode) {
    const children = (sourceNode && sourceNode.children) || [];
    if (children.length !== 1) return false;
    return semanticName(sourceNode, "") === semanticName(children[0], "");
  }

  function isTinyTransparentWrapper(sourceNode, children) {
    if (!children.length) return false;
    const rect = rectOf(sourceNode);
    if (rect.width > 1 && rect.height > 1) return false;
    if (isDesignRegionFrame(sourceNode)) return false;
    return true;
  }

  function shouldFlattenFrameNode(sourceNode, options) {
    if (options && options.normalizeLayers === false) return false;
    const nodeType = sourceNode && (sourceNode.kind || sourceNode.type);
    if (nodeType !== "frame") return false;
    if (!isDomStructuralFrame(sourceNode)) return false;
    if (hasVisibleLayerStyle(sourceNode)) return false;

    const children = (sourceNode && sourceNode.children) || [];
    const tag = inferredTag(sourceNode);

    if (isTinyTransparentWrapper(sourceNode, children)) return true;
    if (shouldPreserveSemanticFrame(sourceNode)) {
      return hasSingleChildWithSameLayerName(sourceNode);
    }
    if (isDesignRegionFrame(sourceNode)) return false;
    if (isMeaningfulStructuralGroup(sourceNode)) return false;
    if (!children.length) return true;
    if (/^h[1-6]$/.test(tag)) return true;

    if (INLINE_TEXT_TAGS.has(tag)) return true;
    if (tag === "div" || tag === "span" || tag.indexOf("-") >= 0) return true;
    return children.length === 1;
  }

  function explicitZIndex(sourceNode) {
    const style = (sourceNode && sourceNode.style) || {};
    const design = (sourceNode && sourceNode.design) || {};
    const raw = design.zIndex !== undefined ? design.zIndex : style.zIndex;
    if (raw === undefined || raw === null || String(raw).toLowerCase() === "auto") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function hasVisiblePaintOrEffect(sourceNode) {
    const style = (sourceNode && sourceNode.style) || {};
    const design = (sourceNode && sourceNode.design) || {};
    if (hasVisibleDesignFill(sourceNode) || hasVisibleStyleFill(sourceNode)) return true;
    if (strokeDefinitions(sourceNode).length > 0) return true;
    if (Array.isArray(design.shadows) && design.shadows.length > 0) return true;
    if (style.boxShadow && style.boxShadow !== "none") return true;
    if (number(design.opacity, 1) !== 1 || number(style.opacity, 1) !== 1) return true;
    return false;
  }

  function fixedDescendantStackingIndex(sourceNode) {
    if (!sourceNode || hasVisiblePaintOrEffect(sourceNode)) return null;
    const children = sourceNode.children || [];
    let maxIndex = null;

    function visitDescendant(node) {
      if (!node || hasVisiblePaintOrEffect(node)) return;

      const nodeIndex = explicitZIndex(node);
      if (isFixedShellSourceNode(node) && nodeIndex !== null) {
        maxIndex = maxIndex === null ? nodeIndex : Math.max(maxIndex, nodeIndex);
      }

      const descendantChildren = node.children || [];
      for (let index = 0; index < descendantChildren.length; index++) {
        visitDescendant(descendantChildren[index]);
      }
    }

    for (let index = 0; index < children.length; index++) {
      visitDescendant(children[index]);
    }

    return maxIndex;
  }

  function orderedRenderableChildren(sourceNode, options) {
    const entries = [];
    let sourceOrder = 0;

    function visit(node, inheritedStackingIndex) {
      if (shouldDropSourceNode(node)) return;

      const ownStackingIndex = explicitZIndex(node);
      const stackingIndex = inheritedStackingIndex === null
        ? ownStackingIndex
        : inheritedStackingIndex;
      const order = sourceOrder++;

      if (shouldFlattenFrameNode(node, options)) {
        for (const child of (node && node.children) || []) {
          visit(child, stackingIndex);
        }
        return;
      }

      const descendantStackingIndex = stackingIndex === null ? fixedDescendantStackingIndex(node) : null;
      entries.push({
        node,
        stackingIndex:
          stackingIndex === null
            ? descendantStackingIndex === null
              ? 0
              : descendantStackingIndex
            : stackingIndex,
        order,
      });
    }

    for (const child of (sourceNode && sourceNode.children) || []) {
      visit(child, null);
    }

    return entries
      .sort((left, right) => {
        if (left.stackingIndex !== right.stackingIndex) {
          return left.stackingIndex - right.stackingIndex;
        }
        return left.order - right.order;
      })
      .map((entry) => entry.node);
  }

  function rectExtendsOutsideHorizontally(rect, bounds) {
    return rect.x < bounds.x || rect.x + rect.width > bounds.x + bounds.width;
  }

  function sourceRole(sourceNode) {
    const source = (sourceNode && sourceNode.source) || {};
    return String((sourceNode && sourceNode.role) || source.role || "").toLowerCase();
  }

  function containsRenderableMedia(sourceNode) {
    if (!sourceNode) return false;
    const nodeType = sourceNode.kind || sourceNode.type;
    const style = sourceNode.style || {};
    const design = sourceNode.design || {};
    if (
      nodeType === "image" ||
      nodeType === "raster" ||
      nodeType === "svg" ||
      sourceNode.assetId ||
      style.backgroundAssetId
    ) {
      return true;
    }
    if (Array.isArray(design.fills) && design.fills.some((fill) => fill && fill.type === "image")) {
      return true;
    }
    return ((sourceNode && sourceNode.children) || []).some(containsRenderableMedia);
  }

  function containsSemanticListItem(sourceNode) {
    for (const child of (sourceNode && sourceNode.children) || []) {
      const tag = inferredTag(child);
      if (tag === "li" || sourceRole(child) === "listitem" || containsSemanticListItem(child)) return true;
    }
    return false;
  }

  function isOverflowContentCandidate(sourceNode, rootRect) {
    const rect = rectOf(sourceNode);
    if (!rectExtendsOutsideHorizontally(rect, rootRect)) return false;
    if (rect.width < 96 || rect.height < 64) return false;
    if (!containsRenderableMedia(sourceNode)) return false;

    const tag = inferredTag(sourceNode);
    const role = sourceRole(sourceNode);
    const semanticItem = tag === "li" || tag === "article" || tag === "figure" || role === "listitem";
    const genericCard =
      (sourceNode.kind || sourceNode.type) === "frame" &&
      hasClassWord(sourceNode, /(?:carousel|gallery|slide|card|tile|media)/i) &&
      !containsSemanticListItem(sourceNode);
    return semanticItem || genericCard;
  }

  function collectOverflowContent(sourceRoot, rootRect) {
    const candidates = [];

    function visit(sourceNode) {
      if (!sourceNode || shouldDropSourceNode(sourceNode)) return;
      if (isOverflowContentCandidate(sourceNode, rootRect)) {
        candidates.push(sourceNode);
        return;
      }
      for (const child of sourceNode.children || []) visit(child);
    }

    for (const child of (sourceRoot && sourceRoot.children) || []) visit(child);
    return candidates;
  }

  function layoutOverflowContent(sourceNodes, availableWidth, gap) {
    const entries = [];
    const maxWidth = Math.max(320, number(availableWidth, 960));
    const spacing = Math.max(0, number(gap, 32));
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    let usedWidth = 0;

    for (const sourceNode of sourceNodes || []) {
      const rect = rectOf(sourceNode);
      if (x > 0 && x + rect.width > maxWidth) {
        x = 0;
        y += rowHeight + spacing;
        rowHeight = 0;
      }

      entries.push({ sourceNode, x, y, rect });
      x += rect.width + spacing;
      rowHeight = Math.max(rowHeight, rect.height);
      usedWidth = Math.max(usedWidth, x - spacing);
    }

    return {
      entries,
      width: Math.max(1, Math.min(maxWidth, usedWidth || maxWidth)),
      height: Math.max(1, y + rowHeight),
    };
  }

  function hasVisuallyHiddenMarker(value) {
    return /(^|\s)(visuallyhidden|visually-hidden|sr-only|screenreader|screen-reader|a11y-hidden|u-hidden)(\s|$)/i.test(
      String(value || "")
    );
  }

  function hasTinyClip(style) {
    const clipPath = String((style && style.clipPath) || "")
      .toLowerCase()
      .replace(/\s+/g, " ");
    const clip = String((style && style.clip) || "")
      .toLowerCase()
      .replace(/\s+/g, " ");

    if (clipPath && clipPath !== "none") {
      if (/inset\([^)]*(?:50%|99(?:\.9)?%|100%)/.test(clipPath)) return true;
      if (/circle\(\s*0|polygon\(\s*0/.test(clipPath)) return true;
    }

    if (clip && clip !== "auto" && clip !== "none") {
      if (/rect\(\s*(?:0|1px)[,\s]+(?:0|1px)[,\s]+(?:0|1px)[,\s]+(?:0|1px)\s*\)/.test(clip)) {
        return true;
      }
    }

    return false;
  }

  function isVisuallyHiddenSourceNode(sourceNode) {
    const style = (sourceNode && sourceNode.style) || {};
    const marker = `${rawClassName(sourceNode)} ${rawId(sourceNode)} ${rawNodeName(sourceNode, "")}`;
    const rect = rectOf(sourceNode);
    const clipped = hasTinyClip(style);
    const overflow = `${style.overflow || ""} ${style.overflowX || ""} ${style.overflowY || ""}`;
    const overflowClipped = /\b(hidden|clip|auto|scroll)\b/i.test(overflow);
    const position = String(style.position || "").toLowerCase();
    const smallAxis = rect.width <= 1 || rect.height <= 1;

    if (hasVisuallyHiddenMarker(marker) && (clipped || overflowClipped || smallAxis || position === "absolute" || position === "fixed")) {
      return true;
    }

    return Boolean(clipped && (overflowClipped || smallAxis || position === "absolute" || position === "fixed"));
  }

  function shouldDropSourceNode(sourceNode) {
    if (isVisuallyHiddenSourceNode(sourceNode)) return true;

    const tag = inferredTag(sourceNode);
    if (tag !== "a") return false;
    const text = sourceTextContent(sourceNode).replace(/\s+/g, " ").trim();
    if (!/^skip to (content|main)/i.test(text)) return false;
    const rect = rectOf(sourceNode);
    const style = (sourceNode && sourceNode.style) || {};
    return rect.y < 40 || String(style.position || "").toLowerCase() === "fixed";
  }

  function isDesignRegionFrame(sourceNode) {
    const tag = inferredTag(sourceNode);
    if (
      tag === "body" ||
      tag === "header" ||
      tag === "main" ||
      tag === "footer" ||
      tag === "nav" ||
      tag === "aside" ||
      tag === "article" ||
      tag === "section"
    ) {
      return true;
    }

    const name = semanticName(sourceNode, "");
    return /^(Header|Navigation|Sidebar|Right Sidebar|Main|Content Panel|Footer|Pagination|Aside|Article|Section)$/i.test(
      name
    );
  }

  function ensureSelectableFrameSurface(frame, sourceNode) {
    if (!frame || frame.type !== "FRAME") return;
    if (Array.isArray(frame.fills) && frame.fills.length > 0) return;
    if (!isDesignRegionFrame(sourceNode)) return;

    frame.fills = [
      {
        type: "SOLID",
        color: { r: 1, g: 1, b: 1 },
        opacity: 0,
      },
    ];
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
    const page = figma && figma.currentPage;
    const createdNodes = new Set(((options && options.createdNodes) || []).filter(Boolean));
    if (rootFrame) createdNodes.add(rootFrame);

    try {
      // Figma creates nodes on the current page before they are appended into the
      // imported root. Remove only this import's top-level nodes: removing a root
      // also removes all of its descendants, while a sidecar overflow frame needs
      // its own removal because it is a sibling of the root.
      const roots = Array.from(createdNodes).filter(
        (node) => node === rootFrame || !page || node.parent === page
      );
      for (let index = roots.length - 1; index >= 0; index--) {
        const node = roots[index];
        if (node && typeof node.remove === "function") node.remove();
      }

      // Do not disturb a selection that pre-dated the import, but make sure the
      // selection cannot retain a node that has just been removed.
      if (page && Array.isArray(page.selection)) {
        page.selection = page.selection.filter((node) => !createdNodes.has(node));
      }
    } finally {
      progress(options, "cancelled");
    }
  }

  function trackCreatedNode(options, node) {
    if (options && options.createdNodes && node) options.createdNodes.push(node);
    return node;
  }

  function focusResult(figma, rootFrame) {
    if (!figma || !figma.currentPage || !rootFrame) return;
    if (typeof figma.currentPage.appendChild === "function") {
      figma.currentPage.appendChild(rootFrame);
    }
    figma.currentPage.selection = [rootFrame];
    if (figma.viewport && typeof figma.viewport.scrolledAndZoomedIntoView === "function") {
      figma.viewport.scrolledAndZoomedIntoView([rootFrame]);
    }
  }

  function noteFailure(options, sourceNode, error) {
    if (!options.failures) options.failures = [];
    options.failures.push({
      name: semanticName(sourceNode, "Node"),
      message: (error && error.message) || String(error),
    });
  }

  function latestCreatedNode(options) {
    const nodes = (options && options.createdNodes) || [];
    return nodes.length ? nodes[nodes.length - 1] : null;
  }

  function createFailureNode(figma, sourceNode, parentRect, options, error, partialNode) {
    noteFailure(options, sourceNode, error);
    const fallback = createFrame(figma, sourceNode, parentRect, options);
    fallback.name = `Import failed · ${semanticName(sourceNode, "Node")}`;
    if (!fallback.fills || fallback.fills.length === 0) {
      fallback.fills = [{ type: "SOLID", color: { r: 1, g: 0.93, b: 0.93 }, opacity: 1 }];
    }
    fallback.strokes = [{ type: "SOLID", color: { r: 0.95, g: 0.27, b: 0.27 }, opacity: 1 }];
    fallback.strokeWeight = 1;
    if (partialNode && partialNode !== fallback) append(fallback, partialNode);
    return fallback;
  }

  function sideStrokeRect(frameRect, stroke) {
    const width = Math.max(0.01, number(stroke && stroke.width, 1));
    const rect = {
      x: frameRect.x,
      y: frameRect.y,
      width: frameRect.width,
      height: frameRect.height,
    };

    if (stroke.side === "top") {
      rect.height = width;
    } else if (stroke.side === "right") {
      rect.x = frameRect.x + Math.max(0, frameRect.width - width);
      rect.width = width;
    } else if (stroke.side === "bottom") {
      rect.y = frameRect.y + Math.max(0, frameRect.height - width);
      rect.height = width;
    } else if (stroke.side === "left") {
      rect.width = width;
    }

    return rect;
  }

  function createSideStrokeNode(figma, sourceNode, frameRect, stroke, options) {
    const paint = strokePaintFromDefinition(stroke);
    if (!paint) return null;

    const line = trackCreatedNode(
      options,
      typeof figma.createRectangle === "function" ? figma.createRectangle() : figma.createFrame()
    );
    line.name = `${semanticName(sourceNode, "Frame")} · border ${stroke.side}`;
    clearDefaultFill(line);
    line.fills = [paint];
    if ("strokes" in line) line.strokes = [];
    place(line, sideStrokeRect(frameRect, stroke), frameRect);
    return line;
  }

  function appendSideStrokeNodes(figma, frame, sourceNode, frameRect, options) {
    for (const stroke of sideStrokeDefinitions(sourceNode)) {
      const line = createSideStrokeNode(figma, sourceNode, frameRect, stroke, options);
      if (line) append(frame, line);
    }
  }

  function createFrame(figma, sourceNode, parentRect, options) {
    const rect = rectOf(sourceNode);
    const frame = trackCreatedNode(options, figma.createFrame());
    frame.name = semanticName(sourceNode, "Frame");
    clearDefaultFill(frame);
    place(frame, rect, parentRect);
    applyStyle(frame, sourceNode, options && options.scene, options);
    ensureSelectableFrameSurface(frame, sourceNode);
    applyLayout(frame, sourceNode, options);
    return frame;
  }

  async function createText(figma, sourceNode, parentRect, options) {
    const rect = rectOf(sourceNode);
    const text = trackCreatedNode(options, figma.createText());
    text.name = semanticName(sourceNode, "Text");
    text.fontName = await loadFont(figma, sourceNode, options || {});
    text.characters = String((sourceNode && sourceNode.text) || "");
    const designText = sourceNode && sourceNode.design && sourceNode.design.text ? sourceNode.design.text : {};
    if (designText.fontSize || (sourceNode && sourceNode.style && sourceNode.style.fontSize)) {
      text.fontSize = number(designText.fontSize || sourceNode.style.fontSize, 16);
    }
    applyTextMetrics(text, sourceNode);
    applyTextRendering(text, sourceNode);
    const color = designText.color ? solidPaintFromDesign({ color: designText.color }) : solidPaint(sourceNode && sourceNode.style ? sourceNode.style.color : undefined);
    if (color) text.fills = [color];
    place(text, rect, parentRect);
    text.textAutoResize = textAutoResizeMode(sourceNode, rect);
    return text;
  }

  function imageHashFor(figma, scene, sourceNode, options) {
    const assetId = (sourceNode && (sourceNode.assetId || sourceNode.src)) || "";
    const asset = assetFor(scene, sourceNode);
    const cacheKey = assetId || (asset && asset.src) || (sourceNode && sourceNode.src);
    if (!cacheKey || !asset) return null;

    if (!options.assetCache) options.assetCache = new Map();
    if (options.assetCache.has(cacheKey)) return options.assetCache.get(cacheKey);

    try {
      const bytes = decodeBase64(asset.base64 || asset.data || "");
      const image = figma.createImage(bytes);
      options.assetCache.set(cacheKey, image.hash);
      return image.hash;
    } catch (error) {
      if (!options.assetFailures) options.assetFailures = [];
      options.assetFailures.push({
        assetId: assetId,
        src: (asset && asset.src) || "",
        message: (error && error.message) || String(error),
      });
      options.assetCache.set(cacheKey, null);
      return null;
    }
  }

  function createSvgImageNode(figma, scene, sourceNode, parentRect, options) {
    const asset = assetFor(scene, sourceNode);
    const svg = asset && (asset.svg || decodeBase64Text(asset.base64 || asset.data || ""));
    if (!svg) return null;

    return createSvgNode(
      figma,
      scene,
      {
        kind: "svg",
        name: sourceNode && sourceNode.name,
        svg,
        rect: sourceNode && sourceNode.rect,
        style: sourceNode && sourceNode.style,
      },
      parentRect,
      options
    );
  }

  function svgIntrinsicSize(asset) {
    const svg = asset && (asset.svg || decodeBase64Text(asset.base64 || asset.data || ""));
    if (!svg) return null;

    const viewBox = svg.match(/\bviewBox=(["'])([^"']+)\1/i);
    if (viewBox) {
      const parts = viewBox[2].trim().split(/\s+/).map((part) => Number.parseFloat(part));
      if (parts.length === 4 && Number.isFinite(parts[2]) && Number.isFinite(parts[3]) && parts[2] > 0 && parts[3] > 0) {
        return { width: parts[2], height: parts[3] };
      }
    }

    const width = svg.match(/\bwidth=(["'])(\d+(?:\.\d+)?)/i);
    const height = svg.match(/\bheight=(["'])(\d+(?:\.\d+)?)/i);
    if (width && height) {
      const parsedWidth = Number.parseFloat(width[2]);
      const parsedHeight = Number.parseFloat(height[2]);
      if (parsedWidth > 0 && parsedHeight > 0) {
        return { width: parsedWidth, height: parsedHeight };
      }
    }

    return null;
  }

  function coverRect(container, intrinsic) {
    if (!intrinsic || !intrinsic.width || !intrinsic.height) return container;

    const containerRatio = container.width / container.height;
    const intrinsicRatio = intrinsic.width / intrinsic.height;
    let width = container.width;
    let height = container.height;
    let x = container.x;
    let y = container.y;

    if (intrinsicRatio > containerRatio) {
      width = container.height * intrinsicRatio;
      x = container.x - (width - container.width) / 2;
    } else {
      height = container.width / intrinsicRatio;
      y = container.y - (height - container.height) / 2;
    }

    return {
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      width: Math.round(width * 100) / 100,
      height: Math.round(height * 100) / 100,
    };
  }

  function createImageNode(figma, scene, sourceNode, parentRect, options) {
    const asset = assetFor(scene, sourceNode);
    if (isSvgAsset(asset) && typeof figma.createNodeFromSvg === "function") {
      const svgNode = createSvgImageNode(figma, scene, sourceNode, parentRect, options);
      if (svgNode) return svgNode;
    }

    const rect = rectOf(sourceNode);
    const imageNode = trackCreatedNode(
      options,
      typeof figma.createRectangle === "function" ? figma.createRectangle() : figma.createFrame()
    );
    imageNode.name = semanticName(sourceNode, "Image");
    clearDefaultFill(imageNode);
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

  function createSvgNode(figma, scene, sourceNode, parentRect, options) {
    const rect = rectOf(sourceNode);
    const svg = normalizeSvgForFigma(sourceNode && sourceNode.svg, scene, sourceNode);
    const vector = trackCreatedNode(
      options,
      typeof figma.createNodeFromSvg === "function"
        ? figma.createNodeFromSvg(svg)
        : figma.createFrame()
    );
    vector.name = semanticName(sourceNode, "Vector");
    place(vector, rect, parentRect);
    applyStyle(vector, sourceNode, null, {});
    return vector;
  }

  function createBackgroundAssetNode(figma, scene, sourceNode, frameRect, options) {
    const style = sourceNode && sourceNode.style ? sourceNode.style : {};
    if (!style.backgroundAssetId) return null;

    const asset = assetFor(scene, { assetId: style.backgroundAssetId });
    if (!isSvgAsset(asset) || typeof figma.createNodeFromSvg !== "function") return null;

    const rect = rectOf(sourceNode);
    const backgroundRect = String(style.objectFit || "").toLowerCase() === "contain"
      ? rect
      : coverRect(rect, svgIntrinsicSize(asset));
    const background = createSvgImageNode(
      figma,
      scene,
      {
        kind: "image",
        name: `${semanticName(sourceNode, "Frame")} · background image`,
        assetId: style.backgroundAssetId,
        rect: backgroundRect,
        style: {
          objectFit: style.objectFit || "cover",
        },
      },
      frameRect,
      options
    );

    if (background) background.name = `${semanticName(sourceNode, "Frame")} · background image`;
    return background;
  }

  async function createNode(figma, scene, sourceNode, parentRect, options) {
    const createdBefore = ((options && options.createdNodes) || []).length;
    const nodeType = sourceNode && (sourceNode.kind || sourceNode.type);
    try {
      if (nodeType === "text") {
        return await createText(figma, sourceNode, parentRect, options);
      }

      if (nodeType === "image" || nodeType === "raster") {
        return createImageNode(figma, scene, sourceNode, parentRect, options);
      }

      if (nodeType === "svg") {
        return createSvgNode(figma, scene, sourceNode, parentRect, options);
      }

      const frame = createFrame(figma, sourceNode, parentRect, options);
      const frameRect = rectOf(sourceNode);
      const background = createBackgroundAssetNode(figma, scene, sourceNode, frameRect, options);
      if (background) append(frame, background);
      appendSideStrokeNodes(figma, frame, sourceNode, frameRect, options);
      const inlineText = collapsedInlineTextSource(sourceNode);
      if (inlineText) {
        append(frame, await createText(figma, inlineText, frameRect, options));
        return frame;
      }
      for (const child of orderedRenderableChildren(sourceNode, options)) {
        append(frame, await createNode(figma, scene, child, frameRect, options));
      }
      return frame;
    } catch (error) {
      const partialNode = ((options && options.createdNodes) || []).length > createdBefore ? latestCreatedNode(options) : null;
      return createFailureNode(figma, sourceNode, parentRect, options, error, partialNode);
    }
  }

  async function createOverflowContentFrame(figma, scene, sourceRoot, rootRect, options) {
    const sourceNodes = collectOverflowContent(sourceRoot, rootRect);
    if (!sourceNodes.length) return null;

    const layout = layoutOverflowContent(sourceNodes, rootRect.width, 32);
    const overflowFrame = trackCreatedNode(options, figma.createFrame());
    overflowFrame.name = "Captured overflow content";
    clearDefaultFill(overflowFrame);
    overflowFrame.x = rootRect.x + rootRect.width + 96;
    overflowFrame.y = rootRect.y;
    overflowFrame.resize(layout.width, layout.height);
    overflowFrame.clipsContent = false;

    for (let index = 0; index < layout.entries.length; index++) {
      const entry = layout.entries[index];
      progress(options, "creating-overflow-content", {
        current: index + 1,
        total: layout.entries.length,
      });
      if (isCancelled(options)) return overflowFrame;

      const placementRect = {
        x: entry.rect.x - entry.x,
        y: entry.rect.y - entry.y,
        width: entry.rect.width,
        height: entry.rect.height,
      };
      append(overflowFrame, await createNode(figma, scene, entry.sourceNode, placementRect, options));
    }

    return overflowFrame;
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

    normalizeFixedShellOverlaps(scene);
    const rootRect = rectOf(sourceRoot);
    progress(options, "import-started", { totalNodes: (sourceRoot.children || []).length + 1 });
    const importOptions = {};
    for (const key in options || {}) {
      if (Object.prototype.hasOwnProperty.call(options, key)) importOptions[key] = options[key];
    }
    importOptions.assetCache = new Map();
    importOptions.createdNodes = [];
    importOptions.figma = figma;
    importOptions.scene = scene;

    const rootFrame = trackCreatedNode(importOptions, figma.createFrame());
    if (options.taskId && rootFrame.setPluginData) {
      rootFrame.setPluginData("webToFigmaTaskId", String(options.taskId));
    }
    let overflow = null;
    try {
      rootFrame.name = rootName(scene, sourceRoot);
      clearDefaultFill(rootFrame);
      rootFrame.x = 0;
      rootFrame.y = 0;
      rootFrame.resize(rootRect.width, rootRect.height);
      applyStyle(rootFrame, sourceRoot, scene, importOptions);
      ensureSelectableFrameSurface(rootFrame, sourceRoot);
      applyLayout(rootFrame, sourceRoot, importOptions);
      const rootBackground = createBackgroundAssetNode(figma, scene, sourceRoot, rootRect, importOptions);
      if (rootBackground) append(rootFrame, rootBackground);
      appendSideStrokeNodes(figma, rootFrame, sourceRoot, rootRect, importOptions);
      const children = orderedRenderableChildren(sourceRoot, importOptions);
      for (let index = 0; index < children.length; index++) {
        progress(options, "creating-nodes", { current: index + 1, total: children.length });
        if (isCancelled(options)) {
          cleanupCancelled(figma, rootFrame, importOptions);
          return { ok: false, cancelled: true, root: rootFrame };
        }
        const child = children[index];
        append(rootFrame, await createNode(figma, scene, child, rootRect, importOptions));
        if (isCancelled(options)) {
          cleanupCancelled(figma, rootFrame, importOptions);
          return { ok: false, cancelled: true, root: rootFrame };
        }
      }

      if (importOptions.overflowMode === "sidecar") {
        overflow = await createOverflowContentFrame(figma, scene, sourceRoot, rootRect, importOptions);
        if (isCancelled(importOptions)) {
          cleanupCancelled(figma, rootFrame, importOptions);
          return { ok: false, cancelled: true, root: rootFrame };
        }
      }

      focusResult(figma, rootFrame);
      progress(options, "completed");
    } catch (error) {
      noteFailure(importOptions, sourceRoot, error);
      cleanupCancelled(figma, rootFrame, importOptions);
      throw error;
    }

    return { ok: true, root: rootFrame, overflow };
  }

  return {
    importSceneToFigma,
  };
});

(function (runtimeRoot) {
  const figmaApi = runtimeRoot && runtimeRoot.figma;
  if (!figmaApi || !figmaApi.showUI || !runtimeRoot.WebToFigmaImporter) {
    return;
  }

  let cancelled = false;
  const AUTH_STORAGE_KEY = "webToFigmaDeviceAuthV1";
  const CLOUD_TASK_STORAGE_KEY = "webToFigmaCloudTaskV1";

  function post(type, payload = {}) {
    const message = { type: type };
    for (const key in payload || {}) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) message[key] = payload[key];
    }
    figmaApi.ui.postMessage(message);
  }

  async function saveCloudTask(task) {
    if (figmaApi.clientStorage && figmaApi.clientStorage.setAsync) {
      await figmaApi.clientStorage.setAsync(CLOUD_TASK_STORAGE_KEY, task || null);
    }
  }

  figmaApi.showUI(__html__, {
    width: 420,
    height: 640,
    themeColors: true,
  });

  figmaApi.ui.onmessage = async (message) => {
    if (!message || typeof message !== "object") return;

    if (message.type === "close") {
      figmaApi.closePlugin();
      return;
    }

    if (message.type === "open-external") {
      if (message.url && figmaApi.openExternal) {
        figmaApi.openExternal(message.url);
        post("external-opened");
      } else {
        post("external-open-failed", { message: "Unable to open the browser." });
      }
      return;
    }

    if (message.type === "save-device-auth") {
      if (figmaApi.clientStorage && figmaApi.clientStorage.setAsync) {
        await figmaApi.clientStorage.setAsync(AUTH_STORAGE_KEY, {
          apiBaseUrl: message.apiBaseUrl || "",
          accessToken: message.accessToken || "",
          refreshToken: message.refreshToken || "",
          accessTokenExpiresAt: message.accessTokenExpiresAt || 0,
          refreshTokenExpiresAt: message.refreshTokenExpiresAt || 0,
        });
      }
      post("device-auth-saved");
      return;
    }

    if (message.type === "get-device-auth") {
      var storedAuth = null;
      if (figmaApi.clientStorage && figmaApi.clientStorage.getAsync) {
        storedAuth = await figmaApi.clientStorage.getAsync(AUTH_STORAGE_KEY);
      }
      post("device-auth", { auth: storedAuth || null });
      return;
    }

    if (message.type === "clear-device-auth") {
      if (figmaApi.clientStorage && figmaApi.clientStorage.setAsync) {
        await figmaApi.clientStorage.setAsync(AUTH_STORAGE_KEY, null);
      }
      post("device-auth-cleared");
      return;
    }

    if (message.type === "get-cloud-task") {
      var storedTask = null;
      if (figmaApi.clientStorage && figmaApi.clientStorage.getAsync) {
        storedTask = await figmaApi.clientStorage.getAsync(CLOUD_TASK_STORAGE_KEY);
      }
      post("cloud-task", { task: storedTask || null });
      return;
    }

    if (message.type === "save-cloud-task") {
      await saveCloudTask(message.task || null);
      post("cloud-task-saved");
      return;
    }

    if (message.type === "clear-cloud-task") {
      await saveCloudTask(null);
      post("cloud-task-cleared");
      return;
    }

    if (message.type === "cleanup-stale-cloud-task") {
      var taskId = String(message.taskId || "");
      if (taskId && figmaApi.currentPage && figmaApi.currentPage.findAll) {
        var staleNodes = figmaApi.currentPage.findAll(function (node) {
          return node && node.getPluginData && node.getPluginData("webToFigmaTaskId") === taskId;
        });
        for (var staleIndex = 0; staleIndex < staleNodes.length; staleIndex++) {
          if (staleNodes[staleIndex] && staleNodes[staleIndex].remove) staleNodes[staleIndex].remove();
        }
      }
      await saveCloudTask({ taskId: taskId, status: "failed_pending" });
      post("cloud-task-cleaned", { taskId: taskId });
      return;
    }

    if (message.type === "cancel-import") {
      cancelled = true;
      return;
    }

    if (message.type !== "import-capture") return;

    cancelled = false;
    var cloudTaskId = message.cloudTaskId ? String(message.cloudTaskId) : "";
    if (cloudTaskId) await saveCloudTask({ taskId: cloudTaskId, status: "importing" });
    try {
      const result = await runtimeRoot.WebToFigmaImporter.importSceneToFigma(message.payload, {
        figma: figmaApi,
        layoutMode: message.layoutMode || "visual",
        overflowMode: message.overflowMode || "sidecar",
        fallbackFont: message.fallbackFont || { family: "Inter", style: "Regular" },
        taskId: cloudTaskId,
        shouldCancel: () => cancelled,
        onProgress: (event) => {
          post("import-progress", event);
        },
      });

      if (result.cancelled) {
        if (cloudTaskId) await saveCloudTask({ taskId: cloudTaskId, status: "cancelled_pending" });
        post("import-cancelled", { cloudTaskId: cloudTaskId });
        return;
      }

      if (cloudTaskId) await saveCloudTask({ taskId: cloudTaskId, status: "imported_pending" });
      post("import-complete", { cloudTaskId: cloudTaskId });
    } catch (error) {
      if (cloudTaskId) await saveCloudTask({ taskId: cloudTaskId, status: "failed_pending" });
      post("import-failed", {
        cloudTaskId: cloudTaskId,
        message: error && error.stack ? error.stack : (error && error.message) || String(error),
      });
    }
  };
})(typeof self !== "undefined" ? self : this);
