import { z } from "zod";

const localAccountWebsiteUrl = "http://localhost:4173";
const railwayAccountWebsiteUrl = "https://web-to-figma-production.up.railway.app";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().min(1).optional(),
  API_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) => value.startsWith("postgresql://") || value.startsWith("postgres://"),
      "DATABASE_URL must be a PostgreSQL connection string"
    ),
  CLERK_PUBLISHABLE_KEY: z.string().min(1, "CLERK_PUBLISHABLE_KEY is required"),
  CLERK_SECRET_KEY: z.string().min(1, "CLERK_SECRET_KEY is required"),
  CLERK_AUTHORIZED_PARTIES: z.string().min(1, "CLERK_AUTHORIZED_PARTIES is required").default(localAccountWebsiteUrl),
  CLERK_AUDIENCE: z.string().optional().default(""),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .min(1, "CORS_ALLOWED_ORIGINS is required")
    .default(`${localAccountWebsiteUrl},null,chrome-extension://*`),
  PUBLIC_WEB_URL: z.string().url(),
  DEVICE_CONNECTION_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
  DEVICE_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(3).max(60).default(5),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3_600).max(31_536_000).default(2_592_000),
  CONVERSION_JOB_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(1_800),
  MAX_SCENE_PACKAGE_BYTES: z.coerce.number().int().min(1_024).max(104_857_600).default(26_214_400),
  MAX_ACTIVE_CONVERSION_JOBS: z.coerce.number().int().min(1).max(20).default(3),
  MAX_STORED_CAPTURE_JOBS: z.coerce.number().int().min(1).max(100).default(10),
  MAX_PREVIEW_IMAGE_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(350_000),
  PACKAGE_STORAGE_DIR: z.string().min(1).default(".data/packages"),
  R2_ACCOUNT_ID: z.string().min(1, "R2_ACCOUNT_ID is required"),
  R2_ACCESS_KEY_ID: z.string().min(1, "R2_ACCESS_KEY_ID is required"),
  R2_SECRET_ACCESS_KEY: z.string().min(1, "R2_SECRET_ACCESS_KEY is required"),
  R2_BUCKET_NAME: z
    .string()
    .min(3, "R2_BUCKET_NAME is required")
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "R2_BUCKET_NAME must be a valid bucket name"),
  R2_ENDPOINT: z.string().url("R2_ENDPOINT must be a valid URL"),
  R2_REGION: z.string().min(1).default("auto"),
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
    maxActiveJobs: number;
    maxStoredCaptures: number;
    maxPreviewImageBytes: number;
    packageStorageDir: string;
  };
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    endpoint: string;
    region: string;
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

const developmentClientCorsOrigins = [
  "null",
  "https://www.figma.com",
  "https://figma.com",
  "chrome-extension://*",
];

function withDevelopmentClientCorsOrigins(origins: string[], environment: ApiConfig["environment"]): string[] {
  if (environment !== "development") return origins;
  return [...new Set([...origins, ...developmentClientCorsOrigins])];
}

function originList(
  value: string,
  variableName: string,
  environment: ApiConfig["environment"],
  options: { allowClientOrigins?: boolean } = {}
): string[] {
  const rawOrigins = commaSeparated(value);
  const origins: string[] = [];
  const issues: string[] = [];

  for (const rawOrigin of rawOrigins) {
    if (options.allowClientOrigins && rawOrigin === "null") {
      origins.push(rawOrigin);
      continue;
    }
    if (options.allowClientOrigins && rawOrigin === "chrome-extension://*") {
      if (environment === "production") {
        issues.push(`${variableName} cannot use chrome-extension://* in production`);
      } else {
        origins.push(rawOrigin);
      }
      continue;
    }
    if (options.allowClientOrigins && /^chrome-extension:\/\/[a-p]{32}$/.test(rawOrigin)) {
      origins.push(rawOrigin);
      continue;
    }
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

function stripRepeatedEnvironmentName(value: string | undefined, variableName: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return trimmed;

  const assignmentPrefix = `${variableName}=`;
  return trimmed.startsWith(assignmentPrefix) ? trimmed.slice(assignmentPrefix.length).trim() : trimmed;
}

function resolvePublicWebUrl(environment: NodeJS.ProcessEnv): string {
  const configuredUrl = stripRepeatedEnvironmentName(environment.PUBLIC_WEB_URL, "PUBLIC_WEB_URL");
  const isRailwayProduction = environment.RAILWAY_ENVIRONMENT_NAME === "production";

  // Railway deployments can retain an old local default while service variables are
  // being configured. A public device-approval link must never send users to their
  // own localhost. An explicitly configured public/custom domain still takes priority.
  if (isRailwayProduction && (!configuredUrl || configuredUrl === localAccountWebsiteUrl)) {
    return railwayAccountWebsiteUrl;
  }

  return configuredUrl ?? localAccountWebsiteUrl;
}

export function createConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = environmentSchema.safeParse({
    ...environment,
    CLERK_AUTHORIZED_PARTIES: stripRepeatedEnvironmentName(
      environment.CLERK_AUTHORIZED_PARTIES,
      "CLERK_AUTHORIZED_PARTIES"
    ),
    CORS_ALLOWED_ORIGINS: stripRepeatedEnvironmentName(environment.CORS_ALLOWED_ORIGINS, "CORS_ALLOWED_ORIGINS"),
    PUBLIC_WEB_URL: resolvePublicWebUrl(environment),
  });
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
    );
  }

  const publicWebOrigin = new URL(parsed.data.PUBLIC_WEB_URL).origin;
  const authorizedParties = [...new Set([...originList(
    parsed.data.CLERK_AUTHORIZED_PARTIES,
    "CLERK_AUTHORIZED_PARTIES",
    parsed.data.NODE_ENV
  ), publicWebOrigin])];
  const corsAllowedOrigins = originList(
    parsed.data.CORS_ALLOWED_ORIGINS,
    "CORS_ALLOWED_ORIGINS",
    parsed.data.NODE_ENV,
    { allowClientOrigins: true }
  );
  const effectiveCorsAllowedOrigins = withDevelopmentClientCorsOrigins(
    [...new Set([...corsAllowedOrigins, publicWebOrigin])],
    parsed.data.NODE_ENV
  );
  const audience = commaSeparated(parsed.data.CLERK_AUDIENCE);
  const railwayPort = parsed.data.PORT;
  const host = parsed.data.API_HOST ?? (railwayPort ? "0.0.0.0" : "127.0.0.1");
  const port = parsed.data.API_PORT ?? railwayPort ?? 8787;

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
    host,
    port,
    databaseUrl: parsed.data.DATABASE_URL,
    clerk,
    corsAllowedOrigins: effectiveCorsAllowedOrigins,
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
      maxActiveJobs: parsed.data.MAX_ACTIVE_CONVERSION_JOBS,
      maxStoredCaptures: parsed.data.MAX_STORED_CAPTURE_JOBS,
      maxPreviewImageBytes: parsed.data.MAX_PREVIEW_IMAGE_BYTES,
      packageStorageDir: parsed.data.PACKAGE_STORAGE_DIR,
    },
    r2: {
      accountId: parsed.data.R2_ACCOUNT_ID,
      accessKeyId: parsed.data.R2_ACCESS_KEY_ID,
      secretAccessKey: parsed.data.R2_SECRET_ACCESS_KEY,
      bucketName: parsed.data.R2_BUCKET_NAME,
      endpoint: parsed.data.R2_ENDPOINT,
      region: parsed.data.R2_REGION,
    },
  };
}
