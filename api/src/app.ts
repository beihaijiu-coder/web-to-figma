import { createDecipheriv, createHash } from "node:crypto";

import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { z } from "zod";

import type { Authenticator } from "./auth/authenticator.js";
import type { ApiConfig } from "./config.js";
import {
  ConversionJobError,
  QuotaExceededError,
  newPreviewObjectKey,
  type ConversionJobRepository,
  type PackageStorage,
  type PreviewContentType,
  type PreviewStorage,
} from "./conversions/conversion-jobs.js";
import { CLIENT_TYPES, type DeviceConnectionService } from "./device/device-connection.js";
import type { DevicePrincipal } from "./device/device-connection.js";
import type { CurrentUserRepository } from "./domain/current-user.js";

export type ApiDependencies = {
  config: ApiConfig;
  authenticator: Authenticator;
  currentUsers: CurrentUserRepository;
  deviceConnections?: DeviceConnectionService;
  conversionJobs?: ConversionJobRepository;
  packageStorage?: PackageStorage;
  previewStorage?: PreviewStorage;
  logger?: FastifyServerOptions["logger"];
};

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

const createConnectionSchema = z.object({
  clientType: z.enum(CLIENT_TYPES),
  requestedClientName: z.string().trim().min(1).max(120).optional(),
});

const userCodeSchema = z.object({
  userCode: z.string().trim().min(3).max(32),
});

const opaqueTokenSchema = z.object({
  deviceCode: z.string().trim().min(20).max(300),
});

const refreshTokenSchema = z.object({
  refreshToken: z.string().trim().min(20).max(300),
});

const createConversionJobSchema = z.object({
  targetInstallationId: z.string().uuid().nullable().optional(),
  preview: z
    .object({
      sourceUrl: z.string().trim().max(2048).nullable().optional(),
      sourceTitle: z.string().trim().max(240).nullable().optional(),
      previewImageDataUrl: z
        .string()
        .trim()
        .max(450_000)
        .regex(/^data:image\/(?:png|jpeg|jpg|webp);base64,/)
        .nullable()
        .optional(),
    })
    .optional(),
  scenePackageVersion: z.number().int().min(1).max(100).optional(),
  packageEncryptionKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .refine((value) => Buffer.from(value, "base64url").length === 32),
});

const paramsWithJobIdSchema = z.object({ jobId: z.string().uuid() });
const paramsWithInstallationIdSchema = z.object({ installationId: z.string().uuid() });
const listInstallationsQuerySchema = z.object({
  clientType: z.enum(CLIENT_TYPES).optional(),
});

async function requireDevicePrincipal(
  deviceConnections: DeviceConnectionService,
  authorizationHeader: string | undefined,
  clientType: DevicePrincipal["clientType"]
): Promise<DevicePrincipal | null> {
  const token = authorizationHeader?.trim().match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!token) return null;
  const principal = await deviceConnections.authenticate(token);
  if (!principal || principal.clientType !== clientType) return null;
  return principal;
}

async function requireAnyDevicePrincipal(
  deviceConnections: DeviceConnectionService,
  authorizationHeader: string | undefined
): Promise<DevicePrincipal | null> {
  const token = authorizationHeader?.trim().match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!token) return null;
  return deviceConnections.authenticate(token);
}

function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function decodePreviewDataUrl(
  dataUrl: string,
  maxBytes: number
): { body: Buffer; contentType: PreviewContentType } {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new Error("Invalid preview image data URL");
  const body = Buffer.from(match[2]!, "base64");
  if (!body.length) throw new Error("Preview image is empty");
  if (body.length > maxBytes) throw new Error("Preview image exceeds the configured limit");
  const rawContentType = match[1]!;
  return {
    body,
    contentType: rawContentType === "image/jpg" ? "image/jpeg" : (rawContentType as PreviewContentType),
  };
}

function previewDataUrl(body: Buffer, contentType: PreviewContentType): string {
  return `data:${contentType};base64,${body.toString("base64")}`;
}

