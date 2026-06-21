import assert from "node:assert/strict";
import test from "node:test";

import { visibleCaptureBounds } from "../screenshot-geometry.mjs";

test("visibleCaptureBounds preserves a fully visible target", () => {
  assert.deepEqual(
    visibleCaptureBounds(
      { x: 120, y: 80, width: 300, height: 180 },
      { scrollX: 0, scrollY: 0, innerWidth: 1280, innerHeight: 720 }
    ),
    { x: 120, y: 80, width: 300, height: 180 }
  );
});

test("visibleCaptureBounds clips transformed targets to the actual viewport image", () => {
  assert.deepEqual(
    visibleCaptureBounds(
      { x: -640, y: 44, width: 3008, height: 692 },
      { scrollX: 0, scrollY: 0, innerWidth: 1697, innerHeight: 800 }
    ),
    { x: 0, y: 44, width: 1697, height: 692 }
  );
});

test("visibleCaptureBounds returns null when the target is not in the captured viewport", () => {
  assert.equal(
    visibleCaptureBounds(
      { x: 120, y: 980, width: 300, height: 180 },
      { scrollX: 0, scrollY: 0, innerWidth: 1280, innerHeight: 720 }
    ),
    null
  );
});
