import type pg from "pg";

import {
  ConversionJobError,
  QuotaExceededError,
  freeQuotaRemaining,
  newConversionObjectKey,
  productWeekDate,
  type ConversionJobRepository,
  type ConversionJobStatus,
  type ConversionJobSummary,
} from "../conversions/conversion-jobs.js";
import type { DevicePrincipal } from "../device/device-connection.js";
import { effectivePlan, type Plan, type SubscriptionStatus } from "../domain/current-user.js";

type JobRow = {
  id: string;
  status: ConversionJobStatus;
  object_key: string | null;
  expires_at: Date;
  target_installation_id: string | null;
  source_url: string | null;
  source_title: string | null;
  preview_image_data_url: string | null;
  scene_package_version: number | null;
  package_size_bytes: string | null;
  package_sha256: string | null;
  package_encryption_key: string;
  package_encryption_algorithm: "A256GCM";
  created_at: Date;
};

type EntitlementRow = {
  plan: Plan;
  used: string;
  reserved: string;
};

function jobSummary(row: JobRow): ConversionJobSummary {
  if (!row.object_key) throw new Error("Conversion job row is incomplete");
  if (!row.package_encryption_key || row.package_encryption_algorithm !== "A256GCM") {
    throw new Error("Conversion job encryption metadata is incomplete");
  }
  return {
    id: row.id,
    status: row.status,
    objectKey: row.object_key,
    expiresAt: row.expires_at.toISOString(),
    targetInstallationId: row.target_installation_id,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    previewImageDataUrl: row.preview_image_data_url,
    scenePackageVersion: row.scene_package_version,
    packageSizeBytes: row.package_size_bytes === null ? null : Number(row.package_size_bytes),
    packageSha256: row.package_sha256,
    packageEncryptionKey: row.package_encryption_key,
    packageEncryptionAlgorithm: row.package_encryption_algorithm,
    createdAt: row.created_at.toISOString(),
  };
}

async function selectJob(client: pg.PoolClient, jobId: string): Promise<ConversionJobSummary | null> {
  const result = await client.query<JobRow>(
    `
      SELECT id, status, object_key, expires_at, target_installation_id,
             source_url, source_title, preview_image_data_url,
             scene_package_version, package_size_bytes::text, package_sha256,
             package_encryption_key, package_encryption_algorithm, created_at
      FROM conversion_jobs
      WHERE id = $1
    `,
    [jobId]
  );
  return result.rows[0] ? jobSummary(result.rows[0]) : null;
}

