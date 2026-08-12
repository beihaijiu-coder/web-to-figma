import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2] || process.env.GITHUB_REF_NAME;

if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(`Release tag must use vMAJOR.MINOR.PATCH format. Received: ${tag || "<empty>"}`);
}

const packageJson = JSON.parse(await readFile(path.join(rootDirectory, "package.json"), "utf8"));
const chromeManifest = JSON.parse(
  await readFile(path.join(rootDirectory, "chrome-extension", "manifest.json"), "utf8")
);
const expectedTag = `v${packageJson.version}`;

if (tag !== expectedTag) {
  throw new Error(`Release tag ${tag} does not match package version ${packageJson.version}.`);
}

if (chromeManifest.version !== packageJson.version) {
  throw new Error(
    `Chrome manifest version ${chromeManifest.version} does not match package version ${packageJson.version}.`
  );
}

console.log(`Release version verified: ${tag}`);
