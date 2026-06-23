import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { ApiConfig } from "../config.js";
import type { PreviewContentType, PreviewStorage } from "../conversions/conversion-jobs.js";

const supportedContentTypes = new Set<PreviewContentType>(["image/jpeg", "image/png", "image/webp"]);

export class R2PreviewStorage implements PreviewStorage {
  readonly #bucketName: string;
  readonly #client: S3Client;

  constructor(config: ApiConfig["r2"]) {
    this.#bucketName = config.bucketName;
    this.#client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async write(objectKey: string, body: Buffer, contentType: PreviewContentType): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucketName,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
        CacheControl: "private, max-age=300",
      })
    );
  }

  async read(objectKey: string): Promise<{ body: Buffer; contentType: PreviewContentType }> {
    const result = await this.#client.send(
      new GetObjectCommand({
        Bucket: this.#bucketName,
        Key: objectKey,
      })
    );
    if (!result.Body) throw new Error("R2 preview object has no body");
    const contentType = result.ContentType as PreviewContentType | undefined;
    if (!contentType || !supportedContentTypes.has(contentType)) {
      throw new Error("R2 preview object has an unsupported content type");
    }
    return {
      body: Buffer.from(await result.Body.transformToByteArray()),
      contentType,
    };
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
