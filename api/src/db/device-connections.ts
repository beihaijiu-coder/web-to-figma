import type pg from "pg";

import {
  createOpaqueToken,
  hashOpaqueToken,
  type ClientType,
  type ConnectionStatus,
  type CreateConnectionInput,
  type DeviceConnectionApproval,
  type DeviceConnectionRepository,
  type InstallationSummary,
  type DevicePollResult,
  type DevicePrincipal,
  type TokenPair,
} from "../device/device-connection.js";

type ConnectionRow = {
  id: string;
  client_type: ClientType;
  requested_client_name: string | null;
  status: ConnectionStatus;
  poll_interval_seconds: number;
  expires_at: Date;
  last_polled_at: Date | null;
  approved_user_id: string | null;
  installation_id: string | null;
};

type RefreshTokenRow = {
  id: string;
  family_id: string;
  installation_id: string;
  client_type: ClientType;
  token_status: "active" | "used" | "revoked";
  token_expires_at: Date;
  family_revoked_at: Date | null;
};

type InstallationRow = {
  id: string;
  client_type: ClientType;
  display_name: string | null;
  status: "active" | "revoked";
  created_at: Date;
  last_seen_at: Date;
};

function isClientType(value: string): value is ClientType {
  return value === "chrome_extension" || value === "figma_plugin";
}

function assertClientType(value: string): ClientType {
  if (!isClientType(value)) throw new Error(`Unknown client type: ${value}`);
  return value;
}

