import assert from "node:assert/strict";
import test from "node:test";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

import { R2PackageStorage } from "../src/storage/r2-package-storage.js";

test("R2 package storage writes, reads, and removes private encrypted packages", async () => {
  const commands: unknown[] = [];
  const body = Buffer.from("encrypted-package");
  const client = {
    async send(command: unknown) {
      commands.push(command);
      if (command instanceof GetObjectCommand) {
        return {
          Body: {
            async transformToByteArray() {
              return new Uint8Array(body);
            },
          },
        };
      }
      return {};
    },
  } as unknown as S3Client;
  const storage = new R2PackageStorage(
    {
      accountId: "account",
      accessKeyId: "access",
      secretAccessKey: "secret",
      bucketName: "web-to-figma-test",
      endpoint: "https://account.r2.cloudflarestorage.com",
      region: "auto",
    },
    client
  );
  const objectKey = "conversion-jobs/job-id/scene-package.w2f";

  await storage.write(objectKey, body);
  assert.deepEqual(await storage.read(objectKey), body);
  await storage.remove(objectKey);

  assert.equal(commands.length, 3);
  assert(commands[0] instanceof PutObjectCommand);
  assert.equal(commands[0].input.Bucket, "web-to-figma-test");
  assert.equal(commands[0].input.Key, objectKey);
  assert.equal(commands[0].input.ContentType, "application/octet-stream");
  assert.equal(commands[0].input.CacheControl, "private, no-store");
  assert(commands[1] instanceof GetObjectCommand);
  assert(commands[2] instanceof DeleteObjectCommand);
});
