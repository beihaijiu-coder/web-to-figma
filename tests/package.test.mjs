import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Chrome extension is packaged for clipboard handoff instead of JSON downloads", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const background = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");

  assert.equal(manifest.permissions.includes("downloads"), false);
  assert.equal(manifest.permissions.includes("clipboardWrite"), true);
  assert.equal(
    manifest.web_accessible_resources[0].resources.includes("scene-capture.js"),
    true
  );
  assert.equal(background.includes("chrome.downloads.download"), false);
  assert.equal(background.includes("payload"), true);
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
  assert.equal(ui.includes("Open URL in Chrome"), true);
  assert.equal(ui.includes("Cancel"), true);
  for (const word of forbidden) {
    const pattern = new RegExp(`\\b${word.replace(/\s+/g, "\\s+")}\\b`, "i");
    assert.equal(pattern.test(ui), false, `UI should not contain ${word}`);
  }
});

test("Figma plugin main script avoids syntax unsupported by Figma's plugin parser", () => {
  const main = fs.readFileSync(new URL("../figma-plugin/importer.js", import.meta.url), "utf8");

  assert.equal(/\?\.|\?\?/.test(main), false, "Figma main script must not use optional chaining or ??");
  assert.equal(/\{\s*\.\.\.|\.\.\.[A-Za-z_$]/.test(main), false, "Figma main script must not use object spread/rest");
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
