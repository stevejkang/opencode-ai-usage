import { ProviderFetchError } from "../../types";
import type {
  LimitEntry,
  OAuthExtraUsage,
  OAuthUsageResponse,
  OAuthUsageWindow,
  ProfileResponse,
} from "./types";

const BASE_URL = "https://api.anthropic.com";
const BETA_HEADER = "oauth-2025-04-20";
const USER_AGENT = "claude-code/2.1.0";

interface ApiUsageWindow {
  utilization?: number | null;
  used_percentage?: number | null;
  resets_at?: string | null;
}

interface ApiExtraUsage {
  is_enabled?: boolean | null;
  monthly_limit?: number | null;
  used_credits?: number | null;
  utilization?: number | null;
  currency?: string | null;
}

interface ApiLimitEntry {
  kind?: string | null;
  group?: string | null;
  percent?: number | null;
  used_percentage?: number | null;
  severity?: string | null;
  resets_at?: string | null;
  scope?: {
    model?: { id?: string | null; display_name?: string | null } | null;
    surface?: string | null;
  } | null;
  is_active?: boolean | null;
}

interface UsageApiResponse {
  five_hour?: ApiUsageWindow | null;
  seven_day?: ApiUsageWindow | null;
  seven_day_sonnet?: ApiUsageWindow | null;
  seven_day_opus?: ApiUsageWindow | null;
  seven_day_oauth_apps?: ApiUsageWindow | null;
  seven_day_cowork?: ApiUsageWindow | null;
  extra_usage?: ApiExtraUsage | null;
  limits?: ApiLimitEntry[] | null;
}

interface ProfileApiResponse {
  account?: { email?: string | null } | null;
  organization?: { organization_type?: string | null } | null;
  email?: string | null;
}

function makeHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "anthropic-beta": BETA_HEADER,
    "User-Agent": USER_AGENT,
  };
}

function mapWindow(w: ApiUsageWindow | null | undefined): OAuthUsageWindow | null {
  if (!w) return null;
  return {
    utilization: w.utilization ?? w.used_percentage ?? null,
    resetsAt: w.resets_at ?? null,
  };
}

function mapExtraUsage(e: ApiExtraUsage | null | undefined): OAuthExtraUsage | null {
  if (!e) return null;
  return {
    isEnabled: e.is_enabled ?? null,
    monthlyLimit: e.monthly_limit ?? null,
    usedCredits: e.used_credits ?? null,
    utilization: e.utilization ?? null,
    currency: e.currency ?? null,
  };
}

function mapLimitEntry(entry: ApiLimitEntry): LimitEntry {
  return {
    kind: entry.kind ?? "",
    group: entry.group ?? "",
    percent: entry.percent ?? entry.used_percentage ?? 0,
    severity: entry.severity ?? "",
    resetsAt: entry.resets_at ?? null,
    scope: entry.scope
      ? {
          model: entry.scope.model
            ? {
                id: entry.scope.model.id ?? null,
                displayName: entry.scope.model.display_name ?? "",
              }
            : null,
          surface: entry.scope.surface ?? null,
        }
      : null,
    isActive: entry.is_active ?? false,
  };
}

function mapUsageResponse(raw: UsageApiResponse): OAuthUsageResponse {
  return {
    fiveHour: mapWindow(raw.five_hour),
    sevenDay: mapWindow(raw.seven_day),
    sevenDaySonnet: mapWindow(raw.seven_day_sonnet),
    sevenDayOpus: mapWindow(raw.seven_day_opus),
    sevenDayOAuthApps: mapWindow(raw.seven_day_oauth_apps),
    sevenDayCowork: mapWindow(raw.seven_day_cowork),
    extraUsage: mapExtraUsage(raw.extra_usage),
    limits: raw.limits?.map(mapLimitEntry) ?? null,
  };
}

function resolveOrgPlan(orgType: string | null | undefined): string | null {
  switch (orgType) {
    case "claude_max":
      return "Max";
    case "claude_pro":
      return "Pro";
    case "claude_team":
      return "Team";
    case "claude_enterprise":
      return "Enterprise";
    default:
      return null;
  }
}

function throwHttpError(status: number, headers: Headers): never {
  if (status === 429) {
    const retryAfter = Number.parseInt(headers.get("retry-after") ?? "0", 10);
    throw new ProviderFetchError(`Rate limited (429)`, {
      kind: "http",
      status: 429,
      retryAfterS: retryAfter > 0 ? retryAfter : 60,
    });
  }
  throw new ProviderFetchError(`HTTP ${status}`, {
    kind: "http",
    status,
  });
}

/** Fetch usage data from the Anthropic OAuth API. */
export async function fetchOAuthUsage(
  accessToken: string,
  fetcher: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<OAuthUsageResponse> {
  let response: Response;
  try {
    response = await fetcher(`${BASE_URL}/api/oauth/usage`, {
      headers: makeHeaders(accessToken),
      signal,
    });
  } catch {
    throw new ProviderFetchError("Network error fetching usage", {
      kind: "network",
    });
  }

  if (!response.ok) {
    throwHttpError(response.status, response.headers);
  }

  const raw = (await response.json()) as UsageApiResponse;
  return mapUsageResponse(raw);
}

/** Fetch profile data from the Anthropic OAuth API. */
export async function fetchOAuthProfile(
  accessToken: string,
  fetcher: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<ProfileResponse | null> {
  let response: Response;
  try {
    response = await fetcher(`${BASE_URL}/api/oauth/profile`, {
      headers: makeHeaders(accessToken),
      signal,
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const data = (await response.json()) as ProfileApiResponse;

  const email =
    typeof data.account?.email === "string"
      ? data.account.email
      : typeof data.email === "string"
        ? data.email
        : null;
  if (!email) return null;

  const plan = resolveOrgPlan(data.organization?.organization_type);

  return { email, plan };
}
