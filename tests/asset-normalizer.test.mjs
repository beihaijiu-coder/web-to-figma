import assert from "node:assert/strict";
import test from "node:test";

import {
  FIGMA_MAX_IMAGE_DIMENSION,
  imageDimensionsFromBytes,
  normalizeImageAssetForFigma,
  scaledImageSize,
} from "../asset-normalizer.mjs";

function jpegHeaderBase64(width, height) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0,
    0x00, 0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
  ]).toString("base64");
}

test("encoded image dimensions are read from headers without rendering every asset", () => {
  const bytes = Buffer.from(jpegHeaderBase64(6016, 1384), "base64");
  assert.deepEqual(imageDimensionsFromBytes(bytes), {
    width: 6016,
    height: 1384,
    type: "image/jpeg",
  });
});

test("oversized encoded images are resized to Figma limits without changing aspect ratio", async () => {
  const drawCalls = [];

  class FakeOffscreenCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }

    getContext(type) {
      assert.equal(type, "2d");
      return {
        drawImage(...args) {
          drawCalls.push(args);
        },
      };
    }

    async convertToBlob(options) {
      assert.deepEqual(options, { type: "image/png" });
      return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    }
  }

  const sourceBase64 = jpegHeaderBase64(6016, 1384);
  const normalized = await normalizeImageAssetForFigma(
    {
      id: "hero",
      contentType: "image/jpeg",
      base64: sourceBase64,
    },
    {
      createImageBitmap: async () => ({ width: 6016, height: 1384, close() {} }),
      OffscreenCanvas: FakeOffscreenCanvas,
    }
  );

  assert.equal(FIGMA_MAX_IMAGE_DIMENSION, 4096);
  assert.deepEqual(scaledImageSize(6016, 1384), { width: 4096, height: 942 });
  assert.equal(normalized.contentType, "image/png");
  assert.equal(normalized.pixelWidth, 4096);
  assert.equal(normalized.pixelHeight, 942);
  assert.equal(normalized.originalPixelWidth, 6016);
  assert.equal(normalized.originalPixelHeight, 1384);
  assert.equal(normalized.normalizedForFigma, true);
  assert.notEqual(normalized.base64, sourceBase64);
  assert.equal(drawCalls.length, 1);
  assert.deepEqual(drawCalls[0].slice(-4), [0, 0, 4096, 942]);
});

test("supported images already within Figma limits keep their original bytes", async () => {
  const sourceBase64 = jpegHeaderBase64(2524, 1160);
  const normalized = await normalizeImageAssetForFigma(
    {
      id: "card",
      contentType: "image/jpeg",
      base64: sourceBase64,
    },
    {
      createImageBitmap: async () => {
        throw new Error("small supported images should not be decoded");
      },
      OffscreenCanvas: class UnexpectedCanvas {
        constructor() {
          throw new Error("small images should not be redrawn");
        }
      },
    }
  );

  assert.equal(normalized.base64, sourceBase64);
  assert.equal(normalized.contentType, "image/jpeg");
  assert.equal(normalized.pixelWidth, 2524);
  assert.equal(normalized.pixelHeight, 1160);
  assert.equal(normalized.normalizedForFigma, undefined);
});
