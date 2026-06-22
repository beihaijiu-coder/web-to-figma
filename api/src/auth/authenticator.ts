import { verifyToken } from "@clerk/backend";

import type { ApiConfig } from "../config.js";

export type AuthenticatedIdentity = {
  clerkUserId: string;
  sessionId: string | null;
  email: string | null;
};

export interface Authenticator {
  authenticate(authorizationHeader: string | undefined): Promise<AuthenticatedIdentity | null>;
}

export class AuthenticationError extends Error {
  constructor() {
    super("Authentication failed");
    this.name = "AuthenticationError";
  }
}

export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorizationHeader.trim());
  return match?.[1] ?? null;
}

function verifiedEmail(claims: Record<string, unknown>): string | null {
  const email = claims.email;
  return typeof email === "string" && email.includes("@") ? email : null;
}

export class ClerkAuthenticator implements Authenticator {
  readonly #config: ApiConfig["clerk"];

  constructor(config: ApiConfig["clerk"]) {
    this.#config = config;
  }

  async authenticate(authorizationHeader: string | undefined): Promise<AuthenticatedIdentity | null> {
    const token = extractBearerToken(authorizationHeader);
    if (!token) return null;

    try {
      const options: Parameters<typeof verifyToken>[1] = {
        secretKey: this.#config.secretKey,
        authorizedParties: this.#config.authorizedParties,
      };
      if (this.#config.audience?.length) options.audience = this.#config.audience;

      const claims = await verifyToken(token, options);
      if (!claims.sub) throw new AuthenticationError();

      return {
        clerkUserId: claims.sub,
        sessionId: typeof claims.sid === "string" ? claims.sid : null,
        email: verifiedEmail(claims as Record<string, unknown>),
      };
    } catch {
      throw new AuthenticationError();
    }
  }
}
