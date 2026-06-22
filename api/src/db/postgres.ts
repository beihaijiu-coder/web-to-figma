import pg from "pg";

import type { AuthenticatedIdentity } from "../auth/authenticator.js";
import {
  calculateQuota,
  effectivePlan,
  startOfUtcProductWeek,
  type BillingPeriod,
  type CurrentUser,
  type CurrentUserRepository,
  type Plan,
  type SubscriptionStatus,
} from "../domain/current-user.js";

const { Pool } = pg;

type UserRow = {
  id: string;
  clerk_user_id: string;
  primary_email: string | null;
  created_at: Date;
};

type EntitlementRow = {
  plan: Plan;
  subscription_status: SubscriptionStatus;
  billing_period: BillingPeriod | null;
  current_period_end: Date | null;
};

type QuotaRow = {
  used: string;
  reserved: string;
};

export function createPostgresPool(databaseUrl: string): pg.Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "web-to-figma-api",
  });
}

export class PostgresCurrentUserRepository implements CurrentUserRepository {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async resolveCurrentUser(identity: AuthenticatedIdentity, now = new Date()): Promise<CurrentUser> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");

      const userResult = await client.query<UserRow>(
        `
          INSERT INTO users (clerk_user_id, primary_email)
          VALUES ($1, $2)
          ON CONFLICT (clerk_user_id) DO UPDATE
          SET primary_email = COALESCE(EXCLUDED.primary_email, users.primary_email),
              updated_at = CASE
                WHEN EXCLUDED.primary_email IS NOT NULL
                 AND EXCLUDED.primary_email IS DISTINCT FROM users.primary_email
                THEN now()
                ELSE users.updated_at
              END
          RETURNING id, clerk_user_id, primary_email, created_at
        `,
        [identity.clerkUserId, identity.email]
      );
      const user = userResult.rows[0];
      if (!user) throw new Error("User upsert returned no row");

      await client.query(
        `
          INSERT INTO entitlements (user_id, plan, subscription_status)
          VALUES ($1, 'free', 'inactive')
          ON CONFLICT (user_id) DO NOTHING
        `,
        [user.id]
      );

      const entitlementResult = await client.query<EntitlementRow>(
        `
          SELECT plan, subscription_status, billing_period, current_period_end
          FROM entitlements
          WHERE user_id = $1
          FOR SHARE
        `,
        [user.id]
      );
      const entitlement = entitlementResult.rows[0];
      if (!entitlement) throw new Error("User entitlement was not created");

      const weekStartsAt = startOfUtcProductWeek(now);
      const quotaResult = await client.query<QuotaRow>(
        `
          SELECT
            (
              SELECT count(*)
              FROM usage_events
              WHERE user_id = $1
                AND kind = 'completed_conversion'
                AND occurred_at >= $2
                AND occurred_at < $2::timestamptz + interval '7 days'
            )::text AS used,
            (
              SELECT count(*)
              FROM quota_reservations
              WHERE user_id = $1
                AND product_week = $3
                AND status = 'reserved'
            )::text AS reserved
        `,
        [user.id, weekStartsAt.toISOString(), weekStartsAt.toISOString().slice(0, 10)]
      );
      const quotaCounts = quotaResult.rows[0] ?? { used: "0", reserved: "0" };

      await client.query("COMMIT");

      return {
        user: {
          id: user.id,
          clerkUserId: user.clerk_user_id,
          email: user.primary_email,
          createdAt: user.created_at.toISOString(),
        },
        entitlement: {
          plan: entitlement.plan,
          subscriptionStatus: entitlement.subscription_status,
          billingPeriod: entitlement.billing_period,
          currentPeriodEnd: entitlement.current_period_end?.toISOString() ?? null,
        },
        quota: calculateQuota({
          plan: effectivePlan({
            plan: entitlement.plan,
            subscriptionStatus: entitlement.subscription_status,
            currentPeriodEnd: entitlement.current_period_end,
            now,
          }),
          used: Number(quotaCounts.used),
          reserved: Number(quotaCounts.reserved),
          weekStartsAt,
        }),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
