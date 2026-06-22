import { createHash } from "node:crypto";

import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { z } from "zod";

import type { Authenticator } from "./auth/authenticator.js";
import type { ApiConfig } from "./config.js";
import {
  ConversionJobError,
  QuotaExceededError,
  type ConversionJobRepository,
  type PackageStorage,
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
  targetInstallationId: z.string().uuid(),
  scenePackageVersion: z.number().int().min(1).max(100).optional(),
});

const paramsWithJobIdSchema = z.object({ jobId: z.string().uuid() });

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

function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function mapConversionError(error: unknown) {
  if (error instanceof QuotaExceededError) {
    return { status: 402, body: errorBody("QUOTA_EXCEEDED", "Free weekly quota has been used") };
  }
  if (error instanceof ConversionJobError) {
    const status = error.code === "TARGET_INSTALLATION_NOT_FOUND" || error.code === "JOB_NOT_FOUND" ? 404 : 409;
    return { status, body: errorBody(error.code, error.message) };
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
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
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
  }

  if (dependencies.deviceConnections && dependencies.conversionJobs && dependencies.packageStorage) {
    const conversionJobs = dependencies.conversionJobs;
    const packageStorage = dependencies.packageStorage;
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

      try {
        const job = await conversionJobs.createUploadJob({
          principal,
          targetInstallationId: parsed.data.targetInstallationId,
          idempotencyKey: idempotencyKey.trim(),
          scenePackageVersion: parsed.data.scenePackageVersion ?? null,
          now: new Date(),
          ttlSeconds: dependencies.config.conversions.jobTtlSeconds,
        });
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

    api.put("/v1/conversion-jobs/:jobId/package", async (request, reply) => {
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
        const job = await conversionJobs.markUploadComplete({
          principal,
          jobId: params.data.jobId,
          packageSizeBytes: request.body.length,
          packageSha256: sha256Hex(request.body),
          now: new Date(),
        });
        await packageStorage.write(job.objectKey, request.body);
        return reply.code(200).send({ taskId: job.id, status: job.status, packageSha256: job.packageSha256 });
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
      return reply.code(200).send({ jobs });
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

    api.post("/v1/conversion-jobs/:jobId/imported", async (request, reply) => {
      const principal = await requireDevicePrincipal(deviceAuth, request.headers.authorization, "figma_plugin");
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Figma plugin token required"));
      const params = paramsWithJobIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid task id"));
      const job = await conversionJobs.markImported({ principal, jobId: params.data.jobId, now: new Date() });
      await packageStorage.remove(job.objectKey);
      return reply.code(200).send({ taskId: job.id, status: job.status });
    });

    api.post("/v1/conversion-jobs/:jobId/failed", async (request, reply) => {
      const principal = await requireDevicePrincipal(deviceAuth, request.headers.authorization, "figma_plugin");
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Figma plugin token required"));
      const params = paramsWithJobIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid task id"));
      const job = await conversionJobs.markFailed({
        principal,
        jobId: params.data.jobId,
        terminalStatus: "import_failed",
        now: new Date(),
      });
      await packageStorage.remove(job.objectKey);
      return reply.code(200).send({ taskId: job.id, status: job.status });
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
