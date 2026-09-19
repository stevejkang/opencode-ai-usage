import { join } from "node:path";
import type { ProviderDeps } from "../../types";
import type { OAuthCredentials } from "./types";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const PROFILE_SCOPE = "user:profile";
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function credentialsFilePath(homedir: string): string {
  return join(homedir, ".claude", ".credentials.json");
}

function openCodeAuthFilePath(homedir: string): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir, "AppData", "Roaming");
    return join(appData, "opencode", "auth.json");
  }
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir, ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

export function isTokenExpired(expiresAtMs: number, now: number): boolean {
  return now + EXPIRY_BUFFER_MS >= expiresAtMs;
}

export function parseCredentials(raw: string, now: number): OAuthCredentials | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const inner = (parsed.claudeAiOauth as Record<string, unknown> | undefined) ?? parsed;
    if (!inner?.accessToken) return null;
    if (isTokenExpired(inner.expiresAt as number, now)) return null;
    return {
      accessToken: inner.accessToken as string,
      refreshToken: (inner.refreshToken as string) ?? "",
      expiresAt: inner.expiresAt as number,
      scopes: (inner.scopes as string[]) ?? [],
      subscriptionType: (inner.subscriptionType as string) ?? null,
      rateLimitTier: (inner.rateLimitTier as string) ?? null,
      hasProfileScope: ((inner.scopes as string[]) ?? []).includes(PROFILE_SCOPE),
    };
  } catch {
    return null;
  }
}

export function readCredentialsFile(
  deps: Pick<ProviderDeps, "readFile" | "homedir" | "now">,
): OAuthCredentials | null {
  try {
    const raw = deps.readFile(credentialsFilePath(deps.homedir()), "utf8");
    return parseCredentials(String(raw), deps.now());
  } catch {
    return null;
  }
}

export function readOpenCodeAuth(
  deps: Pick<ProviderDeps, "readFile" | "homedir">,
): { accessToken: string; refreshToken: string; expiresAt: number } | null {
  try {
    const raw = String(deps.readFile(openCodeAuthFilePath(deps.homedir()), "utf8"));
    const data = JSON.parse(raw) as Record<string, unknown>;
    const ant = data.anthropic as Record<string, unknown> | undefined;
    if (!ant?.access) return null;
    return {
      accessToken: ant.access as string,
      refreshToken: (ant.refresh as string) ?? "",
      expiresAt: (ant.expires as number) ?? 0,
    };
  } catch {
    return null;
  }
}

/** Read keychain credentials synchronously via execFileSync. */
export function readKeychainCredentials(
  deps: Pick<ProviderDeps, "execFile" | "now">,
): OAuthCredentials | null {
  if (process.platform !== "darwin") return null;
  try {
    const stdout = deps.execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 5_000, encoding: "utf8" },
    );
    if (!stdout) return null;
    return parseCredentials(String(stdout).trim(), deps.now());
  } catch {
    return null;
  }
}

export function readEnvToken(): string | null {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return null;
  return token;
}