function secondsUntil(timestamp: Date, now: Date): number {
  return Math.max(0, Math.floor((timestamp.getTime() - now.getTime()) / 1_000));
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class PostgresDeviceConnectionRepository implements DeviceConnectionRepository {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async createConnection(input: CreateConnectionInput): Promise<{ id: string }> {
    const result = await this.#pool.query<{ id: string }>(
      `
        INSERT INTO connection_requests (
          client_type,
          requested_client_name,
          device_code_hash,
          user_code,
          poll_interval_seconds,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `,
      [
        input.clientType,
        input.requestedClientName,
        input.deviceCodeHash,
        input.userCode,
        input.pollIntervalSeconds,
        input.expiresAt,
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Connection request creation returned no row");
    return row;
  }

  async approveConnection(input: {
    userCode: string;
    userId: string;
    now: Date;
  }): Promise<DeviceConnectionApproval | null> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ConnectionRow>(
        `
          SELECT id, client_type, requested_client_name, status, poll_interval_seconds,
                 expires_at, last_polled_at, approved_user_id, installation_id
          FROM connection_requests
          WHERE user_code = $1
          FOR UPDATE
        `,
        [input.userCode]
      );
      const connection = result.rows[0];
      if (!connection) {
        await client.query("COMMIT");
        return null;
      }

      if (connection.expires_at <= input.now) {
        if (connection.status === "pending" || connection.status === "approved") {
          await client.query(
            "UPDATE connection_requests SET status = 'expired' WHERE id = $1",
            [connection.id]
          );
        }
        await client.query("COMMIT");
        return null;
      }

      if (connection.status === "approved") {
        await client.query("COMMIT");
        if (connection.approved_user_id !== input.userId || !connection.installation_id) return null;
        return {
          id: connection.id,
          clientType: assertClientType(connection.client_type),
          requestedClientName: connection.requested_client_name,
          status: "approved",
          installationId: connection.installation_id,
        };
      }
      if (connection.status !== "pending") {
        await client.query("COMMIT");
        return null;
      }

      let installationId: string | undefined;
      if (connection.requested_client_name) {
        const existingInstallation = await client.query<{ id: string }>(
          `
            SELECT id
            FROM installations
            WHERE user_id = $1
              AND client_type = $2
              AND display_name = $3
              AND status = 'active'
            FOR UPDATE
          `,
          [input.userId, connection.client_type, connection.requested_client_name]
        );
        installationId = existingInstallation.rows[0]?.id;
      }
      if (installationId) {
        await this.#revokeInstallationCredentials(client, installationId, input.now, "installation_reconnected");
        await client.query(
          `
            UPDATE installations
            SET display_name = $2, last_seen_at = $3
            WHERE id = $1
          `,
          [installationId, connection.requested_client_name, input.now]
        );
      } else {
        const installation = await client.query<{ id: string }>(
          `
            INSERT INTO installations (user_id, client_type, display_name)
            VALUES ($1, $2, $3)
            RETURNING id
          `,
          [input.userId, connection.client_type, connection.requested_client_name]
        );
        installationId = installation.rows[0]?.id;
      }
      if (!installationId) throw new Error("Installation creation returned no row");

      await client.query(
        `
          UPDATE connection_requests
          SET status = 'approved',
              approved_user_id = $2,
              installation_id = $3,
              approved_at = $4
          WHERE id = $1
        `,
        [connection.id, input.userId, installationId, input.now]
      );
      await client.query("COMMIT");

      return {
        id: connection.id,
        clientType: assertClientType(connection.client_type),
        requestedClientName: connection.requested_client_name,
        status: "approved",
        installationId,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async denyConnection(input: {
    userCode: string;
    userId: string;
    now: Date;
  }): Promise<"denied" | "not_found" | "expired"> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<Pick<ConnectionRow, "id" | "status" | "expires_at">>(
        "SELECT id, status, expires_at FROM connection_requests WHERE user_code = $1 FOR UPDATE",
        [input.userCode]
      );
      const connection = result.rows[0];
      if (!connection) {
        await client.query("COMMIT");
        return "not_found";
      }
      if (connection.expires_at <= input.now) {
        if (connection.status === "pending" || connection.status === "approved") {
          await client.query("UPDATE connection_requests SET status = 'expired' WHERE id = $1", [connection.id]);
        }
        await client.query("COMMIT");
        return "expired";
      }
      if (connection.status !== "pending") {
        await client.query("COMMIT");
        return connection.status === "denied" ? "denied" : "not_found";
      }
      await client.query(
        "UPDATE connection_requests SET status = 'denied', denied_at = $2 WHERE id = $1",
        [connection.id, input.now]
      );
      await client.query("COMMIT");
      return "denied";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async pollConnection(input: {
    deviceCodeHash: string;
    now: Date;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  }): Promise<DevicePollResult | "not_found"> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ConnectionRow>(
        `
          SELECT id, client_type, requested_client_name, status, poll_interval_seconds,
                 expires_at, last_polled_at, approved_user_id, installation_id
          FROM connection_requests
          WHERE device_code_hash = $1
          FOR UPDATE
        `,
        [input.deviceCodeHash]
      );
      const connection = result.rows[0];
      if (!connection) {
        await client.query("COMMIT");
        return "not_found";
      }

      if (connection.expires_at <= input.now && (connection.status === "pending" || connection.status === "approved")) {
        await client.query("UPDATE connection_requests SET status = 'expired' WHERE id = $1", [connection.id]);
        await client.query("COMMIT");
        return { status: "expired" };
      }

      if (
        connection.last_polled_at &&
        input.now.getTime() - connection.last_polled_at.getTime() < connection.poll_interval_seconds * 1_000
      ) {
        await client.query("COMMIT");
        return { status: "slow_down", interval: connection.poll_interval_seconds };
      }
      await client.query("UPDATE connection_requests SET last_polled_at = $2 WHERE id = $1", [connection.id, input.now]);

      if (connection.status === "pending") {
        await client.query("COMMIT");
        return { status: "pending", interval: connection.poll_interval_seconds };
      }
      if (connection.status === "denied") {
        await client.query("COMMIT");
        return { status: "denied" };
      }
      if (connection.status === "expired") {
        await client.query("COMMIT");
        return { status: "expired" };
      }
      if (connection.status === "consumed") {
        await client.query("COMMIT");
        return { status: "consumed" };
      }
      if (!connection.installation_id) throw new Error("Approved connection is missing installation");

      const tokens = await this.#issueTokenPair(client, {
        installationId: connection.installation_id,
        clientType: assertClientType(connection.client_type),
        now: input.now,
        accessTokenTtlSeconds: input.accessTokenTtlSeconds,
        refreshTokenTtlSeconds: input.refreshTokenTtlSeconds,
      });
      await client.query(
        "UPDATE connection_requests SET status = 'consumed', consumed_at = $2 WHERE id = $1",
        [connection.id, input.now]
      );
      await client.query("COMMIT");
      return { status: "approved", tokens };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async refreshToken(input: {
    refreshTokenHash: string;
    now: Date;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  }): Promise<TokenPair | "invalid" | "reuse_detected"> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<RefreshTokenRow>(
        `
          SELECT refresh_tokens.id,
                 refresh_tokens.family_id,
                 refresh_tokens.status AS token_status,
                 refresh_tokens.expires_at AS token_expires_at,
                 refresh_token_families.installation_id,
                 refresh_token_families.client_type,
                 refresh_token_families.revoked_at AS family_revoked_at
          FROM refresh_tokens
          JOIN refresh_token_families ON refresh_token_families.id = refresh_tokens.family_id
          WHERE refresh_tokens.token_hash = $1
          FOR UPDATE OF refresh_tokens, refresh_token_families
        `,
        [input.refreshTokenHash]
      );
      const current = result.rows[0];
      if (!current) {
        await client.query("COMMIT");
        return "invalid";
      }

      if (
        current.family_revoked_at ||
        current.token_status !== "active" ||
        current.token_expires_at <= input.now
      ) {
        await client.query(
          `
            UPDATE refresh_token_families
            SET revoked_at = COALESCE(revoked_at, $2), revoke_reason = COALESCE(revoke_reason, 'refresh_token_reuse')
            WHERE id = $1
          `,
          [current.family_id, input.now]
        );
        await client.query(
          "UPDATE refresh_tokens SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2) WHERE family_id = $1 AND status = 'active'",
          [current.family_id, input.now]
        );
        await client.query(
          "UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE installation_id = $1 AND revoked_at IS NULL",
          [current.installation_id, input.now]
        );
        await client.query("COMMIT");
        return "reuse_detected";
      }

      const tokens = await this.#issueTokenPair(client, {
        installationId: current.installation_id,
        clientType: assertClientType(current.client_type),
        familyId: current.family_id,
        parentRefreshTokenId: current.id,
        now: input.now,
        accessTokenTtlSeconds: input.accessTokenTtlSeconds,
        refreshTokenTtlSeconds: input.refreshTokenTtlSeconds,
      });
      await client.query(
        `
          UPDATE refresh_tokens
          SET status = 'used', used_at = $2,
              replaced_by_token_id = (
                SELECT id FROM refresh_tokens WHERE token_hash = $3
              )
          WHERE id = $1
        `,
        [current.id, input.now, hashOpaqueToken(tokens.refreshToken)]
      );
      await client.query("COMMIT");
      return tokens;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async authenticateAccessToken(input: { accessTokenHash: string; now: Date }): Promise<DevicePrincipal | null> {
    const result = await this.#pool.query<{
      user_id: string;
      installation_id: string;
      client_type: string;
    }>(
      `
        SELECT installations.user_id, installations.id AS installation_id, installations.client_type
        FROM access_tokens
        JOIN installations ON installations.id = access_tokens.installation_id
        WHERE access_tokens.token_hash = $1
          AND access_tokens.expires_at > $2
          AND access_tokens.revoked_at IS NULL
          AND installations.status = 'active'
      `,
      [input.accessTokenHash, input.now]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      installationId: row.installation_id,
      clientType: assertClientType(row.client_type),
    };
  }

  async listInstallations(input: {
    principal: DevicePrincipal;
    clientType?: ClientType | undefined;
  }): Promise<InstallationSummary[]> {
    const values: unknown[] = [input.principal.userId];
    const clientTypeFilter = input.clientType ? "AND client_type = $2" : "";
    if (input.clientType) values.push(input.clientType);

    const result = await this.#pool.query<InstallationRow>(
      `
        SELECT id, client_type, display_name, status, created_at, last_seen_at
        FROM installations
        WHERE user_id = $1
          AND status = 'active'
          ${clientTypeFilter}
        ORDER BY last_seen_at DESC, created_at DESC
      `,
      values
    );

    return result.rows.map((row) => ({
      id: row.id,
      clientType: assertClientType(row.client_type),
      displayName: row.display_name,
      status: row.status,
      createdAt: toIsoString(row.created_at),
      lastSeenAt: toIsoString(row.last_seen_at),
    }));
  }

  async listUserInstallations(input: { userId: string }): Promise<InstallationSummary[]> {
    const result = await this.#pool.query<InstallationRow>(
      `
        SELECT id, client_type, display_name, status, created_at, last_seen_at
        FROM installations
        WHERE user_id = $1
          AND status = 'active'
        ORDER BY last_seen_at DESC, created_at DESC
      `,
      [input.userId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      clientType: assertClientType(row.client_type),
      displayName: row.display_name,
      status: row.status,
      createdAt: toIsoString(row.created_at),
      lastSeenAt: toIsoString(row.last_seen_at),
    }));
  }

  async revokeInstallation(input: { userId: string; installationId: string; now: Date }): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const revoked = await client.query<{ id: string }>(
        `
          UPDATE installations
          SET status = 'revoked', revoked_at = $3
          WHERE id = $1 AND user_id = $2 AND status = 'active'
          RETURNING id
        `,
        [input.installationId, input.userId, input.now]
      );
      if (!revoked.rows[0]) {
        await client.query("COMMIT");
        return false;
      }

      await this.#revokeInstallationCredentials(client, input.installationId, input.now, "installation_revoked");

      const terminalJobs = await client.query<{ id: string }>(
        `
          UPDATE conversion_jobs
          SET status = 'cancelled', completed_at = $3, updated_at = $3
          WHERE user_id = $2
            AND (source_installation_id = $1 OR target_installation_id = $1)
            AND status IN ('created', 'quota_reserved', 'upload_issued', 'uploaded', 'claimed', 'importing')
          RETURNING id
        `,
        [input.installationId, input.userId, input.now]
      );
      if (terminalJobs.rows.length) {
        await client.query(
          `
            UPDATE quota_reservations
            SET status = 'released', released_at = $2
            WHERE conversion_job_id = ANY($1::uuid[]) AND status = 'reserved'
          `,
          [terminalJobs.rows.map((row) => row.id), input.now]
        );
      }

      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #revokeInstallationCredentials(
    client: pg.PoolClient,
    installationId: string,
    now: Date,
    reason: string
  ): Promise<void> {
    await client.query(
      "UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE installation_id = $1",
      [installationId, now]
    );
    await client.query(
      `
        UPDATE refresh_token_families
        SET revoked_at = COALESCE(revoked_at, $2), revoke_reason = COALESCE(revoke_reason, $3)
        WHERE installation_id = $1
      `,
      [installationId, now, reason]
    );
    await client.query(
      `
        UPDATE refresh_tokens
        SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2)
        WHERE family_id IN (
          SELECT id FROM refresh_token_families WHERE installation_id = $1
        ) AND status = 'active'
      `,
      [installationId, now]
    );
  }

  async #issueTokenPair(
    client: pg.PoolClient,
    input: {
      installationId: string;
      clientType: ClientType;
      familyId?: string;
      parentRefreshTokenId?: string;
      now: Date;
      accessTokenTtlSeconds: number;
      refreshTokenTtlSeconds: number;
    }
  ): Promise<TokenPair> {
    const accessToken = createOpaqueToken("w2f_at");
    const refreshToken = createOpaqueToken("w2f_rt");
    const accessTokenExpiresAt = new Date(input.now.getTime() + input.accessTokenTtlSeconds * 1_000);
    const refreshTokenExpiresAt = new Date(input.now.getTime() + input.refreshTokenTtlSeconds * 1_000);

    let familyId = input.familyId;
    if (!familyId) {
      const family = await client.query<{ id: string }>(
        `
          INSERT INTO refresh_token_families (installation_id, client_type)
          VALUES ($1, $2)
          RETURNING id
        `,
        [input.installationId, input.clientType]
      );
      familyId = family.rows[0]?.id;
      if (!familyId) throw new Error("Refresh-token family creation returned no row");
    }

    await client.query(
      `
        INSERT INTO access_tokens (installation_id, token_hash, audience, expires_at)
        VALUES ($1, $2, $3, $4)
      `,
      [input.installationId, hashOpaqueToken(accessToken), input.clientType, accessTokenExpiresAt]
    );
    await client.query(
      `
        INSERT INTO refresh_tokens (family_id, token_hash, parent_token_id, expires_at)
        VALUES ($1, $2, $3, $4)
      `,
      [familyId, hashOpaqueToken(refreshToken), input.parentRefreshTokenId ?? null, refreshTokenExpiresAt]
    );

    return {
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      expiresIn: secondsUntil(accessTokenExpiresAt, input.now),
      refreshExpiresIn: secondsUntil(refreshTokenExpiresAt, input.now),
    };
  }
}
