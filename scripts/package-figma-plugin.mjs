import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(rootDirectory, "figma-plugin");
const outputDirectory = path.join(rootDirectory, "dist", "figma-plugin");

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(path.dirname(outputDirectory), { recursive: true });
await cp(sourceDirectory, outputDirectory, { recursive: true });

console.log(`Figma plugin package staged at: ${outputDirectory}`);
