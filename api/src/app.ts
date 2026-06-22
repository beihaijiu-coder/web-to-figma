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
    async function removeStoredPackage(objectKey: string): Promise<void> {
      try {
        await packageStorage.remove(objectKey);
        await conversionJobs.markPackageRemoved({ objectKey, now: new Date() });
      } catch (error) {
        api.log.warn({ err: error }, "conversion package cleanup deferred");
      }
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

      try {
        const job = await conversionJobs.createUploadJob({
          principal,
          targetInstallationId: parsed.data.targetInstallationId,
          idempotencyKey: idempotencyKey.trim(),
          scenePackageVersion: parsed.data.scenePackageVersion ?? null,
          packageEncryptionKey: parsed.data.packageEncryptionKey,
          now: new Date(),
          ttlSeconds: dependencies.config.conversions.jobTtlSeconds,
          maxActiveJobs: dependencies.config.conversions.maxActiveJobs,
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
          return reply.code(200).send({ taskId: job.id, status: job.status, packageSha256: job.packageSha256 });
        } catch (error) {
          await conversionJobs.markSourceFailed({ principal, jobId: uploadJob.id, now: new Date() }).catch(() => undefined);
          await removeStoredPackage(uploadJob.objectKey);
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
        await removeStoredPackage(job.objectKey);
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
      return reply.code(200).send({
        jobs: jobs.map((job) => ({
          id: job.id,
          status: job.status,
          expiresAt: job.expiresAt,
          scenePackageVersion: job.scenePackageVersion,
          packageSizeBytes: job.packageSizeBytes,
          packageSha256: job.packageSha256,
          createdAt: job.createdAt,
        })),
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

    api.post("/v1/conversion-jobs/:jobId/imported", async (request, reply) => {
      const principal = await requireDevicePrincipal(deviceAuth, request.headers.authorization, "figma_plugin");
      if (!principal) return reply.code(401).send(errorBody("UNAUTHORIZED", "Figma plugin token required"));
      const params = paramsWithJobIdSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send(errorBody("INVALID_REQUEST", "Invalid task id"));
      try {
        const job = await conversionJobs.markImported({ principal, jobId: params.data.jobId, now: new Date() });
        await removeStoredPackage(job.objectKey);
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
        await removeStoredPackage(job.objectKey);
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
        await removeStoredPackage(job.objectKey);
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
