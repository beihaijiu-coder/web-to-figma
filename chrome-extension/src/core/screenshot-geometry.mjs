function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Returns the portion of a page-space rectangle that can genuinely be present
 * in a captureVisibleTab image. Keeping this calculation separate from the
 * browser API makes screenshot fallbacks work for any transformed, oversized,
 * or partially off-screen replaced element.
 */
export function visibleCaptureBounds(rect, viewport) {
  const sourceX = finiteNumber(rect?.x);
  const sourceY = finiteNumber(rect?.y);
  const sourceWidth = Math.max(0, finiteNumber(rect?.width));
  const sourceHeight = Math.max(0, finiteNumber(rect?.height));
  const viewportX = finiteNumber(viewport?.scrollX);
  const viewportY = finiteNumber(viewport?.scrollY);
  const viewportWidth = Math.max(0, finiteNumber(viewport?.innerWidth));
  const viewportHeight = Math.max(0, finiteNumber(viewport?.innerHeight));

  const left = Math.max(sourceX, viewportX);
  const top = Math.max(sourceY, viewportY);
  const right = Math.min(sourceX + sourceWidth, viewportX + viewportWidth);
  const bottom = Math.min(sourceY + sourceHeight, viewportY + viewportHeight);
  if (right <= left || bottom <= top) return null;

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}
