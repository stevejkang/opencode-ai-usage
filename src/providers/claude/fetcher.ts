import type { ProviderDeps, DetectionResult, FetchResult, UsageWindow } from "../../types";
import { toUnixMs, toPercent, ProviderFetchError } from "../../types";
import {
  readEnvToken,
  readCredentialsFile,
  readOpenCodeAuth,
  readKeychainCredentials,
  isTokenExpired,
} from "./keychain";
import { fetchOAuthUsage, fetchOAuthProfile } from "./oauth-client";
import type {
  OAuthUsageResponse,
  ClaudeExtras,
  ClaudeExtraUsage,
  ProfileResponse,
  LimitEntry,
  LimitScope,
} from "./types";

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const CLI_REFRESH_TIMEOUT_MS = 10_000;

/** Whitelist: only these camelCase keys are recognized as renderable windows. */
export const WINDOW_LABEL_MAP: Record<string, string> = {
  fiveHour: "Session",
  sevenDay: "Weekly",
  sevenDaySonnet: "Sonnet",
  sevenDayOpus: "Opus",
  sevenDayOAuthApps: "Apps",
  sevenDayCowork: "Cowork",
};

export const KNOWN_WINDOW_KEYS: readonly string[] = Object.keys(WINDOW_LABEL_MAP);

export function limitLabel(kind: string, scope: LimitScope | null | undefined): string {
  if (scope?.model?.displayName) return scope.model.displayName;
  const labels: Record<string, string> = {
    session: "Session",
    weekly_all: "Weekly",
  };
  return labels[kind] ?? kind;
}

let inflightRefresh: Promise<string | null> | null = null;

function normalizeFromLimits(limits: LimitEntry[]): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const entry of limits) {
    const label = limitLabel(entry.kind, entry.scope);
    const percent = toPercent(entry.percent);

    let resetsAtMs: ReturnType<typeof toUnixMs> | null = null;
    if (entry.resetsAt) {
      const parsed = new Date(entry.resetsAt).getTime();
      if (!Number.isNaN(parsed)) {
        resetsAtMs = toUnixMs(parsed);
      }
    }

    const isActive = !(percent === 0 && resetsAtMs === null);
    windows.push({ label, percent, resetsAt: resetsAtMs, isActive });
  }
  return windows;
}

function normalizeFromWindowKeys(response: OAuthUsageResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];

  for (const [key, label] of Object.entries(WINDOW_LABEL_MAP)) {
    const w = response[key];
    if (w === null || w === undefined) continue;
    if (typeof w !== "object" || !("utilization" in w)) continue;

    const raw = w as { utilization: number | null; resetsAt: string | null };

    let resetsAtMs: ReturnType<typeof toUnixMs> | null = null;
    if (raw.resetsAt) {
      const parsed = new Date(raw.resetsAt).getTime();
      if (!Number.isNaN(parsed)) {
        resetsAtMs = toUnixMs(parsed);
      }
    }

    const percent = raw.utilization !== null ? toPercent(raw.utilization) : null;
    const isActive = percent !== null && (percent > 0 || resetsAtMs !== null);

    windows.push({ label, percent, resetsAt: resetsAtMs, isActive });
  }

  return windows;
}

function normalizeWindows(response: OAuthUsageResponse): UsageWindow[] {
  if (response.limits && response.limits.length > 0) {
    return normalizeFromLimits(response.limits);
  }
  return normalizeFromWindowKeys(response);
}

function buildExtras(response: OAuthUsageResponse): ClaudeExtras {
  let extraUsage: ClaudeExtraUsage | null = null;
  if (response.extraUsage?.isEnabled) {
    extraUsage = {
      isEnabled: true,
      monthlyLimit: response.extraUsage.monthlyLimit ?? null,
      usedCredits: response.extraUsage.usedCredits ?? null,
      utilization: response.extraUsage.utilization ?? null,
      currency: response.extraUsage.currency ?? null,
    };
  }
  return { extraUsage };
}

