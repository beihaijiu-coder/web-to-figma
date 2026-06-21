(function () {
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;
  const assetBySrc = new Map();
  let nodeSequence = 0;
  let paintSequence = 0;

  function number(value, fallback = 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function px(value, fallback = 0) {
    return number(String(value || "").replace("px", ""), fallback);
  }

  function round(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : fallback;
  }

  function cloneRect(rect) {
    return {
      x: round(rect && rect.x),
      y: round(rect && rect.y),
      width: Math.max(1, round(rect && rect.width, 1)),
      height: Math.max(1, round(rect && rect.height, 1)),
    };
  }

  function nextNodeId(kind) {
    nodeSequence += 1;
    return `${kind || "node"}-${nodeSequence}`;
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
    if (!raw || raw === "transparent" || raw === "rgba(0, 0, 0, 0)") {
      return raw === "transparent" ? { r: 0, g: 0, b: 0, a: 0 } : null;
    }
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

  function designColor(value) {
    const color = parseColor(value);
    if (!color) return null;
    return {
      r: round(color.r),
      g: round(color.g),
      b: round(color.b),
      a: round(color.a, 1),
      css: String(value || ""),
    };
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

  function styleFor(element, pseudo) {
    return window.getComputedStyle ? window.getComputedStyle(element, pseudo) || {} : {};
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

  function isTransparent(value) {
    const raw = String(value || "").trim().toLowerCase();
    return !raw || raw === "transparent" || raw === "rgba(0, 0, 0, 0)";
  }

  function clipsOverflowValue(value) {
    return /\b(hidden|clip|auto|scroll)\b/i.test(String(value || ""));
  }

  function clipsOverflow(style) {
    return (
      clipsOverflowValue(style.overflow) ||
      clipsOverflowValue(style.overflowX) ||
      clipsOverflowValue(style.overflowY) ||
      style.clipsContent === true
    );
  }

  function hasVisuallyHiddenName(value) {
    return /(^|\s)(visuallyhidden|visually-hidden|sr-only|screenreader|screen-reader|a11y-hidden|u-hidden)(\s|$)/i.test(
      String(value || "")
    );
  }

  function clipsToTinyRegion(computed) {
    const clipPath = String(computed?.clipPath || "").toLowerCase().replace(/\s+/g, " ");
    const clip = String(computed?.clip || "").toLowerCase().replace(/\s+/g, " ");

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

  function isVisuallyHiddenElement(element, rect, computed = styleFor(element)) {
    if (!element || !computed) return false;
    const marker = `${element.id || ""} ${element.className || ""} ${element.getAttribute?.("class") || ""}`;
    const hasHiddenName = hasVisuallyHiddenName(marker);
    const clipped = clipsToTinyRegion(computed);
    const overflowClipped = clipsOverflowValue(computed.overflow) || clipsOverflowValue(computed.overflowX) || clipsOverflowValue(computed.overflowY);
    const position = String(computed.position || "").toLowerCase();
    const smallAxis = rect && (rect.width <= 1 || rect.height <= 1);

    if (hasHiddenName && (clipped || overflowClipped || smallAxis || position === "absolute" || position === "fixed")) {
      return true;
    }

    return Boolean(
      clipped &&
        (overflowClipped || smallAxis || position === "absolute" || position === "fixed")
    );
  }

  function hasCssGradient(value) {
    return /\b(?:linear|radial|conic|repeating-linear|repeating-radial|repeating-conic)-gradient\(/i.test(
      String(value || "")
    );
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

  function hasImageUrl(value) {
    return /url\(\s*(["']?)(.*?)\1\s*\)/i.test(String(value || ""));
  }

  function normalizeAssetUrl(value) {
    try {
      return new URL(value, window.location.href).href;
    } catch {
      return value;
    }
  }

  function gradientFill(layer) {
    const raw = String(layer || "");
    if (!hasCssGradient(raw)) return null;

    const colors = [];
    const colorRegex = /(#[0-9a-f]{3,6}|rgba?\([^)]+\)|transparent)/gi;
    let match = colorRegex.exec(raw);
    while (match) {
      const color = designColor(match[1]);
      if (color) colors.push(color);
      match = colorRegex.exec(raw);
    }
    if (colors.length < 2) return null;

    return {
      type: /\bradial-gradient\(/i.test(raw) ? "radial-gradient" : "linear-gradient",
      stops: colors.map((color, index) => ({
        position: colors.length === 1 ? 0 : round(index / (colors.length - 1)),
        color,
      })),
      css: raw,
    };
  }

  function solidFill(value) {
    const color = designColor(value);
    if (!color || color.a === 0) return null;
    return {
      type: "solid",
      color,
      css: String(value || ""),
    };
  }

  function backgroundFills(style) {
    const fills = [];
    for (const layer of style.backgroundLayers || []) {
      if (hasCssGradient(layer)) {
        const fill = gradientFill(layer);
        if (fill) fills.push(fill);
      }
    }

    if (!fills.length) {
      const fill = solidFill(style.backgroundColor);
      if (fill) fills.push(fill);
    }

    if (style.backgroundAssetId) {
      fills.unshift({
        type: "image",
        assetId: style.backgroundAssetId,
        fit: style.objectFit || "cover",
        position: style.backgroundPosition || "",
        size: style.backgroundSize || "",
        repeat: style.backgroundRepeat || "",
      });
    }

    return fills;
  }

  function sideStroke(style, side) {
    const width = number(style[`border${side}Width`], 0);
    const color = designColor(style[`border${side}Color`] || style.borderColor);
    if (!width || !color || color.a === 0) return null;
    return {
      side: side.toLowerCase(),
      width: round(width),
      color,
    };
  }

  function designStrokes(style) {
    const sides = ["Top", "Right", "Bottom", "Left"]
      .map((side) => sideStroke(style, side))
      .filter(Boolean);
    if (!sides.length && number(style.borderWidth, 0) > 0) {
      const color = designColor(style.borderColor);
      if (color && color.a > 0) {
        return [{ side: "all", width: round(style.borderWidth), color }];
      }
    }
    if (sides.length === 4) {
      const first = sides[0];
      const same = sides.every(
        (side) =>
          side.width === first.width &&
          side.color.css === first.color.css
      );
      if (same) return [{ side: "all", width: first.width, color: first.color }];
    }
    return sides;
  }

  function designRadius(style) {
    return {
      topLeft: round(style.borderTopLeftRadius, style.borderRadius || 0),
      topRight: round(style.borderTopRightRadius, style.borderRadius || 0),
      bottomRight: round(style.borderBottomRightRadius, style.borderRadius || 0),
      bottomLeft: round(style.borderBottomLeftRadius, style.borderRadius || 0),
    };
  }

  function designPadding(style) {
    return {
      top: round(style.paddingTop),
      right: round(style.paddingRight),
      bottom: round(style.paddingBottom),
      left: round(style.paddingLeft),
    };
  }

  function designShadows(style) {
    const raw = String(style.boxShadow || "");
    if (!raw || raw === "none") return [];
    return splitCssLayers(raw).map((shadow) => ({ type: "drop-shadow", css: shadow }));
  }

  function designText(style) {
    return {
      fontFamily: style.fontFamily,
      fontSize: round(style.fontSize, 16),
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle || "normal",
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      color: designColor(style.color),
      align: style.textAlign || "start",
      transform: style.textTransform || "none",
      decoration: style.textDecorationLine || "none",
      whiteSpace: style.whiteSpace,
    };
  }

  function designStyle(kind, rect, style) {
    return {
      type: kind,
      absoluteRect: cloneRect(rect),
      fills: backgroundFills(style),
      strokes: designStrokes(style),
      radius: designRadius(style),
      shadows: designShadows(style),
      opacity: style.opacity === undefined ? 1 : round(style.opacity, 1),
      clipsContent: clipsOverflow(style),
      blendMode: style.mixBlendMode || "normal",
      transform: style.transform && style.transform !== "none" ? style.transform : "",
      transformOrigin: style.transformOrigin || "",
      position: style.position || "static",
      zIndex: style.zIndex || "auto",
      text: kind === "text" ? designText(style) : undefined,
      image:
        kind === "image" || kind === "raster"
          ? {
              fit: style.objectFit || "cover",
              position: style.objectPosition || style.backgroundPosition || "",
            }
          : undefined,
    };
  }

  function firstBackgroundImageUrl(value) {
    const layers = splitCssLayers(value);
    for (const layer of layers) {
      const match = String(layer || "").match(/url\(\s*(["']?)(.*?)\1\s*\)/i);
      if (!match || !match[2]) continue;

      return normalizeAssetUrl(match[2]);
    }

    return "";
  }

  function captureStyleFromComputed(computed, assets) {
    const backgroundImageUrl = firstBackgroundImageUrl(computed.backgroundImage);
    const hasBackgroundAsset = Boolean(backgroundImageUrl);
    const backgroundLayers = splitCssLayers(computed.backgroundImage);
    const gradientBackgroundLayers = backgroundLayers.filter((layer) => hasCssGradient(layer));
    const style = {
      backgroundColor:
        gradientBackgroundLayers.length
          ? gradientBackgroundLayers.join(", ")
          : computed.backgroundColor,
      borderColor: computed.borderColor || computed.borderTopColor,
      borderWidth: px(computed.borderWidth || computed.borderTopWidth),
      borderTopColor: computed.borderTopColor,
      borderRightColor: computed.borderRightColor,
      borderBottomColor: computed.borderBottomColor,
      borderLeftColor: computed.borderLeftColor,
      borderTopWidth: px(computed.borderTopWidth),
      borderRightWidth: px(computed.borderRightWidth),
      borderBottomWidth: px(computed.borderBottomWidth),
      borderLeftWidth: px(computed.borderLeftWidth),
      borderRadius: px(computed.borderRadius),
      borderTopLeftRadius: px(computed.borderTopLeftRadius || computed.borderRadius),
      borderTopRightRadius: px(computed.borderTopRightRadius || computed.borderRadius),
      borderBottomRightRadius: px(computed.borderBottomRightRadius || computed.borderRadius),
      borderBottomLeftRadius: px(computed.borderBottomLeftRadius || computed.borderRadius),
      boxShadow: computed.boxShadow,
      opacity: computed.opacity ? number(computed.opacity, 1) : undefined,
      overflow: computed.overflow,
      overflowX: computed.overflowX,
      overflowY: computed.overflowY,
      position: computed.position,
      zIndex: computed.zIndex,
      transform: computed.transform,
      transformOrigin: computed.transformOrigin,
      mixBlendMode: computed.mixBlendMode,
      filter: computed.filter,
      backdropFilter: computed.backdropFilter,
      clipPath: computed.clipPath,
      paddingTop: px(computed.paddingTop),
      paddingRight: px(computed.paddingRight),
      paddingBottom: px(computed.paddingBottom),
      paddingLeft: px(computed.paddingLeft),
      color: computed.color,
      fontFamily: computed.fontFamily,
      fontSize: px(computed.fontSize, 16),
      fontWeight: computed.fontWeight,
      fontStyle: computed.fontStyle,
      lineHeight: computed.lineHeight,
      letterSpacing: computed.letterSpacing,
      whiteSpace: computed.whiteSpace,
      textTransform: computed.textTransform,
      textAlign: computed.textAlign,
      textDecorationLine: computed.textDecorationLine,
      objectFit: computed.objectFit,
      objectPosition: computed.objectPosition,
      backgroundSize: computed.backgroundSize,
      backgroundPosition: computed.backgroundPosition,
      backgroundRepeat: computed.backgroundRepeat,
      backgroundImage: computed.backgroundImage,
      backgroundLayers,
    };

    if (backgroundImageUrl && assets) {
      style.backgroundAssetId = assetForUrl(backgroundImageUrl, assets, { source: "background" });
      style.objectFit = String(computed.backgroundSize || "").includes("contain")
        ? "contain"
        : "cover";
    }

    return style;
  }

  function captureStyle(element, assets, pseudo) {
    return captureStyleFromComputed(styleFor(element, pseudo), assets);
  }

  function autoLayoutCandidate(layout, style, children) {
    const display = String(layout.display || "").toLowerCase();
    const direction = String(layout.flexDirection || "row").toLowerCase();
    const wrap = String(layout.flexWrap || "").toLowerCase();
    const childCount = Array.isArray(children) ? children.length : 0;
    const padding = designPadding(style || {});

    if ((display === "flex" || display === "inline-flex") && wrap !== "wrap" && wrap !== "wrap-reverse") {
      return {
        enabled: true,
        type: "flex",
        direction: direction.includes("column") ? "vertical" : "horizontal",
        gap: round(layout.gap || layout.columnGap || layout.rowGap),
        padding,
        align: layout.alignItems || "stretch",
        justify: layout.justifyContent || "start",
        confidence: childCount > 0 ? 0.86 : 0.72,
        reason: "simple non-wrapping flex container",
      };
    }

    if (display === "grid" && wrap !== "wrap" && childCount > 1) {
      return {
        enabled: false,
        type: "grid",
        direction: "grid",
        gap: round(layout.gap || layout.columnGap || layout.rowGap),
        padding,
        align: layout.alignItems || "stretch",
        justify: layout.justifyContent || "start",
        confidence: 0.48,
        reason: "grid requires explicit track inference before auto layout",
      };
    }

    return {
      enabled: false,
      type: "absolute",
      direction: "none",
      gap: 0,
      padding,
      align: layout.alignItems || "",
      justify: layout.justifyContent || "",
      confidence: 0,
      reason: "no safe auto layout signal",
    };
  }

  function captureLayout(element, rect, style, children, computedOverride) {
    const computed = computedOverride || styleFor(element);
    const layout = {
      mode: "absolute",
      absolute: cloneRect(rect),
      display: computed.display,
      flexDirection: computed.flexDirection,
      gap: px(computed.gap),
      rowGap: px(computed.rowGap),
      columnGap: px(computed.columnGap),
      flexWrap: computed.flexWrap,
      alignItems: computed.alignItems,
      justifyContent: computed.justifyContent,
      position: computed.position,
    };
    layout.autoLayoutCandidate = autoLayoutCandidate(layout, style, children);
    return layout;
  }

  function inferAssetType(src, contentType, fallback = "image") {
    const type = String(contentType || "").toLowerCase();
    const raw = String(src || "").toLowerCase();
    if (type.includes("svg") || raw.startsWith("data:image/svg") || /\.svg(?:$|\?)/.test(raw)) {
      return "svg";
    }
    if (type.startsWith("image/") || raw.startsWith("data:image/")) return "image";
    if (raw.startsWith("screenshot:")) return "raster";
    return fallback;
  }

  function assetIdFor(src, assets, extra = {}) {
    if (!src) return "";
    if (assetBySrc.has(src)) return assetBySrc.get(src);
    const id = `asset-${assetBySrc.size + 1}`;
    assetBySrc.set(src, id);
    assets[id] = {
      id,
      type: inferAssetType(src, extra.contentType, extra.type),
      src,
      source: extra.source || "remote",
      ...extra,
    };
    return id;
  }

  function base64FromText(text) {
    return btoa(
      encodeURIComponent(String(text || "")).replace(/%([0-9A-F]{2})/g, (_match, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16))
      )
    );
  }

  function assetFromDataUrl(dataUrl, assets, extra = {}) {
    const raw = String(dataUrl || "");
    const comma = raw.indexOf(",");
    if (!raw.startsWith("data:") || comma < 0) return "";

    const meta = raw.slice(5, comma);
    const payload = raw.slice(comma + 1);
    const parts = meta.split(";").filter(Boolean);
    const contentType = parts[0] || "text/plain";
    const isBase64 = parts.some((part) => part.toLowerCase() === "base64");
    let base64 = payload;

    if (!isBase64) {
      let decoded = payload;
      try {
        decoded = decodeURIComponent(payload);
      } catch {
        decoded = payload;
      }
      base64 = base64FromText(decoded);
    }

    return assetIdFor(dataUrl, assets, {
      contentType,
      base64,
      source: extra.source || "data-uri",
      ...extra,
    });
  }

  function assetForUrl(url, assets, extra = {}) {
    return String(url || "").startsWith("data:")
      ? assetFromDataUrl(url, assets, extra)
      : assetIdFor(url, assets, extra);
  }

  function absoluteUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";

    try {
      return new URL(raw, window.location.href).href;
    } catch {
      return raw;
    }
  }

  function splitSvgUseReference(rawHref) {
    const raw = String(rawHref || "").trim();
    if (!raw) return null;

    const hashIndex = raw.lastIndexOf("#");
    if (hashIndex < 0 || hashIndex === raw.length - 1) return null;

    const symbolId = raw.slice(hashIndex + 1);
    const urlPart = raw.slice(0, hashIndex);
    if (!urlPart) return null;

    return {
      rawHref: raw,
      symbolId,
      url: absoluteUrl(urlPart),
    };
  }

  function svgUseReferences(element, assets) {
    if (!element || typeof element.querySelectorAll !== "function") return [];

    const references = [];
    const uses = Array.from(element.querySelectorAll("use") || []);
    for (const use of uses) {
      const rawHref =
        use.getAttribute?.("href") ||
        use.getAttribute?.("xlink:href") ||
        use.getAttribute?.("xmlns:xlink:href") ||
        "";
      const reference = splitSvgUseReference(rawHref);
      if (!reference || !reference.url || !reference.symbolId) continue;

      const assetId = assetForUrl(reference.url, assets, {
        source: "svg-sprite",
        type: "svg",
        contentType: "image/svg+xml",
      });
      const asset = assets && assets[assetId];
      if (asset) {
        asset.symbolIds = Array.isArray(asset.symbolIds) ? asset.symbolIds : [];
        if (!asset.symbolIds.includes(reference.symbolId)) asset.symbolIds.push(reference.symbolId);
      }

      references.push({
        assetId,
        rawHref: reference.rawHref,
        url: reference.url,
        symbolId: reference.symbolId,
      });
    }

    return references;
  }

  function screenshotAssetForNode(element, assets, reason) {
    return assetIdFor(`screenshot:${reason}:${elementName(element)}`, assets, {
      error: "SCREENSHOT_REQUIRED",
      fallback: "visible-tab-screenshot",
      source: reason,
      type: "raster",
    });
  }

  function toBase64(bytes) {
    let binary = "";
    const chunkSize = 32768;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  async function hydrateInlineAssets(assets) {
    await Promise.all(
      Object.values(assets).map(async (asset) => {
        if (!asset || asset.base64 || asset.data || !String(asset.src || "").startsWith("blob:")) return;

        try {
          const response = await fetch(asset.src);
          if (!response.ok) throw new Error(`HTTP_${response.status}`);
          const contentType = response.headers?.get?.("content-type") || asset.contentType || "image/png";
          const bytes = new Uint8Array(await response.arrayBuffer());
          asset.base64 = toBase64(bytes);
          asset.contentType = contentType;
          asset.type = inferAssetType(asset.src, contentType, asset.type);
        } catch (error) {
          asset.error = (error && error.message) || String(error);
        }
      })
    );
  }

  function cssLength(value, base, fallback) {
    const raw = String(value || "").trim();
    if (!raw || raw === "auto" || raw === "normal" || raw === "none") return fallback;
    if (raw.endsWith("%")) return (number(raw, 0) / 100) * base;
    return px(raw, fallback);
  }

  function cleanCssContent(value) {
    const raw = String(value || "").trim();
    if (!raw || raw === "none" || raw === "normal") return "";
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
    }
    return raw;
  }

  function hasPseudoContent(value) {
    const raw = String(value || "").trim();
    return Boolean(raw && raw !== "none" && raw !== "normal");
  }

  function pseudoRect(element, computed, rootRect) {
    const parentRect = rectFor(element, rootRect);
    const fontSize = px(computed.fontSize, 16);
    const width = Math.max(1, cssLength(computed.width, parentRect.width, fontSize));
    const height = Math.max(
      1,
      cssLength(computed.height, parentRect.height, px(computed.lineHeight, fontSize))
    );
    const left = cssLength(computed.left, parentRect.width, 0);
    const top = cssLength(computed.top, parentRect.height, 0);

    return {
      x: Math.round((parentRect.x + left) * 100) / 100,
      y: Math.round((parentRect.y + top) * 100) / 100,
      width: Math.round(width * 100) / 100,
      height: Math.round(height * 100) / 100,
    };
  }

  function hasPseudoVisual(computed) {
    if (!hasPseudoContent(computed.content)) return false;

    return Boolean(
      cleanCssContent(computed.content) ||
        firstBackgroundImageUrl(computed.backgroundImage) ||
        !isTransparent(computed.backgroundColor) ||
        px(computed.borderWidth || computed.borderTopWidth) > 0
    );
  }

  function capturePseudo(element, rootRect, assets, pseudo) {
    const computed = styleFor(element, pseudo);
    if (!computed || computed.display === "none" || computed.visibility === "hidden") return null;
    if (!hasPseudoVisual(computed)) return null;

    const rect = pseudoRect(element, computed, rootRect);
    const content = cleanCssContent(computed.content);
    const style = captureStyleFromComputed(computed, assets);
    const name = `${elementName(element)}${pseudo}`;

    if (content && !style.backgroundAssetId && isTransparent(computed.backgroundColor)) {
      return buildNode("text", rect, {
        name: `Text · ${textName(content)}`,
        text: content,
        style,
        source: sourceForElement(element, { pseudo }),
      });
    }

    const children = content
      ? [
          buildNode("text", rect, {
            name: `Text · ${textName(content)}`,
            text: content,
            style,
            source: sourceForElement(element, { pseudo, generatedContent: true }),
          }),
        ]
      : [];

    return buildNode("frame", rect, {
      name,
      tag: pseudo,
      role: "",
      ariaLabel: "",
      style,
      source: sourceForElement(element, { pseudo }),
      layout: captureLayout(element, rect, style, children, computed),
      children,
    });
  }

  function shouldIgnoreElement(node) {
    if (node.getAttribute?.("data-figma-capture-ignore") === "1") return true;
    if (node.closest?.("[data-figma-capture-ignore='1']")) return true;

    const id = String(node.id || "");
    const className = String(node.className || "");
    const tag = String(node.tagName || "").toLowerCase();
    const marker = `${tag} ${id} ${className} ${node.getAttribute?.("data-testid") || ""} ${
      node.getAttribute?.("aria-label") || ""
    }`;
    if (
      /(monica|immersive-translate|google_translate|gtx-trans|plasmo|crx-root|translation-theme)/i.test(
        marker
      )
    ) {
      return true;
    }

    return tag === "font" && /\bnotranslate\b/i.test(className);
  }

  function isSkipLinkElement(node, rect) {
    if (!node || String(node.tagName || "").toLowerCase() !== "a") return false;

    const text = String(collectTextContent(node)).replace(/\s+/g, " ").trim();
    if (!/^skip to (content|main)/i.test(text)) return false;

    const href = String(node.getAttribute?.("href") || "").trim();
    const className = String(node.className || "");
    const id = String(node.id || "");
    const top = Number(rect && rect.y);

    return (
      href.startsWith("#") ||
      /\bskip\b/i.test(className) ||
      /\bskip\b/i.test(id) ||
      Number.isFinite(top) && top < 40
    );
  }

  function collectTextContent(node) {
    if (!node) return "";
    if (node.nodeType === TEXT_NODE) return String(node.textContent || "");
    if (node.nodeType !== ELEMENT_NODE) return "";
    return Array.from(node.childNodes || [])
      .map((child) => collectTextContent(child))
      .join(" ");
  }

  const AGGREGATED_TEXT_TAGS = new Set(["p", "figcaption", "blockquote"]);
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
  const REPLACED_OR_CONTROL_TAGS = new Set([
    "button",
    "canvas",
    "iframe",
    "img",
    "input",
    "select",
    "svg",
    "textarea",
    "video",
  ]);

  function hasOnlyInlineTextDescendants(node) {
    for (const child of Array.from(node.childNodes || [])) {
      if (child.nodeType === TEXT_NODE) continue;
      if (child.nodeType !== ELEMENT_NODE) return false;
      const childTag = String(child.tagName || "").toLowerCase();
      if (REPLACED_OR_CONTROL_TAGS.has(childTag) || !INLINE_TEXT_TAGS.has(childTag)) return false;
      if (!hasOnlyInlineTextDescendants(child)) return false;
    }
    return true;
  }

  function shouldCaptureTextAsSingleNode(node, rect) {
    if (!node || node.nodeType !== ELEMENT_NODE) return false;
    const tag = String(node.tagName || "").toLowerCase();
    if (!AGGREGATED_TEXT_TAGS.has(tag)) return false;

    const computed = styleFor(node);
    if (!computed || computed.display === "none" || computed.visibility === "hidden") return false;
    if (computed.display === "flex" || computed.display === "inline-flex" || computed.display === "grid") {
      return false;
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;

    if (!hasOnlyInlineTextDescendants(node)) return false;

    return true;
  }

  function hasVisibleFrameStyle(style) {
    if (!style) return false;
    if (style.backgroundAssetId) return true;
    if (!isTransparent(style.backgroundColor || style.background || style.fill)) return true;
    if (designStrokes(style).length > 0) return true;
    if (style.boxShadow && style.boxShadow !== "none") return true;
    return false;
  }

  function classListFor(element) {
    return String(element?.className || "")
      .split(/\s+/)
      .filter(Boolean);
  }

  function sourceSelectorFor(element) {
    const tag = String(element?.tagName || "node").toLowerCase();
    if (element?.id) return `#${element.id}`;
    const classes = classListFor(element).slice(0, 2);
    if (classes.length) return `${tag}.${classes.join(".")}`;
    return tag;
  }

  function sourceForElement(element, extra = {}) {
    if (!element) return { nodeType: "unknown" };
    const tag = String(element.tagName || "node").toLowerCase();
    return {
      nodeType: "element",
      tag,
      id: element.id || "",
      className: String(element.className || ""),
      selector: sourceSelectorFor(element),
      role: element.getAttribute?.("role") || "",
      ariaLabel: element.getAttribute?.("aria-label") || "",
      testId: element.getAttribute?.("data-testid") || "",
      ...extra,
    };
  }

  function sourceForTextNode(node) {
    const parent = node && node.parentElement;
    return {
      ...sourceForElement(parent),
      nodeType: "text",
      parentSelector: parent ? sourceSelectorFor(parent) : "",
    };
  }

  function buildNode(kind, rect, fields) {
    const node = {
      id: nextNodeId(kind),
      type: kind,
      kind,
      rect: cloneRect(rect),
      absoluteRect: cloneRect(rect),
      paintOrder: ++paintSequence,
      ...fields,
    };
    node.design = node.design || designStyle(kind, node.rect, node.style || {});
    return node;
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

    if (node.parentElement) {
      const parentRect = rectFor(node.parentElement, rootRect);
      if (isVisuallyHiddenElement(node.parentElement, parentRect)) return null;
    }

    const parentStyle = node.parentElement ? captureStyle(node.parentElement) : {};
    return buildNode("text", rect, {
      name: `Text · ${textName(text)}`,
      text,
      style: parentStyle,
      source: sourceForTextNode(node),
      textRuns: [
        {
          start: 0,
          end: text.length,
          style: designText(parentStyle),
        },
      ],
    });
  }

  function captureImage(element, rootRect, assets) {
    const src = element.currentSrc || element.src || element.getAttribute?.("src") || "";
    const rect = rectFor(element, rootRect);
    const assetId = assetForUrl(src, assets, {
      source: "img",
      naturalWidth: number(element.naturalWidth),
      naturalHeight: number(element.naturalHeight),
      alt: element.alt || "",
    });
    return buildNode("image", rect, {
      name: element.alt || element.getAttribute?.("aria-label") || elementName(element),
      assetId,
      style: captureStyle(element, assets),
      source: sourceForElement(element),
    });
  }

  function captureSvg(element, rootRect, assets) {
    const rect = rectFor(element, rootRect);
    const svgUses = svgUseReferences(element, assets);
    return buildNode("svg", rect, {
      name: element.getAttribute?.("aria-label") || elementName(element),
      svg: element.outerHTML || "<svg />",
      svgUses,
      style: captureStyle(element, {}),
      source: sourceForElement(element),
    });
  }

  function captureNode(node, rootRect, assets) {
    if (!node) return null;
    if (node.nodeType === TEXT_NODE) return captureTextNode(node, rootRect);
    if (node.nodeType !== ELEMENT_NODE) return null;
    if (shouldIgnoreElement(node)) return null;

    const tag = String(node.tagName || "").toLowerCase();
    const rect = rectFor(node, rootRect);
    if (!isVisible(node, rect)) return null;
    if (isVisuallyHiddenElement(node, rect)) return null;
    if (isSkipLinkElement(node, rect)) return null;
    if (tag === "img") return captureImage(node, rootRect, assets);
    if (tag === "svg") return captureSvg(node, rootRect, assets);
    if (tag === "canvas" || tag === "video" || tag === "iframe") {
      const poster = tag === "video" ? String(node.poster || "").trim() : "";
      const rasterAssetId = tag === "canvas" && typeof node.toDataURL === "function"
        ? assetFromDataUrl(node.toDataURL("image/png"), assets, { source: "canvas", type: "raster" })
        : poster
        ? assetForUrl(poster, assets, { source: tag, type: "raster" })
        : screenshotAssetForNode(node, assets, tag);
      return buildNode("raster", rect, {
        name: elementName(node),
        assetId: rasterAssetId,
        style: captureStyle(node, assets),
        source: sourceForElement(node, { fallback: "raster" }),
        fallback: {
          type: "raster",
          reason: tag,
          assetId: rasterAssetId,
        },
      });
    }

    if (shouldCaptureTextAsSingleNode(node, rect)) {
      const text = String(collectTextContent(node)).replace(/\s+/g, " ").trim();
      if (text) {
        const style = captureStyle(node, assets);
        const textNode = buildNode("text", rect, {
          name: `Text · ${textName(text)}`,
          text,
          style,
          source: sourceForElement(node),
          textRuns: [
            {
              start: 0,
              end: text.length,
              style: designText(style),
            },
          ],
        });

        return buildNode("frame", rect, {
          name: elementName(node),
          tag,
          role: node.getAttribute?.("role") || "",
          ariaLabel: node.getAttribute?.("aria-label") || "",
          style,
          source: sourceForElement(node),
          layout: captureLayout(node, rect, style, [textNode]),
          children: [textNode],
        });
      }
    }

    const before = capturePseudo(node, rootRect, assets, "::before");
    const after = capturePseudo(node, rootRect, assets, "::after");
    const domChildren = Array.from(node.childNodes || [])
      .map((child) => {
        if (child.nodeType === TEXT_NODE) child.parentElement = node;
        return captureNode(child, rootRect, assets);
      })
      .filter(Boolean);
    const children = [before, ...domChildren, after].filter(Boolean);
    const style = captureStyle(node, assets);
    if (children.length === 0 && !hasVisibleFrameStyle(style)) return null;

    return buildNode("frame", rect, {
      name: elementName(node),
      tag,
      role: node.getAttribute?.("role") || "",
      ariaLabel: node.getAttribute?.("aria-label") || "",
      style,
      source: sourceForElement(node),
      layout: captureLayout(node, rect, style, children),
      children,
    });
  }

  async function webToFigmaCaptureScene(selector = "body", options = {}) {
    assetBySrc.clear();
    nodeSequence = 0;
    paintSequence = 0;
    const target =
      selector === "body" || selector === "html" ? document.body : document.querySelector(selector);
    if (!target) throw new Error(`Element not found: ${selector}`);

    const fullPage = selector === "body" || selector === "html";
    const rootRect = absoluteRect(target, fullPage);
    const assets = {};
    const root = captureNode(target, rootRect, assets);
    await hydrateInlineAssets(assets);
    root.rect = {
      x: rootRect.x,
      y: rootRect.y,
      width: rootRect.width,
      height: rootRect.height,
    };
    root.absoluteRect = cloneRect(root.rect);
    root.design = designStyle(root.kind || root.type || "frame", root.rect, root.style || {});
    if (root.layout) {
      root.layout.mode = "absolute";
      root.layout.absolute = cloneRect(root.rect);
      root.layout.autoLayoutCandidate = autoLayoutCandidate(root.layout, root.style || {}, root.children || []);
    }

    return {
      version: 1,
      irVersion: 2,
      schema: "web-to-figma.scene-ir",
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
      capabilities: {
        absoluteGeometry: true,
        designStyle: true,
        textRuns: true,
        assetMetadata: true,
        layoutCandidates: true,
        localRasterFallback: true,
      },
      assets,
      root,
    };
  }

  window.webToFigmaCaptureScene = webToFigmaCaptureScene;
})();