export class PostgresConversionJobRepository implements ConversionJobRepository {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async createUploadJob(input: {
    principal: DevicePrincipal;
    targetInstallationId: string | null;
    sourceUrl: string | null;
    sourceTitle: string | null;
    previewImageDataUrl: string | null;
    idempotencyKey: string;
    scenePackageVersion: number | null;
    packageEncryptionKey: string;
    now: Date;
    ttlSeconds: number;
    maxActiveJobs: number;
  }): Promise<ConversionJobSummary> {
    if (input.principal.clientType !== "chrome_extension") throw new ConversionJobError("JOB_NOT_READY");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");

      const existing = await client.query<JobRow>(
        `
          SELECT id, status, object_key, expires_at, target_installation_id,
                 source_url, source_title, preview_image_data_url,
                 scene_package_version, package_size_bytes::text, package_sha256,
                 package_encryption_key, package_encryption_algorithm, created_at
          FROM conversion_jobs
          WHERE user_id = $1 AND idempotency_key = $2
          FOR UPDATE
        `,
        [input.principal.userId, input.idempotencyKey]
      );
      if (existing.rows[0]) {
        const existingJob = jobSummary(existing.rows[0]);
        if (
          existingJob.targetInstallationId !== input.targetInstallationId ||
          existingJob.scenePackageVersion !== input.scenePackageVersion ||
          existingJob.packageEncryptionKey !== input.packageEncryptionKey
        ) {
          throw new ConversionJobError("IDEMPOTENCY_CONFLICT");
        }
        await client.query("COMMIT");
        return existingJob;
      }

      if (input.targetInstallationId) {
        const target = await client.query<{ id: string }>(
          `
            SELECT id
            FROM installations
            WHERE id = $1
              AND user_id = $2
              AND client_type = 'figma_plugin'
              AND status = 'active'
          `,
          [input.targetInstallationId, input.principal.userId]
        );
        if (!target.rows[0]) throw new ConversionJobError("TARGET_INSTALLATION_NOT_FOUND");
      }

      const entitlementLock = await client.query<{
        plan: Plan;
        subscription_status: SubscriptionStatus;
        current_period_end: Date | null;
      }>(
        "SELECT plan, subscription_status, current_period_end FROM entitlements WHERE user_id = $1 FOR UPDATE",
        [input.principal.userId]
      );
      const entitlementRecord = entitlementLock.rows[0];
      if (!entitlementRecord) throw new Error("Entitlement missing for conversion user");
      const plan = effectivePlan({
        plan: entitlementRecord.plan,
        subscriptionStatus: entitlementRecord.subscription_status,
        currentPeriodEnd: entitlementRecord.current_period_end,
        now: input.now,
      });

      await client.query(
        `
          UPDATE conversion_jobs
          SET status = 'expired', completed_at = $2, updated_at = $2
          WHERE user_id = $1
            AND expires_at <= $2
            AND status IN ('created', 'quota_reserved', 'upload_issued', 'uploaded', 'claimed', 'importing')
        `,
        [input.principal.userId, input.now]
      );
      await client.query(
        `
          UPDATE quota_reservations
          SET status = 'released', released_at = $2
          WHERE user_id = $1
            AND status = 'reserved'
            AND conversion_job_id IN (
              SELECT id FROM conversion_jobs WHERE user_id = $1 AND status = 'expired'
            )
        `,
        [input.principal.userId, input.now]
      );

      const activeJobs = await client.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM conversion_jobs
          WHERE user_id = $1
            AND status IN ('created', 'quota_reserved', 'upload_issued', 'uploaded', 'claimed', 'importing')
            AND package_deleted_at IS NULL
        `,
        [input.principal.userId]
      );
      if (Number(activeJobs.rows[0]?.count || 0) >= input.maxActiveJobs) {
        throw new ConversionJobError("ACTIVE_JOB_LIMIT_REACHED");
      }

      const week = productWeekDate(input.now);
      const entitlementResult = await client.query<Omit<EntitlementRow, "plan">>(
        `
          SELECT
            (
              SELECT count(*)
              FROM usage_events
              WHERE user_id = $1
                AND kind = 'completed_conversion'
                AND occurred_at >= $2::date::timestamptz
                AND occurred_at < $2::date::timestamptz + interval '7 days'
            )::text AS used,
            (
              SELECT count(*)
              FROM quota_reservations
              WHERE user_id = $1
                AND product_week = $2
                AND status = 'reserved'
            )::text AS reserved
        `,
        [input.principal.userId, week]
      );
      const entitlement = entitlementResult.rows[0];
      if (!entitlement) throw new Error("Entitlement counters are unavailable");
      const remaining = freeQuotaRemaining({
        plan,
        used: Number(entitlement.used),
        reserved: Number(entitlement.reserved),
      });
      if (remaining !== null && remaining <= 0) throw new QuotaExceededError();

      const { jobId, objectKey } = newConversionObjectKey();
      const expiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1_000);
      const job = await client.query<JobRow>(
        `
          INSERT INTO conversion_jobs (
            id,
            user_id,
            source_installation_id,
            target_installation_id,
            source_url,
            source_title,
            preview_image_data_url,
            status,
            idempotency_key,
            object_key,
            scene_package_version,
            package_encryption_key,
            expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'upload_issued', $8, $9, $10, $11, $12)
          RETURNING id, status, object_key, expires_at, target_installation_id,
                    source_url, source_title, preview_image_data_url,
                    scene_package_version, package_size_bytes::text, package_sha256,
                    package_encryption_key, package_encryption_algorithm, created_at
        `,
        [
          jobId,
          input.principal.userId,
          input.principal.installationId,
          input.targetInstallationId,
          input.sourceUrl,
          input.sourceTitle,
          input.previewImageDataUrl,
          input.idempotencyKey,
          objectKey,
          input.scenePackageVersion,
          input.packageEncryptionKey,
          expiresAt,
        ]
      );
      if (plan === "free") {
        await client.query(
          "INSERT INTO quota_reservations (user_id, conversion_job_id, product_week, status) VALUES ($1, $2, $3, 'reserved')",
          [input.principal.userId, jobId, week]
        );
      }
      await client.query("COMMIT");
      return jobSummary(job.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markUploadComplete(input: {
    principal: DevicePrincipal;
    jobId: string;
    packageSizeBytes: number;
    packageSha256: string;
    now: Date;
  }): Promise<ConversionJobSummary> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const update = await client.query<JobRow>(
        `
          UPDATE conversion_jobs
          SET status = 'uploaded', package_size_bytes = $4, package_sha256 = $5, updated_at = $6
          WHERE id = $1
            AND user_id = $2
            AND source_installation_id = $3
            AND status = 'upload_issued'
          RETURNING id, status, object_key, expires_at, target_installation_id,
                    source_url, source_title, preview_image_data_url,
                    scene_package_version, package_size_bytes::text, package_sha256,
                    package_encryption_key, package_encryption_algorithm, created_at
        `,
        [input.jobId, input.principal.userId, input.principal.installationId, input.packageSizeBytes, input.packageSha256, input.now]
      );
      if (!update.rows[0]) {
        const existing = await selectJob(client, input.jobId);
        if (!existing) throw new ConversionJobError("JOB_NOT_FOUND");
        if (existing.status !== "uploaded") throw new ConversionJobError("JOB_NOT_READY");
        await client.query("COMMIT");
        return existing;
      }
      await client.query("COMMIT");
      return jobSummary(update.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getUploadForSource(input: {
    principal: DevicePrincipal;
    jobId: string;
    now: Date;
  }): Promise<ConversionJobSummary> {
    const result = await this.#pool.query<JobRow>(
      `
        SELECT id, status, object_key, expires_at, target_installation_id,
               source_url, source_title, preview_image_data_url,
               scene_package_version, package_size_bytes::text, package_sha256,
               package_encryption_key, package_encryption_algorithm, created_at
        FROM conversion_jobs
        WHERE id = $1
          AND user_id = $2
          AND source_installation_id = $3
          AND status IN ('upload_issued', 'uploaded')
          AND expires_at > $4
      `,
      [input.jobId, input.principal.userId, input.principal.installationId, input.now]
    );
    if (!result.rows[0]) throw new ConversionJobError("JOB_NOT_READY");
    return jobSummary(result.rows[0]);
  }

  async listPendingForTarget(input: { principal: DevicePrincipal; now: Date }): Promise<ConversionJobSummary[]> {
    const result = await this.#pool.query<JobRow>(
      `
        SELECT id, status, object_key, expires_at, target_installation_id,
               source_url, source_title, preview_image_data_url,
               scene_package_version, package_size_bytes::text, package_sha256,
               package_encryption_key, package_encryption_algorithm, created_at
        FROM conversion_jobs
        WHERE user_id = $1
          AND package_deleted_at IS NULL
          AND (
            (target_installation_id IS NULL AND status = 'uploaded')
            OR (target_installation_id = $2 AND status IN ('uploaded', 'claimed', 'importing'))
            OR status = 'imported'
          )
          AND (expires_at > $3 OR status = 'imported')
        ORDER BY created_at DESC, id DESC
        LIMIT 10
      `,
      [input.principal.userId, input.principal.installationId, input.now]
    );
    return result.rows.map(jobSummary);
  }

  async claimForImport(input: { principal: DevicePrincipal; jobId: string; now: Date }): Promise<ConversionJobSummary> {
    const result = await this.#pool.query<JobRow>(
      `
        UPDATE conversion_jobs
        SET status = 'claimed',
            target_installation_id = $3,
            claimed_at = $4,
            updated_at = $4
        WHERE id = $1
          AND user_id = $2
          AND (target_installation_id IS NULL OR target_installation_id = $3)
          AND package_deleted_at IS NULL
          AND status = 'uploaded'
          AND expires_at > $4
        RETURNING id, status, object_key, expires_at, target_installation_id,
                  source_url, source_title, preview_image_data_url,
                  scene_package_version, package_size_bytes::text, package_sha256,
                  package_encryption_key, package_encryption_algorithm, created_at
      `,
      [input.jobId, input.principal.userId, input.principal.installationId, input.now]
    );
    if (result.rows[0]) return jobSummary(result.rows[0]);

    const existing = await this.#pool.query<JobRow>(
      `
        SELECT id, status, object_key, expires_at, target_installation_id,
               source_url, source_title, preview_image_data_url,
               scene_package_version, package_size_bytes::text, package_sha256,
               package_encryption_key, package_encryption_algorithm, created_at
        FROM conversion_jobs
        WHERE id = $1
          AND user_id = $2
          AND package_deleted_at IS NULL
          AND (
            (target_installation_id = $3 AND status IN ('claimed', 'importing') AND expires_at > $4)
            OR status = 'imported'
          )
      `,
      [input.jobId, input.principal.userId, input.principal.installationId, input.now]
    );
    if (!existing.rows[0]) throw new ConversionJobError("JOB_NOT_READY");
    return jobSummary(existing.rows[0]);
  }

  async getPackageForTarget(input: { principal: DevicePrincipal; jobId: string; now: Date }): Promise<ConversionJobSummary> {
    const result = await this.#pool.query<JobRow>(
      `
        UPDATE conversion_jobs
        SET status = 'importing', updated_at = $4
        WHERE id = $1
          AND user_id = $2
          AND target_installation_id = $3
          AND status IN ('claimed', 'importing')
          AND package_deleted_at IS NULL
          AND expires_at > $4
        RETURNING id, status, object_key, expires_at, target_installation_id,
                  source_url, source_title, preview_image_data_url,
                  scene_package_version, package_size_bytes::text, package_sha256,
                  package_encryption_key, package_encryption_algorithm, created_at
      `,
      [input.jobId, input.principal.userId, input.principal.installationId, input.now]
    );
    if (result.rows[0]) return jobSummary(result.rows[0]);

    const imported = await this.#pool.query<JobRow>(
      `
        SELECT id, status, object_key, expires_at, target_installation_id,
               source_url, source_title, preview_image_data_url,
               scene_package_version, package_size_bytes::text, package_sha256,
               package_encryption_key, package_encryption_algorithm, created_at
        FROM conversion_jobs
        WHERE id = $1
          AND user_id = $2
          AND status = 'imported'
          AND package_deleted_at IS NULL
      `,
      [input.jobId, input.principal.userId]
    );
    if (!imported.rows[0]) throw new ConversionJobError("JOB_NOT_READY");
    return jobSummary(imported.rows[0]);
  }

  async markImported(input: { principal: DevicePrincipal; jobId: string; now: Date }): Promise<ConversionJobSummary> {
    return this.#finalize(input.principal, input.jobId, "imported", input.now);
  }

  async markFailed(input: {
    principal: DevicePrincipal;
    jobId: string;
    terminalStatus: "import_failed" | "cancelled";
    now: Date;
  }): Promise<ConversionJobSummary> {
    return this.#finalize(input.principal, input.jobId, input.terminalStatus, input.now);
  }

  async markSourceFailed(input: {
    principal: DevicePrincipal;
    jobId: string;
    now: Date;
  }): Promise<ConversionJobSummary> {
    return this.#finalize(input.principal, input.jobId, "capture_failed", input.now, "source");
  }

  async markPackageRemoved(input: { objectKey: string; now: Date }): Promise<void> {
    await this.#pool.query(
      `
        UPDATE conversion_jobs
        SET package_deleted_at = COALESCE(package_deleted_at, $2), updated_at = $2
        WHERE object_key = $1
      `,
      [input.objectKey, input.now]
    );
  }

  async storedPackageObjectKeysBeyondLimit(input: {
    principal: DevicePrincipal;
    maxStoredCaptures: number;
    now: Date;
  }): Promise<string[]> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const pruned = await client.query<{ id: string; object_key: string; status: ConversionJobStatus }>(
        `
          SELECT id, object_key, status
          FROM (
            SELECT id, object_key, status,
                   row_number() OVER (ORDER BY created_at DESC, id DESC) AS stored_rank
            FROM conversion_jobs
            WHERE user_id = $1
              AND object_key IS NOT NULL
              AND package_deleted_at IS NULL
              AND package_size_bytes IS NOT NULL
              AND status IN ('uploaded', 'claimed', 'importing', 'imported')
          ) stored
          WHERE stored_rank > $2
          ORDER BY stored_rank ASC
        `,
        [input.principal.userId, input.maxStoredCaptures]
      );
      if (!pruned.rows.length) {
        await client.query("COMMIT");
        return [];
      }

      const prunedIds = pruned.rows.map((row) => row.id);
      await client.query(
        `
          UPDATE conversion_jobs
          SET status = CASE WHEN status = 'imported' THEN status ELSE 'expired' END,
              completed_at = CASE
                WHEN status = 'imported' THEN completed_at
                ELSE COALESCE(completed_at, $3)
              END,
              updated_at = $3
          WHERE user_id = $1
            AND id = ANY($2::uuid[])
        `,
        [input.principal.userId, prunedIds, input.now]
      );
      await client.query(
        `
          UPDATE quota_reservations
          SET status = 'released', released_at = $2
          WHERE status = 'reserved'
            AND conversion_job_id = ANY($1::uuid[])
        `,
        [prunedIds, input.now]
      );
      await client.query("COMMIT");
      return pruned.rows.map((row) => row.object_key);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async expireStale(now: Date): Promise<string[]> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          UPDATE conversion_jobs
          SET status = 'expired', completed_at = $1, updated_at = $1
          WHERE expires_at <= $1
            AND status IN ('created', 'quota_reserved', 'upload_issued', 'uploaded', 'claimed', 'importing')
        `,
        [now]
      );
      await client.query(
        `
          UPDATE quota_reservations
          SET status = 'released', released_at = $1
          WHERE status = 'reserved'
            AND conversion_job_id IN (
              SELECT id FROM conversion_jobs WHERE status = 'expired'
            )
        `,
        [now]
      );
      const objects = await client.query<{ object_key: string }>(
        `
          SELECT DISTINCT object_key
          FROM conversion_jobs
          WHERE object_key IS NOT NULL
            AND package_deleted_at IS NULL
            AND status IN ('cancelled', 'capture_failed', 'upload_expired', 'import_failed', 'expired')
          ORDER BY object_key
          LIMIT 500
        `
      );
      await client.query("COMMIT");
      return objects.rows.map((row) => row.object_key);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #finalize(
    principal: DevicePrincipal,
    jobId: string,
    status: "imported" | "import_failed" | "cancelled" | "capture_failed",
    now: Date,
    role: "source" | "target" = "target"
  ): Promise<ConversionJobSummary> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const installationColumn = role === "source" ? "source_installation_id" : "target_installation_id";
      const installationPredicate = role === "source" ? `AND ${installationColumn} = $3` : "";
      const job = await client.query<JobRow>(
        `
          SELECT id, status, object_key, expires_at, target_installation_id,
                 source_url, source_title, preview_image_data_url,
                 scene_package_version, package_size_bytes::text, package_sha256,
                 package_encryption_key, package_encryption_algorithm, created_at
          FROM conversion_jobs
          WHERE id = $1
            AND user_id = $2
            ${installationPredicate}
          FOR UPDATE
        `,
        role === "source" ? [jobId, principal.userId, principal.installationId] : [jobId, principal.userId]
      );
      const existing = job.rows[0];
      if (!existing) throw new ConversionJobError("JOB_NOT_FOUND");
      if (existing.status === "imported") {
        await client.query("COMMIT");
        return jobSummary(existing);
      }
      if (role === "target" && existing.target_installation_id !== principal.installationId) {
        throw new ConversionJobError("JOB_NOT_READY");
      }
      if (
        ["imported", "import_failed", "cancelled", "capture_failed", "upload_expired", "expired"].includes(
          existing.status
        )
      ) {
        await client.query("COMMIT");
        return jobSummary(existing);
      }

      const allowedStatuses = role === "source"
        ? ["created", "quota_reserved", "upload_issued", "uploaded"]
        : ["claimed", "importing"];
      if (!allowedStatuses.includes(existing.status)) throw new ConversionJobError("JOB_NOT_READY");

      const updated = await client.query<JobRow>(
        `
          UPDATE conversion_jobs
          SET status = $4, completed_at = $5, updated_at = $5
          WHERE id = $1 AND user_id = $2 AND ${installationColumn} = $3
          RETURNING id, status, object_key, expires_at, target_installation_id,
                    source_url, source_title, preview_image_data_url,
                    scene_package_version, package_size_bytes::text, package_sha256,
                    package_encryption_key, package_encryption_algorithm, created_at
        `,
        [jobId, principal.userId, principal.installationId, status, now]
      );
      if (status === "imported") {
        await client.query(
          `
            UPDATE quota_reservations
            SET status = 'settled', settled_at = $2
            WHERE conversion_job_id = $1 AND status = 'reserved'
          `,
          [jobId, now]
        );
        await client.query(
          `
            INSERT INTO usage_events (user_id, conversion_job_id, kind, occurred_at)
            VALUES ($1, $2, 'completed_conversion', $3)
            ON CONFLICT (conversion_job_id) DO NOTHING
          `,
          [principal.userId, jobId, now]
        );
      } else {
        await client.query(
          `
            UPDATE quota_reservations
            SET status = 'released', released_at = $2
            WHERE conversion_job_id = $1 AND status = 'reserved'
          `,
          [jobId, now]
        );
      }
      await client.query("COMMIT");
      return jobSummary(updated.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
