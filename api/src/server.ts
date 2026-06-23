import { ClerkAuthenticator } from "./auth/authenticator.js";
import { createApi } from "./app.js";
import { createConfig, loadLocalEnvironment } from "./config.js";
import { PostgresDeviceConnectionRepository } from "./db/device-connections.js";
import { PostgresConversionJobRepository } from "./db/conversion-jobs.js";
import { createPostgresPool, PostgresCurrentUserRepository } from "./db/postgres.js";
import { DeviceConnectionService } from "./device/device-connection.js";
import { LocalPackageStorage } from "./storage/local-package-storage.js";
import { R2PreviewStorage } from "./storage/r2-preview-storage.js";

loadLocalEnvironment();

const config = createConfig();
const pool = createPostgresPool(config.databaseUrl);
const conversionJobs = new PostgresConversionJobRepository(pool);
const packageStorage = new LocalPackageStorage(config.conversions.packageStorageDir);
const previewStorage = new R2PreviewStorage(config.r2);
const api = await createApi({
  config,
  authenticator: new ClerkAuthenticator(config.clerk),
  currentUsers: new PostgresCurrentUserRepository(pool),
  deviceConnections: new DeviceConnectionService(new PostgresDeviceConnectionRepository(pool), config),
  conversionJobs,
  packageStorage,
  previewStorage,
  logger: {
    level: config.environment === "production" ? "info" : "debug",
    redact: ["req.headers.authorization", "request.headers.authorization"],
  },
});

let closing = false;
let cleanupTimer: NodeJS.Timeout | null = null;

async function cleanupExpiredConversions(): Promise<void> {
  try {
    const objects = await conversionJobs.expireStale(new Date());
    await Promise.all(
      objects.map(async ({ packageObjectKey, previewObjectKey }) => {
        await Promise.all([
          (async () => {
            try {
              await packageStorage.remove(packageObjectKey);
              await conversionJobs.markPackageRemoved({ objectKey: packageObjectKey, now: new Date() });
            } catch (error) {
              api.log.warn({ err: error }, "conversion package cleanup deferred");
            }
          })(),
          (async () => {
            if (!previewObjectKey) return;
            try {
              await previewStorage.remove(previewObjectKey);
              await conversionJobs.markPreviewRemoved({ previewObjectKey, now: new Date() });
            } catch (error) {
              api.log.warn({ err: error }, "conversion preview cleanup deferred");
            }
          })(),
        ]);
      })
    );
  } catch (error) {
    api.log.error({ err: error }, "conversion cleanup failed");
  }
}

async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  if (cleanupTimer) clearInterval(cleanupTimer);
  api.log.info({ signal }, "shutting down");
  await api.close();
  await pool.end();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await api.listen({ host: config.host, port: config.port });
  await cleanupExpiredConversions();
  cleanupTimer = setInterval(() => void cleanupExpiredConversions(), 60_000);
  cleanupTimer.unref();
} catch (error) {
  api.log.error(error);
  await pool.end();
  process.exitCode = 1;
}
