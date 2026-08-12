import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const runFile = promisify(execFile);
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(rootDirectory, "dist");
const releaseDirectory = path.join(distDirectory, "release");

const packageJson = JSON.parse(await readFile(path.join(rootDirectory, "package.json"), "utf8"));
const chromeManifest = JSON.parse(
  await readFile(path.join(distDirectory, "chrome-extension", "manifest.json"), "utf8")
);

if (packageJson.version !== chromeManifest.version) {
  throw new Error(
    `Release version mismatch: package.json is ${packageJson.version}, Chrome manifest is ${chromeManifest.version}`
  );
}

const archives = [
  {
    name: `web-to-figma-chrome-v${packageJson.version}.zip`,
    sourceDirectory: path.join(distDirectory, "chrome-extension"),
  },
  {
    name: `web-to-figma-figma-v${packageJson.version}.zip`,
    sourceDirectory: path.join(distDirectory, "figma-plugin"),
  },
];

await rm(releaseDirectory, { force: true, recursive: true });
await mkdir(releaseDirectory, { recursive: true });

const checksums = [];
for (const archive of archives) {
  const sourceStats = await stat(archive.sourceDirectory);
  if (!sourceStats.isDirectory()) {
    throw new Error(`Release source is not a directory: ${archive.sourceDirectory}`);
  }

  const outputPath = path.join(releaseDirectory, archive.name);
  try {
    await runFile(
      "zip",
      ["-q", "-r", "-X", outputPath, ".", "-x", "*.DS_Store", "__MACOSX/*"],
      { cwd: archive.sourceDirectory }
    );
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error("The release packager requires the zip command to be installed.");
    }
    throw error;
  }

  const bytes = await readFile(outputPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  checksums.push(`${digest}  ${archive.name}`);
}

await writeFile(path.join(releaseDirectory, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`, "utf8");

console.log(`Versioned release packages staged at: ${releaseDirectory}`);
