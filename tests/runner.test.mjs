import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const runnerSource = fs.readFileSync(new URL("../runner.js", import.meta.url), "utf8");

function createRunnerContext({
  bodyScrollHeight = 800,
  documentScrollHeight = 2400,
  innerHeight = 1000,
  images = [],
  elements = [],
  ignoredElements = [],
  fontsReady = Promise.resolve(),
  maxTimers = Number.POSITIVE_INFINITY,
  captureResult,
  sceneCaptureResult,
  captureOptions,
} = {}) {
  const scrolls = [];
  const captureCalls = [];
  const progressEvents = [];
  const eventHandlers = new Map();
  let timerCount = 0;

  const documentElement = {};
  Object.defineProperty(documentElement, "scrollHeight", {
    get:
      typeof documentScrollHeight === "function"
        ? documentScrollHeight
        : () => documentScrollHeight,
  });

  const body = {
    scrollHeight: bodyScrollHeight,
  };

  const document = {
    body,
    documentElement,
    images,
    baseURI: "https://example.com/",
    querySelectorAll(selector) {
      if (selector === "[data-figma-capture-ignore='1']") return ignoredElements;
      return selector === "*" ? elements : [];
    },
    fonts: {
      ready: fontsReady,
    },
  };

  const window = {
    document,
    innerHeight,
    location: { href: "https://example.com/page" },
    __FIGMA_CAPTURE_OPTIONS__: captureOptions,
    addEventListener(type, handler) {
      if (!eventHandlers.has(type)) eventHandlers.set(type, []);
      eventHandlers.get(type).push(handler);
    },
    dispatchEvent(event) {
      progressEvents.push(event.detail);
      for (const handler of eventHandlers.get(event.type) || []) {
        handler(event);
      }
      return true;
    },
    getComputedStyle(element) {
      return element.computedStyle || element.style || {};
    },
    scrollTo(x, y) {
      scrolls.push({ x, y });
    },
    figma: {
      async captureForDesign(options) {
        captureCalls.push(options);
        return captureResult ? captureResult({ options, images }) : { ok: true, options };
      },
    },
  };

  if (sceneCaptureResult) {
    window.webToFigmaCaptureScene = async (selector, options) => {
      captureCalls.push({ selector, ...options, sceneCapture: true });
      return sceneCaptureResult({ selector, options, images });
    };
  }

  const context = vm.createContext({
    window,
    document,
    setTimeout(callback) {
      timerCount++;
      if (timerCount > maxTimers) {
        throw new Error("runner did not finish within the timer budget");
      }
      callback();
      return 1;
    },
    clearTimeout() {},
    Promise,
    Math,
    Error,
    Array,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    URL,
  });

  return { context, scrolls, captureCalls, progressEvents };
}

async function runRunner(options) {
  const state = createRunnerContext(options);
  const script = new vm.Script(runnerSource);
  const result = await script.runInContext(state.context);

  return { ...state, result };
}

function createFakeImage(attributes = {}) {
  const store = { ...attributes };
  const image = {
    complete: true,
    get src() {
      return store.src || "";
    },
    set src(value) {
      store.src = value;
    },
    get currentSrc() {
      return store.currentSrc || store.src || "";
    },
    getAttribute(name) {
      return store[name] || "";
    },
    setAttribute(name, value) {
      store[name] = String(value);
    },
    addEventListener() {},
  };

  return image;
}

function createFakeSource(attributes = {}) {
  return {
    getAttribute(name) {
      return attributes[name] || "";
    },
  };
}

function createFakeElement({ backgroundImage = "" } = {}) {
  return {
    style: {
      backgroundImage,
    },
    computedStyle: {
      backgroundImage,
    },
  };
}

