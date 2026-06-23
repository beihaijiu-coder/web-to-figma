import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";

import type { ApiConfig } from "../src/config.js";

export function testConfig(): ApiConfig {
  return {
    environment: "test",
    host: "127.0.0.1",
    port: 8787,
    databaseUrl: "postgresql://test:test@localhost:5432/test",
    clerk: {
      publishableKey: "pk_test_example",
      secretKey: "sk_test_example",
      authorizedParties: ["http://localhost:4173"],
    },
    corsAllowedOrigins: [
      "http://localhost:4173",
      "null",
      "https://www.figma.com",
      "https://figma.com",
      "chrome-extension://*",
    ],
    publicWebUrl: "http://localhost:4173",
    device: {
      connectionTtlSeconds: 600,
      pollIntervalSeconds: 5,
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
    },
    conversions: {
      jobTtlSeconds: 1_800,
      maxScenePackageBytes: 26_214_400,
      maxActiveJobs: 3,
      maxStoredCaptures: 10,
      packageStorageDir: ".data/test-packages",
    },
  };
}

export async function migratedPglite(): Promise<PGlite> {
  const database = new PGlite();
  const { loadMigrations } = await import("../src/db/migrations.js");
  for (const migration of await loadMigrations()) {
    await database.exec(migration.sql);
  }
  return database;
}

export function pglitePool(database: PGlite): pg.Pool {
  async function query<Row extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<Row>> {
    if ((!values || values.length === 0) && /;\s*\S/.test(text.trim())) {
      await database.exec(text);
      return { rows: [] } as unknown as pg.QueryResult<Row>;
    }
    const result = await database.query<Row>(text, values);
    return { rows: result.rows } as pg.QueryResult<Row>;
  }

  return {
    query,
    async connect() {
      return {
        query,
        release() {},
      } as unknown as pg.PoolClient;
    },
  } as unknown as pg.Pool;
}