function refreshViaCli(deps: Pick<ProviderDeps, "execFile">): boolean {
  try {
    deps.execFile("claude", ["auth", "refresh"], {
      timeout: CLI_REFRESH_TIMEOUT_MS,
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

async function refreshTokenDirect(
  refreshTokenStr: string,
  deps: Pick<ProviderDeps, "fetch" | "now">,
  signal: AbortSignal,
): Promise<{ accessToken: string; expiresAt: number } | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshTokenStr,
    client_id: OAUTH_CLIENT_ID,
  });
  try {
    const resp = await deps.fetch(REFRESH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Record<string, unknown>;
    const accessToken = data.access_token as string | undefined;
    if (!accessToken) return null;
    const expiresIn = (data.expires_in as number | undefined) ?? 28800;
    return { accessToken, expiresAt: deps.now() + expiresIn * 1000 };
  } catch {
    return null;
  }
}

/**
 * CLI delegation first, then direct refresh with race-condition defense:
 * re-read before refresh, single-flight dedup, one retry on 400.
 */
async function refreshWithDefense(
  deps: Pick<ProviderDeps, "readFile" | "homedir" | "fetch" | "now" | "execFile">,
  signal: AbortSignal,
): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh;

  inflightRefresh = (async (): Promise<string | null> => {
    const cliOk = refreshViaCli(deps);
    if (cliOk) {
      const reread = readOpenCodeAuth(deps);
      if (reread && !isTokenExpired(reread.expiresAt, deps.now())) {
        return reread.accessToken;
      }
    }

    const auth = readOpenCodeAuth(deps);
    if (!auth?.refreshToken) return null;

    const result = await refreshTokenDirect(auth.refreshToken, deps, signal);
    if (result) return result.accessToken;

    // Re-read credentials in case another process already refreshed
    const reread = readOpenCodeAuth(deps);
    if (reread && !isTokenExpired(reread.expiresAt, deps.now())) {
      return reread.accessToken;
    }

    if (reread?.refreshToken) {
      const retry = await refreshTokenDirect(reread.refreshToken, deps, signal);
      if (retry) return retry.accessToken;
    }

    return null;
  })();

  try {
    return await inflightRefresh;
  } finally {
    inflightRefresh = null;
  }
}

async function tryFetchWithToken(
  token: string,
  deps: Pick<ProviderDeps, "fetch">,
  signal: AbortSignal,
): Promise<{ usage: OAuthUsageResponse; profile: ProfileResponse | null }> {
  const [usage, profile] = await Promise.all([
    fetchOAuthUsage(token, deps.fetch, signal),
    fetchOAuthProfile(token, deps.fetch, signal),
  ]);
  return { usage, profile };
}

/** Detect whether any OAuth source is available. */
export async function detect(deps: ProviderDeps, _signal: AbortSignal): Promise<DetectionResult> {
  const keychainCreds = readKeychainCredentials(deps);
  if (keychainCreds) return { available: true };

  if (readEnvToken()) return { available: true };

  const fileCreds = readCredentialsFile(deps);
  if (fileCreds) return { available: true };

  const ocAuth = readOpenCodeAuth(deps);
  if (ocAuth) return { available: true };

  return { available: false, reason: "No OAuth credentials found" };
}

/** Fetch usage via 4-step OAuth fallback chain: Keychain → env → credentials → OpenCode auth. */
export async function fetchUsage(
  deps: ProviderDeps,
  signal: AbortSignal,
): Promise<FetchResult<ClaudeExtras>> {
  const errors: string[] = [];
  let lastProviderError: ProviderFetchError | null = null;

  const keychainCreds = readKeychainCredentials(deps);
  if (keychainCreds) {
    try {
      const { usage, profile } = await tryFetchWithToken(keychainCreds.accessToken, deps, signal);
      return buildResult(usage, profile);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof ProviderFetchError) lastProviderError = error;
      errors.push(`keychain: ${String(error)}`);
    }
  }

  const envToken = readEnvToken();
  if (envToken) {
    try {
      const { usage, profile } = await tryFetchWithToken(envToken, deps, signal);
      return buildResult(usage, profile);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof ProviderFetchError) lastProviderError = error;
      errors.push(`env: ${String(error)}`);
    }
  }

  const fileCreds = readCredentialsFile(deps);
  if (fileCreds) {
    try {
      const { usage, profile } = await tryFetchWithToken(fileCreds.accessToken, deps, signal);
      return buildResult(usage, profile);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof ProviderFetchError) lastProviderError = error;
      errors.push(`credentials: ${String(error)}`);
    }
  }

  const ocAuth = readOpenCodeAuth(deps);
  if (ocAuth) {
    let token = ocAuth.accessToken;
    if (isTokenExpired(ocAuth.expiresAt, deps.now()) && ocAuth.refreshToken) {
      const refreshed = await refreshWithDefense(deps, signal);
      if (refreshed) token = refreshed;
    }
    try {
      const { usage, profile } = await tryFetchWithToken(token, deps, signal);
      return buildResult(usage, profile);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof ProviderFetchError) lastProviderError = error;
      errors.push(`opencode: ${String(error)}`);
    }
  }

  throw (
    lastProviderError ??
    new ProviderFetchError(`All OAuth sources exhausted: ${errors.join("; ")}`, {
      kind: "network",
    })
  );
}

function buildResult(
  usage: OAuthUsageResponse,
  profile: ProfileResponse | null,
): FetchResult<ClaudeExtras> {
  return {
    accountKey: profile?.email ?? null,
    windows: normalizeWindows(usage),
    profile: profile ? { email: profile.email, plan: profile.plan } : null,
    extras: buildExtras(usage),
  };
}
