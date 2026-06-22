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
import type { Plan } from "../domain/current-user.js";

type JobRow = {
  id: string;
  status: ConversionJobStatus;
  object_key: string | null;
  expires_at: Date;
  target_installation_id: string | null;
  scene_package_version: number | null;
  package_size_bytes: string | null;
  package_sha256: string | null;
  created_at: Date;
};

type EntitlementRow = {
  plan: Plan;
  used: string;
  reserved: string;
};

function jobSummary(row: JobRow): ConversionJobSummary {
  if (!row.object_key || !row.target_installation_id) throw new Error("Conversion job row is incomplete");
  return {
    id: row.id,
    status: row.status,
    objectKey: row.object_key,
    expiresAt: row.expires_at.toISOString(),
    targetInstallationId: row.target_installation_id,
    scenePackageVersion: row.scene_package_version,
    packageSizeBytes: row.package_size_bytes === null ? null : Number(row.package_size_bytes),
    packageSha256: row.package_sha256,
    createdAt: row.created_at.toISOString(),
  };
}

async function selectJob(client: pg.PoolClient, jobId: string): Promise<ConversionJobSummary | null> {
  const result = await client.query<JobRow>(
    `
      SELECT id, status, object_key, expires_at, target_installation_id,
             scene_package_version, package_size_bytes::text, package_sha256, created_at
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
    targetInstallationId: string;
    idempotencyKey: string;
    scenePackageVersion: number | null;
    now: Date;
    ttlSeconds: number;
  }): Promise<ConversionJobSummary> {
    if (input.principal.clientType !== "chrome_extension") throw new ConversionJobError("JOB_NOT_READY");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");

      const existing = await client.query<JobRow>(
        `
          SELECT id, status, object_key, expires_at, target_installation_id,
                 scene_package_version, package_size_bytes::text, package_sha256, created_at
          FROM conversion_jobs
          WHERE user_id = $1 AND idempotency_key = $2
          FOR UPDATE
        `,
        [input.principal.userId, input.idempotencyKey]
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return jobSummary(existing.rows[0]);
      }

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

      const week = productWeekDate(input.now);
      const entitlementResult = await client.query<EntitlementRow>(
        `
          SELECT entitlements.plan,
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
          FROM entitlements
          WHERE user_id = $1
          FOR UPDATE
        `,
        [input.principal.userId, week]
      );
      const entitlement = entitlementResult.rows[0];
      if (!entitlement) throw new Error("Entitlement missing for conversion user");
      const remaining = freeQuotaRemaining({
        plan: entitlement.plan,
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
            status,
            idempotency_key,
            object_key,
            scene_package_version,
            expires_at
          )
          VALUES ($1, $2, $3, $4, 'upload_issued', $5, $6, $7, $8)
          RETURNING id, status, object_key, expires_at, target_installation_id,
                    scene_package_version, package_size_bytes::text, package_sha256, created_at
        `,
        [
          jobId,
          input.principal.userId,
          input.principal.installationId,
          input.targetInstallationId,
          input.idempotencyKey,
          objectKey,
          input.scenePackageVersion,
          expiresAt,
        ]
      );
      if (entitlement.plan === "free") {
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
                    scene_package_version, package_size_bytes::text, package_sha256, created_at
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

  async listPendingForTarget(input: { principal: DevicePrincipal; now: Date }): Promise<ConversionJobSummary[]> {
    const result = await this.#pool.query<JobRow>(
      `
        SELECT id, status, object_key, expires_at, target_installation_id,
               scene_package_version, package_size_bytes::text, package_sha256, created_at
        FROM conversion_jobs
        WHERE user_id = $1
          AND target_installation_id = $2
          AND status = 'uploaded'
          AND expires_at > $3
        ORDER BY created_at ASC
        LIMIT 20
      `,
      [input.principal.userId, input.principal.installationId, input.now]
    );
    return result.rows.map(jobSummary);
  }

  async claimForImport(input: { principal: DevicePrincipal; jobId: string; now: Date }): Promise<ConversionJobSummary> {
    const result = await this.#pool.query<JobRow>(
      `
        UPDATE conversion_jobs
        SET status = 'claimed', claimed_at = $4, updated_at = $4
        WHERE id = $1
          AND user_id = $2
          AND target_installation_id = $3
          AND status = 'uploaded'
        RETURNING id, status, object_key, expires_at, target_installation_id,
                  scene_package_version, package_size_bytes::text, package_sha256, created_at
      `,
      [input.jobId, input.principal.userId, input.principal.installationId, input.now]
    );
    if (!result.rows[0]) throw new ConversionJobError("JOB_NOT_READY");
    return jobSummary(result.rows[0]);
  }

  async getPackageForTarget(input: { principal: DevicePrincipal; jobId: string; now: Date }): Promise<ConversionJobSummary> {
    const result = await this.#pool.query<JobRow>(
      `
        SELECT id, status, object_key, expires_at, target_installation_id,
               scene_package_version, package_size_bytes::text, package_sha256, created_at
        FROM conversion_jobs
        WHERE id = $1
          AND user_id = $2
          AND target_installation_id = $3
          AND status IN ('claimed', 'importing')
          AND expires_at > $4
      `,
      [input.jobId, input.principal.userId, input.principal.installationId, input.now]
    );
    if (!result.rows[0]) throw new ConversionJobError("JOB_NOT_READY");
    return jobSummary(result.rows[0]);
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

  async #finalize(
    principal: DevicePrincipal,
    jobId: string,
    status: "imported" | "import_failed" | "cancelled",
    now: Date
  ): Promise<ConversionJobSummary> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const job = await client.query<JobRow>(
        `
          SELECT id, status, object_key, expires_at, target_installation_id,
                 scene_package_version, package_size_bytes::text, package_sha256, created_at
          FROM conversion_jobs
          WHERE id = $1
            AND user_id = $2
            AND target_installation_id = $3
          FOR UPDATE
        `,
        [jobId, principal.userId, principal.installationId]
      );
      const existing = job.rows[0];
      if (!existing) throw new ConversionJobError("JOB_NOT_FOUND");
      if (["imported", "import_failed", "cancelled", "expired"].includes(existing.status)) {
        await client.query("COMMIT");
        return jobSummary(existing);
      }

      const updated = await client.query<JobRow>(
        `
          UPDATE conversion_jobs
          SET status = $4, completed_at = $5, updated_at = $5
          WHERE id = $1 AND user_id = $2 AND target_installation_id = $3
          RETURNING id, status, object_key, expires_at, target_installation_id,
                    scene_package_version, package_size_bytes::text, package_sha256, created_at
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
