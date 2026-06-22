import assert from "node:assert/strict";
import test from "node:test";

import { PostgresCurrentUserRepository } from "../src/db/postgres.js";
import { calculateQuota, startOfUtcProductWeek } from "../src/domain/current-user.js";
import { migratedPglite, pglitePool } from "./helpers.js";

test("product week starts on Monday in UTC", () => {
  assert.equal(startOfUtcProductWeek(new Date("2026-06-21T23:59:00.000Z")).toISOString(), "2026-06-15T00:00:00.000Z");
  assert.equal(startOfUtcProductWeek(new Date("2026-06-22T00:00:00.000Z")).toISOString(), "2026-06-22T00:00:00.000Z");
});

test("Free quota counts completed jobs and active reservations", () => {
  const quota = calculateQuota({
    plan: "free",
    used: 1,
    reserved: 1,
    weekStartsAt: new Date("2026-06-22T00:00:00.000Z"),
  });

  assert.equal(quota.limit, 2);
  assert.equal(quota.remaining, 0);
  assert.equal(quota.unlimited, false);
});

test("Pro quota remains unlimited while still reporting observed usage", () => {
  const quota = calculateQuota({
    plan: "pro",
    used: 12,
    reserved: 3,
    weekStartsAt: new Date("2026-06-22T00:00:00.000Z"),
  });

  assert.equal(quota.limit, null);
  assert.equal(quota.remaining, null);
  assert.equal(quota.unlimited, true);
  assert.equal(quota.used, 12);
});

test("current user upsert creates one internal Free user and reports weekly quota", async () => {
  const database = await migratedPglite();
  const repository = new PostgresCurrentUserRepository(pglitePool(database));
  const now = new Date("2026-06-24T10:00:00.000Z");

  const first = await repository.resolveCurrentUser(
    { clerkUserId: "user_clerk_1", sessionId: "sess_1", email: "first@example.com" },
    now
  );
  const second = await repository.resolveCurrentUser(
    { clerkUserId: "user_clerk_1", sessionId: "sess_2", email: "first@example.com" },
    now
  );

  assert.equal(first.user.id, second.user.id);
  assert.equal(first.user.email, "first@example.com");
  assert.equal(first.entitlement.plan, "free");
  assert.equal(first.quota.remaining, 2);

  const count = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM users");
  assert.equal(count.rows[0]?.count, "1");

  await database.query(
    `
      INSERT INTO conversion_jobs (user_id, status, idempotency_key, expires_at, completed_at)
      VALUES ($1, 'imported', 'job-1', now() + interval '1 hour', now())
      RETURNING id
    `,
    [first.user.id]
  );
  const completedJob = await database.query<{ id: string }>(
    "SELECT id FROM conversion_jobs WHERE user_id = $1 AND idempotency_key = 'job-1'",
    [first.user.id]
  );
  const completedJobId = completedJob.rows[0]?.id;
  assert.ok(completedJobId);
  await database.query(
    "INSERT INTO usage_events (user_id, conversion_job_id, kind, occurred_at) VALUES ($1, $2, 'completed_conversion', $3)",
    [first.user.id, completedJobId, now]
  );

  await database.query(
    `
      INSERT INTO conversion_jobs (user_id, status, idempotency_key, expires_at)
      VALUES ($1, 'quota_reserved', 'job-2', now() + interval '1 hour')
      RETURNING id
    `,
    [first.user.id]
  );
  const reservationJob = await database.query<{ id: string }>(
    "SELECT id FROM conversion_jobs WHERE user_id = $1 AND idempotency_key = 'job-2'",
    [first.user.id]
  );
  const reservationJobId = reservationJob.rows[0]?.id;
  assert.ok(reservationJobId);
  await database.query(
    "INSERT INTO quota_reservations (user_id, conversion_job_id, product_week, status) VALUES ($1, $2, $3, 'reserved')",
    [first.user.id, reservationJobId, "2026-06-22"]
  );

  const afterUsage = await repository.resolveCurrentUser(
    { clerkUserId: "user_clerk_1", sessionId: "sess_3", email: "first@example.com" },
    now
  );
  assert.equal(afterUsage.quota.used, 1);
  assert.equal(afterUsage.quota.reserved, 1);
  assert.equal(afterUsage.quota.remaining, 0);

  await database.query(
    "UPDATE entitlements SET plan = 'pro', subscription_status = 'active', billing_period = 'month' WHERE user_id = $1",
    [first.user.id]
  );
  const pro = await repository.resolveCurrentUser(
    { clerkUserId: "user_clerk_1", sessionId: "sess_4", email: "first@example.com" },
    now
  );
  assert.equal(pro.entitlement.plan, "pro");
  assert.equal(pro.quota.unlimited, true);

  await database.close();
});