test("runner scrolls through the full document before capturing", async () => {
  const { scrolls, captureCalls, result } = await runRunner({
    bodyScrollHeight: 800,
    documentScrollHeight: 2600,
    innerHeight: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(captureCalls.length, 1);
  assert.equal(captureCalls[0].selector, "body");
  assert.ok(
    Math.max(...scrolls.map((entry) => entry.y)) >= 1600,
    "expected runner to scroll far enough to trigger lower-page lazy loading"
  );
  assert.deepEqual(scrolls.at(-1), { x: 0, y: 0 });
});

test("runner still captures when the page keeps growing during preparation", async () => {
  let height = 2600;
  const { scrolls, captureCalls, result } = await runRunner({
    bodyScrollHeight: 800,
    documentScrollHeight: () => {
      height += 1000;
      return height;
    },
    innerHeight: 1000,
    maxTimers: 70,
  });

  assert.equal(result.ok, true);
  assert.equal(captureCalls.length, 1);
  assert.ok(scrolls.length <= 60, "expected scrolling to stay bounded");
  assert.deepEqual(scrolls.at(-1), { x: 0, y: 0 });
});

test("HD mode promotes responsive images before capturing", async () => {
  const image = createFakeImage({
    src: "https://example.com/small.jpg",
    srcset: "https://example.com/small.jpg 400w, https://example.com/large.jpg 1600w",
  });

  const { result } = await runRunner({
    images: [image],
    captureOptions: { qualityMode: "hd" },
    captureResult: ({ images }) => ({ srcAtCapture: images[0].src }),
  });

  assert.equal(result.srcAtCapture, "https://example.com/large.jpg");
});

test("HD mode promotes common lazy image attributes before capturing", async () => {
  const image = createFakeImage({
    src: "https://example.com/placeholder.gif",
    "data-src": "https://example.com/photo-large.jpg",
  });

  const { result } = await runRunner({
    images: [image],
    captureOptions: { qualityMode: "hd" },
    captureResult: ({ images }) => ({ srcAtCapture: images[0].src }),
  });

  assert.equal(result.srcAtCapture, "https://example.com/photo-large.jpg");
});

test("HD mode promotes picture source candidates before capturing", async () => {
  const source = createFakeSource({
    srcset: "https://example.com/card-small.webp 480w, https://example.com/card-large.webp 1800w",
  });
  const image = createFakeImage({
    src: "https://example.com/card-fallback.jpg",
  });
  image.parentElement = {
    tagName: "PICTURE",
    querySelectorAll(selector) {
      return selector === "source" ? [source] : [];
    },
  };

  const { result } = await runRunner({
    images: [image],
    captureOptions: { qualityMode: "hd" },
    captureResult: ({ images }) => ({ srcAtCapture: images[0].src }),
  });

  assert.equal(result.srcAtCapture, "https://example.com/card-large.webp");
});

test("HD mode promotes CSS image-set backgrounds before capturing", async () => {
  const hero = createFakeElement({
    backgroundImage:
      'image-set(url("https://example.com/hero-small.jpg") 1x, url("https://example.com/hero-large.jpg") 2x)',
  });

  const { result } = await runRunner({
    elements: [hero],
    captureOptions: { qualityMode: "hd" },
    captureResult: () => ({ backgroundAtCapture: hero.style.backgroundImage }),
  });

  assert.equal(result.backgroundAtCapture, 'url("https://example.com/hero-large.jpg")');
});

test("standard mode keeps image sources unchanged before capturing", async () => {
  const image = createFakeImage({
    src: "https://example.com/small.jpg",
    srcset: "https://example.com/small.jpg 400w, https://example.com/large.jpg 1600w",
  });

  const { result } = await runRunner({
    images: [image],
    captureOptions: { qualityMode: "standard" },
    captureResult: ({ images }) => ({ srcAtCapture: images[0].src }),
  });

  assert.equal(result.srcAtCapture, "https://example.com/small.jpg");
});

test("runner reports preparation progress before capturing", async () => {
  const { progressEvents } = await runRunner({
    images: [createFakeImage({ src: "https://example.com/photo.jpg" })],
  });
  const stages = progressEvents.map((event) => event.stage);

  assert.ok(stages.includes("preparing"));
  assert.ok(stages.includes("loading-images"));
  assert.ok(stages.includes("capturing"));
});

test("runner captures the requested selector", async () => {
  const { captureCalls } = await runRunner({
    captureOptions: { selector: "#pricing-card" },
  });

  assert.equal(captureCalls.length, 1);
  assert.equal(captureCalls[0].selector, "#pricing-card");
});

test("runner prefers the Web to Figma scene capture when it is available", async () => {
  const { captureCalls, result } = await runRunner({
    captureOptions: { selector: "#hero", qualityMode: "standard" },
    sceneCaptureResult: ({ selector }) => ({
      version: 1,
      root: { kind: "frame", name: selector, rect: { x: 0, y: 0, width: 100, height: 80 } },
    }),
  });

  assert.equal(captureCalls.length, 1);
  assert.equal(captureCalls[0].sceneCapture, true);
  assert.equal(captureCalls[0].selector, "#hero");
  assert.equal(result.root.name, "#hero");
});

test("runner hides extension UI while capturing and restores it after", async () => {
  const toolbar = {
    style: {
      display: "block",
      visibility: "visible",
      pointerEvents: "auto",
    },
  };

  const { result } = await runRunner({
    ignoredElements: [toolbar],
    captureResult: () => ({
      displayAtCapture: toolbar.style.display,
      visibilityAtCapture: toolbar.style.visibility,
      pointerEventsAtCapture: toolbar.style.pointerEvents,
    }),
  });

  assert.equal(result.displayAtCapture, "none");
  assert.equal(result.visibilityAtCapture, "hidden");
  assert.equal(result.pointerEventsAtCapture, "none");
  assert.equal(toolbar.style.display, "block");
  assert.equal(toolbar.style.visibility, "visible");
  assert.equal(toolbar.style.pointerEvents, "auto");
});
