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
  const STOP_SCROLL_KEY = "__FIGMA_CAPTURE_STOP_SCROLL_REQUESTED__";
  const isFullPageCapture = captureSelector === "body";
  window[STOP_SCROLL_KEY] = false;
  const diagnostics = {
    generatedAt: new Date().toISOString(),
    qualityMode: captureOptions.qualityMode || "standard",
    imagesDiscovered: 0,
    hdImagesPromoted: 0,
    hdBackgroundsPromoted: 0,
    scrollStoppedByUser: false,
    scrollLoadedUntil: 0,
    scrollSteps: 0,
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
  const CONTENT_FLOW_STATE_KEY = "__FIGMA_CAPTURE_CONTENT_FLOW_STATE__";
  const DEFAULT_STREAM_SEGMENT_SCREENS = 5;
  const STABLE_BOTTOM_PASSES = 2;
  const scrollStep = Math.max(400, Math.floor(window.innerHeight * 0.8));
  const viewportHeight = Math.max(1, window.innerHeight || 1);
  const getPageHeight = () =>
    Math.max(
      window.innerHeight || 0,
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0
    );
  const numberInRange = (value, fallback, min, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
  };
  const contentFlowOptions = captureOptions.contentFlow || {};
  const segmentScreens = numberInRange(
    contentFlowOptions.segmentScreens,
    DEFAULT_STREAM_SEGMENT_SCREENS,
    1,
    20
  );
  const segmentHeight = segmentScreens * viewportHeight;
  const requestedNextSegment = contentFlowOptions.action === "next";
  const initialScroll = {
    x: Number(window.scrollX) || 0,
    y: Number(window.scrollY) || 0,
  };
  const stopScrollRequested = () => Boolean(window[STOP_SCROLL_KEY]);

  const scrollUntilSettled = async (startY, maxSteps) => {
    let y = Math.max(0, Number(startY) || 0);
    let loadedUntil = y + viewportHeight;
    let stableBottomPasses = 0;

    for (let steps = 0; steps < maxSteps; steps++) {
      emitProgress("scrolling", {
        canStopScroll: isFullPageCapture,
        loadedUntil,
        step: steps + 1,
      });
      if (stopScrollRequested()) {
        return { ended: false, stoppedByUser: true, loadedUntil, steps };
      }

      const pageHeightBefore = getPageHeight();
      const maxScrollY = Math.max(0, pageHeightBefore - viewportHeight);
      const targetY = Math.min(y, maxScrollY);
      window.scrollTo(0, targetY);
      await delay(400);

      const pageHeightAfter = getPageHeight();
      loadedUntil = Math.max(loadedUntil, targetY + viewportHeight);
      if (stopScrollRequested()) {
        return { ended: false, stoppedByUser: true, loadedUntil, steps: steps + 1 };
      }

      const isAtBottom = targetY + viewportHeight >= pageHeightAfter - 2;

      if (isAtBottom) {
        await delay(300);
        const settledHeight = getPageHeight();
        if (stopScrollRequested()) {
          return { ended: false, stoppedByUser: true, loadedUntil, steps: steps + 1 };
        }

        if (settledHeight <= pageHeightAfter + 2) {
          stableBottomPasses++;
          if (stableBottomPasses >= STABLE_BOTTOM_PASSES) {
            return { ended: true, loadedUntil, steps: steps + 1 };
          }
        } else {
          stableBottomPasses = 0;
        }
      } else {
        stableBottomPasses = 0;
      }

      y = targetY + scrollStep;
    }

    return { ended: false, loadedUntil, steps: maxSteps };
  };
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

  const rectForNode = (node) => {
    const rect = (node && node.rect) || {};
    return {
      x: Number(rect.x) || 0,
      y: Number(rect.y) || 0,
      width: Math.max(1, Number(rect.width) || 1),
      height: Math.max(1, Number(rect.height) || 1),
    };
  };
  const setNodeRect = (node, rect) => {
    if (!node) return;
    const nextRect = {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
    node.rect = nextRect;
    if (node.absoluteRect) node.absoluteRect = { ...nextRect };
    if (node.design?.absoluteRect) node.design.absoluteRect = { ...nextRect };
  };
  const translateNode = (node, deltaY) => {
    const rect = rectForNode(node);
    setNodeRect(node, { ...rect, y: rect.y + deltaY });
    for (const child of node.children || []) translateNode(child, deltaY);
  };
  const isPinnedNode = (node) => {
    const position = String(node?.style?.position || node?.design?.position || "").toLowerCase();
    return position === "fixed" || position === "sticky";
  };
  const intersectsRange = (rect, start, end) => rect.y < end && rect.y + rect.height > start;
  const cropSceneToContentSegment = (scene, flow) => {
    if (!scene || !scene.root || !flow?.isSegment) return scene;

    const start = flow.rangeStart;
    const end = flow.rangeEnd;
    const root = scene.root;
    const originalRootRect = rectForNode(root);
    const cropNode = (node, isRoot = false) => {
      if (!node) return null;
      if (!isRoot && isPinnedNode(node)) {
        const rect = rectForNode(node);
        translateNode(node, start - rect.y);
        return node;
      }

      const children = [];
      for (const child of node.children || []) {
        const croppedChild = cropNode(child);
        if (croppedChild) children.push(croppedChild);
      }
      const rect = rectForNode(node);
      if (!isRoot && !intersectsRange(rect, start, end) && !children.length) return null;
      node.children = children;
      return node;
    };

    cropNode(root, true);
    setNodeRect(root, {
      x: originalRootRect.x,
      y: start,
      width: originalRootRect.width,
      height: Math.max(1, end - start),
    });
    root.style = root.style || {};
    root.style.overflow = "clip";
    root.style.overflowX = "clip";
    root.style.overflowY = "clip";
    root.design = root.design || {};
    root.design.clipsContent = true;

    scene.capture = scene.capture || {};
    scene.capture.contentFlow = flow;
    return scene;
  };

  emitProgress("preparing", { qualityMode: diagnostics.qualityMode });

  const savedFlowState = window[CONTENT_FLOW_STATE_KEY];
  const canContinueFlow =
    isFullPageCapture &&
    requestedNextSegment &&
    savedFlowState &&
    savedFlowState.url === window.location.href;
  let scrollPreparation;
  let contentFlow = null;

  if (canContinueFlow) {
    const rangeStart = Math.max(0, Number(savedFlowState.nextSegmentStart) || 0);
    const segmentIndex = Math.max(1, Number(savedFlowState.nextSegmentIndex) || 1);
    const priorLoadedUntil = Math.max(0, Number(savedFlowState.loadedUntil) || 0);
    const targetRangeEnd = rangeStart + segmentHeight;

    scrollPreparation =
      targetRangeEnd <= priorLoadedUntil
        ? { ended: false, loadedUntil: priorLoadedUntil, steps: 0 }
        : await scrollUntilSettled(Math.max(0, priorLoadedUntil - scrollStep), MAX_SCROLL_STEPS);

    const pageHeight = getPageHeight();
    const targetEnd = scrollPreparation.stoppedByUser ? scrollPreparation.loadedUntil : targetRangeEnd;
    const rangeEnd = Math.max(rangeStart + 1, Math.min(targetEnd, pageHeight));
    const hasMore = scrollPreparation.stoppedByUser
      ? false
      : !scrollPreparation.ended || rangeEnd < pageHeight - 2;
    contentFlow = {
      isSegment: true,
      segmentIndex,
      rangeStart,
      rangeEnd,
      segmentScreens,
      hasMore,
      reason: scrollPreparation.stoppedByUser
        ? "user-stopped"
        : scrollPreparation.ended
        ? "page-end"
        : "continuous-content",
      stoppedByUser: Boolean(scrollPreparation.stoppedByUser),
    };
  } else {
    if (isFullPageCapture) delete window[CONTENT_FLOW_STATE_KEY];
    scrollPreparation = await scrollUntilSettled(0, MAX_SCROLL_STEPS);
    if (isFullPageCapture && scrollPreparation.stoppedByUser) {
      const pageHeight = getPageHeight();
      contentFlow = {
        isSegment: true,
        segmentIndex: 1,
        rangeStart: 0,
        rangeEnd: Math.max(1, Math.min(scrollPreparation.loadedUntil, pageHeight)),
        segmentScreens,
        hasMore: false,
        reason: "user-stopped",
        stoppedByUser: true,
      };
    } else if (isFullPageCapture && !scrollPreparation.ended) {
      const pageHeight = getPageHeight();
      contentFlow = {
        isSegment: true,
        segmentIndex: 1,
        rangeStart: 0,
        rangeEnd: Math.max(1, Math.min(segmentHeight, pageHeight)),
        segmentScreens,
        hasMore: true,
        reason: "continuous-content",
        stoppedByUser: false,
      };
    }
  }

  diagnostics.scrollStoppedByUser = Boolean(scrollPreparation?.stoppedByUser);
  diagnostics.scrollLoadedUntil = Math.round(Number(scrollPreparation?.loadedUntil) || 0);
  diagnostics.scrollSteps = Math.round(Number(scrollPreparation?.steps) || 0);

  if (contentFlow?.isSegment) {
    const nextState = {
      url: window.location.href,
      loadedUntil: scrollPreparation.loadedUntil,
      nextSegmentStart: contentFlow.rangeEnd,
      nextSegmentIndex: contentFlow.segmentIndex + 1,
    };
    if (contentFlow.hasMore) window[CONTENT_FLOW_STATE_KEY] = nextState;
    else delete window[CONTENT_FLOW_STATE_KEY];
    emitProgress(contentFlow.stoppedByUser ? "scroll-stopped" : "continuous-content", contentFlow);
  }

  await delay(800);
  window.scrollTo(0, contentFlow?.isSegment ? contentFlow.rangeStart : 0);
  await delay(250);

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
    let scene;
    if (window.webToFigmaCaptureScene) {
      scene = await window.webToFigmaCaptureScene(captureSelector, {
        qualityMode: diagnostics.qualityMode,
      });
    } else {
      scene = await window.figma.captureForDesign({ selector: captureSelector });
    }

    return cropSceneToContentSegment(scene, contentFlow);
  } finally {
    restoreIgnoredUi.forEach((restore) => restore());
    restoreHdAssets.forEach((restore) => restore());
    window.scrollTo(initialScroll.x, initialScroll.y);
  }
})();
