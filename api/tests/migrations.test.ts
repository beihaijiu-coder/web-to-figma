import assert from "node:assert/strict";
import test from "node:test";

import { loadMigrations } from "../src/db/migrations.js";
import { migratedPglite } from "./helpers.js";

test("migrations are ordered and create the identity and usage tables", async () => {
  const migrations = await loadMigrations();
  assert.deepEqual(
    migrations.map((migration) => migration.name),
    ["0001_identity_and_entitlements.sql", "0002_conversion_usage.sql", "0003_device_connections.sql"]
  );

  const database = await migratedPglite();
  const tables = await database.query<{ tablename: string }>(
    `
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `
  );
  assert.deepEqual(tables.rows.map((row) => row.tablename), [
    "access_tokens",
    "connection_requests",
    "conversion_jobs",
    "entitlements",
    "installations",
    "quota_reservations",
    "refresh_token_families",
    "refresh_tokens",
    "usage_events",
    "users",
  ]);

  await assert.rejects(
    database.query<{ id: string }>("INSERT INTO users (clerk_user_id) VALUES ('user_test') RETURNING id").then(async (result) => {
      const userId = result.rows[0]?.id;
      await database.query("INSERT INTO entitlements (user_id, plan) VALUES ($1, 'enterprise')", [userId]);
    })
  );

  await database.close();
});
