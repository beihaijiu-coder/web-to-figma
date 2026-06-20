import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../scene-capture.js", import.meta.url), "utf8");

function createElement(tagName, rect, options = {}) {
  const element = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    id: options.id || "",
    className: options.className || "",
    childNodes: options.childNodes || [],
    children: [],
    attributes: options.attributes || [],
    currentSrc: options.currentSrc || "",
    src: options.src || "",
    alt: options.alt || "",
    textContent: options.textContent || "",
    style: {},
    getBoundingClientRect() {
      return {
        x: rect.x,
        y: rect.y,
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
      };
    },
    getAttribute(name) {
      return options[name] || "";
    },
    matches(selector) {
      return selector === tagName.toLowerCase();
    },
  };
  element.children = element.childNodes.filter((node) => node.nodeType === 1);
  for (const child of element.children) child.parentElement = element;
  return element;
}

function createText(text, rect) {
  return {
    nodeType: 3,
    textContent: text,
    rect,
  };
}

function runSceneCapture({ root, selector = "body", scrollHeight = root.getBoundingClientRect().height }) {
  const document = {
    body: root,
    documentElement: { scrollHeight },
    title: "Fixture Page",
    querySelector(value) {
      return value === selector || value === "body" ? root : null;
    },
    createRange() {
      let node = null;
      return {
        selectNodeContents(value) {
          node = value;
        },
        getBoundingClientRect() {
          const rect = node?.rect || { x: 0, y: 0, width: 1, height: 1 };
          return {
            x: rect.x,
            y: rect.y,
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
            right: rect.x + rect.width,
            bottom: rect.y + rect.height,
          };
        },
        detach() {},
      };
    },
  };
  const context = vm.createContext({
    window: {
      document,
      location: { href: "https://example.com/page" },
      innerWidth: 1440,
      innerHeight: 900,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle(element) {
        return element.computedStyle || {};
      },
    },
    document,
    Date,
    URL,
  });

  new vm.Script(source).runInContext(context);
  return context.window.webToFigmaCaptureScene(selector);
}

test("scene capture keeps full-page bounds and component text/image structure", async () => {
  const title = createText("Launch faster", { x: 40, y: 32, width: 220, height: 36 });
  const image = createElement("img", { x: 40, y: 96, width: 320, height: 180 }, {
    id: "hero-image",
    currentSrc: "https://example.com/hero.png",
    alt: "Hero product screenshot",
  });
  const root = createElement("section", { x: 0, y: 0, width: 800, height: 1200 }, {
    id: "hero",
    childNodes: [title, image],
  });
  root.computedStyle = {
    display: "flex",
    flexDirection: "column",
    gap: "24px",
    backgroundColor: "rgb(255, 255, 255)",
    color: "rgb(15, 23, 42)",
    fontFamily: "Inter",
    fontSize: "32px",
    fontWeight: "700",
  };
  image.computedStyle = {
    objectFit: "cover",
    borderRadius: "16px",
  };

  const scene = await runSceneCapture({ root, selector: "#hero", scrollHeight: 1200 });

  assert.equal(scene.version, 1);
  assert.equal(scene.source.url, "https://example.com/page");
  assert.equal(scene.source.selector, "#hero");
  assert.equal(scene.viewport.width, 1440);
  assert.equal(scene.root.name, "section#hero");
  assert.equal(scene.root.rect.height, 1200);
  assert.equal(scene.root.layout.display, "flex");
  assert.equal(scene.root.children[0].kind, "text");
  assert.equal(scene.root.children[0].text, "Launch faster");
  assert.equal(scene.root.children[1].kind, "image");
  assert.equal(scene.root.children[1].assetId, "asset-1");
  assert.equal(scene.assets["asset-1"].src, "https://example.com/hero.png");
});

