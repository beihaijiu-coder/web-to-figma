import { createConfig, loadLocalEnvironment } from "../config.js";
import { createPostgresPool } from "./postgres.js";
import { runMigrations } from "./migrations.js";

loadLocalEnvironment();

const config = createConfig();
const pool = createPostgresPool(config.databaseUrl);

try {
  const applied = await runMigrations(pool);
  if (applied.length) {
    console.log(`Applied migrations: ${applied.join(", ")}`);
  } else {
    console.log("Database is already up to date.");
  }
} finally {
  await pool.end();
}
