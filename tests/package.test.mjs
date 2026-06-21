import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Chrome extension is packaged for clipboard handoff instead of JSON downloads", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const background = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
  const toolbar = fs.readFileSync(new URL("../inpage-toolbar.js", import.meta.url), "utf8");

  assert.equal(manifest.permissions.includes("downloads"), false);
  assert.equal(manifest.permissions.includes("clipboardWrite"), true);
  assert.equal(
    manifest.web_accessible_resources[0].resources.includes("scene-capture.js"),
    true
  );
  assert.equal(background.includes("chrome.downloads.download"), false);
  assert.equal(background.includes("payload"), true);
  assert.equal(background.includes("captureVisibleTab"), true);
  assert.equal(background.includes("screenshot-fallback"), true);
  assert.equal(background.includes("data-figma-capture-ignore"), true);
  assert.equal(toolbar.includes("Copy to clipboard"), true);
  assert.equal(toolbar.includes("figmaCopyBtn"), true);
  assert.equal(toolbar.includes("figmaCopyJsonBtn"), true);
  assert.equal(toolbar.includes("figmaStopScrollBtn"), true);
  assert.equal(toolbar.includes("停止滚动并生成"), true);
  assert.equal(toolbar.includes("__FIGMA_CAPTURE_STOP_SCROLL_REQUESTED__"), true);
  assert.equal(toolbar.includes("figmaContinueFlowBtn"), true);
  assert.equal(toolbar.includes("scroll-stopped"), true);
  assert.equal(toolbar.includes("continuous-content"), true);
  assert.equal(toolbar.includes("sceneToSvg"), true);
  assert.equal(toolbar.includes("copyCanvasSvgForFigma"), true);
  assert.equal(toolbar.includes("image/svg+xml"), true);
  assert.equal(toolbar.includes("copyPayloadForFigma(pendingCopyPayload)"), true);
});

test("Figma plugin UI stays focused on import progress without commercial/report panels", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../figma-plugin/manifest.json", import.meta.url), "utf8")
  );
  const ui = fs.readFileSync(new URL("../figma-plugin/ui.html", import.meta.url), "utf8");
  const forbidden = ["Upgrade", "Pro", "credit", "quota", "report", "node count", "diagnostic"];

  assert.deepEqual(manifest.editorType, ["figma"]);
  assert.equal(manifest.main, "importer.js");
  assert.equal(manifest.ui, "ui.html");
  assert.equal(ui.includes("Import clipboard capture"), true);
  assert.equal(ui.includes("manualCaptureInput"), true);
  assert.equal(ui.includes("Figma cannot read the clipboard directly"), true);
  assert.equal(ui.includes('window.addEventListener("paste"'), true);
  assert.equal(ui.includes("tryImportCaptureText"), true);
  assert.equal(ui.includes("Open URL in Chrome"), true);
  assert.equal(ui.includes("Cancel"), true);
  assert.equal((ui.match(/id="fallbackFont"/g) || []).length, 1);
  assert.equal((ui.match(/id="overflowMode"/g) || []).length, 1);
  assert.equal(ui.includes('value="preserve"'), true);
  assert.equal(ui.includes('value="sidecar"'), true);
  assert.equal(ui.includes('value="show"'), true);
  for (const word of forbidden) {
    const pattern = new RegExp(`\\b${word.replace(/\s+/g, "\\s+")}\\b`, "i");
    assert.equal(pattern.test(ui), false, `UI should not contain ${word}`);
  }
});

test("Figma plugin main script avoids syntax unsupported by Figma's plugin parser", () => {
  const main = fs.readFileSync(new URL("../figma-plugin/importer.js", import.meta.url), "utf8");

  assert.equal(/\?\.|\?\?/.test(main), false, "Figma main script must not use optional chaining or ??");
  assert.equal(/\{\s*\.\.\.|\.\.\.[A-Za-z_$]/.test(main), false, "Figma main script must not use object spread/rest");
  assert.equal(/\bcatch\s*\{/.test(main), false, "Figma main script must not use optional catch binding");
  assert.equal(/\bglobalThis\b|\bmatchAll\s*\(/.test(main), false, "Figma main script must avoid newer runtime globals");
});

test("manual smoke fixture exercises the first commercial conversion path", () => {
  const fixture = fs.readFileSync(new URL("../fixtures/manual-smoke.html", import.meta.url), "utf8");

  for (const marker of [
    "id=\"pricing-card\"",
    "id=\"background-card\"",
    "<canvas",
    "<svg",
    "<img",
    "contenteditable=\"true\"",
  ]) {
    assert.equal(fixture.includes(marker), true, `fixture should contain ${marker}`);
  }
});