test("selected component scenes keep absolute geometry for Figma placement", async () => {
  const label = createText("Buy now", { x: 148, y: 96, width: 88, height: 24 });
  const root = createElement("button", { x: 120, y: 80, width: 180, height: 64 }, {
    id: "cta",
    childNodes: [label],
  });
  root.computedStyle = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgb(34, 197, 94)",
    color: "rgb(5, 46, 22)",
    fontFamily: "Inter",
    fontSize: "18px",
    fontWeight: "700",
  };

  const scene = await runSceneCapture({ root, selector: "#cta", scrollHeight: 900 });

  assert.equal(scene.root.rect.x, 120);
  assert.equal(scene.root.rect.y, 80);
  assert.equal(scene.root.children[0].rect.x, 148);
  assert.equal(scene.root.children[0].rect.y, 96);
});

test("canvas regions become local raster assets instead of flattening the page", async () => {
  const canvas = createElement("canvas", { x: 24, y: 56, width: 300, height: 160 }, {
    id: "chart",
  });
  canvas.toDataURL = () => "data:image/png;base64,QUJD";
  const label = createText("Chart title", { x: 24, y: 24, width: 120, height: 24 });
  const root = createElement("section", { x: 0, y: 0, width: 420, height: 260 }, {
    id: "analytics",
    childNodes: [label, canvas],
  });
  root.computedStyle = {
    display: "block",
    backgroundColor: "rgb(255, 255, 255)",
    color: "rgb(15, 23, 42)",
    fontFamily: "Inter",
    fontSize: "18px",
    fontWeight: "600",
  };

  const scene = await runSceneCapture({ root, selector: "#analytics" });

  assert.equal(scene.root.kind, "frame");
  assert.equal(scene.root.children[0].kind, "text");
  assert.equal(scene.root.children[1].kind, "raster");
  assert.equal(scene.assets["asset-1"].contentType, "image/png");
  assert.equal(scene.assets["asset-1"].base64, "QUJD");
});

test("css background images become replaceable scene assets", async () => {
  const root = createElement("section", { x: 0, y: 0, width: 480, height: 280 }, {
    id: "hero-bg",
    childNodes: [createText("Background hero", { x: 32, y: 40, width: 220, height: 32 })],
  });
  root.computedStyle = {
    display: "block",
    backgroundImage: 'url("https://example.com/hero-bg.png")',
    backgroundSize: "cover",
    backgroundPosition: "center center",
    borderRadius: "24px",
    color: "rgb(255, 255, 255)",
    fontFamily: "Inter",
    fontSize: "24px",
    fontWeight: "700",
  };

  const scene = await runSceneCapture({ root, selector: "#hero-bg" });

  assert.equal(scene.root.kind, "frame");
  assert.equal(scene.root.style.backgroundAssetId, "asset-1");
  assert.equal(scene.root.style.objectFit, "cover");
  assert.equal(scene.assets["asset-1"].src, "https://example.com/hero-bg.png");
  assert.equal(scene.root.children[0].kind, "text");
});

test("data uri images carry base64 bytes for offline smoke testing", async () => {
  const image = createElement("img", { x: 16, y: 16, width: 160, height: 90 }, {
    src: "data:image/png;base64,MTIzNA==",
    alt: "Inline asset",
  });
  const root = createElement("section", { x: 0, y: 0, width: 220, height: 140 }, {
    id: "inline-assets",
    childNodes: [image],
  });
  root.computedStyle = {
    display: "block",
    backgroundImage: 'url("data:image/png;base64,QUJDRA==")',
    backgroundSize: "contain",
  };

  const scene = await runSceneCapture({ root, selector: "#inline-assets" });

  const backgroundAsset = scene.assets[scene.root.style.backgroundAssetId];
  const imageAsset = scene.assets[scene.root.children[0].assetId];
  assert.equal(backgroundAsset.contentType, "image/png");
  assert.equal(backgroundAsset.base64, "QUJDRA==");
  assert.equal(imageAsset.contentType, "image/png");
  assert.equal(imageAsset.base64, "MTIzNA==");
});
