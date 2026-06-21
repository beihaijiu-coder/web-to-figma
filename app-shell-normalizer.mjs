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

function setNodeRect(node, rect) {
  if (!node) return;
  const next = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };

  node.rect = next;
  if (node.absoluteRect) node.absoluteRect = { ...next };
  if (node.design?.absoluteRect) node.design.absoluteRect = { ...next };
  if (node.layout?.absolute) node.layout.absolute = { ...next };
}

function visit(node, visitor, parent = null) {
  if (!node || typeof node !== "object") return;
  visitor(node, parent);
  for (const child of node.children || []) visit(child, visitor, node);
}

function intersects(a, b, tolerance = 0) {
  return (
    a.x < b.x + b.width - tolerance &&
    a.x + a.width > b.x + tolerance &&
    a.y < b.y + b.height - tolerance &&
    a.y + a.height > b.y + tolerance
  );
}

function intersection(a, b) {
  if (!intersects(a, b)) return null;
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

function isTransparentColor(value) {
  const raw = String(value || "").trim().toLowerCase();
  return (
    !raw ||
    raw === "transparent" ||
    raw === "rgba(0, 0, 0, 0)" ||
    raw === "rgba(0,0,0,0)" ||
    /rgba\([^)]*,\s*0(?:\.0+)?\s*\)/.test(raw)
  );
}

function hasVisiblePaint(node, options = {}) {
  const kind = String(node?.kind || node?.type || "").toLowerCase();
  const style = node?.style || {};

  if (kind === "text" && String(node.text || "").trim()) return true;
  if (kind === "image" || kind === "raster" || kind === "svg") return true;
  if (node?.assetId || node?.svg) return true;
  if (style.backgroundAssetId || style.fill) return true;
  if (Number(style.borderWidth || 0) > 0 && !isTransparentColor(style.borderColor)) return true;
  if (options.includeBackground && !isTransparentColor(style.backgroundColor)) return true;
  return false;
}

function hasVisibleContentInRegion(node, region, options = {}) {
  let found = false;
  visit(node, (candidate) => {
    if (found) return;
    const rect = rectOf(candidate);
    if (!intersects(rect, region, 0.5)) return;
    const overlap = intersection(rect, region);
    if (!overlap || overlap.width < 1 || overlap.height < 1) return;
    if (hasVisiblePaint(candidate, options)) found = true;
  });
  return found;
}

function isFixedShellNode(node) {
  const position = String(node?.style?.position || node?.design?.position || "").toLowerCase();
  return position === "fixed" || position === "sticky";
}

function isTopShell(node, rootRect) {
  const rect = rectOf(node);
  const maxTopShellHeight = Math.min(160, Math.max(48, rootRect.height * 0.3));
  return (
    rect.y <= rootRect.y + 4 &&
    rect.height >= 24 &&
    rect.height <= maxTopShellHeight &&
    rect.width >= Math.min(rootRect.width * 0.5, 480) &&
    rect.width >= rect.height * 3
  );
}

function isSideShell(node, rootRect) {
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

function translateNodeTree(node, deltaY) {
  if (!node || !Number.isFinite(deltaY) || Math.abs(deltaY) < 0.5) return;
  const rect = rectOf(node);
  setNodeRect(node, {
    x: rect.x,
    y: rect.y + deltaY,
    width: rect.width,
    height: rect.height,
  });
  for (const child of node.children || []) translateNodeTree(child, deltaY);
}

function moveSideShellBelowTopShell(sideNode, targetTop) {
  const rect = rectOf(sideNode);
  const deltaY = targetTop - rect.y;
  if (deltaY <= 0.5 || targetTop >= rect.y + rect.height - 24) return false;

  translateNodeTree(sideNode, deltaY);
  const nextRect = rectOf(sideNode);
  setNodeRect(sideNode, {
    x: nextRect.x,
    y: nextRect.y,
    width: nextRect.width,
    height: Math.max(1, rect.y + rect.height - targetTop),
  });
  return true;
}

function isInsetTopShell(shell, rootRect) {
  const rect = shell.rect || rectOf(shell.node);
  return rect.x > rootRect.x + 4 || rect.width < rootRect.width - 8;
}

function moveTopShellBelowTopShell(shellNode, targetTop) {
  const rect = rectOf(shellNode);
  const deltaY = targetTop - rect.y;
  if (deltaY <= 0.5) return false;
  translateNodeTree(shellNode, deltaY);
  return true;
}

export function normalizeFixedShellOverlaps(scene) {
  const root = scene && scene.root;
  if (!root) return { adjusted: 0 };

  const rootRect = rectOf(root);
  const fixedNodes = [];
  visit(root, (node) => {
    if (node === root || !isFixedShellNode(node)) return;
    const rect = rectOf(node);
    if (rect.width <= 1 || rect.height <= 1) return;
    fixedNodes.push({ node, rect });
  });

  const topShells = fixedNodes.filter(({ node }) => isTopShell(node, rootRect));
  const sideShells = fixedNodes.filter(({ node }) => isSideShell(node, rootRect));
  let adjusted = 0;

  for (const topShell of topShells) {
    if (!isInsetTopShell(topShell, rootRect)) continue;

    let targetTop = topShell.rect.y;
    for (const blocker of topShells) {
      if (blocker.node === topShell.node) continue;
      if (isInsetTopShell(blocker, rootRect)) continue;

      const overlap = intersection(topShell.rect, blocker.rect);
      if (!overlap || overlap.width < 8 || overlap.height < 8) continue;
      if (!hasVisibleContentInRegion(blocker.node, overlap)) continue;
      if (!hasVisibleContentInRegion(topShell.node, overlap, { includeBackground: true })) continue;

      targetTop = Math.max(targetTop, blocker.rect.y + blocker.rect.height);
    }

    if (moveTopShellBelowTopShell(topShell.node, targetTop)) adjusted++;
  }

  for (const sideShell of sideShells) {
    let targetTop = sideShell.rect.y;

    for (const topShell of topShells) {
      const overlap = intersection(sideShell.rect, topShell.rect);
      if (!overlap || overlap.width < 8 || overlap.height < 8) continue;
      if (!hasVisibleContentInRegion(topShell.node, overlap)) continue;
      if (!hasVisibleContentInRegion(sideShell.node, overlap, { includeBackground: true })) continue;

      targetTop = Math.max(targetTop, topShell.rect.y + topShell.rect.height);
    }

    if (moveSideShellBelowTopShell(sideShell.node, targetTop)) adjusted++;
  }

  if (adjusted > 0) {
    scene.capture = scene.capture || {};
    scene.capture.normalizedFixedShells = {
      adjusted,
      strategy: "avoid-overlapping-fixed-top-and-side-shells",
    };
  }

  return { adjusted };
}
