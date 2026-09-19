export interface RateLimitWindow {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface RateLimitCredits {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string | null;
}

export interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: RateLimitCredits | null;
  planType?: string | null;
}

export interface RateLimitResponse {
  rateLimits?: RateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
}

export interface AccountResponse {
  account?: {
    type?: "apiKey" | "chatgpt";
    email?: string | null;
    planType?: string | null;
  } | null;
  requiresOpenaiAuth?: boolean;
}
