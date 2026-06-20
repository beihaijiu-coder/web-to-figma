import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { importSceneToFigma } = require("../figma-plugin/importer.js");

function createFakeFigma({ unavailableFonts = [] } = {}) {
  const nodes = [];
  const pageChildren = [];
  const focusedNodes = [];
  const viewport = {
    scrolledAndZoomedIntoView(selection) {
      focusedNodes.push(selection);
    },
  };

  function appendChild(child) {
    this.children.push(child);
    child.parent = this;
  }

  function resize(width, height) {
    this.width = width;
    this.height = height;
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
        this.removed = true;
      },
    };
    nodes.push(node);
    return node;
  }

  return {
    nodes,
    currentPage: {
      children: pageChildren,
      selection: [],
      appendChild(node) {
        pageChildren.push(node);
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
      if (unavailableFonts.includes(fontName.family) || unavailableFonts.includes(key)) {
        throw new Error(`Missing font: ${key}`);
      }
      this.loadedFonts.push(fontName);
    },
    loadedFonts: [],
    createdImages: [],
  };
}

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
      ],
    },
  };

  const result = await importSceneToFigma(scene, { figma });
  const [hero, thumb] = result.root.children;

  assert.equal(hero.type, "RECTANGLE");
  assert.equal(hero.fills[0].type, "IMAGE");
  assert.equal(hero.fills[0].scaleMode, "FILL");
  assert.equal(hero.cornerRadius, 16);
  assert.equal(thumb.fills[0].type, "IMAGE");
  assert.equal(thumb.fills[0].scaleMode, "FIT");
  assert.equal(hero.fills[0].imageHash, thumb.fills[0].imageHash);
  assert.equal(figma.createdImages.length, 1);
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
        objectFit: "cover",
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

test("layout preference switches safe flex containers between fixed and auto layout", async () => {
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

  const visualResult = await importSceneToFigma(scene, { figma: visual, layoutMode: "visual" });
  const editableResult = await importSceneToFigma(scene, { figma: editable, layoutMode: "editable" });

  assert.equal(visualResult.root.layoutMode || "NONE", "NONE");
  assert.equal(visualResult.root.children[1].x, 88);
  assert.equal(editableResult.root.layoutMode, "HORIZONTAL");
  assert.equal(editableResult.root.itemSpacing, 24);
  assert.equal(editableResult.root.counterAxisAlignItems, "CENTER");
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
      if (event.stage === "creating-nodes") cancel = true;
    },
    shouldCancel() {
      return cancel;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.root.removed, true);
  assert.deepEqual(figma.currentPage.selection, []);
  assert.ok(progress.includes("import-started"));
  assert.ok(progress.includes("creating-nodes"));
  assert.ok(progress.includes("cancelled"));
});
