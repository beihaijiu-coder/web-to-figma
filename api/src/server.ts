import { ClerkAuthenticator } from "./auth/authenticator.js";
import { createApi } from "./app.js";
import { createConfig, loadLocalEnvironment } from "./config.js";
import { PostgresDeviceConnectionRepository } from "./db/device-connections.js";
import { PostgresConversionJobRepository } from "./db/conversion-jobs.js";
import { createPostgresPool, PostgresCurrentUserRepository } from "./db/postgres.js";
import { DeviceConnectionService } from "./device/device-connection.js";
import { LocalPackageStorage } from "./storage/local-package-storage.js";

loadLocalEnvironment();

const config = createConfig();
const pool = createPostgresPool(config.databaseUrl);
const api = await createApi({
  config,
  authenticator: new ClerkAuthenticator(config.clerk),
  currentUsers: new PostgresCurrentUserRepository(pool),
  deviceConnections: new DeviceConnectionService(new PostgresDeviceConnectionRepository(pool), config),
  conversionJobs: new PostgresConversionJobRepository(pool),
  packageStorage: new LocalPackageStorage(config.conversions.packageStorageDir),
  logger: {
    level: config.environment === "production" ? "info" : "debug",
    redact: ["req.headers.authorization", "request.headers.authorization"],
  },
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  api.log.info({ signal }, "shutting down");
  await api.close();
  await pool.end();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await api.listen({ host: config.host, port: config.port });
} catch (error) {
  api.log.error(error);
  await pool.end();
  process.exitCode = 1;
}
