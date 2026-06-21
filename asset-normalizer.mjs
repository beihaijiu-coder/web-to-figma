export const FIGMA_MAX_IMAGE_DIMENSION = 4096;

const FIGMA_BITMAP_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
]);

function normalizedContentType(value) {
  return String(value || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function decodeBase64(value, decode = globalThis.atob) {
  const binary = decode(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(bytes, encode = globalThis.btoa) {
  let binary = "";
  const chunkSize = 32768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return encode(binary);
}

function readUint16BigEndian(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16LittleEndian(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32BigEndian(bytes, offset) {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

export function imageDimensionsFromBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);

  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return {
      width: readUint32BigEndian(bytes, 16),
      height: readUint32BigEndian(bytes, 20),
      type: "image/png",
    };
  }

  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return {
      width: readUint16LittleEndian(bytes, 6),
      height: readUint16LittleEndian(bytes, 8),
      type: "image/gif",
    };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const startOfFrameMarkers = new Set([
      0xc0, 0xc1, 0xc2, 0xc3,
      0xc5, 0xc6, 0xc7,
      0xc9, 0xca, 0xcb,
      0xcd, 0xce, 0xcf,
    ]);
    let offset = 2;

    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }

      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      if (offset + 1 >= bytes.length) break;

      const segmentLength = readUint16BigEndian(bytes, offset);
      if (segmentLength < 2) break;
      if (startOfFrameMarkers.has(marker) && offset + 6 < bytes.length) {
        return {
          width: readUint16BigEndian(bytes, offset + 5),
          height: readUint16BigEndian(bytes, offset + 3),
          type: "image/jpeg",
        };
      }
      offset += segmentLength;
    }
  }

  return null;
}

export function scaledImageSize(
  width,
  height,
  maxDimension = FIGMA_MAX_IMAGE_DIMENSION
) {
  const sourceWidth = Math.max(1, Number(width) || 1);
  const sourceHeight = Math.max(1, Number(height) || 1);
  const scale = Math.min(1, maxDimension / sourceWidth, maxDimension / sourceHeight);

  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

export async function normalizeImageAssetForFigma(asset, options = {}) {
  if (!asset || (!asset.base64 && !asset.data)) return asset;

  const contentType = normalizedContentType(asset.contentType);
  if (contentType === "image/svg+xml" || /\.svg(?:$|\?)/i.test(String(asset.src || ""))) return asset;

  const bytes = decodeBase64(
    asset.base64 || asset.data,
    options.atob || globalThis.atob
  );
  const header = imageDimensionsFromBytes(bytes);
  const effectiveContentType = header && header.type ? header.type : contentType;
  const headerTarget = header
    ? scaledImageSize(
        header.width,
        header.height,
        options.maxDimension || FIGMA_MAX_IMAGE_DIMENSION
      )
    : null;
  const supportedType = FIGMA_BITMAP_TYPES.has(effectiveContentType);

  if (
    supportedType &&
    header &&
    headerTarget.width === header.width &&
    headerTarget.height === header.height
  ) {
    return {
      ...asset,
      contentType: effectiveContentType,
      pixelWidth: header.width,
      pixelHeight: header.height,
    };
  }

  const createBitmap = options.createImageBitmap || globalThis.createImageBitmap;
  const Canvas = options.OffscreenCanvas || globalThis.OffscreenCanvas;
  if (typeof createBitmap !== "function") {
    throw new Error("IMAGE_BITMAP_UNAVAILABLE");
  }

  const blob = new Blob([bytes], {
    type: effectiveContentType || "application/octet-stream",
  });
  const bitmap = await createBitmap(blob);

  try {
    const pixelWidth = Math.max(1, Number(bitmap.width) || 1);
    const pixelHeight = Math.max(1, Number(bitmap.height) || 1);
    const target = scaledImageSize(
      pixelWidth,
      pixelHeight,
      options.maxDimension || FIGMA_MAX_IMAGE_DIMENSION
    );
    const needsRedraw =
      !supportedType || target.width !== pixelWidth || target.height !== pixelHeight;

    if (!needsRedraw) {
      return {
        ...asset,
        pixelWidth,
        pixelHeight,
      };
    }

    if (typeof Canvas !== "function") {
      throw new Error("OFFSCREEN_CANVAS_UNAVAILABLE");
    }

    const canvas = new Canvas(target.width, target.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("IMAGE_CANVAS_CONTEXT_UNAVAILABLE");

    context.drawImage(bitmap, 0, 0, pixelWidth, pixelHeight, 0, 0, target.width, target.height);
    const normalizedBlob = await canvas.convertToBlob({ type: "image/png" });
    const normalizedBytes = new Uint8Array(await normalizedBlob.arrayBuffer());

    return {
      ...asset,
      base64: encodeBase64(normalizedBytes, options.btoa || globalThis.btoa),
      contentType: "image/png",
      pixelWidth: target.width,
      pixelHeight: target.height,
      originalPixelWidth: pixelWidth,
      originalPixelHeight: pixelHeight,
      normalizedForFigma: true,
    };
  } finally {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
}

export async function normalizeSceneAssetsForFigma(scene, options = {}) {
  const assets = scene && scene.assets;
  if (!assets || typeof assets !== "object") return scene;

  const entries = Object.entries(assets);
  const concurrency = Math.max(1, Math.min(entries.length || 1, Number(options.concurrency) || 4));
  let cursor = 0;

  async function worker() {
    while (cursor < entries.length) {
      const [assetId, asset] = entries[cursor++];
      if (!asset || (!asset.base64 && !asset.data)) continue;

      try {
        const normalized = await normalizeImageAssetForFigma(asset, options);
        assets[assetId] = normalized;
        if (normalized && normalized.normalizedForFigma && options.onDiagnostic) {
          options.onDiagnostic({
            assetId,
            src: normalized.src || "",
            phase: "image-normalization",
            ok: true,
            originalWidth: normalized.originalPixelWidth,
            originalHeight: normalized.originalPixelHeight,
            width: normalized.pixelWidth,
            height: normalized.pixelHeight,
          });
        }
      } catch (error) {
        assets[assetId] = {
          ...asset,
          normalizationError: (error && error.message) || String(error),
        };
        if (options.onDiagnostic) {
          options.onDiagnostic({
            assetId,
            src: asset.src || "",
            phase: "image-normalization",
            ok: false,
            error: (error && error.message) || String(error),
          });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return scene;
}
