import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(rootDirectory, "chrome-extension");
const outputDirectory = path.join(rootDirectory, "dist", "chrome-extension");

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(path.dirname(outputDirectory), { recursive: true });
await cp(sourceDirectory, outputDirectory, { recursive: true });

console.log(`Chrome extension package staged at: ${outputDirectory}`);
