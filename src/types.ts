import { execSync, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { JSX } from "solid-js";

export type UnixMs = number & { readonly __brand: "UnixMs" };

export type Percent0to100 = number & { readonly __brand: "Percent0to100" };

export function toUnixMs(value: number): UnixMs {
  return value as UnixMs;
}

export function toPercent(value: number): Percent0to100 {
  return Math.max(0, Math.min(100, value)) as Percent0to100;
}

export interface ProviderDeps {
  exec: typeof execSync;
  execFile: typeof execFileSync;
  spawn: typeof spawn;
  readFile: typeof readFileSync;
  fetch: typeof globalThis.fetch;
  now: () => number;
  homedir: () => string;
}

export type DetectionResult = { available: true } | { available: false; reason: string };

export interface UsageWindow {
  label: string;
  percent: Percent0to100 | null;
  resetsAt: UnixMs | null;
  isActive: boolean;
}

export interface ProviderProfile {
  email?: string | null;
  plan?: string | null;
}

export interface TuiTheme {
  text?: string;
  textMuted?: string;
}

export type DisplayMode = "text" | "bar" | "mixed";

export interface ProviderOverrides {
  refreshInterval?: number;
  headerColor?: string;
}

export interface PluginOptions {
  disabledProviders?: string[];
  showRemaining?: boolean;
  displayMode?: DisplayMode;
  providers?: Record<string, ProviderOverrides>;
}

export interface FetchResult<TExtras = unknown> {
  accountKey: string | null;
  windows: UsageWindow[];
  profile: ProviderProfile | null;
  extras: TExtras | null;
}

export interface ProviderDefinition<TExtras = unknown> {
  id: string;
  displayName: string;
  defaultHeaderColor: string;
  expectedLoadTimeS: number;
  defaultRefreshIntervalS: number;
  detect(deps: ProviderDeps, signal: AbortSignal): Promise<DetectionResult>;
  fetch(deps: ProviderDeps, signal: AbortSignal): Promise<FetchResult<TExtras>>;
  renderExpanded?(
    ctx: { theme: TuiTheme; options: PluginOptions },
    extras: TExtras | null,
  ): JSX.Element;
}

export interface CacheSchema {
  version: 1;
  providers: Record<string, ProviderCache>;
}

export interface ProviderCache {
  accounts: Record<string, AccountCache>;
}

export interface AccountCache {
  timestamp: number;
  windows: UsageWindow[];
  profile: ProviderProfile | null;
  extras: unknown | null;
}

export const UNKNOWN_ACCOUNT_KEY = "__unknown__";

export interface CacheStore {
  read(providerId: string, accountKey: string): AccountCache | null;
  readLatest(providerId: string): { accountKey: string; entry: AccountCache } | null;
  write(providerId: string, accountKey: string, entry: AccountCache): Promise<void>;
  getAge(providerId: string, accountKey: string): number | null;
  migrateUnknown(providerId: string, newAccountKey: string): Promise<void>;
}

export interface RefreshState {
  windows: UsageWindow[];
  profile: ProviderProfile | null;
  extras: unknown | null;
  error: string | null;
  lastFetchedAt: number | null;
}

export type ProviderFetchErrorInfo =
  | { kind: "http"; status: number; retryAfterS?: number }
  | { kind: "network" };

export class ProviderFetchError extends Error {
  readonly info: ProviderFetchErrorInfo;

  constructor(message: string, info: ProviderFetchErrorInfo) {
    super(message);
    this.name = "ProviderFetchError";
    this.info = info;
  }
}
