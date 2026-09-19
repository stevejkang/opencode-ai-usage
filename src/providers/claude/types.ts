export interface OAuthUsageWindow {
  utilization: number | null;
  resetsAt: string | null;
}

export interface OAuthExtraUsage {
  isEnabled: boolean | null;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
  currency: string | null;
}

export interface LimitScope {
  model: { id: string | null; displayName: string } | null;
  surface: string | null;
}

export interface LimitEntry {
  kind: string;
  group: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
  scope: LimitScope | null;
  isActive: boolean;
}

export interface OAuthUsageResponse {
  fiveHour: OAuthUsageWindow | null;
  sevenDay: OAuthUsageWindow | null;
  sevenDaySonnet: OAuthUsageWindow | null;
  sevenDayOpus: OAuthUsageWindow | null;
  sevenDayOAuthApps: OAuthUsageWindow | null;
  sevenDayCowork: OAuthUsageWindow | null;
  extraUsage: OAuthExtraUsage | null;
  limits: LimitEntry[] | null;
  [key: string]: unknown;
}

export interface ProfileResponse {
  email: string;
  plan: string | null;
}

export interface KeychainPayload {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string | null;
  rateLimitTier: string | null;
  hasProfileScope: boolean;
}

export interface ClaudeExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
  currency: string | null;
}

export interface ClaudeExtras {
  extraUsage: ClaudeExtraUsage | null;
}
