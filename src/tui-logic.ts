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

  const totalMinutes = Math.floor(ageMs / 60_000);
  if (totalMinutes < 1) return "updated <1m ago";

  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) return `updated ${days}d ${hours}h ago`;
  if (totalHours > 0) return `updated ${totalHours}h ${minutes}m ago`;
  return `updated ${totalMinutes}m ago`;
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
