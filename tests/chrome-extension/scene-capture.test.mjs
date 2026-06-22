import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../../chrome-extension/src/scene-capture.js", import.meta.url),
  "utf8"
);

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
      if (name === "id") return options.id || "";
      if (name === "class") return options.className || "";
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

function runSceneCapture({
  root,
  selector = "body",
  scrollHeight = root.getBoundingClientRect().height,
  fetchImpl,
}) {
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
      getComputedStyle(element, pseudo) {
        if (pseudo && element.pseudoStyles && element.pseudoStyles[pseudo]) {
          return element.pseudoStyles[pseudo];
        }
        return element.computedStyle || {};
      },
    },
    document,
    Date,
    URL,
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
    fetch: fetchImpl,
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
  assert.equal(scene.irVersion, 2);
  assert.equal(scene.schema, "web-to-figma.scene-ir");
  assert.equal(scene.capabilities.designStyle, true);
  assert.equal(scene.capabilities.layoutCandidates, true);
  assert.equal(scene.source.url, "https://example.com/page");
  assert.equal(scene.source.selector, "#hero");
  assert.equal(scene.viewport.width, 1440);
  assert.match(scene.root.id, /^frame-/);
  assert.equal(scene.root.type, "frame");
  assert.equal(scene.root.name, "section#hero");
  assert.equal(scene.root.rect.height, 1200);
  assert.deepEqual(scene.root.absoluteRect, scene.root.rect);
  assert.equal(scene.root.source.selector, "#hero");
  assert.equal(scene.root.design.fills[0].type, "solid");
  assert.equal(scene.root.design.text, undefined);
  assert.equal(scene.root.layout.display, "flex");
  assert.equal(scene.root.layout.mode, "absolute");
  assert.equal(scene.root.layout.absolute.height, 1200);
  assert.equal(scene.root.layout.autoLayoutCandidate.enabled, true);
  assert.equal(scene.root.layout.autoLayoutCandidate.direction, "vertical");
  assert.equal(scene.root.children[0].kind, "text");
  assert.equal(scene.root.children[0].type, "text");
  assert.equal(scene.root.children[0].text, "Launch faster");
  assert.equal(scene.root.children[0].design.text.fontFamily, "Inter");
  assert.equal(scene.root.children[0].textRuns[0].style.fontSize, 32);
  assert.equal(scene.root.children[1].kind, "image");
  assert.equal(scene.root.children[1].assetId, "asset-1");
  assert.equal(scene.root.children[1].design.image.fit, "cover");
  assert.equal(scene.assets["asset-1"].id, "asset-1");
  assert.equal(scene.assets["asset-1"].type, "image");
  assert.equal(scene.assets["asset-1"].source, "img");
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

test("blob image assets are hydrated in the page context before handoff", async () => {
  const image = createElement("img", { x: 16, y: 16, width: 160, height: 90 }, {
    src: "blob:https://example.com/asset-id",
    alt: "Blob asset",
  });
  const root = createElement("section", { x: 0, y: 0, width: 220, height: 140 }, {
    id: "blob-assets",
    childNodes: [image],
  });

  const scene = await runSceneCapture({
    root,
    selector: "#blob-assets",
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get() {
          return "image/png";
        },
      },
      async arrayBuffer() {
        return Uint8Array.from([1, 2, 3, 4]).buffer;
      },
    }),
  });

  const asset = scene.assets[scene.root.children[0].assetId];
  assert.equal(asset.src, "blob:https://example.com/asset-id");
  assert.equal(asset.contentType, "image/png");
  assert.equal(asset.base64, "AQIDBA==");
});

test("pseudo element visuals are captured as local editable nodes", async () => {
  const root = createElement("button", { x: 40, y: 50, width: 160, height: 48 }, {
    id: "with-icon",
    childNodes: [createText("Save", { x: 72, y: 62, width: 48, height: 20 })],
  });
  root.computedStyle = {
    display: "inline-flex",
    backgroundColor: "rgb(255, 255, 255)",
    color: "rgb(15, 23, 42)",
    fontFamily: "Inter",
    fontSize: "16px",
    fontWeight: "600",
  };
  root.pseudoStyles = {
    "::before": {
      content: '""',
      display: "block",
      width: "20px",
      height: "20px",
      left: "16px",
      top: "14px",
      backgroundImage: 'url("https://example.com/icon.png")',
      backgroundSize: "contain",
      backgroundColor: "rgba(0, 0, 0, 0)",
    },
  };

  const scene = await runSceneCapture({ root, selector: "#with-icon" });
  const pseudo = scene.root.children[0];

  assert.equal(pseudo.name, "button#with-icon::before");
  assert.equal(pseudo.rect.x, 56);
  assert.equal(pseudo.rect.y, 64);
  assert.equal(pseudo.style.backgroundAssetId, "asset-1");
  assert.equal(scene.assets["asset-1"].src, "https://example.com/icon.png");
});

