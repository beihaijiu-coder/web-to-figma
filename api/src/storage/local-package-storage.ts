import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { PackageStorage } from "../conversions/conversion-jobs.js";

function safeObjectPath(rootDirectory: string, objectKey: string): string {
  if (!/^[-a-zA-Z0-9_./]+$/.test(objectKey) || objectKey.includes("..")) {
    throw new Error("Invalid object key");
  }
  const root = resolve(rootDirectory);
  const fullPath = resolve(join(root, objectKey));
  if (!fullPath.startsWith(`${root}/`)) throw new Error("Object key escapes storage root");
  return fullPath;
}

export class LocalPackageStorage implements PackageStorage {
  readonly #rootDirectory: string;

  constructor(rootDirectory: string) {
    this.#rootDirectory = rootDirectory;
  }

  async write(objectKey: string, body: Buffer): Promise<void> {
    const path = safeObjectPath(this.#rootDirectory, objectKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, { flag: "w" });
  }

  read(objectKey: string): Promise<Buffer> {
    return readFile(safeObjectPath(this.#rootDirectory, objectKey));
  }

  async remove(objectKey: string): Promise<void> {
    await rm(safeObjectPath(this.#rootDirectory, objectKey), { force: true });
  }
}
