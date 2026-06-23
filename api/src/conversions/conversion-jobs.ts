import { randomUUID } from "node:crypto";

import type { DevicePrincipal } from "../device/device-connection.js";
import {
  FREE_WEEKLY_CONVERSION_LIMIT,
  startOfUtcProductWeek,
  type Plan,
} from "../domain/current-user.js";

export type ConversionJobStatus =
  | "created"
  | "quota_reserved"
  | "upload_issued"
  | "uploaded"
  | "claimed"
  | "importing"
  | "imported"
  | "cancelled"
  | "capture_failed"
  | "upload_expired"
  | "import_failed"
  | "expired";

export type ConversionJobSummary = {
  id: string;
  status: ConversionJobStatus;
  objectKey: string;
  expiresAt: string;
  targetInstallationId: string | null;
  scenePackageVersion: number | null;
  packageSizeBytes: number | null;
  packageSha256: string | null;
  packageEncryptionKey: string;
  packageEncryptionAlgorithm: "A256GCM";
  createdAt: string;
};

export class QuotaExceededError extends Error {
  constructor() {
    super("Weekly Free quota exceeded");
    this.name = "QuotaExceededError";
  }
}

export class ConversionJobError extends Error {
  readonly code:
    | "TARGET_INSTALLATION_NOT_FOUND"
    | "JOB_NOT_FOUND"
    | "JOB_NOT_READY"
    | "JOB_ALREADY_FINAL"
    | "ACTIVE_JOB_LIMIT_REACHED"
    | "IDEMPOTENCY_CONFLICT";

  constructor(code: ConversionJobError["code"]) {
    super(code);
    this.name = "ConversionJobError";
    this.code = code;
  }
}

export interface ConversionJobRepository {
  createUploadJob(input: {
    principal: DevicePrincipal;
    targetInstallationId: string | null;
    idempotencyKey: string;
    scenePackageVersion: number | null;
    packageEncryptionKey: string;
    now: Date;
    ttlSeconds: number;
    maxActiveJobs: number;
  }): Promise<ConversionJobSummary>;
  markUploadComplete(input: {
    principal: DevicePrincipal;
    jobId: string;
    packageSizeBytes: number;
    packageSha256: string;
    now: Date;
  }): Promise<ConversionJobSummary>;
  getUploadForSource(input: {
    principal: DevicePrincipal;
    jobId: string;
    now: Date;
  }): Promise<ConversionJobSummary>;
  listPendingForTarget(input: { principal: DevicePrincipal; now: Date }): Promise<ConversionJobSummary[]>;
  claimForImport(input: { principal: DevicePrincipal; jobId: string; now: Date }): Promise<ConversionJobSummary>;
  getPackageForTarget(input: { principal: DevicePrincipal; jobId: string; now: Date }): Promise<ConversionJobSummary>;
  markImported(input: { principal: DevicePrincipal; jobId: string; now: Date }): Promise<ConversionJobSummary>;
  markFailed(input: {
    principal: DevicePrincipal;
    jobId: string;
    terminalStatus: "import_failed" | "cancelled";
    now: Date;
  }): Promise<ConversionJobSummary>;
  markSourceFailed(input: {
    principal: DevicePrincipal;
    jobId: string;
    now: Date;
  }): Promise<ConversionJobSummary>;
  markPackageRemoved(input: { objectKey: string; now: Date }): Promise<void>;
  expireStale(now: Date): Promise<string[]>;
}

export type PackageStorage = {
  write(objectKey: string, body: Buffer): Promise<void>;
  read(objectKey: string): Promise<Buffer>;
  remove(objectKey: string): Promise<void>;
};

export function newConversionObjectKey(jobId = randomUUID()): { jobId: string; objectKey: string } {
  return { jobId, objectKey: `conversion-jobs/${jobId}/scene-package.w2f` };
}

export function freeQuotaRemaining(input: { plan: Plan; used: number; reserved: number }): number | null {
  if (input.plan === "pro") return null;
  return Math.max(0, FREE_WEEKLY_CONVERSION_LIMIT - Math.max(0, input.used) - Math.max(0, input.reserved));
}

export function productWeekDate(now: Date): string {
  return startOfUtcProductWeek(now).toISOString().slice(0, 10);
}
