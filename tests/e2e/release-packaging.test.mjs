import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const releaseDirectory = path.join(rootDirectory, "dist", "release");

function archiveEntries(archivePath) {
  return execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" })
    .trim()
    .split("\n");
}

function archiveText(archivePath, entry) {
  return execFileSync("unzip", ["-p", archivePath, entry], { encoding: "utf8" });
}

test("release packages are versioned, valid, and directly installable", { timeout: 30_000 }, () => {
  execFileSync("npm", ["run", "package:release"], {
    cwd: rootDirectory,
    encoding: "utf8",
    stdio: "pipe",
  });

  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDirectory, "package.json"), "utf8"));
  const chromeName = `web-to-figma-chrome-v${packageJson.version}.zip`;
  const figmaName = `web-to-figma-figma-v${packageJson.version}.zip`;
  const expectedNames = [chromeName, figmaName];
  const checksumLines = fs
    .readFileSync(path.join(releaseDirectory, "SHA256SUMS.txt"), "utf8")
    .trim()
    .split("\n");

  assert.equal(checksumLines.length, expectedNames.length);
  for (const line of checksumLines) {
    const [expectedDigest, name] = line.split(/\s{2}/);
    assert.equal(expectedNames.includes(name), true, `Unexpected release file: ${name}`);
    const bytes = fs.readFileSync(path.join(releaseDirectory, name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedDigest);
  }

  const chromePath = path.join(releaseDirectory, chromeName);
  const figmaPath = path.join(releaseDirectory, figmaName);
  const chromeEntries = archiveEntries(chromePath);
  const figmaEntries = archiveEntries(figmaPath);

  assert.equal(chromeEntries.includes("manifest.json"), true);
  assert.equal(chromeEntries.includes("src/connection-complete-bridge.js"), false);
  assert.equal(figmaEntries.includes("manifest.json"), true);
  assert.equal(figmaEntries.includes("src/importer.js"), true);

  const chromeManifest = JSON.parse(archiveText(chromePath, "manifest.json"));
  const figmaManifest = JSON.parse(archiveText(figmaPath, "manifest.json"));
  assert.equal(chromeManifest.version, packageJson.version);
  assert.deepEqual(figmaManifest.networkAccess, { allowedDomains: ["none"] });
});
