import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { importSceneToFigma } = require("../../figma-plugin/src/importer.js");

function createFakeFigma({
  unavailableFonts = [],
  availableFonts = null,
  failImages = false,
  defaultFrameClipsContent = false,
  strictClipsContent = false,
} = {}) {
  const nodes = [];
  const pageChildren = [];
  const focusedNodes = [];
  const viewport = {
    scrolledAndZoomedIntoView(selection) {
      focusedNodes.push(selection);
    },
  };

  function removeFromParent(child) {
    const parent = child && child.parent;
    if (!parent || !parent.children) return;
    const index = parent.children.indexOf(child);
    if (index >= 0) parent.children.splice(index, 1);
  }

  function appendChild(child) {
    removeFromParent(child);
    if (!this.children.includes(child)) this.children.push(child);
    child.parent = this;
  }

  function resize(width, height) {
    this.width = width;
    this.height = height;
  }

  const figma = {
    nodes,
    currentPage: {
      children: pageChildren,
      selection: [],
      appendChild(node) {
        removeFromParent(node);
        if (!pageChildren.includes(node)) pageChildren.push(node);
        node.parent = this;
      },
    },
    viewport,
    focusedNodes,
    createFrame() {
      return createNode("FRAME");
    },
    createRectangle() {
      return createNode("RECTANGLE");
    },
    createText() {
      const node = createNode("TEXT");
      node.characters = "";
      return node;
    },
    createImage(bytes) {
      if (failImages) throw new TypeError("not a function");
      this.createdImages.push(bytes);
      return { hash: `hash-${this.createdImages.length}` };
    },
    createNodeFromSvg(svg) {
      const node = createNode("VECTOR");
      node.svg = svg;
      return node;
    },
    async loadFontAsync(fontName) {
      const key = `${fontName.family}/${fontName.style}`;
      if (
        Array.isArray(availableFonts) &&
        !availableFonts.some(
          (font) => font.family === fontName.family && font.style === fontName.style
        )
      ) {
        throw new Error(`Missing font: ${key}`);
      }
      if (unavailableFonts.includes(fontName.family) || unavailableFonts.includes(key)) {
        throw new Error(`Missing font: ${key}`);
      }
      this.loadedFonts.push(fontName);
    },
    loadedFonts: [],
    createdImages: [],
  };

  if (Array.isArray(availableFonts)) {
    figma.listAvailableFontsAsync = async () =>
      availableFonts.map((fontName) => ({ fontName }));
  }

  function createNode(type) {
    const node = {
      id: `${type.toLowerCase()}-${nodes.length + 1}`,
      type,
      name: "",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      children: [],
      appendChild,
      resize,
      remove() {
        removeFromParent(this);
        this.removed = true;
      },
    };
    if (type === "FRAME" || type === "RECTANGLE") {
      node.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 1 }];
      if (type === "FRAME") node.clipsContent = defaultFrameClipsContent;
    }
    if (strictClipsContent && type !== "FRAME") {
      Object.defineProperty(node, "clipsContent", {
        configurable: true,
        get() {
          return undefined;
        },
        set() {
          throw new Error(`${type} does not support clipsContent`);
        },
      });
    }
    nodes.push(node);
    figma.currentPage.appendChild(node);
    return node;
  }

  return figma;
}

