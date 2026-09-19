import type { Percent0to100 } from "./types";
import { toPercent } from "./types";

export type SectionVisibility =
  | { kind: "loading" }
  | { kind: "data"; staleText: string | null }
  | { kind: "error"; message: string };

export function computeSectionVisibility(input: {
  hasData: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  refreshIntervalMs: number;
  now: number;
}): SectionVisibility {
  if (!input.hasData && input.error === null) return { kind: "loading" };
  if (!input.hasData && input.error !== null) return { kind: "error", message: input.error };
  const staleText = computeStaleText(input.lastFetchedAt!, input.refreshIntervalMs, input.now);
  return { kind: "data", staleText };
}

export function computeStaleText(
  lastFetchedAt: number,
  refreshIntervalMs: number,
  now: number,
): string | null {
  const ageMs = now - lastFetchedAt;
  if (ageMs <= 2 * refreshIntervalMs) return null;
  const mins = Math.floor(ageMs / 60_000);
  return mins < 1 ? "updated <1m ago" : `updated ${mins}m ago`;
}

export function computeDisplayPercent(
  percent: Percent0to100 | null,
  showRemaining: boolean,
): Percent0to100 | null {
  if (percent === null) return null;
  return showRemaining ? toPercent(100 - percent) : percent;
}

export function computeCountdown(expectedLoadTimeS: number, elapsedS: number): number {
  return Math.max(0, expectedLoadTimeS - elapsedS);
}
