import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFixedShellOverlaps } from "../../chrome-extension/src/core/app-shell-normalizer.mjs";

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixedFrame(name, rect, children = []) {
  return {
    kind: "frame",
    name,
    rect,
    absoluteRect: { ...rect },
    style: { position: "fixed", zIndex: "10", backgroundColor: "rgba(0, 0, 0, 0)" },
    design: { absoluteRect: { ...rect } },
    children,
  };
}

test("fixed side shells are moved below overlapping fixed top shells", () => {
  const scene = {
    version: 1,
    root: {
      kind: "frame",
      name: "Body",
      rect: { x: 0, y: 0, width: 1200, height: 1800 },
      children: [
        fixedFrame("Top app bar", { x: 0, y: 0, width: 1200, height: 64 }, [
          {
            kind: "svg",
            name: "Logo",
            rect: { x: 40, y: 20, width: 96, height: 24 },
            svg: "<svg />",
          },
        ]),
        fixedFrame("Left navigation rail", { x: 0, y: 0, width: 240, height: 900 }, [
          {
            kind: "text",
            name: "Home label",
            text: "Home",
            rect: { x: 72, y: 18, width: 48, height: 20 },
          },
          {
            kind: "text",
            name: "Subscriptions label",
            text: "Subscriptions",
            rect: { x: 72, y: 88, width: 120, height: 20 },
          },
        ]),
      ],
    },
  };

  const result = normalizeFixedShellOverlaps(scene);
  const sidebar = scene.root.children[1];

  assert.equal(result.adjusted, 1);
  assert.deepEqual(plain(scene.root.children[0].rect), { x: 0, y: 0, width: 1200, height: 64 });
  assert.deepEqual(plain(sidebar.rect), { x: 0, y: 64, width: 240, height: 836 });
  assert.deepEqual(plain(sidebar.absoluteRect), sidebar.rect);
  assert.deepEqual(
    plain(sidebar.children.map((node) => [node.name, node.rect.y])),
    [
      ["Home label", 82],
      ["Subscriptions label", 152],
    ]
  );
  assert.equal(scene.capture.normalizedFixedShells.strategy, "avoid-overlapping-fixed-top-and-side-shells");
});

test("fixed side shells are not moved when the top shell starts after the rail", () => {
  const scene = {
    version: 1,
    root: {
      kind: "frame",
      name: "Body",
      rect: { x: 0, y: 0, width: 1200, height: 1200 },
      children: [
        fixedFrame("Left navigation rail", { x: 0, y: 0, width: 240, height: 900 }, [
          {
            kind: "text",
            name: "Home label",
            text: "Home",
            rect: { x: 72, y: 18, width: 48, height: 20 },
          },
        ]),
        fixedFrame("Content top bar", { x: 240, y: 0, width: 960, height: 64 }, [
          {
            kind: "text",
            name: "Search",
            text: "Search",
            rect: { x: 300, y: 20, width: 160, height: 20 },
          },
        ]),
      ],
    },
  };

  const result = normalizeFixedShellOverlaps(scene);

  assert.equal(result.adjusted, 0);
  assert.deepEqual(plain(scene.root.children[0].rect), { x: 0, y: 0, width: 240, height: 900 });
  assert.equal(scene.capture, undefined);
});

test("inset fixed top shells are moved below overlapping full-width top shells", () => {
  const scene = {
    version: 1,
    root: {
      kind: "frame",
      name: "Body",
      rect: { x: 0, y: 0, width: 1200, height: 1600 },
      children: [
        fixedFrame("Primary top app bar", { x: 0, y: 0, width: 1200, height: 64 }, [
          {
            kind: "text",
            name: "Search field",
            text: "Search",
            rect: { x: 420, y: 20, width: 220, height: 24 },
          },
        ]),
        fixedFrame("Content filter chips", { x: 240, y: 0, width: 960, height: 56 }, [
          {
            kind: "text",
            name: "All chip",
            text: "All",
            rect: { x: 264, y: 18, width: 40, height: 20 },
          },
        ]),
      ],
    },
  };

  const result = normalizeFixedShellOverlaps(scene);
  const chips = scene.root.children[1];

  assert.equal(result.adjusted, 1);
  assert.deepEqual(plain(chips.rect), { x: 240, y: 64, width: 960, height: 56 });
  assert.deepEqual(plain(chips.absoluteRect), chips.rect);
  assert.deepEqual(plain(chips.children[0].rect), { x: 264, y: 82, width: 40, height: 20 });
});

test("inset fixed top shells are not moved when the full-width wrapper has no visible overlap content", () => {
  const scene = {
    version: 1,
    root: {
      kind: "frame",
      name: "Body",
      rect: { x: 0, y: 0, width: 1200, height: 1600 },
      children: [
        fixedFrame("Transparent primary top wrapper", { x: 0, y: 0, width: 1200, height: 64 }, [
          {
            kind: "text",
            name: "Left-only logo",
            text: "Logo",
            rect: { x: 24, y: 20, width: 80, height: 24 },
          },
        ]),
        fixedFrame("Content filter chips", { x: 240, y: 0, width: 960, height: 56 }, [
          {
            kind: "text",
            name: "All chip",
            text: "All",
            rect: { x: 264, y: 18, width: 40, height: 20 },
          },
        ]),
      ],
    },
  };

  const result = normalizeFixedShellOverlaps(scene);

  assert.equal(result.adjusted, 0);
  assert.deepEqual(plain(scene.root.children[1].rect), { x: 240, y: 0, width: 960, height: 56 });
});

test("transparent fixed top wrappers without visible overlap content do not move side shells", () => {
  const scene = {
    version: 1,
    root: {
      kind: "frame",
      name: "Body",
      rect: { x: 0, y: 0, width: 1200, height: 1200 },
      children: [
        fixedFrame("Transparent full-width wrapper", { x: 0, y: 0, width: 1200, height: 96 }, [
          {
            kind: "text",
            name: "Search",
            text: "Search",
            rect: { x: 420, y: 20, width: 160, height: 20 },
          },
        ]),
        fixedFrame("Left navigation rail", { x: 0, y: 0, width: 240, height: 900 }, [
          {
            kind: "text",
            name: "Home label",
            text: "Home",
            rect: { x: 72, y: 18, width: 48, height: 20 },
          },
        ]),
      ],
    },
  };

  const result = normalizeFixedShellOverlaps(scene);

  assert.equal(result.adjusted, 0);
  assert.deepEqual(plain(scene.root.children[1].rect), { x: 0, y: 0, width: 240, height: 900 });
});
