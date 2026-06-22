import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) => value.startsWith("postgresql://") || value.startsWith("postgres://"),
      "DATABASE_URL must be a PostgreSQL connection string"
    ),
  CLERK_PUBLISHABLE_KEY: z.string().min(1, "CLERK_PUBLISHABLE_KEY is required"),
  CLERK_SECRET_KEY: z.string().min(1, "CLERK_SECRET_KEY is required"),
  CLERK_AUTHORIZED_PARTIES: z.string().min(1, "CLERK_AUTHORIZED_PARTIES is required"),
  CLERK_AUDIENCE: z.string().optional().default(""),
  CORS_ALLOWED_ORIGINS: z.string().min(1, "CORS_ALLOWED_ORIGINS is required"),
  PUBLIC_WEB_URL: z.string().url().default("http://localhost:4173"),
  DEVICE_CONNECTION_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
  DEVICE_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(3).max(60).default(5),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3_600).max(31_536_000).default(2_592_000),
  CONVERSION_JOB_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(1_800),
  MAX_SCENE_PACKAGE_BYTES: z.coerce.number().int().min(1_024).max(104_857_600).default(26_214_400),
  PACKAGE_STORAGE_DIR: z.string().min(1).default(".data/packages"),
});

export type ApiConfig = {
  environment: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  clerk: {
    publishableKey: string;
    secretKey: string;
    authorizedParties: string[];
    audience?: string[];
  };
  corsAllowedOrigins: string[];
  publicWebUrl: string;
  device: {
    connectionTtlSeconds: number;
    pollIntervalSeconds: number;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  };
  conversions: {
    jobTtlSeconds: number;
    maxScenePackageBytes: number;
    packageStorageDir: string;
  };
};

export class ConfigurationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid API configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

function commaSeparated(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function originList(value: string, variableName: string, environment: ApiConfig["environment"]): string[] {
  const rawOrigins = commaSeparated(value);
  const origins: string[] = [];
  const issues: string[] = [];

  for (const rawOrigin of rawOrigins) {
    try {
      const parsed = new URL(rawOrigin);
      if (parsed.origin !== rawOrigin || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        issues.push(`${variableName} entries must be origins without paths: ${rawOrigin}`);
        continue;
      }
      if (environment === "production" && parsed.protocol !== "https:") {
        issues.push(`${variableName} entries must use HTTPS in production: ${rawOrigin}`);
        continue;
      }
      origins.push(rawOrigin);
    } catch {
      issues.push(`${variableName} contains an invalid origin: ${rawOrigin}`);
    }
  }

  if (issues.length || !origins.length) {
    throw new ConfigurationError(issues.length ? issues : [`${variableName} must contain an origin`]);
  }
  return origins;
}

export function loadLocalEnvironment(path = ".env.local"): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

export function createConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
    );
  }

  const authorizedParties = originList(
    parsed.data.CLERK_AUTHORIZED_PARTIES,
    "CLERK_AUTHORIZED_PARTIES",
    parsed.data.NODE_ENV
  );
  const corsAllowedOrigins = originList(
    parsed.data.CORS_ALLOWED_ORIGINS,
    "CORS_ALLOWED_ORIGINS",
    parsed.data.NODE_ENV
  );
  const audience = commaSeparated(parsed.data.CLERK_AUDIENCE);

  if (parsed.data.NODE_ENV === "production" && !audience.length) {
    throw new ConfigurationError([
      "CLERK_AUDIENCE is required in production after configuring the Clerk session-token audience",
    ]);
  }

  const clerk: ApiConfig["clerk"] = {
    publishableKey: parsed.data.CLERK_PUBLISHABLE_KEY,
    secretKey: parsed.data.CLERK_SECRET_KEY,
    authorizedParties,
  };
  if (audience.length) clerk.audience = audience;

  return {
    environment: parsed.data.NODE_ENV,
    host: parsed.data.API_HOST,
    port: parsed.data.API_PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    clerk,
    corsAllowedOrigins,
    publicWebUrl: parsed.data.PUBLIC_WEB_URL,
    device: {
      connectionTtlSeconds: parsed.data.DEVICE_CONNECTION_TTL_SECONDS,
      pollIntervalSeconds: parsed.data.DEVICE_POLL_INTERVAL_SECONDS,
      accessTokenTtlSeconds: parsed.data.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: parsed.data.REFRESH_TOKEN_TTL_SECONDS,
    },
    conversions: {
      jobTtlSeconds: parsed.data.CONVERSION_JOB_TTL_SECONDS,
      maxScenePackageBytes: parsed.data.MAX_SCENE_PACKAGE_BYTES,
      packageStorageDir: parsed.data.PACKAGE_STORAGE_DIR,
    },
  };
}