const SCENE_PACKAGE_MAGIC = Buffer.from([0x57, 0x32, 0x46, 0x31]);
const SCENE_PACKAGE_IV_BYTES = 12;
const SCENE_PACKAGE_AUTH_TAG_BYTES = 16;

class ScenePackageDecodeError extends Error {
  readonly code: "INVALID_SCENE_PACKAGE" | "SCENE_PACKAGE_DECRYPTION_FAILED";

  constructor(code: ScenePackageDecodeError["code"], message: string) {
    super(message);
    this.name = "ScenePackageDecodeError";
    this.code = code;
  }
}

function decryptScenePackagePayload(body: Buffer, packageEncryptionKey: string): unknown {
  const minimumLength = SCENE_PACKAGE_MAGIC.length + SCENE_PACKAGE_IV_BYTES + SCENE_PACKAGE_AUTH_TAG_BYTES + 1;
  if (body.length < minimumLength || !body.subarray(0, SCENE_PACKAGE_MAGIC.length).equals(SCENE_PACKAGE_MAGIC)) {
    throw new ScenePackageDecodeError("INVALID_SCENE_PACKAGE", "Scene package format is not supported");
  }

  const rawKey = Buffer.from(packageEncryptionKey, "base64url");
  if (rawKey.length !== 32) {
    throw new ScenePackageDecodeError("INVALID_SCENE_PACKAGE", "Scene package key is invalid");
  }

  const ivStart = SCENE_PACKAGE_MAGIC.length;
  const ivEnd = ivStart + SCENE_PACKAGE_IV_BYTES;
  const tagStart = body.length - SCENE_PACKAGE_AUTH_TAG_BYTES;
  const iv = body.subarray(ivStart, ivEnd);
  const ciphertext = body.subarray(ivEnd, tagStart);
  const authTag = body.subarray(tagStart);

  try {
    const decipher = createDecipheriv("aes-256-gcm", rawKey, iv);
    decipher.setAAD(SCENE_PACKAGE_MAGIC);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString("utf8"));
    if (parsed?.source !== "web-to-figma" || parsed?.type !== "capture-scene" || parsed.payload === undefined) {
      throw new Error("Unexpected scene package payload");
    }
    return parsed.payload;
  } catch (error) {
    if (error instanceof ScenePackageDecodeError) throw error;
    throw new ScenePackageDecodeError(
      "SCENE_PACKAGE_DECRYPTION_FAILED",
      "Scene package authentication or decoding failed"
    );
  }
}