test("known browser extension injected roots are ignored during capture", async () => {
  const content = createElement("main", { x: 0, y: 0, width: 600, height: 400 }, {
    id: "content",
    childNodes: [createText("Real page", { x: 24, y: 24, width: 120, height: 24 })],
  });
  const injected = createElement("div", { x: 0, y: 400, width: 600, height: 40 }, {
    id: "monica-content-root",
    childNodes: [createText("Injected", { x: 0, y: 400, width: 80, height: 20 })],
  });
  const root = createElement("body", { x: 0, y: 0, width: 600, height: 440 }, {
    childNodes: [content, injected],
  });

  const scene = await runSceneCapture({ root, selector: "body" });

  assert.equal(scene.root.children.length, 1);
  assert.equal(scene.root.children[0].name, "main#content");
});

test("transparent empty overlays are not captured as white covering frames", async () => {
  const content = createElement("main", { x: 288, y: 0, width: 1120, height: 900 }, {
    className: "page",
    childNodes: [createText("Real top content", { x: 320, y: 48, width: 260, height: 32 })],
  });
  content.computedStyle = {
    display: "grid",
    backgroundColor: "rgba(0, 0, 0, 0)",
  };
  const injectedOverlay = createElement("div", { x: 0, y: 0, width: 1440, height: 900 });
  injectedOverlay.computedStyle = {
    display: "block",
    backgroundColor: "rgba(0, 0, 0, 0)",
    borderWidth: "0px",
    boxShadow: "none",
    overflow: "hidden",
  };
  const root = createElement("body", { x: 0, y: 0, width: 1440, height: 1200 }, {
    childNodes: [content, injectedOverlay],
  });

  const scene = await runSceneCapture({ root, selector: "body", scrollHeight: 1200 });

  assert.equal(scene.root.children.length, 1);
  assert.equal(scene.root.children[0].name, "main.page");
});

test("scroll containers are captured as clipping frames", async () => {
  const content = createElement("div", { x: 0, y: -36.5, width: 284, height: 920 }, {
    className: "sidebar-content",
    childNodes: [createText("Refore HTML to Figma", { x: 58, y: -12.2, width: 168.44, height: 19 })],
  });
  content.computedStyle = {
    display: "block",
    overflow: "visible",
    backgroundColor: "rgba(0, 0, 0, 0)",
    color: "rgb(17, 24, 39)",
    fontFamily: "Inter",
    fontSize: "16px",
  };
  const root = createElement("div", { x: 0, y: 56, width: 300, height: 844 }, {
    id: "starlight__sidebar",
    childNodes: [content],
  });
  root.computedStyle = {
    display: "block",
    overflow: "auto",
    overflowX: "hidden",
    overflowY: "auto",
    backgroundColor: "rgba(0, 0, 0, 0)",
  };

  const scene = await runSceneCapture({ root, selector: "#starlight__sidebar" });

  assert.equal(scene.root.style.overflow, "auto");
  assert.equal(scene.root.design.clipsContent, true);
  assert.equal(scene.root.children[0].rect.y, -36.5);
});

test("empty one-sided divider elements are kept during capture", async () => {
  const divider = createElement("div", { x: 300, y: 56, width: 1, height: 844 }, {
    className: "sidebar-divider",
  });
  divider.computedStyle = {
    display: "block",
    backgroundColor: "rgba(0, 0, 0, 0)",
    borderWidth: "0px",
    borderRightWidth: "1px",
    borderRightColor: "rgb(237, 238, 243)",
  };
  const root = createElement("body", { x: 0, y: 0, width: 1440, height: 900 }, {
    childNodes: [divider],
  });

  const scene = await runSceneCapture({ root, selector: "body" });
  const captured = scene.root.children[0];

  assert.equal(captured.name, "div.sidebar-divider");
  assert.equal(captured.design.strokes.length, 1);
  assert.equal(captured.design.strokes[0].side, "right");
  assert.equal(captured.design.strokes[0].width, 1);
});

