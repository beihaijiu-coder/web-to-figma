import assert from "node:assert/strict";
import test from "node:test";

import { loadMigrations, runMigrations } from "../src/db/migrations.js";
import { pglitePool } from "./helpers.js";

test("migration runner records migrations and refuses changed history", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const database = new PGlite();
  const pool = pglitePool(database);
  const migrations = await loadMigrations();

  assert.deepEqual(await runMigrations(pool, migrations), migrations.map((migration) => migration.name));
  assert.deepEqual(await runMigrations(pool, migrations), []);

  const changedFirstMigration = {
    ...migrations[0]!,
    checksum: "intentionally-changed",
  };
  await assert.rejects(
    runMigrations(pool, [changedFirstMigration]),
    /Applied migration was modified: 0001_identity_and_entitlements.sql/
  );

  await database.close();
});