function isCorsOriginAllowed(origin: string, allowedOrigins: Set<string>): boolean {
  if (allowedOrigins.has(origin)) return true;
  return allowedOrigins.has("chrome-extension://*") && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function mapConversionError(error: unknown) {
  if (error instanceof QuotaExceededError) {
    return { status: 402, body: errorBody("QUOTA_EXCEEDED", "Free weekly quota has been used") };
  }
  if (error instanceof ConversionJobError) {
    const status =
      error.code === "TARGET_INSTALLATION_NOT_FOUND" || error.code === "JOB_NOT_FOUND"
        ? 404
        : error.code === "ACTIVE_JOB_LIMIT_REACHED"
          ? 429
          : 409;
    return { status, body: errorBody(error.code, error.message) };
  }
  if (error instanceof ScenePackageDecodeError) {
    return { status: 422, body: errorBody(error.code, error.message) };
  }
  return null;
}

export async function createApi(dependencies: ApiDependencies): Promise<FastifyInstance> {
  const api = Fastify({
    logger: dependencies.logger ?? false,
    bodyLimit: 1_048_576,
    trustProxy: true,
    requestIdHeader: "x-request-id",
  });

  const allowedOrigins = new Set(dependencies.config.corsAllowedOrigins);
  await api.register(cors, {
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    origin(origin, callback) {
      if (!origin || isCorsOriginAllowed(origin, allowedOrigins)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed"), false);
    },
  });

  api.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    if (request.url.startsWith("/v1/")) reply.header("cache-control", "no-store");
    return payload;
  });

  api.get("/health", async () => ({
    status: "ok",
    service: "web-to-figma-api",
    version: "0.1.0",
  }));

  api.get("/", async () => ({
    status: "ok",
    service: "web-to-figma-api",
    health: "/health",
  }));

  api.get("/v1/me", async (request, reply) => {
    let identity;
    try {
      identity = await dependencies.authenticator.authenticate(request.headers.authorization);
    } catch {
      return reply.code(401).send(errorBody("UNAUTHORIZED", "Authentication required"));
    }

    if (!identity) {
      return reply.code(401).send(errorBody("UNAUTHORIZED", "Authentication required"));
    }

    const currentUser = await dependencies.currentUsers.resolveCurrentUser(identity);
    return reply.code(200).send(currentUser);
  });

  const deviceConnections = dependencies.deviceConnections;
  if (deviceConnections) {
    api.post("/v1/device-connections", async (request, reply) => {
      const parsed = createConnectionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid device connection request"));
      }
      const connection = await deviceConnections.create(parsed.data);
      return reply.code(201).send(connection);
    });

    api.post("/v1/device-connections/approve", async (request, reply) => {
      const parsed = userCodeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid user code"));
      }

      let identity;
      try {
        identity = await dependencies.authenticator.authenticate(request.headers.authorization);
      } catch {
        return reply.code(401).send(errorBody("UNAUTHORIZED", "Authentication required"));
      }
      if (!identity) return reply.code(401).send(errorBody("UNAUTHORIZED", "Authentication required"));

      const currentUser = await dependencies.currentUsers.resolveCurrentUser(identity);
      const approval = await deviceConnections.approve(parsed.data.userCode, currentUser.user.id);
      if (!approval) {
        return reply.code(410).send(errorBody("CONNECTION_UNAVAILABLE", "This connection request is unavailable"));
      }
      return reply.code(200).send(approval);
    });

    api.post("/v1/device-connections/deny", async (request, reply) => {
      const parsed = userCodeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid user code"));
      }

      let identity;
      try {
        identity = await dependencies.authenticator.authenticate(request.headers.authorization);
      } catch {
        return reply.code(401).send(errorBody("UNAUTHORIZED", "Authentication required"));
      }
      if (!identity) return reply.code(401).send(errorBody("UNAUTHORIZED", "Authentication required"));

      const currentUser = await dependencies.currentUsers.resolveCurrentUser(identity);
      const result = await deviceConnections.deny(parsed.data.userCode, currentUser.user.id);
      if (result === "not_found") {
        return reply.code(404).send(errorBody("CONNECTION_NOT_FOUND", "Connection request was not found"));
      }
      if (result === "expired") {
        return reply.code(410).send(errorBody("CONNECTION_EXPIRED", "Connection request has expired"));
      }
      return reply.code(200).send({ status: "denied" });
    });

    api.post("/v1/device-connections/token", async (request, reply) => {
      const parsed = opaqueTokenSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid device code"));
      }
      const result = await deviceConnections.poll(parsed.data.deviceCode);
      if (result === "not_found") {
        return reply.code(400).send(errorBody("INVALID_DEVICE_CODE", "Device code is invalid"));
      }
      if (result.status === "pending") return reply.code(202).send(result);
      if (result.status === "slow_down") return reply.code(429).send(result);
      if (result.status === "denied") {
        return reply.code(403).send(errorBody("CONNECTION_DENIED", "Connection request was denied"));
      }
      if (result.status === "expired") {
        return reply.code(410).send(errorBody("CONNECTION_EXPIRED", "Connection request has expired"));
      }
      if (result.status === "consumed") {
        return reply.code(409).send(errorBody("CONNECTION_CONSUMED", "Connection request was already used"));
      }
      return reply.code(200).send(result.tokens);
    });

    api.post("/v1/tokens/refresh", async (request, reply) => {
      const parsed = refreshTokenSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid refresh token"));
      }
      const result = await deviceConnections.refresh(parsed.data.refreshToken);
      if (result === "invalid") {
        return reply.code(401).send(errorBody("INVALID_REFRESH_TOKEN", "Refresh token is invalid"));
      }
      if (result === "reuse_detected") {
        return reply.code(401).send(errorBody("REFRESH_REUSE_DETECTED", "Reconnect this installation"));
      }
      return reply.code(200).send(result);
    });

    api.get("/v1/device/me", async (request, reply) => {
      const principal = await requireAnyDevicePrincipal(deviceConnections, request.headers.authorization);
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Device token required"));
      return reply.code(200).send({ installation: principal });
    });

    api.get("/v1/installations", async (request, reply) => {
      const principal = await requireAnyDevicePrincipal(deviceConnections, request.headers.authorization);
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Device token required"));

      const parsed = listInstallationsQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid installation query"));
      const installations = await deviceConnections.listInstallations({
        principal,
        clientType: parsed.data.clientType,
      });
      return reply.code(200).send({ installations });
    });

    api.delete("/v1/device/me", async (request, reply) => {
      const principal = await requireAnyDevicePrincipal(deviceConnections, request.headers.authorization);
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Device token required"));
      await deviceConnections.revokeOwnInstallation(principal);
      return reply.code(200).send({ status: "revoked" });
    });

    api.get("/v1/me/installations", async (request, reply) => {
      let identity;
      try {
        identity = await dependencies.authenticator.authenticate(request.headers.authorization);
      } catch {
        return reply.code(401).send(errorBody("UNAUTHORIZED", "Authentication required"));
      }
      if (!identity) return reply.code(401).send(errorBody("UNAUTHORIZED", "Authentication required"));
      const currentUser = await dependencies.currentUsers.resolveCurrentUser(identity);
      const installations = await deviceConnections.listUserInstallations(currentUser.user.id);
      return reply.code(200).send({ installations });
    });

    api.delete("/v1/me/installations/:installationId", async (request, reply) => {
      let identity;
      try {
        identity = await dependencies.authenticator.authenticate(request.headers.authorization);
      } catch {
        return reply.code(401).send(errorBody("UNAUTHORIZED", "Authentication required"));
      }
      if (!identity) return reply.code(401).send(errorBody("UNAUTHORIZED", "Authentication required"));
      const params = paramsWithInstallationIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid installation id"));
      const currentUser = await dependencies.currentUsers.resolveCurrentUser(identity);
      const revoked = await deviceConnections.revokeInstallation({
        userId: currentUser.user.id,
        installationId: params.data.installationId,
      });
      if (!revoked) return reply.code(404).send(errorBody("INSTALLATION_NOT_FOUND", "Installation was not found"));
      return reply.code(200).send({ status: "revoked" });
    });
  }

  if (dependencies.deviceConnections && dependencies.conversionJobs && dependencies.packageStorage) {
    const conversionJobs = dependencies.conversionJobs;
    const packageStorage = dependencies.packageStorage;
    const previewStorage = dependencies.previewStorage;
    async function removeStoredPackage(objectKey: string): Promise<void> {
      try {
        await packageStorage.remove(objectKey);
        await conversionJobs.markPackageRemoved({ objectKey, now: new Date() });
      } catch (error) {
        api.log.warn({ err: error }, "conversion package cleanup deferred");
      }
    }
    async function removeStoredPreview(previewObjectKey: string | null): Promise<void> {
      if (!previewObjectKey || !previewStorage) return;
      try {
        await previewStorage.remove(previewObjectKey);
        await conversionJobs.markPreviewRemoved({ previewObjectKey, now: new Date() });
      } catch (error) {
        api.log.warn({ err: error }, "conversion preview cleanup deferred");
      }
    }
    async function removeStoredObjects(objects: {
      packageObjectKey: string;
      previewObjectKey: string | null;
    }): Promise<void> {
      await Promise.all([
        removeStoredPackage(objects.packageObjectKey),
        removeStoredPreview(objects.previewObjectKey),
      ]);
    }
    async function pruneStoredCaptures(principal: DevicePrincipal): Promise<void> {
      const objects = await conversionJobs.storedObjectsBeyondLimit({
        principal,
        maxStoredCaptures: dependencies.config.conversions.maxStoredCaptures,
        now: new Date(),
      });
      await Promise.all(objects.map((storedObjects) => removeStoredObjects(storedObjects)));
    }
    const deviceAuth = dependencies.deviceConnections;

    api.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });

    api.post("/v1/conversion-jobs", async (request, reply) => {
      const principal = await requireDevicePrincipal(deviceAuth, request.headers.authorization, "chrome_extension");
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Chrome extension token required"));

      const parsed = createConversionJobSchema.safeParse(request.body);
      const idempotencyKey = request.headers["idempotency-key"];
      if (!parsed.success || typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid conversion job request"));
      }

      let decodedPreview: { body: Buffer; contentType: PreviewContentType } | null = null;
      if (parsed.data.preview?.previewImageDataUrl) {
        if (!previewStorage) {
          return reply.code(503).send(errorBody("PREVIEW_STORAGE_UNAVAILABLE", "Thumbnail storage is unavailable"));
        }
        try {
          decodedPreview = decodePreviewDataUrl(
            parsed.data.preview.previewImageDataUrl,
            dependencies.config.conversions.maxPreviewImageBytes
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid preview image";
          const status = message.includes("exceeds") ? 413 : 400;
          return reply.code(status).send(errorBody("INVALID_PREVIEW_IMAGE", message));
        }
      }

      try {
        let job = await conversionJobs.createUploadJob({
          principal,
          targetInstallationId: parsed.data.targetInstallationId ?? null,
          sourceUrl: parsed.data.preview?.sourceUrl || null,
          sourceTitle: parsed.data.preview?.sourceTitle || null,
          idempotencyKey: idempotencyKey.trim(),
          scenePackageVersion: parsed.data.scenePackageVersion ?? null,
          packageEncryptionKey: parsed.data.packageEncryptionKey,
          now: new Date(),
          ttlSeconds: dependencies.config.conversions.jobTtlSeconds,
          maxActiveJobs: dependencies.config.conversions.maxActiveJobs,
        });
        if (decodedPreview && previewStorage && !job.previewObjectKey) {
          const previewObjectKey = newPreviewObjectKey(job.id, decodedPreview.contentType);
          try {
            await previewStorage.write(previewObjectKey, decodedPreview.body, decodedPreview.contentType);
            job = await conversionJobs.attachPreviewObject({
              principal,
              jobId: job.id,
              previewObjectKey,
              now: new Date(),
            });
          } catch (error) {
            await previewStorage.remove(previewObjectKey).catch(() => undefined);
            await conversionJobs.markSourceFailed({ principal, jobId: job.id, now: new Date() }).catch(() => undefined);
            request.log.error({ err: error }, "thumbnail upload failed");
            return reply
              .code(503)
              .send(errorBody("PREVIEW_STORAGE_UNAVAILABLE", "Thumbnail could not be stored"));
          }
        }
        return reply.code(201).send({
          taskId: job.id,
          status: job.status,
          expiresAt: job.expiresAt,
          upload: {
            method: "PUT",
            url: `/v1/conversion-jobs/${job.id}/package`,
            contentType: "application/octet-stream",
            maxBytes: dependencies.config.conversions.maxScenePackageBytes,
          },
        });
      } catch (error) {
        const mapped = mapConversionError(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    api.put(
      "/v1/conversion-jobs/:jobId/package",
      { bodyLimit: dependencies.config.conversions.maxScenePackageBytes },
      async (request, reply) => {
      const principal = await requireDevicePrincipal(deviceAuth, request.headers.authorization, "chrome_extension");
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Chrome extension token required"));
      const params = paramsWithJobIdSchema.safeParse(request.params);
      if (!params.success || !Buffer.isBuffer(request.body)) {
        return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid package upload"));
      }
      if (request.body.length > dependencies.config.conversions.maxScenePackageBytes) {
        return reply.code(413).send(errorBody("PACKAGE_TOO_LARGE", "Scene package exceeds the configured limit"));
      }
      try {
        const packageSha256 = sha256Hex(request.body);
        const uploadJob = await conversionJobs.getUploadForSource({
          principal,
          jobId: params.data.jobId,
          now: new Date(),
        });
        if (uploadJob.status === "uploaded") {
          if (uploadJob.packageSizeBytes !== request.body.length || uploadJob.packageSha256 !== packageSha256) {
            throw new ConversionJobError("JOB_ALREADY_FINAL");
          }
          return reply.code(200).send({
            taskId: uploadJob.id,
            status: uploadJob.status,
            packageSha256: uploadJob.packageSha256,
          });
        }
        try {
          await packageStorage.write(uploadJob.objectKey, request.body);
          const job = await conversionJobs.markUploadComplete({
            principal,
            jobId: params.data.jobId,
            packageSizeBytes: request.body.length,
            packageSha256,
            now: new Date(),
          });
          await pruneStoredCaptures(principal);
          return reply.code(200).send({ taskId: job.id, status: job.status, packageSha256: job.packageSha256 });
        } catch (error) {
          await conversionJobs.markSourceFailed({ principal, jobId: uploadJob.id, now: new Date() }).catch(() => undefined);
          await removeStoredObjects({
            packageObjectKey: uploadJob.objectKey,
            previewObjectKey: uploadJob.previewObjectKey,
          });
          throw error;
        }
      } catch (error) {
        const mapped = mapConversionError(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
      }
    );

    api.post("/v1/conversion-jobs/:jobId/capture-failed", async (request, reply) => {
      const principal = await requireDevicePrincipal(deviceAuth, request.headers.authorization, "chrome_extension");
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Chrome extension token required"));
      const params = paramsWithJobIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid task id"));
      try {
        const job = await conversionJobs.markSourceFailed({ principal, jobId: params.data.jobId, now: new Date() });
        await removeStoredObjects({ packageObjectKey: job.objectKey, previewObjectKey: job.previewObjectKey });
        return reply.code(200).send({ taskId: job.id, status: job.status });
      } catch (error) {
        const mapped = mapConversionError(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    api.get("/v1/conversion-jobs/pending", async (request, reply) => {
      const principal = await requireDevicePrincipal(deviceAuth, request.headers.authorization, "figma_plugin");
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Figma plugin token required"));
      const jobs = await conversionJobs.listPendingForTarget({ principal, now: new Date() });
      const responseJobs = await Promise.all(
        jobs.map(async (job) => {
          let imageDataUrl = job.previewImageDataUrl;
          if (job.previewObjectKey && previewStorage) {
            try {
              const storedPreview = await previewStorage.read(job.previewObjectKey);
              if (storedPreview.body.length <= dependencies.config.conversions.maxPreviewImageBytes) {
                imageDataUrl = previewDataUrl(storedPreview.body, storedPreview.contentType);
              }
            } catch (error) {
              request.log.warn({ err: error, jobId: job.id }, "thumbnail read failed");
            }
          }
          return {
            id: job.id,
            status: job.status,
            expiresAt: job.expiresAt,
            sourceUrl: job.sourceUrl,
            sourceTitle: job.sourceTitle,
            previewImageDataUrl: imageDataUrl,
            scenePackageVersion: job.scenePackageVersion,
            packageSizeBytes: job.packageSizeBytes,
            packageSha256: job.packageSha256,
            createdAt: job.createdAt,
          };
        })
      );
      return reply.code(200).send({
        jobs: responseJobs,
      });
    });

    api.post("/v1/conversion-jobs/:jobId/claim", async (request, reply) => {
      const principal = await requireDevicePrincipal(deviceAuth, request.headers.authorization, "figma_plugin");
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Figma plugin token required"));
      const params = paramsWithJobIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid task id"));
      try {
        const job = await conversionJobs.claimForImport({ principal, jobId: params.data.jobId, now: new Date() });
        return reply.code(200).send({
          taskId: job.id,
          status: job.status,
          download: { method: "GET", url: `/v1/conversion-jobs/${job.id}/package` },
          downloadJson: { method: "GET", url: `/v1/conversion-jobs/${job.id}/package-json` },
          encryption: {
            algorithm: job.packageEncryptionAlgorithm,
            key: job.packageEncryptionKey,
          },
          packageSha256: job.packageSha256,
        });
      } catch (error) {
        const mapped = mapConversionError(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    api.get("/v1/conversion-jobs/:jobId/package", async (request, reply) => {
      const principal = await requireDevicePrincipal(deviceAuth, request.headers.authorization, "figma_plugin");
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Figma plugin token required"));
      const params = paramsWithJobIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid task id"));
      try {
        const job = await conversionJobs.getPackageForTarget({ principal, jobId: params.data.jobId, now: new Date() });
        const body = await packageStorage.read(job.objectKey);
        return reply
          .code(200)
          .header("content-type", "application/octet-stream")
          .header("x-scene-package-sha256", job.packageSha256 ?? "")
          .send(body);
      } catch (error) {
        const mapped = mapConversionError(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    api.get("/v1/conversion-jobs/:jobId/package-json", async (request, reply) => {
      const principal = await requireDevicePrincipal(deviceAuth, request.headers.authorization, "figma_plugin");
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Figma plugin token required"));
      const params = paramsWithJobIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid task id"));
      try {
        const job = await conversionJobs.getPackageForTarget({ principal, jobId: params.data.jobId, now: new Date() });
        const body = await packageStorage.read(job.objectKey);
        const expectedSha256 = job.packageSha256;
        if (expectedSha256 && sha256Hex(body) !== expectedSha256) {
          throw new ScenePackageDecodeError("INVALID_SCENE_PACKAGE", "Task package checksum does not match");
        }
        return reply.code(200).send({
          taskId: job.id,
          packageSha256: expectedSha256,
          payload: decryptScenePackagePayload(body, job.packageEncryptionKey),
        });
      } catch (error) {
        const mapped = mapConversionError(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    api.post("/v1/conversion-jobs/:jobId/imported", async (request, reply) => {
      const principal = await requireDevicePrincipal(deviceAuth, request.headers.authorization, "figma_plugin");
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Figma plugin token required"));
      const params = paramsWithJobIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid task id"));
      try {
        const job = await conversionJobs.markImported({ principal, jobId: params.data.jobId, now: new Date() });
        return reply.code(200).send({ taskId: job.id, status: job.status });
      } catch (error) {
        const mapped = mapConversionError(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    api.post("/v1/conversion-jobs/:jobId/failed", async (request, reply) => {
      const principal = await requireDevicePrincipal(deviceAuth, request.headers.authorization, "figma_plugin");
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Figma plugin token required"));
      const params = paramsWithJobIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid task id"));
      try {
        const job = await conversionJobs.markFailed({
          principal,
          jobId: params.data.jobId,
          terminalStatus: "import_failed",
          now: new Date(),
        });
        if (job.status === "import_failed") {
          await removeStoredObjects({ packageObjectKey: job.objectKey, previewObjectKey: job.previewObjectKey });
        }
        return reply.code(200).send({ taskId: job.id, status: job.status });
      } catch (error) {
        const mapped = mapConversionError(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });

    api.post("/v1/conversion-jobs/:jobId/cancelled", async (request, reply) => {
      const principal = await requireDevicePrincipal(deviceAuth, request.headers.authorization, "figma_plugin");
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Figma plugin token required"));
      const params = paramsWithJobIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid task id"));
      try {
        const job = await conversionJobs.markFailed({
          principal,
          jobId: params.data.jobId,
          terminalStatus: "cancelled",
          now: new Date(),
        });
        if (job.status === "cancelled") {
          await removeStoredObjects({ packageObjectKey: job.objectKey, previewObjectKey: job.previewObjectKey });
        }
        return reply.code(200).send({ taskId: job.id, status: job.status });
      } catch (error) {
        const mapped = mapConversionError(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });
  }

  api.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send(errorBody("NOT_FOUND", "Route not found"));
  });

  api.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    if (error instanceof Error && error.message === "Origin is not allowed") {
      return reply.code(403).send(errorBody("ORIGIN_NOT_ALLOWED", "Origin is not allowed"));
    }
    return reply.code(500).send(errorBody("INTERNAL_ERROR", "The request could not be completed"));
  });

  return api;
}
