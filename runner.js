(async () => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  if (!window.webToFigmaCaptureScene && !window.figma?.captureForDesign) {
    throw new Error(
      "No capture adapter is available. scene-capture.js may not have loaded."
    );
  }

  const captureOptions = window.__FIGMA_CAPTURE_OPTIONS__ || {};
  const captureSelector = captureOptions.selector || "body";
  const PROGRESS_EVENT = "__FIGMA_CAPTURE_PROGRESS__";
  const diagnostics = {
    generatedAt: new Date().toISOString(),
    qualityMode: captureOptions.qualityMode || "standard",
    imagesDiscovered: 0,
    hdImagesPromoted: 0,
    hdBackgroundsPromoted: 0,
  };
  const emitProgress = (stage, detail = {}) => {
    try {
      const payload = { stage, ...detail, diagnostics: { ...diagnostics } };
      window.__FIGMA_CAPTURE_LAST_DIAGNOSTICS__ = payload.diagnostics;
      window.dispatchEvent?.(new CustomEvent(PROGRESS_EVENT, { detail: payload }));
    } catch {
      // Progress updates are best-effort only.
    }
  };
  const MAX_SCROLL_STEPS = 50;
  const scrollStep = Math.max(400, Math.floor(window.innerHeight * 0.8));
  const getPageHeight = () =>
    Math.max(
      window.innerHeight || 0,
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0
    );
  const resolveUrl = (rawUrl) => {
    if (!String(rawUrl || "").trim()) return "";

    try {
      return new URL(rawUrl, document.baseURI || window.location.href).href;
    } catch {
      return "";
    }
  };
  const isUsableImageUrl = (rawUrl) => {
    const url = String(rawUrl || "").trim();
    return Boolean(url) && !url.startsWith("data:") && !url.startsWith("blob:");
  };
  const bestSrcsetCandidate = (srcset) => {
    if (!srcset) return "";

    return srcset
      .split(",")
      .map((part) => {
        const [rawUrl, descriptor = "1x"] = part.trim().split(/\s+/);
        const widthMatch = descriptor.match(/^(\d+)w$/);
        const densityMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/);
        const score = widthMatch
          ? Number(widthMatch[1])
          : densityMatch
          ? Number(densityMatch[1]) * 1000
          : 1;

        return { url: resolveUrl(rawUrl), score };
      })
      .filter((candidate) => isUsableImageUrl(candidate.url))
      .sort((a, b) => b.score - a.score)[0]?.url || "";
  };
  const lazyImageCandidate = (img) => {
    const attributes = [
      "data-src",
      "data-original",
      "data-lazy-src",
      "data-lazy",
      "data-url",
      "data-large",
    ];

    for (const name of attributes) {
      const value = img.getAttribute?.(name);
      const url = resolveUrl(value);
      if (isUsableImageUrl(url)) return url;
    }

    return "";
  };
  const scoreDescriptor = (descriptor = "1x") => {
    const widthMatch = String(descriptor).match(/^(\d+)w$/);
    const densityMatch = String(descriptor).match(/^(\d+(?:\.\d+)?)x$/);

    if (widthMatch) return Number(widthMatch[1]);
    if (densityMatch) return Number(densityMatch[1]) * 1000;
    return 1;
  };
  const bestImageSetCandidate = (value) => {
    if (!String(value || "").includes("image-set(")) return "";

    const candidates = [];
    const matcher = /url\(\s*(["']?)(.*?)\1\s*\)\s*(\d+(?:\.\d+)?x|\d+w)?/gi;
    let match;

    while ((match = matcher.exec(value))) {
      const url = resolveUrl(match[2]);
      if (isUsableImageUrl(url)) {
        candidates.push({ url, score: scoreDescriptor(match[3]) });
      }
    }

    return candidates.sort((a, b) => b.score - a.score)[0]?.url || "";
  };
  const promoteHdBackgrounds = () => {
    if (captureOptions.qualityMode !== "hd") return [];

    return Array.from(document.querySelectorAll?.("*") || []).flatMap((element) => {
      const style = element.style;
      if (!style) return [];

      const computed = window.getComputedStyle?.(element);
      const candidate =
        bestImageSetCandidate(computed?.backgroundImage) ||
        bestImageSetCandidate(style.backgroundImage);

      if (!candidate) return [];

      const originalBackgroundImage = style.backgroundImage;
      style.backgroundImage = `url("${candidate}")`;

      return [
        () => {
          style.backgroundImage = originalBackgroundImage;
        },
      ];
    });
  };
  const hideIgnoredUi = () =>
    Array.from(document.querySelectorAll?.("[data-figma-capture-ignore='1']") || []).flatMap(
      (element) => {
        if (!element.style) return [];

        const original = {
          display: element.style.display,
          visibility: element.style.visibility,
          pointerEvents: element.style.pointerEvents,
        };

        element.style.display = "none";
        element.style.visibility = "hidden";
        element.style.pointerEvents = "none";

        return [
          () => {
            element.style.display = original.display;
            element.style.visibility = original.visibility;
            element.style.pointerEvents = original.pointerEvents;
          },
        ];
      }
    );
  const pictureSourceCandidate = (img) => {
    const parent = img.parentElement;
    if (!parent || String(parent.tagName || "").toLowerCase() !== "picture") return "";

    for (const source of Array.from(parent.querySelectorAll?.("source") || [])) {
      const candidate = bestSrcsetCandidate(source.getAttribute?.("srcset"));
      if (candidate) return candidate;
    }

    return "";
  };
  const promoteHdImages = () => {
    if (captureOptions.qualityMode !== "hd") return [];

    return Array.from(document.images || []).flatMap((img) => {
      const candidate =
        pictureSourceCandidate(img) ||
        bestSrcsetCandidate(img.getAttribute?.("srcset")) ||
        lazyImageCandidate(img);
      if (!candidate || candidate === img.currentSrc || candidate === img.src) return [];

      const originalSrc = img.getAttribute?.("src") || img.src || "";
      img.setAttribute?.("src", candidate);
      img.src = candidate;

      return [
        () => {
          if (originalSrc) {
            img.setAttribute?.("src", originalSrc);
            img.src = originalSrc;
          }
        },
      ];
    });
  };

  emitProgress("preparing", { qualityMode: diagnostics.qualityMode });
  emitProgress("scrolling");

  for (
    let y = 0, steps = 0;
    y < getPageHeight() && steps < MAX_SCROLL_STEPS;
    y += scrollStep, steps++
  ) {
    window.scrollTo(0, y);
    await delay(400);
  }

  await delay(1500);
  window.scrollTo(0, 0);

  const images = Array.from(document.images || []);
  diagnostics.imagesDiscovered = images.length;
  const restoreHdImages = promoteHdImages();
  const restoreHdBackgrounds = promoteHdBackgrounds();
  const restoreHdAssets = [...restoreHdImages, ...restoreHdBackgrounds];
  diagnostics.hdImagesPromoted = restoreHdImages.length;
  diagnostics.hdBackgroundsPromoted = restoreHdBackgrounds.length;
  emitProgress("loading-images", {
    imagesDiscovered: diagnostics.imagesDiscovered,
    hdImagesPromoted: diagnostics.hdImagesPromoted,
    hdBackgroundsPromoted: diagnostics.hdBackgroundsPromoted,
  });

  await Promise.allSettled(
    images.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
            setTimeout(resolve, 10000);
          })
    )
  );

  if (document.fonts?.ready) {
    emitProgress("loading-fonts");
    await Promise.race([document.fonts.ready, delay(3000)]);
  }

  await delay(1000);
  emitProgress("capturing", { selector: captureSelector });
  const restoreIgnoredUi = hideIgnoredUi();
  try {
    if (window.webToFigmaCaptureScene) {
      return await window.webToFigmaCaptureScene(captureSelector, {
        qualityMode: diagnostics.qualityMode,
      });
    }

    return await window.figma.captureForDesign({ selector: captureSelector });
  } finally {
    restoreIgnoredUi.forEach((restore) => restore());
    restoreHdAssets.forEach((restore) => restore());
  }
})();
