import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Chrome extension is packaged for clipboard handoff instead of JSON downloads", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../../chrome-extension/manifest.json", import.meta.url), "utf8")
  );
  const background = fs.readFileSync(
    new URL("../../chrome-extension/src/background.js", import.meta.url),
    "utf8"
  );
  const toolbar = fs.readFileSync(
    new URL("../../chrome-extension/src/inpage-toolbar.js", import.meta.url),
    "utf8"
  );
  const popup = fs.readFileSync(
    new URL("../../chrome-extension/popup/popup.js", import.meta.url),
    "utf8"
  );
  const popupHtml = fs.readFileSync(
    new URL("../../chrome-extension/popup/popup.html", import.meta.url),
    "utf8"
  );

  assert.equal(manifest.permissions.includes("downloads"), false);
  assert.equal(manifest.permissions.includes("clipboardWrite"), true);
  assert.equal("content_scripts" in manifest, false);
  assert.equal(
    manifest.web_accessible_resources[0].resources.includes("src/scene-capture.js"),
    true
  );
  assert.equal(background.includes("chrome.downloads.download"), false);
  assert.equal(background.includes("payload"), true);
  assert.equal(background.includes("captureVisibleTab"), true);
  assert.equal(background.includes("sourceTabId"), true);
  assert.equal(background.includes("isCapturableTab"), true);
  assert.equal(background.includes("无法采集扩展页、设置页或浏览器内部页面"), true);
  assert.equal(background.includes('params.set("sourceTabId"'), true);
  assert.equal(background.includes("popup.html"), true);
  assert.equal(background.includes("screenshot-fallback"), true);
  assert.equal(background.includes("data-figma-capture-ignore"), true);
  assert.equal(toolbar.includes("已准备好导入"), true);
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
  assert.equal(toolbar.includes('class="toolbar-link hidden" id="figmaAccountBtn"'), true);
  assert.equal(popup.includes("new URLSearchParams(window.location.search).get(\"sourceTabId\")"), true);
  assert.equal(popup.includes("sourceTabId:"), true);
  assert.equal(background.includes("createCloudTaskPreview"), true);
  assert.equal(background.includes("downscalePreviewInPage"), true);
  assert.equal(background.includes("submitCaptureToCloud(payload, msg.targetInstallationId || null, tab, previewImageDataUrl)"), true);
  assert.equal(background.includes("WEB_TO_FIGMA_CLOUD_CONNECTION_APPROVED"), true);
  assert.equal(background.includes("returnToCloudConnectionSource"), true);
  assert.equal(background.includes("const CLOUD_HANDOFF_ENABLED = false"), true);
  assert.equal(popup.includes("const CLOUD_SYNC_ENABLED = false"), true);
  assert.equal(popupHtml.includes('data-disabled-feature="remote-handoff" hidden aria-hidden="true"'), true);
  assert.equal(popupHtml.includes("不需要登录或配置 API"), true);
});

test("Figma plugin UI stays focused on import progress without commercial/report panels", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../../figma-plugin/manifest.json", import.meta.url), "utf8")
  );
  const ui = fs.readFileSync(new URL("../../figma-plugin/ui/index.html", import.meta.url), "utf8");
  const forbidden = ["Upgrade", "Pro", "credit", "quota", "report", "node count", "diagnostic"];

  assert.deepEqual(manifest.editorType, ["figma"]);
  assert.equal(manifest.main, "src/importer.js");
  assert.equal(manifest.ui, "ui/index.html");
  assert.deepEqual(manifest.networkAccess, { allowedDomains: ["none"] });
  assert.equal(ui.includes("导入最近捕获"), true);
  assert.equal(ui.includes('class="local-flow" aria-label="本地导入流程"'), true);
  assert.equal(ui.includes("const CLOUD_SYNC_ENABLED = false"), true);
  assert.equal(ui.includes('value="https://web-to-figmaapi-production.up.railway.app"'), true);
  assert.equal(ui.includes("Account connection · dev"), false);
  assert.equal(ui.includes("clientType: \"figma_plugin\""), true);
  assert.equal(ui.includes("manualCaptureInput"), true);
  assert.equal(ui.includes("Figma 无法直接读取剪贴板"), true);
  assert.equal(ui.includes('window.addEventListener("paste"'), true);
  assert.equal(ui.includes("tryImportCaptureText"), true);
  assert.equal(ui.includes("打开网页"), true);
  assert.equal(ui.includes("cloudTaskGrid"), true);
  assert.equal(ui.includes("cloud-task-card"), true);
  assert.equal(ui.includes("previewImageDataUrl"), true);
  assert.equal(ui.includes("downloadJson"), true);
  assert.equal(ui.includes("hasSubtleCrypto"), true);
  assert.equal(ui.includes("取消导入"), true);
  assert.equal(ui.includes("未完成的图层已从 Figma 中移除"), true);
  assert.equal(ui.includes("Partial layers were kept in Figma."), false);
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

test("release packaging stages both local apps", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  );
  const chromePackager = fs.readFileSync(
    new URL("../../scripts/package-extension.mjs", import.meta.url),
    "utf8"
  );
  const figmaPackager = fs.readFileSync(
    new URL("../../scripts/package-figma-plugin.mjs", import.meta.url),
    "utf8"
  );

  assert.equal(packageJson.version, "1.0.0");
  assert.equal(packageJson.scripts["package:figma"], "node scripts/package-figma-plugin.mjs");
  assert.equal(
    packageJson.scripts["package:all"],
    "npm run package:extension && npm run package:figma"
  );
  assert.equal(chromePackager.includes('"connection-complete-bridge.js"'), true);
  assert.equal(figmaPackager.includes('path.join(rootDirectory, "figma-plugin")'), true);
});

test("Figma plugin main script avoids syntax unsupported by Figma's plugin parser", () => {
  const main = fs.readFileSync(
    new URL("../../figma-plugin/src/importer.js", import.meta.url),
    "utf8"
  );

  assert.equal(/\?\.|\?\?/.test(main), false, "Figma main script must not use optional chaining or ??");
  assert.equal(/\{\s*\.\.\.|\.\.\.[A-Za-z_$]/.test(main), false, "Figma main script must not use object spread/rest");
  assert.equal(/\bcatch\s*\{/.test(main), false, "Figma main script must not use optional catch binding");
  assert.equal(/\bglobalThis\b|\bmatchAll\s*\(/.test(main), false, "Figma main script must avoid newer runtime globals");
  assert.equal(main.includes("figmaApi.openExternal"), true);
  assert.equal(main.includes("figmaApi.clientStorage"), true);
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
