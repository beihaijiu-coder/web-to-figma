import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { ApiConfig } from "../config.js";
import type { PackageStorage } from "../conversions/conversion-jobs.js";

export class R2PackageStorage implements PackageStorage {
  readonly #bucketName: string;
  readonly #client: S3Client;

  constructor(config: ApiConfig["r2"], client?: S3Client) {
    this.#bucketName = config.bucketName;
    this.#client =
      client ??
      new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
  }

  async write(objectKey: string, body: Buffer): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucketName,
        Key: objectKey,
        Body: body,
        ContentType: "application/octet-stream",
        CacheControl: "private, no-store",
      })
    );
  }

  async read(objectKey: string): Promise<Buffer> {
    const result = await this.#client.send(
      new GetObjectCommand({
        Bucket: this.#bucketName,
        Key: objectKey,
      })
    );
    if (!result.Body) throw new Error("R2 package object has no body");
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async remove(objectKey: string): Promise<void> {
    await this.#client.send(
      new DeleteObjectCommand({
        Bucket: this.#bucketName,
        Key: objectKey,
      })
    );
  }
}
