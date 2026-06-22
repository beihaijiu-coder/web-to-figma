import { createHash, randomBytes } from "node:crypto";

import type { ApiConfig } from "../config.js";

export const CLIENT_TYPES = ["chrome_extension", "figma_plugin"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];
export type ConnectionStatus = "pending" | "approved" | "denied" | "expired" | "consumed" | "slow_down";

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  refreshExpiresIn: number;
};

export type DeviceConnectionCreated = {
  id: string;
  clientType: ClientType;
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type DeviceConnectionApproval = {
  id: string;
  clientType: ClientType;
  requestedClientName: string | null;
  status: "approved";
  installationId: string;
};

export type DevicePollResult =
  | { status: "pending"; interval: number }
  | { status: "slow_down"; interval: number }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "consumed" }
  | { status: "approved"; tokens: TokenPair };

export type DevicePrincipal = {
  userId: string;
  installationId: string;
  clientType: ClientType;
};

export type InstallationSummary = {
  id: string;
  clientType: ClientType;
  displayName: string | null;
  status: "active" | "revoked";
  createdAt: string;
  lastSeenAt: string;
};

export type CreateConnectionInput = {
  clientType: ClientType;
  requestedClientName: string | null;
  deviceCode: string;
  deviceCodeHash: string;
  userCode: string;
  pollIntervalSeconds: number;
  expiresAt: Date;
};

export interface DeviceConnectionRepository {
  createConnection(input: CreateConnectionInput): Promise<{ id: string }>;
  approveConnection(input: { userCode: string; userId: string; now: Date }): Promise<DeviceConnectionApproval | null>;
  denyConnection(input: { userCode: string; userId: string; now: Date }): Promise<"denied" | "not_found" | "expired">;
  pollConnection(input: {
    deviceCodeHash: string;
    now: Date;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  }): Promise<DevicePollResult | "not_found">;
  refreshToken(input: {
    refreshTokenHash: string;
    now: Date;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  }): Promise<TokenPair | "invalid" | "reuse_detected">;
  authenticateAccessToken(input: { accessTokenHash: string; now: Date }): Promise<DevicePrincipal | null>;
  listInstallations(input: {
    principal: DevicePrincipal;
    clientType?: ClientType | undefined;
  }): Promise<InstallationSummary[]>;
}

export class DeviceConnectionError extends Error {
  readonly code: "CONNECTION_NOT_FOUND" | "CONNECTION_EXPIRED" | "CONNECTION_ALREADY_APPROVED";

  constructor(code: DeviceConnectionError["code"]) {
    super(code);
    this.name = "DeviceConnectionError";
    this.code = code;
  }
}

export function hashOpaqueToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function userVerificationCode(): string {
  const random = randomBytes(10);
  let value = "";
  for (const byte of random) value += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  return `${value.slice(0, 5)}-${value.slice(5)}`;
}

export function normalizeUserVerificationCode(value: string): string {
  return value.trim().toUpperCase();
}

export class DeviceConnectionService {
  readonly #repository: DeviceConnectionRepository;
  readonly #config: ApiConfig;

  constructor(repository: DeviceConnectionRepository, config: ApiConfig) {
    this.#repository = repository;
    this.#config = config;
  }

  async create(input: { clientType: ClientType; requestedClientName?: string | undefined }): Promise<DeviceConnectionCreated> {
    const now = new Date();
    const deviceCode = createOpaqueToken("w2f_dc");
    const userCode = userVerificationCode();
    const expiresAt = new Date(now.getTime() + this.#config.device.connectionTtlSeconds * 1_000);
    const created = await this.#repository.createConnection({
      clientType: input.clientType,
      requestedClientName: input.requestedClientName?.trim() || null,
      deviceCode,
      deviceCodeHash: hashOpaqueToken(deviceCode),
      userCode,
      pollIntervalSeconds: this.#config.device.pollIntervalSeconds,
      expiresAt,
    });
    const verificationUri = new URL("/connect/device", this.#config.publicWebUrl).toString();
    const verificationUriComplete = new URL(
      `/connect/device?user_code=${encodeURIComponent(userCode)}`,
      this.#config.publicWebUrl
    ).toString();

    return {
      id: created.id,
      clientType: input.clientType,
      userCode,
      deviceCode,
      verificationUri,
      verificationUriComplete,
      expiresIn: this.#config.device.connectionTtlSeconds,
      interval: this.#config.device.pollIntervalSeconds,
    };
  }

  approve(userCode: string, userId: string): Promise<DeviceConnectionApproval | null> {
    return this.#repository.approveConnection({
      userCode: normalizeUserVerificationCode(userCode),
      userId,
      now: new Date(),
    });
  }

  deny(userCode: string, userId: string): Promise<"denied" | "not_found" | "expired"> {
    return this.#repository.denyConnection({
      userCode: normalizeUserVerificationCode(userCode),
      userId,
      now: new Date(),
    });
  }

  poll(deviceCode: string): Promise<DevicePollResult | "not_found"> {
    return this.#repository.pollConnection({
      deviceCodeHash: hashOpaqueToken(deviceCode),
      now: new Date(),
      accessTokenTtlSeconds: this.#config.device.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: this.#config.device.refreshTokenTtlSeconds,
    });
  }

  refresh(refreshToken: string): Promise<TokenPair | "invalid" | "reuse_detected"> {
    return this.#repository.refreshToken({
      refreshTokenHash: hashOpaqueToken(refreshToken),
      now: new Date(),
      accessTokenTtlSeconds: this.#config.device.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: this.#config.device.refreshTokenTtlSeconds,
    });
  }

  authenticate(accessToken: string): Promise<DevicePrincipal | null> {
    return this.#repository.authenticateAccessToken({
      accessTokenHash: hashOpaqueToken(accessToken),
      now: new Date(),
    });
  }

  listInstallations(input: {
    principal: DevicePrincipal;
    clientType?: ClientType | undefined;
  }): Promise<InstallationSummary[]> {
    return this.#repository.listInstallations(input);
  }
}