test("flattened positioned content keeps its CSS z-index above later image siblings", async () => {
  const figma = createFakeFigma();
  const scene = {
    version: 1,
    source: { url: "https://example.com/promo", selector: "body" },
    viewport: { width: 1200, height: 800 },
    assets: {
      hero: {
        src: "https://example.com/hero.jpg",
        contentType: "image/jpeg",
        base64: "QUJD",
      },
    },
    root: {
      kind: "frame",
      name: "Body",
      source: { tag: "body" },
      rect: { x: 0, y: 0, width: 640, height: 360 },
      children: [
        {
          kind: "frame",
          name: "Promo Tile",
          source: { tag: "section" },
          rect: { x: 0, y: 0, width: 640, height: 360 },
          style: { backgroundColor: "rgb(245, 245, 247)", overflow: "hidden" },
          children: [
            {
              kind: "frame",
              name: "Copy Wrapper",
              source: { tag: "div" },
              paintOrder: 1,
              rect: { x: 160, y: 40, width: 320, height: 64 },
              style: { position: "relative", zIndex: "2" },
              children: [
                {
                  kind: "text",
                  paintOrder: 2,
                  text: "MacBook Air",
                  rect: { x: 200, y: 48, width: 240, height: 44 },
                  style: { fontFamily: "Inter", fontSize: 36, fontWeight: 600 },
                },
              ],
            },
            {
              kind: "frame",
              name: "Image Wrapper",
              source: { tag: "div" },
              paintOrder: 3,
              rect: { x: 0, y: 0, width: 640, height: 360 },
              style: { position: "absolute", zIndex: "auto" },
              children: [
                {
                  kind: "image",
                  paintOrder: 4,
                  assetId: "hero",
                  rect: { x: 0, y: 0, width: 640, height: 360 },
                  style: { objectFit: "cover" },
                },
              ],
            },
          ],
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const tile = result.root.children[0];

  assert.deepEqual(
    tile.children.map((node) => node.type),
    ["RECTANGLE", "TEXT"],
    "image should be below the higher-z-index editable headline"
  );
  assert.equal(tile.children[1].characters, "MacBook Air");
});

test("font loading resolves real Figma family and style names from the CSS font stack", async () => {
  const figma = createFakeFigma({
    availableFonts: [
      { family: "SF Pro Text", style: "Semibold" },
      { family: "Helvetica Neue", style: "Medium" },
      { family: "Inter", style: "Regular" },
    ],
  });
  const scene = {
    version: 1,
    source: { url: "https://example.com/type", selector: "body" },
    viewport: { width: 800, height: 600 },
    root: {
      kind: "frame",
      name: "Typography",
      rect: { x: 0, y: 0, width: 400, height: 180 },
      children: [
        {
          kind: "text",
          text: "Available semibold",
          rect: { x: 24, y: 32, width: 280, height: 36 },
          style: {
            fontFamily: '"SF Pro Text", "Helvetica Neue", Arial, sans-serif',
            fontSize: 28,
            fontWeight: 600,
          },
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const text = result.root.children[0];

  assert.deepEqual(text.fontName, { family: "SF Pro Text", style: "Semibold" });
  assert.equal(text.characters, "Available semibold");
});

test("font loading tries later CSS families before the configured fallback", async () => {
  const figma = createFakeFigma({
    availableFonts: [
      { family: "Site Icons", style: "Regular" },
      { family: "Helvetica Neue", style: "Medium" },
      { family: "Inter", style: "Regular" },
    ],
  });
  const scene = {
    version: 1,
    source: { url: "https://example.com/type", selector: "body" },
    viewport: { width: 800, height: 600 },
    root: {
      kind: "frame",
      name: "Typography",
      rect: { x: 0, y: 0, width: 400, height: 180 },
      children: [
        {
          kind: "text",
          text: "Stack fallback",
          rect: { x: 24, y: 32, width: 240, height: 32 },
          style: {
            fontFamily: '"Unavailable Web Font", "Site Icons", "Helvetica Neue", Arial, sans-serif',
            fontSize: 24,
            fontWeight: 500,
          },
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  assert.deepEqual(result.root.children[0].fontName, {
    family: "Helvetica Neue",
    style: "Medium",
  });
});

test("a captured component imports as a focused Figma root with editable text", async () => {
  const figma = createFakeFigma();
  const scene = {
    version: 1,
    source: { url: "https://example.com/pricing", selector: "#pricing-card" },
    viewport: { width: 1440, height: 900 },
    root: {
      kind: "frame",
      name: "Pricing Card",
      rect: { x: 100, y: 80, width: 360, height: 220 },
      style: { backgroundColor: "rgb(255, 255, 255)", borderRadius: 24 },
      children: [
        {
          kind: "text",
          name: "Heading · Pro Plan",
          text: "Pro Plan",
          rect: { x: 124, y: 112, width: 160, height: 36 },
          style: {
            color: "rgb(17, 24, 39)",
            fontFamily: "Inter",
            fontSize: 28,
            fontWeight: 700,
          },
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });

  assert.equal(result.ok, true);
  assert.equal(result.root.name, "Web to Figma · Pricing Card");
  assert.equal(result.root.type, "FRAME");
  assert.equal(result.root.width, 360);
  assert.equal(result.root.height, 220);

  const text = figma.nodes.find((node) => node.type === "TEXT");
  assert.ok(text, "expected an editable text node");
  assert.equal(text.characters, "Pro Plan");
  assert.equal(text.name, "Heading · Pro Plan");
  assert.deepEqual(figma.currentPage.selection, [result.root]);
  assert.deepEqual(figma.focusedNodes, [[result.root]]);
  assert.deepEqual(figma.currentPage.children, [result.root]);
  assert.equal(result.root.children.length, 1);
});

test("manually stopped captures are named separately from automatic content-flow segments", async () => {
  const figma = createFakeFigma();
  const scene = {
    version: 1,
    source: { url: "https://example.com/feed", selector: "body" },
    capture: {
      contentFlow: {
        isSegment: true,
        segmentIndex: 1,
        reason: "user-stopped",
        stoppedByUser: true,
      },
    },
    root: {
      kind: "frame",
      name: "Body",
      source: { tag: "body" },
      rect: { x: 0, y: 0, width: 800, height: 1800 },
      children: [],
    },
  };

  const result = await importSceneToFigma(scene, { figma });

  assert.equal(result.root.name, "Web to Figma · Body · 手动停止采集");
});

test("import normalizes overlapping fixed top and side app shells from older captures", async () => {
  const figma = createFakeFigma();
  const scene = {
    version: 1,
    source: { url: "https://example.com/feed", selector: "body" },
    root: {
      kind: "frame",
      name: "Body",
      source: { tag: "body" },
      rect: { x: 0, y: 0, width: 1200, height: 1800 },
      children: [
        {
          kind: "frame",
          name: "Top app bar",
          source: { tag: "header" },
          rect: { x: 0, y: 0, width: 1200, height: 64 },
          style: {
            position: "fixed",
            zIndex: "2020",
            backgroundColor: "rgba(0, 0, 0, 0)",
          },
          children: [
            {
              kind: "svg",
              name: "Logo",
              source: { tag: "svg" },
              rect: { x: 40, y: 20, width: 96, height: 24 },
              svg: "<svg />",
            },
          ],
        },
        {
          kind: "frame",
          name: "Left navigation rail",
          source: { tag: "aside" },
          rect: { x: 0, y: 0, width: 240, height: 900 },
          style: {
            position: "fixed",
            zIndex: "2021",
            backgroundColor: "rgb(255, 255, 255)",
          },
          children: [
            {
              kind: "text",
              name: "Home label",
              text: "Home",
              source: { tag: "span" },
              rect: { x: 72, y: 18, width: 48, height: 20 },
              style: { fontFamily: "Inter", fontSize: 16 },
            },
          ],
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const sideRail = result.root.children.find((node) => node.name === "Aside");

  assert.ok(sideRail, "expected fixed side rail to remain as an editable frame");
  assert.equal(sideRail.y, 64);
  assert.equal(sideRail.height, 836);
  assert.equal(sideRail.children[0].y, 18);
  assert.equal(scene.capture.normalizedFixedShells.strategy, "avoid-overlapping-fixed-top-and-side-shells");
});

test("import normalizes inset fixed top bars hidden under primary app bars", async () => {
  const figma = createFakeFigma();
  const scene = {
    version: 1,
    source: { url: "https://example.com/feed", selector: "body" },
    root: {
      kind: "frame",
      name: "Body",
      source: { tag: "body" },
      rect: { x: 0, y: 0, width: 1200, height: 1800 },
      children: [
        {
          kind: "frame",
          name: "Primary top app bar",
          source: { tag: "header" },
          rect: { x: 0, y: 0, width: 1200, height: 64 },
          style: {
            position: "fixed",
            zIndex: "2020",
            backgroundColor: "rgba(0, 0, 0, 0)",
          },
          children: [
            {
              kind: "text",
              name: "Search field",
              text: "Search",
              source: { tag: "span" },
              rect: { x: 420, y: 20, width: 220, height: 24 },
              style: { fontFamily: "Inter", fontSize: 16 },
            },
          ],
        },
        {
          kind: "frame",
          name: "Content filter chips",
          source: { tag: "nav" },
          rect: { x: 240, y: 0, width: 960, height: 56 },
          style: {
            position: "fixed",
            zIndex: "2019",
            backgroundColor: "rgba(0, 0, 0, 0)",
          },
          children: [
            {
              kind: "text",
              name: "All chip",
              text: "All",
              source: { tag: "span" },
              rect: { x: 264, y: 18, width: 40, height: 20 },
              style: { fontFamily: "Inter", fontSize: 16 },
            },
          ],
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const filterBar = result.root.children.find((node) => node.name === "Navigation");

  assert.ok(filterBar, "expected inset fixed top bar to remain importable");
  assert.equal(filterBar.y, 64);
  assert.equal(filterBar.children[0].y, 18);
});

test("transparent wrappers with fixed app-shell descendants inherit their stacking order", async () => {
  const figma = createFakeFigma();
  const scene = {
    version: 1,
    source: { url: "https://example.com/feed", selector: "body" },
    root: {
      kind: "frame",
      name: "Body",
      source: { tag: "body" },
      rect: { x: 0, y: 0, width: 1200, height: 1200 },
      children: [
        {
          kind: "frame",
          name: "Main content wrapper",
          source: { tag: "main" },
          rect: { x: 240, y: 64, width: 960, height: 900 },
          style: { backgroundColor: "rgba(0, 0, 0, 0)" },
          children: [
            {
              kind: "frame",
              name: "Content filter chips",
              source: { tag: "nav" },
              rect: { x: 240, y: 0, width: 960, height: 56 },
              style: {
                position: "fixed",
                zIndex: "2019",
                backgroundColor: "rgba(0, 0, 0, 0)",
              },
              children: [
                {
                  kind: "text",
                  name: "All chip",
                  text: "All",
                  source: { tag: "span" },
                  rect: { x: 264, y: 18, width: 40, height: 20 },
                  style: { fontFamily: "Inter", fontSize: 16 },
                },
              ],
            },
          ],
        },
        {
          kind: "frame",
          name: "Top backdrop",
          source: { tag: "div" },
          rect: { x: 0, y: 0, width: 1200, height: 120 },
          style: {
            position: "fixed",
            zIndex: "2018",
            backgroundColor: "rgba(255, 255, 255, 0.9)",
          },
          children: [],
        },
        {
          kind: "frame",
          name: "Top controls",
          source: { tag: "header" },
          rect: { x: 0, y: 0, width: 1200, height: 64 },
          style: {
            position: "fixed",
            zIndex: "2020",
            backgroundColor: "rgba(0, 0, 0, 0)",
          },
          children: [
            {
              kind: "text",
              name: "Search field",
              text: "Search",
              source: { tag: "span" },
              rect: { x: 420, y: 20, width: 220, height: 24 },
              style: { fontFamily: "Inter", fontSize: 16 },
            },
          ],
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });

  assert.equal(result.root.children[1].name, "Main");
  assert.equal(result.root.children[2].name, "Header");
  assert.equal(
    result.root.children[0].width,
    1200,
    "lower-z fixed backdrop should stay below the transparent main wrapper"
  );
});

test("failed child imports stay visible inside the generated root", async () => {
  const figma = createFakeFigma({ unavailableFonts: ["Unavailable Sans", "Inter/Regular"] });
  const scene = {
    version: 1,
    source: { url: "https://example.com/failing", selector: "body" },
    viewport: { width: 1024, height: 768 },
    root: {
      kind: "frame",
      name: "Failing Page",
      rect: { x: 0, y: 0, width: 320, height: 180 },
      children: [
        {
          kind: "text",
          role: "heading",
          text: "Missing font",
          rect: { x: 16, y: 24, width: 160, height: 24 },
          style: {
            fontFamily: "Unavailable Sans",
            fontWeight: 400,
            fontSize: 16,
            color: "rgb(30, 41, 59)",
          },
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, {
    figma,
    fallbackFont: { family: "Inter", style: "Regular" },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(figma.currentPage.children, [result.root]);
  assert.equal(result.root.children[0].name, "Import failed · Heading · Missing font");
  assert.equal(result.root.children[0].removed, undefined);
});

test("styled containers import as editable frames with visible styling", async () => {
  const figma = createFakeFigma();
  const scene = {
    version: 1,
    source: { url: "https://example.com/card", selector: "#card" },
    viewport: { width: 1280, height: 720 },
    root: {
      kind: "frame",
      name: "Dashboard Card",
      rect: { x: 32, y: 40, width: 420, height: 280 },
      style: {
        backgroundColor: "rgba(255, 255, 255, 0.92)",
        borderColor: "rgb(226, 232, 240)",
        borderWidth: 1,
        borderRadius: 18,
        boxShadow: "0px 16px 40px rgba(15, 23, 42, 0.18)",
        opacity: 0.86,
        overflow: "hidden",
      },
      children: [
        {
          kind: "frame",
          name: "Metric Row",
          rect: { x: 56, y: 72, width: 372, height: 80 },
          style: {
            backgroundColor: "linear-gradient(90deg, #2563eb 0%, #06b6d4 100%)",
            borderRadius: 14,
          },
          children: [],
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const row = result.root.children[0];

  assert.notEqual(result.root.fills?.[0]?.type, "IMAGE", "root must not be a whole-page image fallback");
  assert.equal(result.root.fills[0].type, "SOLID");
  assert.equal(result.root.strokes[0].type, "SOLID");
  assert.equal(result.root.strokeWeight, 1);
  assert.equal(result.root.cornerRadius, 18);
  assert.equal(result.root.opacity, 0.86);
  assert.equal(result.root.clipsContent, true);
  assert.equal(result.root.effects[0].type, "DROP_SHADOW");
  assert.equal(row.fills[0].type, "GRADIENT_LINEAR");
});

test("missing web fonts fall back without changing deterministic text names", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/form", selector: "#signup" },
    viewport: { width: 1024, height: 768 },
    root: {
      kind: "frame",
      name: "Signup Form",
      rect: { x: 0, y: 0, width: 320, height: 180 },
      children: [
        {
          kind: "text",
          role: "label",
          text: "Email address",
          rect: { x: 16, y: 24, width: 160, height: 24 },
          style: {
            fontFamily: "Unavailable Sans",
            fontWeight: 400,
            fontSize: 16,
            color: "rgb(30, 41, 59)",
          },
        },
      ],
    },
  };
  const first = createFakeFigma({ unavailableFonts: ["Unavailable Sans"] });
  const second = createFakeFigma({ unavailableFonts: ["Unavailable Sans"] });

  const firstResult = await importSceneToFigma(scene, {
    figma: first,
    fallbackFont: { family: "Arial", style: "Regular" },
  });
  const secondResult = await importSceneToFigma(scene, {
    figma: second,
    fallbackFont: { family: "Arial", style: "Regular" },
  });
  const firstText = first.nodes.find((node) => node.type === "TEXT");
  const secondText = second.nodes.find((node) => node.type === "TEXT");

  assert.equal(firstResult.ok, true);
  assert.deepEqual(firstText.fontName, { family: "Arial", style: "Regular" });
  assert.equal(firstText.name, "Label · Email address");
  assert.equal(secondText.name, firstText.name);
  assert.equal(firstText.fills[0].type, "SOLID");
});

test("images import as replaceable image fills and reuse duplicated assets", async () => {
  const figma = createFakeFigma();
  const scene = {
    version: 1,
    source: { url: "https://example.com/gallery", selector: "#gallery" },
    viewport: { width: 1200, height: 800 },
    assets: {
      hero: {
        src: "https://example.com/hero.png",
        contentType: "image/png",
        base64: "AQIDBA==",
      },
    },
    root: {
      kind: "frame",
      name: "Gallery",
      rect: { x: 0, y: 0, width: 640, height: 320 },
      children: [
        {
          kind: "image",
          name: "Hero Image",
          assetId: "hero",
          rect: { x: 0, y: 0, width: 300, height: 220 },
          style: { objectFit: "cover", borderRadius: 16 },
        },
        {
          kind: "image",
          name: "Hero Thumbnail",
          assetId: "hero",
          rect: { x: 320, y: 0, width: 120, height: 88 },
          style: { objectFit: "contain" },
        },
        {
          kind: "image",
          name: "Stretched Image",
          assetId: "hero",
          rect: { x: 460, y: 0, width: 120, height: 88 },
          style: { objectFit: "fill" },
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const [hero, thumb, stretched] = result.root.children;

  assert.equal(hero.type, "RECTANGLE");
  assert.equal(hero.fills[0].type, "IMAGE");
  assert.equal(hero.fills[0].scaleMode, "FILL");
  assert.equal(hero.cornerRadius, 16);
  assert.equal(thumb.fills[0].type, "IMAGE");
  assert.equal(thumb.fills[0].scaleMode, "FIT");
  assert.equal(stretched.fills[0].type, "IMAGE");
  assert.equal(stretched.fills[0].scaleMode, "FILL");
  assert.equal(hero.fills[0].imageHash, thumb.fills[0].imageHash);
  assert.equal(figma.createdImages.length, 1);
});

test("clipped image nodes do not receive unsupported frame-only clipping", async () => {
  const figma = createFakeFigma({ strictClipsContent: true });
  const scene = {
    version: 1,
    source: { url: "https://example.com/gallery", selector: "body" },
    viewport: { width: 1200, height: 800 },
    assets: {
      hero: {
        src: "https://example.com/hero.png",
        contentType: "image/png",
        base64: "AQIDBA==",
      },
    },
    root: {
      kind: "frame",
      name: "Gallery",
      rect: { x: 0, y: 0, width: 640, height: 320 },
      children: [
        {
          kind: "image",
          name: "Hero Image",
          assetId: "hero",
          rect: { x: 0, y: 0, width: 300, height: 220 },
          style: { objectFit: "cover", overflow: "clip", overflowX: "clip", overflowY: "clip" },
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const image = result.root.children[0];

  assert.equal(image.name, "Hero Image");
  assert.equal(image.type, "RECTANGLE");
  assert.equal(image.fills[0].type, "IMAGE");
  assert.equal(image.clipsContent, undefined);
  assert.equal((result.failures || []).length, 0);
});

test("background images import as replaceable fills while keeping children editable", async () => {
  const figma = createFakeFigma();
  const scene = {
    version: 1,
    source: { url: "https://example.com/hero", selector: "#hero" },
    viewport: { width: 1440, height: 900 },
    assets: {
      bg: {
        src: "https://example.com/bg.png",
        contentType: "image/png",
        base64: "CQoLDA==",
      },
    },
    root: {
      kind: "frame",
      name: "Hero",
      rect: { x: 0, y: 0, width: 720, height: 360 },
      style: {
        backgroundAssetId: "bg",
        objectFit: "fill",
        borderRadius: 28,
      },
      children: [
        {
          kind: "text",
          text: "Editable headline",
          rect: { x: 48, y: 56, width: 260, height: 36 },
          style: { fontFamily: "Inter", fontSize: 28, color: "rgb(255, 255, 255)" },
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });

  assert.equal(result.root.fills[0].type, "IMAGE");
  assert.equal(result.root.fills[0].scaleMode, "FILL");
  assert.equal(result.root.cornerRadius, 28);
  assert.equal(result.root.children[0].type, "TEXT");
  assert.equal(result.root.children[0].characters, "Editable headline");
  assert.equal(figma.createdImages.length, 1);
});

test("svg image assets import as vectors instead of broken bitmap fills", async () => {
  const figma = createFakeFigma();
  const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"10\"><rect width=\"20\" height=\"10\" fill=\"#f97316\"/></svg>";
  const scene = {
    version: 1,
    source: { url: "https://example.com/svg-image", selector: "#asset" },
    viewport: { width: 800, height: 600 },
    assets: {
      inlineSvg: {
        src: "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
        contentType: "image/svg+xml",
        base64: Buffer.from(svg, "utf8").toString("base64"),
      },
    },
    root: {
      kind: "frame",
      name: "Svg Image Page",
      rect: { x: 0, y: 0, width: 240, height: 160 },
      children: [
        {
          kind: "image",
          name: "Inline SVG",
          assetId: "inlineSvg",
          rect: { x: 24, y: 32, width: 120, height: 60 },
          style: { borderRadius: 8 },
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const vector = result.root.children[0];

  assert.equal(vector.type, "VECTOR");
  assert.equal(vector.svg, svg);
  assert.equal(vector.width, 120);
  assert.equal(vector.height, 60);
  assert.equal(figma.createdImages.length, 0);
});

test("external svg sprite uses import as self-contained visible vectors", async () => {
  const figma = createFakeFigma();
  const sprite =
    "<svg xmlns=\"http://www.w3.org/2000/svg\"><symbol id=\"new-chat\" viewBox=\"0 0 20 20\"><path d=\"M4 4h12v12H4z\" fill=\"currentColor\"/></symbol></svg>";
  const scene = {
    version: 1,
    source: { url: "https://example.com/app", selector: "body" },
    viewport: { width: 800, height: 600 },
    assets: {
      "sprite-1": {
        src: "https://example.com/cdn/icons.svg",
        contentType: "image/svg+xml",
        base64: Buffer.from(sprite, "utf8").toString("base64"),
      },
    },
    root: {
      kind: "frame",
      name: "Icon Page",
      rect: { x: 0, y: 0, width: 120, height: 80 },
      children: [
        {
          kind: "svg",
          name: "External sprite icon",
          source: { tag: "svg" },
          rect: { x: 16, y: 20, width: 20, height: 20 },
          style: { color: "rgb(13, 13, 13)" },
          svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\"><use href=\"https://example.com/cdn/icons.svg#new-chat\" fill=\"currentColor\"></use></svg>",
          svgUses: [
            {
              assetId: "sprite-1",
              url: "https://example.com/cdn/icons.svg",
              symbolId: "new-chat",
            },
          ],
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const vector = result.root.children[0];

  assert.equal(vector.type, "VECTOR");
  assert.match(vector.svg, /<path\b/);
  assert.match(vector.svg, /viewBox="0 0 20 20"/);
  assert.equal(vector.svg.includes("<use"), false);
  assert.equal(vector.svg.includes("currentColor"), false);
  assert.match(vector.svg, /rgb\(13, 13, 13\)/);
});

test("invalid image assets degrade locally instead of failing the full import", async () => {
  const figma = createFakeFigma({ failImages: true });
  const scene = {
    version: 1,
    source: { url: "https://example.com/broken-image", selector: "body" },
    viewport: { width: 1200, height: 800 },
    assets: {
      broken: {
        src: "https://example.com/broken.png",
        contentType: "image/png",
        base64: "this-is-not-a-valid-image",
      },
    },
    root: {
      kind: "frame",
      name: "Broken Image Page",
      rect: { x: 0, y: 0, width: 640, height: 320 },
      children: [
        {
          kind: "image",
          name: "Broken Image",
          assetId: "broken",
          rect: { x: 0, y: 0, width: 300, height: 220 },
          style: {
            backgroundColor: "rgb(241, 245, 249)",
            borderRadius: 16,
          },
        },
        {
          kind: "text",
          text: "Still editable",
          rect: { x: 24, y: 250, width: 180, height: 28 },
          style: { fontFamily: "Inter", fontSize: 18 },
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const [image, text] = result.root.children;

  assert.equal(result.ok, true);
  assert.equal(image.type, "RECTANGLE");
  assert.equal(image.fills[0].type, "SOLID");
  assert.equal(text.type, "TEXT");
  assert.equal(text.characters, "Still editable");
  assert.deepEqual(figma.currentPage.children, [result.root]);
});

test("transparent captured frames do not keep Figma default white fills", async () => {
  const figma = createFakeFigma();
  const scene = {
    version: 1,
    source: { url: "https://example.com/page", selector: "body" },
    viewport: { width: 1200, height: 800 },
    root: {
      kind: "frame",
      name: "Transparent Page",
      rect: { x: 0, y: 0, width: 640, height: 420 },
      style: { backgroundColor: "rgba(0, 0, 0, 0)" },
      children: [
        {
          kind: "frame",
          name: "Transparent Wrapper",
          rect: { x: 24, y: 32, width: 400, height: 120 },
          style: { backgroundColor: "rgba(0, 0, 0, 0)" },
          children: [
            {
              kind: "text",
              text: "Visible content",
              rect: { x: 48, y: 56, width: 180, height: 28 },
              style: { fontFamily: "Inter", fontSize: 18 },
            },
          ],
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const wrapper = result.root.children[0];

  assert.deepEqual(result.root.fills, []);
  assert.deepEqual(wrapper.fills, []);
  assert.equal(wrapper.children[0].characters, "Visible content");
});

test("multi-layer page gradients import as visible root fills", async () => {
  const figma = createFakeFigma();
  const scene = {
    version: 1,
    source: { url: "https://example.com/page", selector: "body" },
    viewport: { width: 1200, height: 800 },
    root: {
      kind: "frame",
      name: "Gradient Page",
      rect: { x: 0, y: 0, width: 640, height: 420 },
      style: {
        backgroundColor:
          "radial-gradient(circle at top left, rgba(37, 99, 235, 0.22), transparent 34rem), linear-gradient(180deg, #f8fafc 0%, #e0f2fe 100%)",
      },
      children: [],
    },
  };

  const result = await importSceneToFigma(scene, { figma });

  assert.equal(result.root.fills[0].type, "GRADIENT_RADIAL");
  assert.equal(result.root.fills[1].type, "GRADIENT_LINEAR");
  assert.equal(result.root.fills[0].gradientStops.length, 2);
  assert.equal(result.root.fills[0].gradientStops[1].color.a, 0);
});

test("svg background images import behind editable children instead of turning gray", async () => {
  const figma = createFakeFigma();
  const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"900\" height=\"640\"><rect width=\"900\" height=\"640\" fill=\"#2563eb\"/><circle cx=\"680\" cy=\"120\" r=\"150\" fill=\"#ffffff\" opacity=\".2\"/></svg>";
  const scene = {
    version: 1,
    source: { url: "https://example.com/smoke", selector: "#background-card" },
    viewport: { width: 1440, height: 900 },
    assets: {
      bgSvg: {
        src: "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
        contentType: "image/svg+xml",
        base64: Buffer.from(svg, "utf8").toString("base64"),
      },
    },
    root: {
      kind: "frame",
      name: "Background Card",
      rect: { x: 0, y: 0, width: 520, height: 420 },
      style: {
        backgroundAssetId: "bgSvg",
        backgroundColor:
          "linear-gradient(180deg, rgba(15, 23, 42, 0.05), rgba(15, 23, 42, 0.74)), url(\"data:image/svg+xml,%3Csvg%3E%3C/svg%3E\")",
        borderRadius: 28,
      },
      children: [
        {
          kind: "text",
          text: "Background image fill",
          rect: { x: 28, y: 300, width: 340, height: 42 },
          style: { fontFamily: "Inter", fontSize: 34, color: "rgb(255, 255, 255)" },
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const [background, headline] = result.root.children;

  assert.equal(background.type, "VECTOR");
  assert.equal(background.name, "Background Card · background image");
  assert.equal(background.svg, svg);
  assert.ok(background.x < 0);
  assert.equal(background.y, 0);
  assert.ok(background.width > 520);
  assert.equal(headline.type, "TEXT");
  assert.equal(headline.characters, "Background image fill");
  assert.equal(figma.createdImages.length, 0);
});

test("text import preserves measured boxes, symbols, and text transforms", async () => {
  const figma = createFakeFigma();
  const scene = {
    version: 1,
    source: { url: "https://example.com/smoke", selector: "body" },
    viewport: { width: 1440, height: 900 },
    root: {
      kind: "frame",
      name: "Metrics",
      rect: { x: 0, y: 0, width: 480, height: 240 },
      children: [
        {
          kind: "text",
          text: "Editable website layers, not a screenshot.",
          rect: { x: 32, y: 32, width: 360, height: 188 },
          style: {
            fontFamily: "Inter",
            fontSize: 72,
            fontWeight: 800,
            lineHeight: "68.4px",
            letterSpacing: "-4.32px",
            color: "rgb(15, 23, 42)",
          },
        },
        {
          kind: "text",
          text: "98%",
          rect: { x: 32, y: 216, width: 58, height: 38 },
          style: { fontFamily: "Inter", fontSize: 34, fontWeight: 800, textTransform: "uppercase" },
        },
        {
          kind: "text",
          text: "3×",
          rect: { x: 112, y: 216, width: 36, height: 38 },
          style: { fontFamily: "Inter", fontSize: 34, fontWeight: 800 },
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const [headline, percent, multiply] = result.root.children;

  assert.equal(headline.characters, "Editable website layers, not a screenshot.");
  assert.deepEqual(headline.lineHeight, { unit: "PIXELS", value: 68.4 });
  assert.deepEqual(headline.letterSpacing, { unit: "PIXELS", value: -4.32 });
  assert.equal(headline.textAutoResize, "HEIGHT");
  assert.equal(headline.width, 360);
  assert.equal(headline.height, 188);
  assert.equal(percent.characters, "98%");
  assert.equal(percent.textAutoResize, "WIDTH_AND_HEIGHT");
  assert.equal(percent.textCase, "UPPER");
  assert.equal(percent.width, 58);
  assert.equal(multiply.characters, "3×");
  assert.equal(multiply.textAutoResize, "WIDTH_AND_HEIGHT");
  assert.equal(multiply.width, 36);
});

test("single-line section headings can grow horizontally without changing position", async () => {
  const figma = createFakeFigma();
  const scene = {
    version: 1,
    source: { url: "https://example.com/smoke", selector: "body" },
    viewport: { width: 1440, height: 900 },
    root: {
      kind: "frame",
      name: "Cards",
      rect: { x: 0, y: 0, width: 420, height: 180 },
      children: [
        {
          kind: "text",
          text: "Replaceable image",
          rect: { x: 24, y: 32, width: 120, height: 29 },
          style: {
            fontFamily: "Inter",
            fontSize: 24,
            fontWeight: 800,
            lineHeight: "28.8px",
            color: "rgb(15, 23, 42)",
          },
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const heading = result.root.children[0];

  assert.equal(heading.characters, "Replaceable image");
  assert.equal(heading.x, 24);
  assert.equal(heading.y, 32);
  assert.equal(heading.textAutoResize, "WIDTH_AND_HEIGHT");
});

test("editable mode does not turn wrapping flex rows into non-wrapping auto layout", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/smoke", selector: ".actions" },
    viewport: { width: 1440, height: 900 },
    root: {
      kind: "frame",
      name: "Actions",
      rect: { x: 0, y: 0, width: 520, height: 72 },
      layout: {
        display: "flex",
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 12,
        alignItems: "center",
      },
      children: [
        {
          kind: "frame",
          name: "Primary Button",
          rect: { x: 0, y: 0, width: 210, height: 54 },
          children: [],
        },
        {
          kind: "frame",
          name: "Secondary Button",
          rect: { x: 222, y: 0, width: 220, height: 54 },
          children: [],
        },
      ],
    },
  };
  const figma = createFakeFigma();

  const result = await importSceneToFigma(scene, { figma, layoutMode: "editable" });

  assert.equal(result.root.layoutMode || "NONE", "NONE");
  assert.equal(result.root.children[1].x, 222);
});

test("editable layout keeps absolute positioning unless auto layout is explicitly enabled", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/nav", selector: "#nav" },
    viewport: { width: 1280, height: 720 },
    root: {
      kind: "frame",
      name: "Nav",
      rect: { x: 0, y: 0, width: 600, height: 72 },
      layout: { display: "flex", flexDirection: "row", gap: 24, alignItems: "center" },
      children: [
        {
          kind: "text",
          text: "Docs",
          rect: { x: 24, y: 24, width: 40, height: 24 },
          style: { fontFamily: "Inter", fontSize: 16 },
        },
        {
          kind: "text",
          text: "Pricing",
          rect: { x: 88, y: 24, width: 56, height: 24 },
          style: { fontFamily: "Inter", fontSize: 16 },
        },
      ],
    },
  };
  const visual = createFakeFigma();
  const editable = createFakeFigma();
  const auto = createFakeFigma();

  const visualResult = await importSceneToFigma(scene, { figma: visual, layoutMode: "visual" });
  const editableResult = await importSceneToFigma(scene, { figma: editable, layoutMode: "editable" });
  const autoResult = await importSceneToFigma(scene, {
    figma: auto,
    layoutMode: "editable",
    enableAutoLayout: true,
  });

  assert.equal(visualResult.root.layoutMode || "NONE", "NONE");
  assert.equal(visualResult.root.children[1].x, 88);
  assert.equal(editableResult.root.layoutMode || "NONE", "NONE");
  assert.equal(editableResult.root.children[1].x, 88);
  assert.equal(autoResult.root.layoutMode, "HORIZONTAL");
  assert.equal(autoResult.root.itemSpacing, 24);
  assert.equal(autoResult.root.counterAxisAlignItems, "CENTER");
});

test("non-clipping wrapper frames keep fixed shell content visible", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/docs", selector: "body" },
    viewport: { width: 1440, height: 900 },
    root: {
      kind: "frame",
      name: "Body",
      rect: { x: 0, y: 0, width: 1440, height: 900 },
      style: { overflow: "visible" },
      children: [
        {
          kind: "frame",
          name: "astro-island",
          rect: { x: 0, y: 0, width: 1, height: 1 },
          style: { overflow: "visible" },
          children: [
            {
              kind: "frame",
              name: "header.top-0.z-50",
              rect: { x: 0, y: 0, width: 1440, height: 52 },
              style: { position: "fixed", overflow: "visible", backgroundColor: "rgb(255, 255, 255)" },
              children: [
                {
                  kind: "text",
                  text: "Make Projects",
                  rect: { x: 120, y: 18, width: 110, height: 18 },
                  style: { fontFamily: "Inter", fontSize: 16 },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const figma = createFakeFigma({ defaultFrameClipsContent: true });

  const result = await importSceneToFigma(scene, { figma });
  const header = result.root.children[0];

  assert.equal(result.root.clipsContent, false);
  assert.equal(header.name, "Header");
  assert.equal(header.clipsContent, false);
  assert.equal(header.children[0].characters, "Make Projects");
});

test("scroll containers clip scrolled children without clipping layout wrappers", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/docs", selector: "body" },
    viewport: { width: 1440, height: 900 },
    root: {
      kind: "frame",
      name: "Body",
      rect: { x: 0, y: 0, width: 1440, height: 900 },
      style: { overflow: "visible" },
      children: [
        {
          kind: "frame",
          name: "nav.sidebar",
          rect: { x: 0, y: 0, width: 1440, height: 1 },
          style: { overflow: "visible" },
          children: [
            {
              kind: "frame",
              name: "div#starlight__sidebar",
              rect: { x: 0, y: 56, width: 300, height: 844 },
              style: { overflow: "auto", position: "fixed" },
              children: [
                {
                  kind: "frame",
                  name: "div.sidebar-content",
                  rect: { x: 0, y: -36.5, width: 284, height: 920 },
                  style: { overflow: "visible" },
                  children: [
                    {
                      kind: "text",
                      text: "Refore HTML to Figma",
                      rect: { x: 58, y: -12.2, width: 168.44, height: 19 },
                      style: { fontFamily: "Inter", fontSize: 16 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const figma = createFakeFigma({ defaultFrameClipsContent: true });

  const result = await importSceneToFigma(scene, { figma });
  const scrollPane = result.root.children[0];
  const scrolledText = scrollPane.children[0];

  assert.equal(scrollPane.name, "Sidebar");
  assert.equal(scrollPane.clipsContent, true);
  assert.equal(scrolledText.characters, "Refore HTML to Figma");
  assert.equal(scrolledText.y, -68.2);
});

test("show overflow mode keeps off-canvas captured carousel content visible", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/catalog", selector: "body" },
    viewport: { width: 1200, height: 800 },
    root: {
      kind: "frame",
      name: "Body",
      rect: { x: 0, y: 0, width: 600, height: 400 },
      style: { overflow: "visible" },
      children: [
        {
          kind: "frame",
          name: "div.carousel-viewport",
          rect: { x: 0, y: 80, width: 600, height: 240 },
          style: { overflowX: "hidden" },
          children: [
            {
              kind: "frame",
              name: "ul.carousel-track",
              rect: { x: 0, y: 80, width: 1800, height: 240 },
              style: { overflow: "visible" },
              children: [
                {
                  kind: "frame",
                  name: "li.carousel-slide",
                  rect: { x: 620, y: 80, width: 560, height: 240 },
                  style: { backgroundColor: "rgb(0, 113, 227)" },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
  };

  const clippedFigma = createFakeFigma({ defaultFrameClipsContent: true });
  const clipped = await importSceneToFigma(scene, { figma: clippedFigma });
  assert.equal(clipped.root.children[0].clipsContent, true);

  const exposedFigma = createFakeFigma({ defaultFrameClipsContent: true });
  const exposed = await importSceneToFigma(scene, {
    figma: exposedFigma,
    overflowMode: "show",
  });
  const viewport = exposed.root.children[0];
  const slide = viewport.children[0].children[0];

  assert.equal(viewport.clipsContent, false);
  assert.equal(slide.x, 620);
  assert.equal(slide.width, 560);
});

test("sidecar overflow mode preserves the page crop and exports off-canvas media items", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/catalog", selector: "body" },
    viewport: { width: 1200, height: 800 },
    assets: {
      "asset-card": { id: "asset-card", contentType: "image/png", base64: "AA==" },
    },
    root: {
      kind: "frame",
      name: "Body",
      rect: { x: 0, y: 0, width: 600, height: 400 },
      style: { overflow: "visible" },
      children: [
        {
          kind: "frame",
          name: "div.carousel-viewport",
          tag: "div",
          rect: { x: 0, y: 80, width: 600, height: 240 },
          style: { overflowX: "hidden" },
          children: [
            {
              kind: "frame",
              name: "ul.carousel-track",
              tag: "ul",
              rect: { x: 0, y: 80, width: 1800, height: 240 },
              style: { overflow: "visible" },
              children: [
                {
                  kind: "frame",
                  name: "li.visible-slide",
                  tag: "li",
                  rect: { x: 0, y: 80, width: 560, height: 240 },
                  children: [
                    {
                      kind: "image",
                      name: "img.visible-slide",
                      tag: "img",
                      assetId: "asset-card",
                      rect: { x: 0, y: 80, width: 560, height: 240 },
                    },
                  ],
                },
                {
                  kind: "frame",
                  name: "li.off-canvas-slide",
                  tag: "li",
                  rect: { x: 620, y: 80, width: 560, height: 240 },
                  children: [
                    {
                      kind: "image",
                      name: "img.off-canvas-slide",
                      tag: "img",
                      assetId: "asset-card",
                      rect: { x: 620, y: 80, width: 560, height: 240 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const figma = createFakeFigma({ defaultFrameClipsContent: true });

  const result = await importSceneToFigma(scene, { figma, overflowMode: "sidecar" });
  const viewport = result.root.children[0];

  assert.equal(viewport.clipsContent, true);
  assert.ok(result.overflow);
  assert.equal(result.overflow.name, "Captured overflow content");
  assert.equal(result.overflow.x, 696);
  assert.equal(result.overflow.y, 0);
  assert.equal(result.overflow.children.length, 1);
  assert.equal(result.overflow.children[0].name, "List Item");
  assert.equal(result.overflow.children[0].x, 0);
  assert.equal(result.overflow.children[0].y, 0);
});

test("one-sided borders import as thin divider rectangles", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/docs", selector: "body" },
    viewport: { width: 1440, height: 900 },
    root: {
      kind: "frame",
      name: "Body",
      rect: { x: 0, y: 0, width: 360, height: 220 },
      children: [
        {
          kind: "frame",
          name: "Header",
          rect: { x: 0, y: 0, width: 360, height: 52 },
          style: {
            backgroundColor: "rgb(255, 255, 255)",
            borderBottomWidth: 1,
            borderBottomColor: "rgb(237, 238, 243)",
          },
          design: {
            strokes: [
              {
                side: "bottom",
                width: 1,
                color: { r: 0.93, g: 0.93, b: 0.95, a: 1 },
              },
            ],
          },
        },
        {
          kind: "frame",
          name: "Note",
          rect: { x: 40, y: 80, width: 240, height: 96 },
          style: {
            backgroundColor: "rgb(224, 231, 255)",
            borderLeftWidth: 4,
            borderLeftColor: "rgb(61, 80, 245)",
          },
          design: {
            strokes: [
              {
                side: "left",
                width: 4,
                color: { r: 0.24, g: 0.31, b: 0.96, a: 1 },
              },
            ],
          },
          children: [
            {
              kind: "text",
              text: "Note",
              rect: { x: 56, y: 100, width: 40, height: 20 },
              style: { fontFamily: "Inter", fontSize: 16 },
            },
          ],
        },
      ],
    },
  };
  const figma = createFakeFigma();

  const result = await importSceneToFigma(scene, { figma });
  const header = result.root.children[0];
  const note = result.root.children[1];
  const headerDivider = header.children[0];
  const noteDivider = note.children[0];

  assert.equal(headerDivider.type, "RECTANGLE");
  assert.equal(headerDivider.x, 0);
  assert.equal(headerDivider.y, 51);
  assert.equal(headerDivider.width, 360);
  assert.equal(headerDivider.height, 1);
  assert.equal(headerDivider.fills[0].type, "SOLID");
  assert.equal(noteDivider.type, "RECTANGLE");
  assert.equal(noteDivider.x, 0);
  assert.equal(noteDivider.y, 0);
  assert.equal(noteDivider.width, 4);
  assert.equal(noteDivider.height, 96);
  assert.equal(note.children[1].characters, "Note");
});

test("transparent DOM wrapper frames flatten into semantic page regions", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/docs", selector: "body" },
    viewport: { width: 1440, height: 900 },
    root: {
      kind: "frame",
      name: "body.astro-ojovxovv",
      tag: "body",
      rect: { x: 0, y: 0, width: 800, height: 420 },
      children: [
        {
          kind: "frame",
          name: "div.astro-header-wrap",
          tag: "div",
          rect: { x: 0, y: 0, width: 800, height: 64 },
          style: { backgroundColor: "rgba(0, 0, 0, 0)", overflow: "visible" },
          children: [
            {
              kind: "frame",
              name: "header.top-0.z-50",
              tag: "header",
              rect: { x: 0, y: 0, width: 800, height: 64 },
              style: { backgroundColor: "rgb(255, 255, 255)" },
              children: [
                {
                  kind: "frame",
                  name: "span.astro-logo-wrap",
                  tag: "span",
                  rect: { x: 24, y: 20, width: 120, height: 24 },
                  style: { backgroundColor: "rgba(0, 0, 0, 0)" },
                  children: [
                    {
                      kind: "text",
                      text: "Refore",
                      rect: { x: 24, y: 20, width: 64, height: 20 },
                      style: { fontFamily: "Inter", fontSize: 16 },
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          kind: "frame",
          name: "div.main-frame.astro-dqhqaokw",
          tag: "div",
          rect: { x: 0, y: 64, width: 800, height: 356 },
          style: { backgroundColor: "rgba(0, 0, 0, 0)", overflow: "visible" },
          children: [
            {
              kind: "frame",
              name: "main.astro-ojovxovv",
              tag: "main",
              rect: { x: 0, y: 64, width: 800, height: 356 },
              style: { backgroundColor: "rgba(0, 0, 0, 0)" },
              children: [
                {
                  kind: "text",
                  text: "Mapping missing fonts",
                  rect: { x: 120, y: 120, width: 260, height: 36 },
                  style: { fontFamily: "Inter", fontSize: 32 },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const figma = createFakeFigma();

  const result = await importSceneToFigma(scene, { figma });
  const header = result.root.children[0];
  const main = result.root.children[1];

  assert.equal(result.root.name, "Web to Figma · Body");
  assert.equal(header.name, "Header");
  assert.equal(main.name, "Main");
  assert.equal(header.children.length, 1);
  assert.equal(header.children[0].type, "TEXT");
  assert.equal(header.children[0].characters, "Refore");
  assert.equal(main.children[0].characters, "Mapping missing fonts");
  assert.equal(header.x, 0);
  assert.equal(main.y, 64);
});

test("page layout wrapper flattens so regions are direct hover targets", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/docs", selector: "body" },
    viewport: { width: 1440, height: 900 },
    root: {
      kind: "frame",
      name: "body.astro-ojovxovv",
      tag: "body",
      rect: { x: 0, y: 0, width: 960, height: 540 },
      children: [
        {
          kind: "frame",
          name: "div.page.sl-flex",
          tag: "div",
          rect: { x: 0, y: 0, width: 960, height: 540 },
          style: { backgroundColor: "rgba(0, 0, 0, 0)", overflow: "visible" },
          source: { className: "page sl-flex astro-dqhqaokw", tag: "div" },
          children: [
            {
              kind: "frame",
              name: "header.top-0.z-50",
              tag: "header",
              rect: { x: 0, y: 0, width: 960, height: 56 },
              style: { backgroundColor: "rgb(255, 255, 255)" },
              children: [],
            },
            {
              kind: "frame",
              name: "div#starlight__sidebar",
              tag: "div",
              rect: { x: 0, y: 56, width: 300, height: 484 },
              style: { backgroundColor: "rgb(255, 255, 255)", overflow: "auto" },
              source: { id: "starlight__sidebar", className: "sidebar-pane astro-dqhqaokw", tag: "div" },
              children: [],
            },
            {
              kind: "frame",
              name: "main.astro-ojovxovv",
              tag: "main",
              rect: { x: 300, y: 56, width: 660, height: 484 },
              style: { backgroundColor: "rgba(0, 0, 0, 0)" },
              children: [],
            },
          ],
        },
      ],
    },
  };
  const figma = createFakeFigma();

  const result = await importSceneToFigma(scene, { figma });
  const names = result.root.children.map((node) => node.name);

  assert.deepEqual(names, ["Header", "Sidebar", "Main"]);
  assert.equal(result.root.children[0].x, 0);
  assert.equal(result.root.children[1].y, 56);
  assert.equal(result.root.children[2].x, 300);
  assert.equal(result.root.children.some((node) => node.name === "Page"), false);
});

test("visually hidden accessibility nodes are dropped during import", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/store", selector: "body" },
    viewport: { width: 1440, height: 900 },
    root: {
      kind: "frame",
      name: "body",
      tag: "body",
      rect: { x: 0, y: 0, width: 320, height: 200 },
      children: [
        {
          kind: "frame",
          name: "h1.visuallyhidden",
          tag: "h1",
          rect: { x: 0, y: 0, width: 1, height: 1 },
          style: {
            position: "absolute",
            overflow: "hidden",
            clipPath: "inset(0px 0px 99.9% 99.9%)",
            backgroundColor: "rgba(0, 0, 0, 0)",
          },
          source: { className: "visuallyhidden", tag: "h1" },
          children: [
            {
              kind: "text",
              text: "Apple",
              rect: { x: 0, y: 4.5, width: 94, height: 40 },
              style: {
                position: "absolute",
                overflow: "hidden",
                clipPath: "inset(0px 0px 99.9% 99.9%)",
                fontFamily: "Inter",
                fontSize: 34,
              },
              source: { className: "visuallyhidden", tag: "h1", nodeType: "text" },
            },
          ],
        },
        {
          kind: "frame",
          name: "nav#globalnav",
          tag: "nav",
          rect: { x: 0, y: 0, width: 320, height: 44 },
          style: { backgroundColor: "rgba(255, 255, 255, 0.8)" },
          children: [
            {
              kind: "svg",
              name: "svg.logo",
              tag: "svg",
              rect: { x: 24, y: 0, width: 20, height: 44 },
              svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"44\"><path d=\"M0 0h20v44H0z\" /></svg>",
            },
            {
              kind: "frame",
              name: "span.globalnav-link-text",
              tag: "span",
              rect: { x: 44, y: 0, width: 1, height: 44 },
              style: {
                position: "absolute",
                overflow: "hidden",
                clipPath: "inset(0px 0px 99.9% 99.9%)",
                backgroundColor: "rgba(0, 0, 0, 0)",
              },
              source: { className: "globalnav-link-text", tag: "span" },
              children: [
                {
                  kind: "text",
                  text: "Store",
                  rect: { x: 44, y: 14, width: 30, height: 15 },
                  style: {
                    position: "absolute",
                    overflow: "hidden",
                    clipPath: "inset(0px 0px 99.9% 99.9%)",
                    fontFamily: "Inter",
                    fontSize: 12,
                  },
                  source: { className: "globalnav-link-text", tag: "span", nodeType: "text" },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const figma = createFakeFigma();

  const result = await importSceneToFigma(scene, { figma });
  const allText = figma.nodes
    .filter((node) => node.type === "TEXT")
    .map((node) => node.characters);
  const nav = result.root.children[0];

  assert.equal(result.root.children.length, 1);
  assert.equal(nav.name, "Navigation");
  assert.equal(nav.children.length, 1);
  assert.equal(nav.children[0].type, "VECTOR");
  assert.deepEqual(allText, []);
});

test("tiny transparent menu wrappers flatten around visible navigation items", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/store", selector: "body" },
    viewport: { width: 1440, height: 900 },
    root: {
      kind: "frame",
      name: "body",
      tag: "body",
      rect: { x: 0, y: 0, width: 420, height: 80 },
      children: [
        {
          kind: "frame",
          name: "nav#globalnav",
          tag: "nav",
          rect: { x: 0, y: 0, width: 420, height: 44 },
          style: { backgroundColor: "rgba(255, 255, 255, 0.8)" },
          children: [
            {
              kind: "frame",
              name: "ul#globalnav-list",
              tag: "ul",
              rect: { x: 20, y: 0, width: 380, height: 44 },
              style: { backgroundColor: "rgba(0, 0, 0, 0)" },
              children: [
                {
                  kind: "frame",
                  name: "li.globalnav-item.globalnav-menu",
                  tag: "li",
                  rect: { x: 0, y: 0, width: 1, height: 1 },
                  style: { backgroundColor: "rgba(0, 0, 0, 0)", overflow: "visible" },
                  children: [
                    {
                      kind: "frame",
                      name: "a.globalnav-link.globalnav-link-store",
                      tag: "a",
                      rect: { x: 40, y: 0, width: 46, height: 44 },
                      style: { backgroundColor: "rgba(0, 0, 0, 0)" },
                      children: [
                        {
                          kind: "svg",
                          name: "svg.store",
                          tag: "svg",
                          rect: { x: 48, y: 0, width: 30, height: 44 },
                          svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"30\" height=\"44\"><path d=\"M0 0h30v44H0z\" /></svg>",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const figma = createFakeFigma();

  const result = await importSceneToFigma(scene, { figma });
  const nav = result.root.children[0];
  const list = nav.children[0];

  assert.equal(nav.name, "Navigation");
  assert.equal(list.name, "List");
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].name, "Link");
  assert.equal(list.children[0].children[0].type, "VECTOR");
  assert.equal(list.children.some((node) => node.name === "List Item" && node.width === 1), false);
});

test("inline link wrappers flatten while preserving link and icon layers", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/docs", selector: "body" },
    viewport: { width: 1440, height: 900 },
    root: {
      kind: "frame",
      name: "Footer Fixture",
      rect: { x: 0, y: 0, width: 420, height: 96 },
      children: [
        {
          kind: "frame",
          name: "footer.sl-flex.astro-t22jioo2",
          tag: "footer",
          rect: { x: 0, y: 0, width: 420, height: 96 },
          style: { backgroundColor: "rgba(0, 0, 0, 0)" },
          children: [
            {
              kind: "frame",
              name: "a.astro-pmhdmori",
              tag: "a",
              rect: { x: 24, y: 16, width: 180, height: 64 },
              style: { backgroundColor: "rgba(0, 0, 0, 0)" },
              children: [
                {
                  kind: "frame",
                  name: "span.astro-pmhdmori",
                  tag: "span",
                  rect: { x: 40, y: 24, width: 120, height: 40 },
                  style: { backgroundColor: "rgba(0, 0, 0, 0)" },
                  children: [
                    {
                      kind: "frame",
                      name: "span.link-title.astro-pmhdmori",
                      tag: "span",
                      rect: { x: 40, y: 44, width: 120, height: 20 },
                      style: { backgroundColor: "rgba(0, 0, 0, 0)" },
                      children: [
                        {
                          kind: "text",
                          text: "Next",
                          rect: { x: 40, y: 44, width: 34, height: 20 },
                          style: { fontFamily: "Inter", fontSize: 14 },
                        },
                      ],
                    },
                  ],
                },
                {
                  kind: "svg",
                  name: "svg.[object SVGAnimatedString]",
                  tag: "svg",
                  rect: { x: 168, y: 40, width: 16, height: 16 },
                  svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"><path d=\"M4 8h8M8 4l4 4-4 4\"/></svg>",
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const figma = createFakeFigma();

  const result = await importSceneToFigma(scene, { figma });
  const footer = result.root.children[0];
  const link = footer.children[0];

  assert.equal(footer.name, "Footer");
  assert.equal(link.name, "Link · Next");
  assert.equal(link.children.length, 2);
  assert.equal(link.children[0].type, "TEXT");
  assert.equal(link.children[0].characters, "Next");
  assert.equal(link.children[1].type, "VECTOR");
  assert.equal(link.children[1].name, "Icon");
});

test("unstyled heading wrappers flatten to a single text layer", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/docs", selector: "body" },
    viewport: { width: 1440, height: 900 },
    root: {
      kind: "frame",
      name: "Main Fixture",
      rect: { x: 0, y: 0, width: 720, height: 160 },
      children: [
        {
          kind: "frame",
          name: "h1#_top",
          tag: "h1",
          rect: { x: 40, y: 32, width: 420, height: 56 },
          style: {
            backgroundColor: "rgba(0, 0, 0, 0)",
            color: "rgb(17, 24, 39)",
            fontFamily: "Inter",
            fontSize: 48,
            fontWeight: 700,
          },
          design: {
            fills: [],
            strokes: [],
            opacity: 1,
            clipsContent: false,
          },
          children: [
            {
              kind: "text",
              text: "Mapping missing fonts",
              rect: { x: 40, y: 32, width: 420, height: 56 },
              style: { fontFamily: "Inter", fontSize: 48, fontWeight: 700 },
            },
          ],
        },
      ],
    },
  };
  const figma = createFakeFigma();

  const result = await importSceneToFigma(scene, { figma });
  const heading = result.root.children[0];

  assert.equal(heading.type, "TEXT");
  assert.equal(heading.name, "Text · Mapping missing fonts");
  assert.equal(heading.characters, "Mapping missing fonts");
});

test("semantic layout frames keep transparent selectable surfaces", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/docs", selector: "body" },
    viewport: { width: 1440, height: 900 },
    root: {
      kind: "frame",
      name: "body.astro-ojovxovv",
      tag: "body",
      rect: { x: 0, y: 0, width: 960, height: 540 },
      style: { backgroundColor: "rgba(0, 0, 0, 0)" },
      children: [
        {
          kind: "frame",
          name: "main.astro-ojovxovv",
          tag: "main",
          rect: { x: 300, y: 56, width: 560, height: 320 },
          style: { backgroundColor: "rgba(0, 0, 0, 0)" },
          children: [
            {
              kind: "frame",
              name: "div.content-panel.astro-6mhqnu4u",
              tag: "div",
              rect: { x: 300, y: 160, width: 560, height: 180 },
              style: { backgroundColor: "rgba(0, 0, 0, 0)" },
              source: { className: "content-panel astro-6mhqnu4u", tag: "div" },
              children: [
                {
                  kind: "text",
                  text: "Editable content",
                  rect: { x: 340, y: 188, width: 140, height: 24 },
                  style: { fontFamily: "Inter", fontSize: 16 },
                },
              ],
            },
          ],
        },
        {
          kind: "frame",
          name: "Transparent Wrapper",
          rect: { x: 40, y: 40, width: 120, height: 80 },
          style: { backgroundColor: "rgba(0, 0, 0, 0)" },
          children: [
            {
              kind: "text",
              text: "Plain wrapper",
              rect: { x: 48, y: 52, width: 96, height: 20 },
              style: { fontFamily: "Inter", fontSize: 14 },
            },
          ],
        },
      ],
    },
  };
  const figma = createFakeFigma();

  const result = await importSceneToFigma(scene, { figma });
  const main = result.root.children[0];
  const contentPanel = main.children[0];
  const plainWrapper = result.root.children[1];

  assert.equal(result.root.fills[0].opacity, 0);
  assert.equal(main.name, "Main");
  assert.equal(main.fills[0].opacity, 0);
  assert.equal(contentPanel.name, "Content Panel");
  assert.equal(contentPanel.fills[0].opacity, 0);
  assert.deepEqual(plainWrapper.fills, []);
});

test("legacy inline prose imports as one paragraph text node", async () => {
  const scene = {
    version: 1,
    source: { url: "https://example.com/docs", selector: "body" },
    viewport: { width: 1440, height: 900 },
    root: {
      kind: "frame",
      name: "Note",
      rect: { x: 0, y: 0, width: 720, height: 124 },
      children: [
        {
          kind: "frame",
          name: "p",
          tag: "p",
          rect: { x: 18, y: 48, width: 684, height: 60 },
          style: { fontFamily: "Inter", fontSize: 16, lineHeight: "24px" },
          children: [
            {
              kind: "text",
              text: "The",
              rect: { x: 18, y: 53, width: 32, height: 19 },
              style: { fontFamily: "Inter", fontSize: 16 },
            },
            {
              kind: "frame",
              name: "code",
              tag: "code",
              rect: { x: 50, y: 54, width: 187, height: 19 },
              children: [
                {
                  kind: "text",
                  text: "Mapping missing fonts",
                  rect: { x: 55, y: 55, width: 177, height: 17 },
                  style: { fontFamily: "Inter", fontSize: 16 },
                },
              ],
            },
            {
              kind: "text",
              text: "feature in Advanced Import has been migrated to",
              rect: { x: 237, y: 53, width: 363, height: 19 },
              style: { fontFamily: "Inter", fontSize: 16 },
            },
            {
              kind: "frame",
              name: "a",
              tag: "a",
              rect: { x: 18, y: 53, width: 683, height: 49 },
              children: [
                {
                  kind: "text",
                  text: "Install Missing Fonts After Import",
                  rect: { x: 18, y: 53, width: 683, height: 49 },
                  style: { fontFamily: "Inter", fontSize: 16 },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const figma = createFakeFigma();

  const result = await importSceneToFigma(scene, { figma });
  const paragraph = result.root.children[0];

  assert.equal(paragraph.children.length, 1);
  assert.equal(paragraph.children[0].type, "TEXT");
  assert.equal(
    paragraph.children[0].characters,
    "The Mapping missing fonts feature in Advanced Import has been migrated to Install Missing Fonts After Import"
  );
  assert.equal(paragraph.children[0].x, 0);
  assert.equal(paragraph.children[0].y, 0);
});

test("simple svg stays editable and complex content degrades only locally", async () => {
  const figma = createFakeFigma();
  const scene = {
    version: 1,
    source: { url: "https://example.com/dashboard", selector: "body" },
    viewport: { width: 1440, height: 900 },
    assets: {
      chartFallback: { contentType: "image/png", base64: "BQYHCA==" },
    },
    root: {
      kind: "frame",
      name: "Dashboard",
      rect: { x: 0, y: 0, width: 960, height: 640 },
      children: [
        {
          kind: "svg",
          name: "Search Icon",
          svg: "<svg viewBox=\"0 0 24 24\"><path d=\"M1 1h10v10H1z\" /></svg>",
          rect: { x: 24, y: 24, width: 24, height: 24 },
        },
        {
          kind: "raster",
          name: "Canvas Chart",
          assetId: "chartFallback",
          rect: { x: 40, y: 80, width: 420, height: 260 },
        },
        {
          kind: "text",
          text: "Revenue",
          rect: { x: 40, y: 360, width: 120, height: 28 },
          style: { fontFamily: "Inter", fontSize: 20 },
        },
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const [icon, chart, label] = result.root.children;

  assert.equal(result.root.type, "FRAME");
  assert.notEqual(result.root.fills?.[0]?.type, "IMAGE");
  assert.equal(icon.type, "VECTOR");
  assert.equal(icon.svg.includes("<path"), true);
  assert.equal(chart.type, "RECTANGLE");
  assert.equal(chart.fills[0].type, "IMAGE");
  assert.equal(label.type, "TEXT");
  assert.equal(label.characters, "Revenue");
});

test("cancelling an import reports progress and removes partial Figma nodes", async () => {
  const figma = createFakeFigma();
  const progress = [];
  const scene = {
    version: 1,
    source: { url: "https://example.com/long", selector: "body" },
    viewport: { width: 1000, height: 800 },
    root: {
      kind: "frame",
      name: "Long Page",
      rect: { x: 0, y: 0, width: 1000, height: 1600 },
      children: [
        {
          kind: "text",
          text: "First section",
          rect: { x: 40, y: 40, width: 160, height: 28 },
          style: { fontFamily: "Inter", fontSize: 18 },
        },
        {
          kind: "text",
          text: "Second section",
          rect: { x: 40, y: 120, width: 180, height: 28 },
          style: { fontFamily: "Inter", fontSize: 18 },
        },
      ],
    },
  };
  let cancel = false;

  const result = await importSceneToFigma(scene, {
    figma,
    onProgress(event) {
      progress.push(event.stage);
      if (event.stage === "creating-nodes" && event.current === 2) cancel = true;
    },
    shouldCancel() {
      return cancel;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.root.removed, true);
  assert.deepEqual(figma.currentPage.children, []);
  assert.deepEqual(figma.currentPage.selection, []);
  assert.ok(progress.includes("import-started"));
  assert.ok(progress.includes("creating-nodes"));
  assert.ok(progress.includes("cancelled"));
});

test("cancelling sidecar overflow import removes both task roots", async () => {
  const figma = createFakeFigma();
  const scene = {
    version: 1,
    source: { url: "https://example.com/carousel", selector: "body" },
    viewport: { width: 100, height: 100 },
    assets: {
      "asset-card": { id: "asset-card", contentType: "image/png", base64: "AA==" },
    },
    root: {
      kind: "frame",
      name: "Carousel page",
      rect: { x: 0, y: 0, width: 100, height: 100 },
      children: [
        {
          kind: "frame",
          name: "li.off-canvas-card",
          tag: "li",
          rect: { x: 120, y: 0, width: 100, height: 100 },
          children: [
            {
              kind: "image",
              name: "img.card",
              tag: "img",
              assetId: "asset-card",
              rect: { x: 120, y: 0, width: 100, height: 100 },
            },
          ],
        },
      ],
    },
  };
  let cancel = false;

  const result = await importSceneToFigma(scene, {
    figma,
    overflowMode: "sidecar",
    onProgress(event) {
      if (event.stage === "creating-overflow-content") cancel = true;
    },
    shouldCancel() {
      return cancel;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.root.removed, true);
  assert.deepEqual(figma.currentPage.children, []);
  assert.deepEqual(figma.currentPage.selection, []);
});
