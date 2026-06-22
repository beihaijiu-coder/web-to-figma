import type { AuthenticatedIdentity } from "../auth/authenticator.js";

export const FREE_WEEKLY_CONVERSION_LIMIT = 2;

export type Plan = "free" | "pro";
export type SubscriptionStatus = "inactive" | "active" | "past_due" | "cancelled";
export type BillingPeriod = "month" | "year";

export type CurrentUser = {
  user: {
    id: string;
    clerkUserId: string;
    email: string | null;
    createdAt: string;
  };
  entitlement: {
    plan: Plan;
    subscriptionStatus: SubscriptionStatus;
    billingPeriod: BillingPeriod | null;
    currentPeriodEnd: string | null;
  };
  quota: {
    weekStartsAt: string;
    weekEndsAt: string;
    limit: number | null;
    used: number;
    reserved: number;
    remaining: number | null;
    unlimited: boolean;
  };
};

export interface CurrentUserRepository {
  resolveCurrentUser(identity: AuthenticatedIdentity, now?: Date): Promise<CurrentUser>;
}

export function startOfUtcProductWeek(now: Date): Date {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (midnight.getUTCDay() + 6) % 7;
  midnight.setUTCDate(midnight.getUTCDate() - daysSinceMonday);
  return midnight;
}

export function endOfUtcProductWeek(weekStartsAt: Date): Date {
  const result = new Date(weekStartsAt);
  result.setUTCDate(result.getUTCDate() + 7);
  return result;
}

export function calculateQuota(input: {
  plan: Plan;
  used: number;
  reserved: number;
  weekStartsAt: Date;
}): CurrentUser["quota"] {
  const used = Math.max(0, Math.trunc(input.used));
  const reserved = Math.max(0, Math.trunc(input.reserved));
  const weekEndsAt = endOfUtcProductWeek(input.weekStartsAt);

  if (input.plan === "pro") {
    return {
      weekStartsAt: input.weekStartsAt.toISOString(),
      weekEndsAt: weekEndsAt.toISOString(),
      limit: null,
      used,
      reserved,
      remaining: null,
      unlimited: true,
    };
  }

  return {
    weekStartsAt: input.weekStartsAt.toISOString(),
    weekEndsAt: weekEndsAt.toISOString(),
    limit: FREE_WEEKLY_CONVERSION_LIMIT,
    used,
    reserved,
    remaining: Math.max(0, FREE_WEEKLY_CONVERSION_LIMIT - used - reserved),
    unlimited: false,
  };
}
