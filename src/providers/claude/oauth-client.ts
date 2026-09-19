import { ProviderFetchError } from "../../types";
import { KNOWN_WINDOW_KEYS } from "./fetcher";
import type { OAuthUsageResponse, ProfileResponse } from "./types";

const BASE_URL = "https://api.anthropic.com";
const BETA_HEADER = "oauth-2025-04-20";
const USER_AGENT = "claude-code/2.1.0";

function makeHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "anthropic-beta": BETA_HEADER,
    "User-Agent": USER_AGENT,
  };
}

function snakeToCamel(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(snakeToCamel);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      result[camelKey] = snakeToCamel(value);
    }
    return result;
  }
  return obj;
}

function normalizeWindow(w: unknown): unknown {
  if (w === null || typeof w !== "object") return w;
  const obj = w as Record<string, unknown>;
  if (obj.utilization === undefined && typeof obj.usedPercentage === "number") {
    obj.utilization = obj.usedPercentage;
  }
  return obj;
}

function normalizeUsageResponse(raw: Record<string, unknown>): OAuthUsageResponse {
  for (const key of KNOWN_WINDOW_KEYS) {
    if (raw[key]) raw[key] = normalizeWindow(raw[key]);
  }
  if (Array.isArray(raw.limits)) {
    raw.limits = (raw.limits as Record<string, unknown>[]).map((entry) => {
      if (entry.percent === undefined && typeof entry.usedPercentage === "number") {
        entry.percent = entry.usedPercentage;
      }
      return entry;
    });
  }
  return raw as unknown as OAuthUsageResponse;
}

function resolveOrgPlan(orgType: unknown): string | null {
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

  const raw = (await response.json()) as Record<string, unknown>;
  return normalizeUsageResponse(snakeToCamel(raw) as Record<string, unknown>);
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

  const raw = (await response.json()) as Record<string, unknown>;
  const converted = snakeToCamel(raw) as Record<string, unknown>;

  const account = converted.account as Record<string, unknown> | undefined;
  const org = converted.organization as Record<string, unknown> | undefined;

  const email =
    typeof account?.email === "string"
      ? account.email
      : typeof converted.email === "string"
        ? converted.email
        : null;
  if (!email) return null;

  const plan = resolveOrgPlan(org?.organizationType);

  return { email, plan };
}