test("translation extension inline wrappers are ignored during capture", async () => {
  const translated = createElement("font", { x: 96, y: 32, width: 180, height: 24 }, {
    className: "notranslate immersive-translate-target-wrapper",
    childNodes: [createText("Injected translation", { x: 96, y: 32, width: 180, height: 24 })],
  });
  const root = createElement("p", { x: 80, y: 24, width: 420, height: 72 }, {
    className: "copy",
    childNodes: [
      createText("Original copy", { x: 80, y: 24, width: 120, height: 24 }),
      translated,
    ],
  });

  const scene = await runSceneCapture({ root, selector: ".copy" });

  assert.equal(scene.root.children.length, 1);
  assert.equal(scene.root.children[0].text, "Original copy");
});

test("focus-only skip links are ignored during visual capture", async () => {
  const skip = createElement("a", { x: 12, y: 12, width: 112, height: 24 }, {
    href: "#content",
    childNodes: [createText("Skip to content", { x: 12, y: 14, width: 112, height: 19 })],
  });
  skip.computedStyle = {
    display: "block",
    position: "fixed",
    color: "rgb(53, 56, 65)",
    backgroundColor: "rgba(0, 0, 0, 0)",
  };
  const main = createElement("main", { x: 300, y: 56, width: 900, height: 480 }, {
    id: "content",
    childNodes: [createText("Mapping missing fonts", { x: 472, y: 84, width: 408, height: 47 })],
  });
  const root = createElement("body", { x: 0, y: 0, width: 1440, height: 900 }, {
    childNodes: [skip, main],
  });

  const scene = await runSceneCapture({ root, selector: "body", scrollHeight: 900 });

  assert.equal(scene.root.children.length, 1);
  assert.equal(scene.root.children[0].name, "main#content");
});

test("visually hidden accessibility text is ignored during visual capture", async () => {
  const hiddenTitle = createElement("h1", { x: 0, y: 0, width: 1, height: 1 }, {
    className: "visuallyhidden",
    childNodes: [createText("Apple", { x: 0, y: 4.5, width: 94, height: 40 })],
  });
  hiddenTitle.computedStyle = {
    display: "block",
    position: "absolute",
    overflow: "hidden",
    clipPath: "inset(0px 0px 99.9% 99.9%)",
    backgroundColor: "rgba(0, 0, 0, 0)",
  };
  const icon = createElement("svg", { x: 24, y: 0, width: 20, height: 44 }, {
    childNodes: [],
  });
  icon.outerHTML = "<svg width=\"20\" height=\"44\"><path d=\"M0 0h20v44H0z\" /></svg>";
  icon.computedStyle = {
    display: "block",
    overflow: "hidden",
    backgroundColor: "rgba(0, 0, 0, 0)",
  };
  const hiddenLinkText = createElement("span", { x: 44, y: 0, width: 1, height: 44 }, {
    className: "globalnav-link-text",
    childNodes: [createText("Store", { x: 44, y: 14, width: 30, height: 15 })],
  });
  hiddenLinkText.computedStyle = {
    display: "block",
    position: "absolute",
    overflow: "hidden",
    clipPath: "inset(0px 0px 99.9% 99.9%)",
    backgroundColor: "rgba(0, 0, 0, 0)",
  };
  const nav = createElement("nav", { x: 0, y: 0, width: 320, height: 44 }, {
    childNodes: [icon, hiddenLinkText],
  });
  nav.computedStyle = {
    display: "block",
    backgroundColor: "rgba(255, 255, 255, 0.8)",
  };
  const root = createElement("body", { x: 0, y: 0, width: 320, height: 200 }, {
    childNodes: [hiddenTitle, nav],
  });

  const scene = await runSceneCapture({ root, selector: "body", scrollHeight: 200 });
  const navNode = scene.root.children[0];

  assert.equal(scene.root.children.length, 1);
  assert.equal(navNode.name, "nav");
  assert.equal(navNode.children.length, 1);
  assert.equal(navNode.children[0].kind, "svg");
  assert.equal(JSON.stringify(scene.root).includes("Apple"), false);
  assert.equal(JSON.stringify(scene.root).includes("Store"), false);
});

test("external svg sprite uses are captured as reusable scene assets", async () => {
  const spriteUse = {
    getAttribute(name) {
      if (name === "href") return "/cdn/icons.svg#new-chat";
      return "";
    },
  };
  const icon = createElement("svg", { x: 16, y: 24, width: 20, height: 20 }, {
    childNodes: [],
  });
  icon.outerHTML =
    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\"><use href=\"/cdn/icons.svg#new-chat\" fill=\"currentColor\"></use></svg>";
  icon.querySelectorAll = (selector) => (selector === "use" ? [spriteUse] : []);
  icon.computedStyle = {
    display: "block",
    color: "rgb(13, 13, 13)",
    backgroundColor: "rgba(0, 0, 0, 0)",
  };
  const root = createElement("button", { x: 0, y: 0, width: 56, height: 56 }, {
    id: "icon-button",
    childNodes: [icon],
  });
  root.computedStyle = {
    display: "flex",
    backgroundColor: "rgba(0, 0, 0, 0)",
    color: "rgb(13, 13, 13)",
  };

  const scene = await runSceneCapture({ root, selector: "#icon-button" });
  const svgNode = scene.root.children[0];
  const spriteAsset = scene.assets[svgNode.svgUses[0].assetId];

  assert.equal(svgNode.kind, "svg");
  assert.equal(svgNode.svgUses[0].symbolId, "new-chat");
  assert.equal(spriteAsset.src, "https://example.com/cdn/icons.svg");
  assert.equal(spriteAsset.type, "svg");
  assert.equal(spriteAsset.source, "svg-sprite");
  assert.deepEqual(Array.from(spriteAsset.symbolIds), ["new-chat"]);
});

test("inline prose with links is captured as one paragraph text node", async () => {
  const code = createElement("code", { x: 524, y: 239, width: 187, height: 19 }, {
    childNodes: [createText("Mapping missing fonts", { x: 529, y: 240, width: 177, height: 17 })],
  });
  code.computedStyle = {
    display: "inline",
    fontFamily: "monospace",
    fontSize: "16px",
    backgroundColor: "rgb(229, 231, 235)",
  };
  const link = createElement("a", { x: 492, y: 238, width: 683, height: 49 }, {
    href: "/docs/html-to-figma/features/install-missing-fonts-after-import",
    childNodes: [
      createText("Install Missing Fonts After Import", { x: 492, y: 238, width: 683, height: 49 }),
    ],
  });
  link.computedStyle = {
    display: "inline",
    color: "rgb(37, 99, 235)",
    fontSize: "16px",
  };
  const paragraph = createElement("p", { x: 492, y: 233, width: 684, height: 60 }, {
    childNodes: [
      createText("The ", { x: 492, y: 238, width: 32, height: 19 }),
      code,
      createText(" feature in Advanced Import has been migrated to ", {
        x: 711,
        y: 238,
        width: 363,
        height: 19,
      }),
      link,
    ],
  });
  paragraph.computedStyle = {
    display: "block",
    color: "rgb(17, 24, 39)",
    fontFamily: "Inter",
    fontSize: "16px",
    lineHeight: "24px",
    backgroundColor: "rgba(0, 0, 0, 0)",
  };

  const scene = await runSceneCapture({ root: paragraph, selector: "p" });

  assert.equal(scene.root.kind, "frame");
  assert.equal(scene.root.children.length, 1);
  assert.equal(scene.root.children[0].kind, "text");
  assert.equal(
    scene.root.children[0].text,
    "The Mapping missing fonts feature in Advanced Import has been migrated to Install Missing Fonts After Import"
  );
  assert.deepEqual(scene.root.children[0].rect, scene.root.rect);
});

test("url-encoded data uri svg images become scene assets", async () => {
  const svgDataUrl =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='10'%3E%3Crect width='20' height='10' fill='%23f97316'/%3E%3C/svg%3E";
  const image = createElement("img", { x: 16, y: 16, width: 160, height: 90 }, {
    src: svgDataUrl,
    alt: "Inline svg asset",
  });
  const root = createElement("section", { x: 0, y: 0, width: 220, height: 140 }, {
    id: "svg-assets",
    childNodes: [image],
  });

  const scene = await runSceneCapture({ root, selector: "#svg-assets" });
  const asset = scene.assets[scene.root.children[0].assetId];

  assert.equal(asset.src, svgDataUrl);
  assert.equal(asset.contentType, "image/svg+xml");
  assert.equal(
    Buffer.from(asset.base64, "base64").toString("utf8"),
    "<svg xmlns='http://www.w3.org/2000/svg' width='20' height='10'><rect width='20' height='10' fill='#f97316'/></svg>"
  );
});

test("body gradient backgrounds are preserved on full-page captures", async () => {
  const content = createElement("main", { x: 0, y: 0, width: 800, height: 600 }, {
    childNodes: [createText("Content", { x: 24, y: 24, width: 80, height: 24 })],
  });
  const root = createElement("body", { x: 0, y: 0, width: 800, height: 900 }, {
    childNodes: [content],
  });
  root.computedStyle = {
    display: "block",
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage:
      "radial-gradient(circle at top left, rgba(37, 99, 235, 0.22), transparent 34rem), linear-gradient(180deg, #f8fafc 0%, #e0f2fe 100%)",
  };

  const scene = await runSceneCapture({ root, selector: "body", scrollHeight: 900 });

  assert.match(scene.root.style.backgroundColor, /radial-gradient/);
  assert.match(scene.root.style.backgroundColor, /linear-gradient/);
  assert.equal(scene.root.style.backgroundLayers.length, 2);
});

test("text capture keeps typography metrics that prevent Figma clipping", async () => {
  const heading = createText("Editable website layers, not a screenshot.", {
    x: 32,
    y: 40,
    width: 520,
    height: 188,
  });
  const root = createElement("h1", { x: 32, y: 40, width: 560, height: 200 }, {
    childNodes: [heading],
  });
  root.computedStyle = {
    display: "block",
    color: "rgb(15, 23, 42)",
    fontFamily: "Inter",
    fontSize: "72px",
    fontWeight: "800",
    fontStyle: "italic",
    lineHeight: "68.4px",
    letterSpacing: "-4.32px",
    whiteSpace: "normal",
  };

  const scene = await runSceneCapture({ root, selector: "h1" });
  const text = scene.root.children[0];

  assert.equal(text.style.lineHeight, "68.4px");
  assert.equal(text.style.letterSpacing, "-4.32px");
  assert.equal(text.style.whiteSpace, "normal");
  assert.equal(text.style.fontStyle, "italic");
  assert.equal(text.design.text.fontStyle, "italic");
  assert.equal(text.rect.width, 520);
});

test("wrapped flex containers keep their wrap flag for fixed visual import", async () => {
  const first = createElement("button", { x: 24, y: 24, width: 180, height: 54 }, {
    childNodes: [createText("Capture this component", { x: 42, y: 40, width: 144, height: 18 })],
  });
  const second = createElement("button", { x: 216, y: 24, width: 190, height: 54 }, {
    childNodes: [createText("Then import clipboard", { x: 234, y: 40, width: 150, height: 18 })],
  });
  const root = createElement("div", { x: 0, y: 0, width: 480, height: 96 }, {
    className: "actions",
    childNodes: [first, second],
  });
  root.computedStyle = {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: "12px",
    backgroundColor: "rgba(0, 0, 0, 0)",
  };

  const scene = await runSceneCapture({ root, selector: ".actions" });

  assert.equal(scene.root.layout.display, "flex");
  assert.equal(scene.root.layout.flexWrap, "wrap");
});

test("iframe regions are marked for screenshot fallback instead of empty DOM frames", async () => {
  const iframe = createElement("iframe", { x: 32, y: 48, width: 420, height: 260 }, {
    id: "map",
  });
  const root = createElement("section", { x: 0, y: 0, width: 520, height: 360 }, {
    id: "embed",
    childNodes: [iframe],
  });

  const scene = await runSceneCapture({ root, selector: "#embed" });
  const iframeNode = scene.root.children[0];
  const asset = scene.assets[iframeNode.assetId];

  assert.equal(iframeNode.kind, "raster");
  assert.equal(iframeNode.name, "iframe#map");
  assert.equal(asset.error, "SCREENSHOT_REQUIRED");
  assert.equal(asset.fallback, "visible-tab-screenshot");
});

test("videos without posters use screenshot fallback instead of mp4 image assets", async () => {
  const video = createElement("video", { x: 24, y: 32, width: 640, height: 360 }, {
    id: "hero-video",
    currentSrc: "https://example.com/hero.mp4",
  });
  video.poster = "";
  const root = createElement("section", { x: 0, y: 0, width: 720, height: 420 }, {
    id: "hero",
    childNodes: [video],
  });

  const scene = await runSceneCapture({ root, selector: "#hero" });
  const videoNode = scene.root.children[0];
  const asset = scene.assets[videoNode.assetId];

  assert.equal(videoNode.kind, "raster");
  assert.equal(videoNode.name, "video#hero-video");
  assert.equal(asset.src, "screenshot:video:video#hero-video");
  assert.equal(asset.error, "SCREENSHOT_REQUIRED");
  assert.equal(asset.fallback, "visible-tab-screenshot");
  assert.equal(asset.contentType, undefined);
});
